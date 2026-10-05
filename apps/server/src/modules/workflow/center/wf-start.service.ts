import { Inject, Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  applyFormCalc,
  compile,
  Err,
  formUploadIds,
  formValuesSchema,
  type OrgDirectory,
  type WfCompiled,
  type WfInitiatorCtx,
  type WfInitiatorScope,
  type WfStartableVo,
  wfStartableVo,
  type WfStartBody,
  type WfStartInfoVo,
} from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import { IsNull, Not } from 'typeorm'
import type { z } from 'zod'
import { BizError } from '../../../core/http/biz-error.js'
import { ValidationException } from '../../../core/http/validation.pipe.js'
import { currentLocale } from '../../../core/i18n/locale.js'
import { DictService } from '../../../core/settings/dict.service.js'
import { StorageService } from '../../platform/storage/storage.service.js'
import {
  checkInitiatorPicks,
  dictValuesOf,
  pickNodes,
  type WfPicksError,
} from '../engine/form-values.js'
import { WfModel, WfVersion } from '../model/wf-model.entity.js'
import { WfHandlers } from '../runtime/wf-handlers.js'
import { type WfApplied, WF_ORG, WfStore } from '../runtime/wf-store.js'

/** Who starts: the org chart's answers about the caller, read once per call. */
interface Initiator {
  id: number
  deptId: number | null
  ctx: WfInitiatorCtx
}

/** null = everyone; else a listed user, a member of a listed dept or of one below it, or a listed role. */
function inScope(scope: WfInitiatorScope | null, who: Initiator): boolean {
  if (!scope) return true
  const depts = who.ctx.deptTreePath?.split('/').filter(Boolean).map(Number) ?? []
  return (
    scope.userIds.includes(who.id) ||
    depts.some((d) => scope.deptIds.includes(d)) ||
    who.ctx.roleIds.some((r) => scope.roleIds.includes(r))
  )
}

/** A 400 of the request body (`field.wf.instance.*` labels). */
function badBody(issues: z.core.$ZodIssue[]) {
  const e = new ValidationException(issues)
  e.domain = 'wf.instance'
  return e
}

const issue = (path: PropertyKey[], message: string, params?: Record<string, string>) =>
  ({ code: 'custom', path, message, params, input: undefined }) as z.core.$ZodIssue

/**
 * Starting a process (发起; see docs/design-notes.md#workflow), reusable inside a caller's transaction (the OA leave sample saves
 * its business row and starts in one). A model the caller may not start (unknown, disabled, never published,
 * outside its initiator scope) is 404.
 */
@Injectable()
export class WfStartService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly handlers: WfHandlers,
    private readonly store: WfStore,
    private readonly i18n: I18nService,
    @Inject(WF_ORG) private readonly org: OrgDirectory,
    private readonly storage: StorageService,
    private readonly dicts: DictService,
  ) {}

  /** GET startable-models: what `startable` lets `userId` start, in sort order. */
  async list(userId: number): Promise<WfStartableVo[]> {
    const who = await this.initiator(userId)
    const models = await this.txHost.tx.getRepository(WfModel).find({
      select: {
        modelKey: true,
        name: true,
        category: true,
        icon: true,
        description: true,
        formKind: true,
        createRoute: true,
        initiatorScope: true,
      },
      where: { enabled: true, currentVersionId: Not(IsNull()) },
      order: { sortNo: 'ASC', id: 'ASC' },
    })
    // the parse drops initiatorScope
    return models.filter((m) => inScope(m.initiatorScope, who)).map((m) => wfStartableVo.parse(m))
  }

  /** GET start-info: the current version's form and its steps whose users the initiator picks. */
  async info(modelKey: string, userId: number): Promise<WfStartInfoVo> {
    const { version, flow } = await this.startable(modelKey, await this.initiator(userId))
    return {
      schema: version.formSnapshot.schema ?? null,
      picks: pickNodes(flow).map(({ id, name, type }) => ({ id, name, type })),
    }
  }

  /**
   * Scope → form values (dynamic: the client's, checked against the version's form (`formValuesSchema`:
   * types, options, ranges, required), calc results recomputed; custom: the client's
   * are ignored, the handler locks and checks the business row, then reads them from it) → `initiatorPicks`
   * (missing / not enabled users → 400) → the instance, its initiator context and its first tasks → a
   * dynamic form's attachments bound to it (`biz_ref = 'wf:<id>'`, anything but the initiator's own
   * unbound `wf.attachment` uploads → 400 C1009, nothing started). One transaction, the caller's when there
   * is one.
   */
  start(initiatorId: number, body: WfStartBody): Promise<WfApplied> {
    return this.txHost.withTransaction(async () => {
      const who = await this.initiator(initiatorId)
      const { model, version, flow } = await this.startable(body.modelKey, who)
      let businessKey: string | null = null
      let formValues: Record<string, unknown>
      let files: number[] = []
      if (model.formKind === 'custom') {
        const handler = this.handlers.get(model.modelKey)
        if (!handler) throw new BizError(Err.WF_HANDLER_MISSING, { modelKey: model.modelKey })
        if (!body.businessKey) throw badBody([issue(['businessKey'], 'validation.required')])
        businessKey = body.businessKey
        await handler.assertStartable(businessKey, who.id, this.txHost.tx)
        formValues = await handler.loadFormValues(businessKey, this.txHost.tx)
      } else {
        const { fields, schema } = version.formSnapshot
        const dicts = await dictValuesOf(schema?.rule ?? [], (code) => this.dicts.entries(code))
        const r = formValuesSchema(fields, schema, dicts).safeParse(body.formValues)
        if (!r.success)
          throw badBody(r.error.issues.map((i) => ({ ...i, path: ['formValues', ...i.path] })))
        // the calc components' results: recomputed from the inputs, the client's numbers dropped
        formValues = applyFormCalc(schema, r.data)
        files = formUploadIds(schema?.rule ?? [], formValues)
      }
      const picks = await checkInitiatorPicks(flow, body.initiatorPicks, this.org)
      if (!picks.ok) throw this.badPicks(flow, picks.errors)
      const applied = await this.store.start({
        versionId: version.id,
        initiatorId: who.id,
        initiatorDeptId: who.deptId,
        businessKey,
        formValues,
        initiatorPicks: picks.picks,
        initiatorCtx: who.ctx,
      })
      const ref = `wf:${applied.inst.id}`
      await this.storage.bindRefs(files, 'wf.attachment', ref, who.id, this.txHost.tx)
      return applied
    })
  }

  private async initiator(id: number): Promise<Initiator> {
    const ctx = await this.org.initiatorCtx(id)
    // a dept's tree_path ends with its own id (`/1/4/` → 4): the same read as `org.deptOfUser`
    const deptId = Number(ctx.deptTreePath?.split('/').filter(Boolean).at(-1)) || null
    return { id, deptId, ctx }
  }

  /** The model and its current version, compiled; 404 unless `who` may start it. */
  private async startable(modelKey: string, who: Initiator) {
    const { tx } = this.txHost
    const model = await tx.getRepository(WfModel).findOneBy({ modelKey, enabled: true })
    if (!model?.currentVersionId || !inScope(model.initiatorScope, who))
      throw new BizError(Err.NOT_FOUND)
    const version = await tx
      .getRepository(WfVersion)
      .findOneByOrFail({ id: model.currentVersionId })
    const r = compile(version.treeJson, version.formSnapshot.fields)
    // published versions passed `compile`; one that no longer does is a server bug (500)
    if (!r.ok) throw new Error(`wf_version ${version.id} does not compile: ${r.errors[0]!.code}`)
    return { model, version, flow: r.flow }
  }

  /** `initiatorPicks.<step id>` issues naming the step (a seeded name translated). */
  private badPicks(flow: WfCompiled, errors: WfPicksError[]) {
    const lang = currentLocale()
    const name = (id: string) => {
      const text = flow.nodes.get(id)!.node.name
      return text.startsWith('seed.') ? String(this.i18n.translate(text, { lang })) : text
    }
    return badBody(
      errors.map((e) =>
        issue(['initiatorPicks', e.nodeId], `validation.wf.picks_${e.code}`, {
          node: name(e.nodeId),
        }),
      ),
    )
  }
}
