import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  compile,
  Err,
  fieldsFromFormSchema,
  type Page,
  type WfBeginNode,
  type WfCompileError,
  type WfDraftBody,
  type WfFields,
  type WfFormSnapshot,
  wfFormSchemaJson,
  type WfModelDetailVo,
  type WfModelQuery,
  type WfModelSortBody,
  type WfPublishBody,
  type WfVersionDetailVo,
  wfPerms,
} from '@qiwu/shared'
import type { DeepPartial, QueryDeepPartialEntity, SelectQueryBuilder } from 'typeorm'
import type { z } from 'zod'
import { clsGet } from '../../../core/context/cls.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { contains, paginate } from '../../../core/db/page.js'
import { BizError } from '../../../core/http/biz-error.js'
import { ValidationException } from '../../../core/http/validation.pipe.js'
import { seedKeysLike } from '../../../core/i18n/seed-names.js'
import { WfForm } from '../form/wf-form.entity.js'
import { WfHandlers } from '../runtime/wf-handlers.js'
import { invalidXml, parseBpmn, readBpmn } from './wf-bpmn.js'
import { WfModel, WfVersion } from './wf-model.entity.js'

/** Compile errors as the 400 of the request body's `tree` (`validation.wf.<code>`, param `node`). */
function invalidTree(errors: WfCompileError[]): ValidationException {
  const e = new ValidationException(
    errors.map(
      (err) =>
        ({
          code: 'custom',
          path: ['tree', ...err.path],
          message: err.message?.key ?? `validation.wf.${err.code}`,
          params: { ...err.message?.params, node: err.id ?? '' },
          input: undefined,
        }) as z.core.$ZodIssue,
    ),
  )
  e.domain = 'wf.model'
  return e
}

/**
 * A draft or publish body sending what the model's flow kind does not draw: a tree model's
 * `xml`, a BPMN model's `tree` — refused (400 at it), never ignored.
 */
function notThisKind(field: 'tree' | 'xml'): ValidationException {
  const issue = { code: 'custom', path: [field], message: 'validation.invalid', input: undefined }
  const e = new ValidationException([issue as z.core.$ZodIssue])
  e.domain = 'wf.model'
  return e
}

/**
 * Process models (see docs/design-notes.md#workflow) over BaseCrudService (not data-scoped: `wfPerms` guard the admin pages).
 * `model_key` is unique among live models (DB, 409 `duplicate`); a published model cannot be deleted (409
 * `in_use`, wf-model.entity.ts). Publishing compiles the tree against the form's fields and appends a
 * `wf_version` under the model's row lock.
 */
@Injectable()
export class WfModelService extends BaseCrudService<WfModel> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly handlers: WfHandlers,
  ) {
    super(txHost, WfModel)
  }

  protected override filter(
    qb: SelectQueryBuilder<WfModel>,
    { modelKey, name, category, enabled }: WfModelQuery,
  ): SelectQueryBuilder<WfModel> {
    if (modelKey) qb.andWhere('t.modelKey LIKE :modelKey', { modelKey: contains(modelKey) })
    if (name) {
      // seeded names are keys (seed.wf.*): also match the text users see, in any language
      const seeded = seedKeysLike('seed.wf.', name)
      qb.andWhere(
        seeded.length ? '(t.name LIKE :name OR t.name IN (:...seeded))' : 't.name LIKE :name',
        { name: contains(name), seeded },
      )
    }
    if (category) qb.andWhere('t.category = :category', { category })
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    return qb
  }

  /**
   * Process managers see every field of the approval data, so appointing them is its own perm:
   * a create or update whose `managerUserIds` differ from the stored ones (none on a create; order and repeats
   * aside) needs `wf.model.managers`, else 403 — `wf.model.modify` alone cannot add its holder.
   */
  private assertManagers(next: number[] | undefined, stored: number[] | null): void {
    if (next === undefined) return
    const was = new Set(stored ?? [])
    const now = new Set(next)
    if (now.size === was.size && [...now].every((id) => was.has(id))) return
    const p = clsGet('principal')
    if (!p?.root && !p?.perms.includes(wfPerms.model.managers)) throw new ForbiddenException()
  }

  override create(dto: DeepPartial<WfModel>): Promise<WfModel> {
    this.assertManagers(dto.managerUserIds as number[] | undefined, null)
    return super.create(dto)
  }

  override async update(id: number, dto: QueryDeepPartialEntity<WfModel>): Promise<void> {
    if (dto.managerUserIds !== undefined)
      this.assertManagers(dto.managerUserIds as number[], (await this.get(id)).managerUserIds)
    return super.update(id, dto)
  }

  /** A page of models without their drafts (those come with the detail only). */
  list(query: WfModelQuery): Promise<Page<WfModel>> {
    const columns = this.repo.metadata.columns
      .filter((c) => c.propertyName !== 'draftJson' && c.propertyName !== 'draftXml')
      .map((c) => `t.${c.propertyName}`)
    return paginate(this.filter(this.scopedQb('t').select(columns), query), query)
  }

  /** + the fields the designer builds conditions from: a custom model's handler's, a dynamic one's form's. */
  async detail(id: number): Promise<WfModelDetailVo> {
    const model = await this.get(id)
    let fields: WfFields | null = null
    if (model.formKind === 'custom') fields = this.handlers.get(model.modelKey)?.fields() ?? null
    else if (model.formId) {
      const form = await this.txHost.tx.getRepository(WfForm).findOneBy({ id: model.formId })
      const r = form && fieldsFromFormSchema(form.schemaJson)
      if (r?.ok) fields = r.fields
    }
    return { ...model, fields } as unknown as WfModelDetailVo
  }

  async sort({ items }: WfModelSortBody): Promise<void> {
    await this.txHost.withTransaction(async () => {
      await this.lockScopedIds(items.map((i) => i.id))
      for (const { id, sortNo } of items) await this.repo.update(id, { sortNo })
    })
  }

  /**
   * A tree model's tree (any tree-shaped object) or a BPMN model's XML (size, DOCTYPE and strict parse only:
   * a diagram may be half drawn), saved as sent; both are compiled on publish.
   */
  async saveDraft(id: number, body: WfDraftBody): Promise<void> {
    const { flowKind } = await this.get(id)
    if ('xml' in body) {
      if (flowKind !== 'bpmn') throw notThisKind('xml')
      await readBpmn(body.xml)
      return this.update(id, { draftXml: body.xml })
    }
    if (flowKind === 'bpmn') throw notThisKind('tree')
    const { tree } = body
    // MySQL refuses a JSON value nested deeper than 100 (500): the size check of compile, alone
    const r = compile(tree, {})
    if (!r.ok && r.errors[0]?.code === 'too_large') throw invalidTree(r.errors)
    await this.update(id, { draftJson: tree })
  }

  /** Newest first, without the trees. Unpaged, a model has few versions. */
  async versions(id: number): Promise<WfVersion[]> {
    await this.get(id)
    return this.txHost.tx.getRepository(WfVersion).find({
      select: { id: true, version: true, formSnapshot: true, publishedBy: true, publishedAt: true },
      where: { modelId: id },
      order: { version: 'DESC' },
    })
  }

  /** One version with its tree (the JSON export) and BPMN XML; a version of another model → 404. */
  async version(id: number, versionId: number): Promise<WfVersionDetailVo> {
    const row = await this.txHost.tx
      .getRepository(WfVersion)
      .findOneBy({ id: versionId, modelId: id })
    if (!row) throw new NotFoundException()
    const { id: vid, version, formSnapshot, publishedBy, publishedAt, treeJson, bpmnXml } = row
    // publishedAt: a Date, serialized as the ISO string the VO names
    const vo = { id: vid, version, formSnapshot, publishedBy, publishedAt, tree: treeJson, bpmnXml }
    return vo as unknown as WfVersionDetailVo
  }

  /**
   * A tree model: `tree` (or the saved draft) → compile against the form's fields. A BPMN model:
   * `xml` (or the saved draft; neither → 400 `bpmn_parse`) → `parseBpmn`, the tree derived from the XML, which
   * is stored normalized as the version's and the draft (`draft_json` stays null). → version max + 1, now the
   * model's current one. The model row lock serializes concurrent publishes of one model.
   */
  publish(id: number, { tree, xml, fields }: WfPublishBody): Promise<WfVersion> {
    return this.txHost.withTransaction(async () => {
      const model = await this.repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
      if (!model) throw new NotFoundException()
      const bpmn = model.flowKind === 'bpmn'
      if (bpmn ? tree !== undefined : xml !== undefined) throw notThisKind(bpmn ? 'tree' : 'xml')
      const formSnapshot = await this.formOf(model, fields)
      let root: WfBeginNode
      let bpmnXml: string | null = null
      if (bpmn) {
        const source = xml ?? model.draftXml
        if (!source) throw invalidXml([{ code: 'bpmn_parse', id: null }])
        const parsed = await parseBpmn(source, formSnapshot.fields)
        root = parsed.tree
        bpmnXml = parsed.xml
      } else {
        const r = compile(tree ?? model.draftJson, formSnapshot.fields)
        if (!r.ok) throw invalidTree(r.errors)
        root = r.flow.root
      }
      const versions = this.txHost.tx.getRepository(WfVersion)
      const last = await versions.maximum('version', { modelId: id })
      const row = await versions.save(
        versions.create({
          modelId: id,
          modelKey: model.modelKey,
          version: (last ?? 0) + 1,
          treeJson: root,
          bpmnXml,
          formSnapshot,
          publishedBy: clsGet('principal')?.userId ?? null,
        }),
      )
      await this.repo.update(id, {
        currentVersionId: row.id,
        ...(bpmnXml === null ? { draftJson: root } : { draftXml: bpmnXml }),
      })
      return row
    })
  }

  /**
   * What the version runs on. custom: the business handler's fields (none registered → 422). dynamic with a
   * form: the form's schema, sanitized again (the rules may have tightened since it was saved; 400 at
   * `formId`), and its fields. dynamic without one: the body's fields (synthetic snapshot).
   */
  private async formOf(model: WfModel, sent: WfFields | undefined): Promise<WfFormSnapshot> {
    if (model.formKind === 'custom') {
      const handler = this.handlers.get(model.modelKey)
      if (!handler) throw new BizError(Err.WF_HANDLER_MISSING, { modelKey: model.modelKey })
      return { fields: handler.fields() }
    }
    if (!model.formId) return { fields: sent ?? {} }
    const form = await this.txHost.tx.getRepository(WfForm).findOneBy({ id: model.formId })
    if (!form) throw new NotFoundException()
    const s = wfFormSchemaJson.safeParse(form.schemaJson)
    if (!s.success) {
      const e = new ValidationException(
        s.error.issues.map((i) => ({ ...i, path: ['formId', ...i.path] })),
      )
      e.domain = 'wf.model'
      throw e
    }
    const f = fieldsFromFormSchema(s.data)
    // a sanitized schema's field names are unique and valid fields: a failure here is a server bug (500)
    if (!f.ok) throw new Error(`wf_form ${form.id}: no fields (${f.errors[0]!.code})`)
    return { fields: f.fields, schema: s.data }
  }
}
