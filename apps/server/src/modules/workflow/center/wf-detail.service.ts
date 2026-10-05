import { Injectable, Logger } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  compile,
  Err,
  type FormSchema,
  formUploadIds,
  type WfCompiled,
  type WfFieldAccess,
  type WfFields,
  type WfFormKind,
  type WfInstanceDetailVo,
  wfPerms,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { clsGet } from '../../../core/context/cls.js'
import {
  applyScopes,
  type DataScopeColumns,
  defaultScopeRules,
  withCheckedPerm,
} from '../../../core/data-scope/data-scope.js'
import { formatInZone } from '../../../core/excel/excel.js'
import { BizError } from '../../../core/http/biz-error.js'
import { currentLocale, currentTimezone } from '../../../core/i18n/locale.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { readerAccess, visibleValues } from '../engine/form-values.js'
import { withdraw } from '../engine/lifecycle.js'
import { progressOf } from '../engine/progress.js'
import { WfCcRow, WfEventRow, WfInstanceRow, WfTaskRow } from '../runtime/wf-runtime.entity.js'
import { WfStore } from '../runtime/wf-store.js'

/** The data scope of instances (admin pages): the initiator's dept, and the initiator for `own_rows`. */
export const WF_INSTANCE_SCOPE: DataScopeColumns = {
  dept: 'initiator_dept_id',
  owner: 'initiator_id',
}

/** Builds instance titles (`{model name}-{initiator}-{start date}`) in the reader's language and zone. */
export type WfTitler = (modelName: string, initiator: string | null, startedAt: Date) => string

/**
 * Reading one instance (see docs/design-notes.md#workflow): the access rule (IDOR) and the detail with its timeline.
 * `canView` is the one instance access check: the attachment checker (`canDownload`) and the
 * leave detail reuse it; the lists reuse `titler`, `userNames` and `modelNames`.
 */
@Injectable()
export class WfDetailService {
  private readonly logger = new Logger(WfDetailService.name)

  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly params: ParamService,
    private readonly i18n: I18nService,
    private readonly store: WfStore,
  ) {}

  /**
   * May the caller see instance `id`: its initiator, anyone with a task on it (any state: current, done, or
   * waiting their turn; the owner of a delegated one too), a cc recipient, or a `wf.instance.view` holder
   * whose scope for that perm covers the initiator's dept (root: any). Unknown / deleted → false.
   */
  async canView(id: number): Promise<boolean> {
    const p = clsGet('principal')
    if (!p) return false
    const { tx } = this.txHost
    const hit = await tx.query<unknown[]>(
      `SELECT 1 FROM wf_instance i
        WHERE i.id = ? AND i.deleted_at IS NULL
          AND (i.initiator_id = ?
            OR EXISTS (SELECT 1 FROM wf_task t
                        WHERE t.instance_id = i.id AND ? IN (t.assignee_id, t.owner_id)
                          AND t.deleted_at IS NULL)
            OR EXISTS (SELECT 1 FROM wf_cc c
                        WHERE c.instance_id = i.id AND c.user_id = ? AND c.deleted_at IS NULL))`,
      [id, p.userId, p.userId, p.userId],
    )
    return hit.length > 0 || this.viewerOf(id)
  }

  /** A `wf.instance.view` holder whose scope covers the instance (root: any). */
  private viewerOf(id: number): Promise<boolean> {
    // the scope of the roles holding the perm, not of every role the caller has: none → 1=0 (root: no filter)
    return withCheckedPerm({ perms: [wfPerms.instance.view], all: false }, () =>
      applyScopes(
        this.txHost.tx
          .getRepository(WfInstanceRow)
          .createQueryBuilder('i')
          .where('i.id = :id', { id }),
        'i',
        WF_INSTANCE_SCOPE,
        defaultScopeRules(),
      ).getExists(),
    )
  }

  /**
   * GET /wf/instances/:id: 404 unless `canView`. A version whose tree no longer compiles (its snapshot
   * edited by hand, a rule tightened since) still shows: no tree or progress, steps by their stored names,
   * no withdraw (the degraded view).
   */
  async detail(id: number): Promise<WfInstanceDetailVo> {
    if (!(await this.canView(id))) throw new BizError(Err.NOT_FOUND)
    const { tx } = this.txHost
    const inst = await tx.getRepository(WfInstanceRow).findOneByOrFail({ id })
    const { v, flow } = await this.versionOf(inst)
    const nodeOf = (nodeId: string | null) => (nodeId && flow?.nodes.get(nodeId)?.node) || null
    const nodeName = (nodeId: string | null) => nodeOf(nodeId)?.name || null
    const events = await tx
      .getRepository(WfEventRow)
      .find({ where: { instanceId: id }, order: { id: 'ASC' } })
    const tasks = await tx
      .getRepository(WfTaskRow)
      .find({ where: { instanceId: id }, order: { id: 'ASC' } })
    const me = clsGet('principal')!.userId
    const begin = flow?.root.id ?? null
    const running = inst.state === 'running'
    const initiator = running && inst.initiatorId === me
    const pending = tasks.filter((t) => t.state === 'pending')
    const mine = pending.filter((t) => t.assigneeId === me)
    const held = new Set(tasks.filter((t) => t.assigneeId === me).map((t) => t.id))
    const signs = pending.filter(
      (t) => t.signKind !== null && t.parentTaskId !== null && held.has(t.parentTaskId),
    )
    // the newest approval, while the engine would take it back (what it created untouched; see docs/design-notes.md#workflow)
    let approval =
      running && !!Number(v.allowWithdraw)
        ? tasks.findLast(
            (t) =>
              t.assigneeId === me &&
              t.state === 'approved' &&
              t.parentTaskId === null &&
              nodeOf(t.nodeId)?.type === 'review',
          )
        : undefined
    if (approval) {
      const ctx = await this.store.ctxOf(tx, inst.versionId, new Date())
      try {
        withdraw(ctx, inst, tasks, approval, { comment: null, events })
      } catch (e) {
        if (!(e instanceof BizError)) throw e
        approval = undefined
      }
    }
    // a dynamic form as the caller may see it (字段权限; see docs/design-notes.md#workflow): without a tree that compiles, the steps'
    // access is unknown, so no form at all
    const dynamic = v.formKind === 'dynamic' && !!flow
    const access = dynamic ? await this.readerAccessOf(inst, flow, tasks) : {}
    const schema =
      dynamic && v.form.schema
        ? { ...v.form.schema, rule: v.form.schema.rule.filter((r) => access[r.field] !== 'hide') }
        : null
    // the remind job's `timeout` events (no actor): their comment is a seed key, said in the reader's
    // language with whose to-do it was; a user's comment is never taken for a key
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const ofTask = (e: WfEventRow) =>
      e.actorId === null && e.comment?.startsWith('seed.wf.timeout.')
        ? byId.get(e.taskId!)
        : undefined
    const userIds = [inst.initiatorId, ...signs.map((t) => t.assigneeId)]
    for (const e of events) {
      if (e.actorId !== null) userIds.push(e.actorId)
      for (const t of e.targetIds ?? []) if (typeof t === 'number') userIds.push(t)
      const handled = ofTask(e)
      if (handled) userIds.push(handled.assigneeId)
    }
    const names = await this.userNames(userIds)
    const user = (uid: number) => ({ id: uid, name: names.get(uid) ?? null })
    const title = await this.titler()
    const lang = currentLocale()
    const t = (key: string, args?: Record<string, string>) =>
      String(this.i18n.translate(key, { lang, args }))
    const said = (e: WfEventRow) => {
      const handled = ofTask(e)
      if (!handled) return e.comment
      const assignee = names.get(handled.assigneeId) ?? ''
      return t('seed.wf.timeout.ofTask', { assignee, outcome: t(e.comment!) })
    }
    return {
      id: inst.id,
      modelKey: inst.modelKey,
      modelName: v.name,
      title: title(v.name, names.get(inst.initiatorId) ?? null, inst.startedAt),
      formKind: v.formKind,
      viewComponent: v.viewComponent,
      businessKey: inst.businessKey,
      state: inst.state,
      initiator: user(inst.initiatorId),
      startedAt: inst.startedAt.toISOString(),
      endedAt: inst.endedAt?.toISOString() ?? null,
      myTasks: mine.map((t) => {
        const node = nodeOf(t.nodeId)
        return {
          id: t.id,
          nodeId: t.nodeId,
          nodeName: node?.name || t.nodeName,
          type: begin === t.nodeId ? 'begin' : 'review',
          commentRequired: node?.type === 'review' && !!node.commentRequired,
          child: t.parentTaskId !== null,
        }
      }),
      signs: signs.map((t) => ({
        id: t.id,
        parentTaskId: t.parentTaskId!,
        nodeName: nodeName(t.nodeId) || t.nodeName,
        user: user(t.assigneeId),
      })),
      withdrawable: approval
        ? { id: approval.id, nodeName: nodeName(approval.nodeId) || approval.nodeName }
        : null,
      // as WfRoutingService.cancel / urge
      canCancel: initiator && (!!Number(v.allowCancel) || mine.some((t) => t.nodeId === begin)),
      canUrge: initiator && pending.some((t) => t.nodeId !== begin),
      fields: v.form.fields,
      schema,
      formValues: dynamic ? visibleValues(inst.formValues, access) : {},
      access,
      tree: flow?.root ?? null,
      progress: flow && progressOf(flow, v.form.fields, inst, tasks),
      // the diagram shows what the tree does: none without it
      bpmnXml: flow && v.bpmnXml,
      timeline: events.map((e) => ({
        id: e.id,
        action: e.action,
        nodeId: e.nodeId,
        nodeName: nodeName(e.nodeId),
        actor: e.actorId === null ? null : user(e.actorId),
        targets: (e.targetIds ?? []).map((t) =>
          typeof t === 'number' ? user(t) : { id: t, name: nodeName(t) },
        ),
        comment: said(e),
        createdAt: e.createdAt.toISOString(),
      })),
    }
  }

  /**
   * The `wf.attachment` checker (see docs/design-notes.md#storage, #workflow): may the caller download storage object
   * `objectId` bound to instance `id`: `canView`, and a `qw-upload` field the caller may read (not `hide`,
   * `readerAccessOf`) names it in the instance's values — so not a file a step hides from them, nor one the
   * form no longer holds. No dynamic form, or a tree that no longer compiles (no form shown): none.
   */
  async canDownload(id: number, objectId: number): Promise<boolean> {
    if (!(await this.canView(id))) return false
    const { tx } = this.txHost
    const inst = await tx.getRepository(WfInstanceRow).findOneByOrFail({ id })
    const { v, flow } = await this.versionOf(inst)
    if (v.formKind !== 'dynamic' || !flow || !v.form.schema) return false
    const tasks = await tx.getRepository(WfTaskRow).findBy({ instanceId: id })
    const access = await this.readerAccessOf(inst, flow, tasks)
    const shown = v.form.schema.rule.filter((r) => access[r.field] !== 'hide')
    return formUploadIds(shown, inst.formValues).includes(objectId)
  }

  /**
   * The caller's field access on a dynamic form's instance (字段权限, `readerAccess`; see docs/design-notes.md#workflow): the `begin`
   * access for its initiator, the access of each step they hold or held a task on; for whom manual ccs
   * are the only way in, the access of each step whose reviewer cc'd them — a manual cc sees what its sender's
   * step sees. Anyone else (a notify step's cc, `from_user_id` null; a `wf.instance.view` holder) reads every
   * field. `edit` from the step of their pending task.
   */
  private async readerAccessOf(
    inst: WfInstanceRow,
    flow: WfCompiled,
    tasks: readonly WfTaskRow[],
  ): Promise<WfFieldAccess> {
    const me = clsGet('principal')!.userId
    const accessOf = (nodeId: string | null): WfFieldAccess | undefined => {
      const node = nodeId ? flow.nodes.get(nodeId)?.node : undefined
      return node?.type === 'begin' || node?.type === 'review' ? node.access : undefined
    }
    const held = [
      ...(inst.initiatorId === me ? [flow.root.access] : []),
      ...tasks
        .filter((t) => t.assigneeId === me || t.ownerId === me)
        .map((t) => accessOf(t.nodeId)),
    ]
    const ccs = held.length
      ? []
      : await this.txHost.tx.getRepository(WfCcRow).find({
          select: { nodeId: true, fromUserId: true },
          where: { instanceId: inst.id, userId: me },
        })
    // manual ccs only for whom they are the one way in (no notify cc, not an instance viewer)
    const manual =
      ccs.length && ccs.every((c) => c.fromUserId !== null) && !(await this.viewerOf(inst.id))
        ? ccs.map((c) => accessOf(c.nodeId))
        : []
    const pending = tasks.find((t) => t.state === 'pending' && t.assigneeId === me)
    return readerAccess([...held, ...manual], pending && accessOf(pending.nodeId))
  }

  /** The instance's version with its model's settings; `flow` null when its tree no longer compiles. */
  private async versionOf(
    inst: WfInstanceRow,
  ): Promise<{ v: VersionModel; flow: WfCompiled | null }> {
    const [v] = await this.txHost.tx.query<VersionModel[]>(
      // qw:include-deleted a model or version deleted since keeps its name for the instances it started
      `SELECT m.name, m.form_kind AS formKind, m.view_component AS viewComponent,
              v.tree_json AS tree, v.bpmn_xml AS bpmnXml, v.form_snapshot AS form,
              m.deleted_at IS NULL AND m.allow_cancel AS allowCancel,
              m.deleted_at IS NULL AND m.allow_withdraw AS allowWithdraw
         FROM wf_version v JOIN wf_model m ON m.id = v.model_id
        WHERE v.id = ?`,
      [inst.versionId],
    )
    if (!v) throw new Error(`wf_instance ${inst.id}: version ${inst.versionId} has no model`)
    const compiled = compile(v.tree, v.form.fields)
    if (!compiled.ok)
      this.logger.warn(
        { versionId: inst.versionId, instanceId: inst.id },
        'version tree does not compile',
      )
    return { v, flow: compiled.ok ? compiled.flow : null }
  }

  /** The title builder of this request: seeded model names translated, the start date in its time zone. */
  async titler(): Promise<WfTitler> {
    const lang = currentLocale()
    const tz = await currentTimezone(this.params)
    return (modelName, initiator, startedAt) => {
      const model = modelName.startsWith('seed.')
        ? String(this.i18n.translate(modelName, { lang }))
        : modelName
      return `${model}-${initiator ?? ''}-${formatInZone(startedAt, tz).slice(0, 10)}`
    }
  }

  /** display names by id; a deleted user keeps theirs on the instances they took part in */
  async userNames(ids: number[]): Promise<Map<number, string>> {
    if (!ids.length) return new Map()
    const rows = await this.txHost.tx.query<{ id: number; display_name: string }[]>(
      // qw:include-deleted a deleted user's name stays on the timeline
      'SELECT id, display_name FROM iam_user WHERE id IN (?)',
      [[...new Set(ids)]],
    )
    return new Map(rows.map((r) => [Number(r.id), r.display_name]))
  }

  /** model names by version id (the lists' titles); a deleted model keeps its name */
  async modelNames(versionIds: number[]): Promise<Map<number, string>> {
    if (!versionIds.length) return new Map()
    const rows = await this.txHost.tx.query<{ id: number; name: string }[]>(
      // qw:include-deleted a model or version deleted since keeps its name for the instances it started
      'SELECT v.id, m.name FROM wf_version v JOIN wf_model m ON m.id = v.model_id WHERE v.id IN (?)',
      [[...new Set(versionIds)]],
    )
    return new Map(rows.map((r) => [Number(r.id), r.name]))
  }
}

interface VersionModel {
  name: string
  formKind: WfFormKind
  viewComponent: string | null
  tree: unknown
  /** a BPMN model's version */
  bpmnXml: string | null
  form: { fields: WfFields; schema?: FormSchema }
  /** 0 / 1 (a deleted model allows neither) */
  allowCancel: number | string
  allowWithdraw: number | string
}
