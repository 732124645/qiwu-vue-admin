import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  agentPerms,
  applyFormCalc,
  compile,
  Err,
  formUploadIds,
  formValuesSchema,
  leavePerms,
  oaTripPerms,
  oaExpensePerms,
  oaSealPerms,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { In } from 'typeorm'
import { USER_LOOKUP } from '../../../core/auth/user-lookup.js'
import { factsOf } from '../../../core/agent/automation/pre-approval.js'
import { McpToolSwitch } from '../../../core/mcp/mcp.entity.js'
import { IamUserLookup } from '../../platform/iam/iam-user-lookup.js'
import { reviewersOf } from '../../workflow/engine/advance.js'
import { clsGet } from '../../../core/context/cls.js'
import { tenantId } from '../../../core/context/tenant.js'
import { canonicalJson } from '../../../core/guard/idempotent.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { currentLocale } from '../../../core/i18n/locale.js'
import type { ToolExecutionContext } from '../../../core/mcp/mcp-tool.js'
import type { ToolPreview } from '../../../core/mcp/tool-host.js'
import { StorageService } from '../../platform/storage/storage.service.js'
import { FsObject } from '../../platform/storage/fs-object.entity.js'
import { WfStartService } from '../../workflow/center/wf-start.service.js'
import { checkInitiatorPicks, dictValuesOf } from '../../workflow/engine/form-values.js'
import { resolveAssignees } from '../../workflow/engine/wf-assignee.js'
import { WfModel, WfVersion } from '../../workflow/model/wf-model.entity.js'
import { typeormOrg } from '../../workflow/typeorm-org.js'
import { sumExpenseAmounts } from '../expense/expense-money.js'
import { TripService } from '../trip/trip.service.js'

export type ApplicationKind = 'leave' | 'trip' | 'expense' | 'seal' | 'generic'
const PERMS = {
  leave: leavePerms.create,
  trip: oaTripPerms.create,
  expense: oaExpensePerms.create,
  seal: oaSealPerms.create,
  generic: null,
}
const MODELS = {
  leave: 'leave',
  trip: 'oa-trip',
  expense: 'oa-expense',
  seal: 'oa-seal',
  generic: 'oa-generic',
}
type Values = Record<string, unknown>

/** 预览和提交使用同一事实构造器，业务写入前在外层事务中锁定后复核。 */
@Injectable()
export class OaApplicationPreview {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly starts: WfStartService,
    private readonly storage: StorageService,
    private readonly trips: TripService,
    private readonly i18n: I18nService,
    @Inject(USER_LOOKUP) private readonly lookup: IamUserLookup,
  ) {}

  /** 初次展示也复用同一校验；附件及自由文本只作为值返回，不作为指令执行。 */
  preview(kind: ApplicationKind, args: Values): Promise<ToolPreview> {
    return this.txHost.withTransaction(() => this.build(kind, args))
  }

  /** 凭证来自宿主；锁一直持有到既有提交服务提交或回滚，消除复核后的竞态窗口。 */
  execute<T>(
    kind: ApplicationKind,
    args: Values,
    context: ToolExecutionContext | undefined,
    write: () => Promise<T>,
  ): Promise<T> {
    if (!context?.confirmation) throw new BizError(Err.FORBIDDEN)
    return this.txHost.withTransaction(async () => {
      let current: ToolPreview
      try {
        current = await this.build(kind, args)
      } catch {
        throw new BizError(Err.CONFLICT)
      }
      if (
        canonicalJson(args) !== canonicalJson(context.confirmation!.args) ||
        canonicalJson(current) !== canonicalJson(context.confirmation!.preview)
      )
        throw new BizError(Err.CONFLICT)
      return write()
    })
  }

  /** 所有事实均为当前读；模型先锁，后续普通业务读取才能在同一发布版本上建立快照。 */
  private async build(kind: ApplicationKind, args: Values): Promise<ToolPreview> {
    const tx = this.txHost.tx
    const me = clsGet('principal')!
    const model = await tx.getRepository(WfModel).findOne({
      where: { modelKey: MODELS[kind], enabled: true },
      lock: { mode: 'pessimistic_read' },
    })
    if (!model?.currentVersionId || (model.formKind === 'dynamic') !== (kind === 'generic'))
      throw new BizError(Err.NOT_FOUND)
    const version = await tx.getRepository(WfVersion).findOne({
      where: { id: model.currentVersionId, modelId: model.id },
      lock: { mode: 'pessimistic_read' },
    })
    if (!version) throw new BizError(Err.NOT_FOUND)
    const org = typeormOrg({
      // arch-allow: sql-concat adds only a constant lock clause to the org adapter's checked SQL; tenant: adapter supplies tenant predicates and parameters
      query: (sql: string, params?: unknown[]) => tx.query(`${sql} FOR SHARE`, params),
    })
    const people = async (ids: number[]) => {
      if (!ids.length) return []
      return tx.query<{ id: number; display_name: string; dept_id: number | null }[]>(
        // qw:no-data-scope workflow resolves enabled people across the tenant's organization, exposing only picker identity
        `SELECT id, display_name, dept_id FROM iam_user
         WHERE tenant_id = ? AND id IN (?) AND enabled = 1 AND deleted_at IS NULL ORDER BY id FOR SHARE`,
        [tenantId(), ids],
      )
    }
    const [actor] = await people([me.userId])
    if (!actor || actor.dept_id !== me.deptId) throw new BizError(Err.CONFLICT)
    const actorCtx = await org.initiatorCtx(me.userId)
    const compiled = compile(version.treeJson, version.formSnapshot.fields)
    if (!compiled.ok) throw new BizError(Err.CONFLICT)
    let values: Values = { ...args }
    delete values.initiatorPicks
    let routing: Values = values
    let fileIds = (args.attachmentIds ?? []) as number[]
    if (kind === 'generic') {
      const supplied = args.formValues as Values
      // 发起人隐藏字段不能传给模型、预览或写入；其余字段按发布表单完整校验。
      if (Object.keys(supplied).some((field) => version.treeJson.access?.[field] === 'hide'))
        throw new BizError(Err.VALIDATION_FAILED)
      const { fields, schema } = version.formSnapshot
      const dicts = await dictValuesOf(schema?.rule ?? [], async (code) => {
        const [dict] = await tx.query<{ enabled: number }[]>(
          'SELECT enabled FROM cfg_dict WHERE code = ? AND deleted_at IS NULL FOR SHARE',
          [code],
        )
        if (!dict?.enabled) return null
        const entries = await tx.query<{ value: string }[]>(
          'SELECT value FROM cfg_dict_entry WHERE dict_code = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY sort_no, id FOR SHARE',
          [code],
        )
        return { entries }
      })
      values = applyFormCalc(schema, parseOr400(formValuesSchema(fields, schema, dicts), supplied))
      if (Object.keys(values).some((field) => version.treeJson.access?.[field] === 'hide'))
        throw new BizError(Err.VALIDATION_FAILED)
      routing = values
      fileIds = formUploadIds(schema?.rule ?? [], values)
    }
    if (kind === 'expense') {
      const items = args.items as { amount: string; attachmentIds?: number[]; id?: number }[]
      if (items.some((item) => item.id !== undefined)) throw new BizError(Err.VALIDATION_FAILED)
      values.totalAmount = sumExpenseAmounts(items.map((item) => item.amount))
      values.currency = 'CNY'
      routing = { reason: args.reason, totalAmount: Number(values.totalAmount) }
      fileIds = [...fileIds, ...items.flatMap((item) => item.attachmentIds ?? [])]
      if (args.tripId != null) {
        const trip = await this.trips.assertExpenseReference(args.tripId as number, me.userId, tx)
        values.trip = {
          id: trip.id,
          destination: trip.destination,
          startAt: trip.startAt.toISOString(),
          endAt: trip.endAt.toISOString(),
          state: trip.state,
        }
      }
    }
    const picks = await checkInitiatorPicks(
      compiled.flow,
      args.initiatorPicks as Record<string, number[]> | undefined,
      org,
    )
    if (!picks.ok) throw new BizError(Err.VALIDATION_FAILED)
    const reviewers: Values[] = []
    for (const { node } of compiled.flow.nodes.values()) {
      if (node.type !== 'review' && node.type !== 'notify') continue
      const inst = { initiatorId: me.userId, formValues: routing, initiatorPicks: picks.picks }
      const ids =
        node.type === 'review'
          ? await reviewersOf({ org, managerIds: model.managerUserIds ?? [] }, inst, node)
          : await resolveAssignees(
              node,
              { initiatorId: me.userId, formValues: routing, initiatorPicks: picks.picks },
              org,
            )
      reviewers.push({
        nodeId: node.id,
        name: this.text(node.name),
        kind: node.type,
        routing: 'possibleStep',
        userIds: ids,
        people: await people(ids),
      })
    }
    // 管理员兜底同样纳入确认快照，审批人失效不得悄悄换成另一人。
    const managers = await people(model.managerUserIds ?? [])
    const ids = [...new Set(fileIds)].sort((a, b) => a - b)
    if (ids.length > 10) throw new BizError(Err.VALIDATION_FAILED)
    // 与附件绑定路径同用写锁，避免共享锁升级造成并发重复绑定的死锁。
    const files = ids.length
      ? await tx.getRepository(FsObject).find({
          where: { id: In(ids) },
          order: { id: 'ASC' },
          lock: { mode: 'pessimistic_write' },
        })
      : []
    if (
      files.length !== ids.length ||
      files.some(
        (file) =>
          file.uploaderId !== me.userId ||
          file.bizRef !== null ||
          file.bizTag !== (kind === 'generic' ? 'wf.attachment' : 'oa.attachment'),
      )
    )
      throw new BizError(Err.VALIDATION_FAILED)
    for (const file of files) await this.storage.assertAttachment(file)
    // 授权与套餐也必须在业务事务中当前读并持锁，不能沿用 receipt 消费前的 principal。
    const current = await this.lookup.load(me.userId, {
      // arch-allow: sql-concat locks the identity loader's checked, parameterized queries; tenant: the loader derives and restricts the actor's tenant
      query: (sql: string, params?: unknown[]) => tx.query(`${sql} FOR SHARE`, params),
    })
    const perm = PERMS[kind]
    if (
      !current ||
      current.tenantId !== tenantId() ||
      (!current.root && !current.perms.includes(agentPerms.chat.use)) ||
      (!current.root && perm !== null && !current.perms.includes(perm)) ||
      (current.features !== undefined && !current.features.includes('workflow'))
    )
      throw new BizError(Err.FORBIDDEN)
    const toolSwitch = await tx.getRepository(McpToolSwitch).findOne({
      where: { name: `oa.${kind}.apply` },
      lock: { mode: 'pessimistic_read' },
    })
    if (toolSwitch && (!toolSwitch.enabled || toolSwitch.agentPolicy === 'deny'))
      throw new BizError(Err.FORBIDDEN)
    // 到这里前所有查询均为 current read。此时才让原服务建立普通 RR 快照，
    // 后续引擎的普通组织查询与已锁定事实一致，不能先读旧快照再比较新的人员。
    await this.starts.info(model.modelKey, me.userId)
    const fields: ToolPreview['fields'] = []
    const add = (label: string, value: unknown) =>
      fields.push({ field: this.text(`oa.agent.preview.${label}`), from: null, to: value })
    add('model', {
      key: model.modelKey,
      name: this.text(model.name),
      versionId: version.id,
      version: version.version,
      fingerprint: createHash('sha256')
        .update(
          canonicalJson({
            tree: version.treeJson,
            form: version.formSnapshot,
            scope: model.initiatorScope,
            managers: model.managerUserIds,
            allowCancel: model.allowCancel,
            allowWithdraw: model.allowWithdraw,
          }),
        )
        .digest('hex'),
    })
    add('applicant', {
      id: me.userId,
      name: this.text(actor.display_name),
      deptId: actor.dept_id,
      organization: actorCtx,
      authorization: createHash('sha256')
        .update(
          canonicalJson({
            tool: factsOf(current, perm, 'workflow'),
            chat: factsOf(current, agentPerms.chat.use, 'workflow'),
            expiresAt: current.tenantExpAt,
            switch: toolSwitch
              ? {
                  enabled: toolSwitch.enabled,
                  policy: toolSwitch.agentPolicy,
                  updatedAt: toolSwitch.updatedAt,
                }
              : null,
          }),
        )
        .digest('hex'),
    })
    add('values', values)
    add('reviewers', { picks: picks.picks, steps: reviewers, managers })
    add(
      'attachments',
      files.map((file) => ({
        id: file.id,
        name: file.originalName,
        size: file.size,
        mime: file.mime,
        sha256: file.sha256,
        fingerprint: createHash('sha256')
          .update(
            canonicalJson({
              storageId: file.storageId,
              objectKey: file.objectKey,
              isPublic: file.isPublic,
              uploaderId: file.uploaderId,
              bizTag: file.bizTag,
              bizRef: file.bizRef,
            }),
          )
          .digest('hex'),
      })),
    )
    return { target: this.text(`oa.agent.kind.${kind}`), fields }
  }

  /** 只有预置键才翻译，用户文本保留原值。 */
  private text(value: string): string {
    return value.startsWith('seed.') || value.startsWith('oa.agent.')
      ? String(this.i18n.translate(value, { lang: currentLocale() }))
      : value
  }
}
