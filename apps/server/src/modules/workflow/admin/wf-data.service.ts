import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  compile,
  Err,
  fieldConditionError,
  WF_CONDITION_KEY,
  type WfDataColumn,
  type WfDataFilter,
  type WfDataPageVo,
  type WfDataQuery,
  type WfDataRowVo,
  type WfFields,
  type WfFieldType,
} from '@qiwu/shared'
import type { z } from 'zod'
import { clsGet } from '../../../core/context/cls.js'
import { EXPORT_BATCH } from '../../../core/db/base-crud.service.js'
import { exportBatches, sorted } from '../../../core/db/page.js'
import type { ExcelColumn } from '../../../core/excel/excel.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { ValidationException } from '../../../core/http/validation.pipe.js'
import { currentLocale } from '../../../core/i18n/locale.js'
import { readerAccess } from '../engine/form-values.js'
import { WfModel, WfVersion } from '../model/wf-model.entity.js'
import { WfInstanceRow } from '../runtime/wf-runtime.entity.js'
import { instanceView, scopedInstances } from './wf-admin.service.js'

/** form-create's locale of each of ours (the `option.language` keys the designer writes) */
const FORM_LOCALE = { 'zh-CN': 'zh-cn', 'en-US': 'en' } as const
const TEXT_ID = /\{\{\s*\$t\.([A-Za-z][\w-]*)\s*\}\}/g

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0

/**
 * Field → title of a form-create schema in document order (as `fieldsFromFormSchema` walks it): a rule's
 * `title`, a detail table's column total its column's `label`; `{{$t.<id>}}` texts from `option.language`.
 */
function fieldTitles(schema: unknown, lang: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!isObject(schema) || !Array.isArray(schema.rule)) return out
  const language = isObject(schema.option) ? schema.option.language : undefined
  const texts = isObject(language) && isObject(language[lang]) ? language[lang] : {}
  const text = (v: unknown) =>
    typeof v === 'string'
      ? v.replace(TEXT_ID, (_, id: string) => {
          const t = Object.hasOwn(texts, id) ? texts[id] : undefined
          return typeof t === 'string' ? t : id
        })
      : ''
  const set = (field: unknown, title: unknown) => {
    if (typeof field === 'string' && field !== '' && !out.has(field)) out.set(field, text(title))
  }
  const stack: unknown[] = [...schema.rule].reverse()
  while (stack.length > 0) {
    const rule = stack.pop()
    if (!isObject(rule)) continue
    if (Array.isArray(rule.children))
      for (let i = rule.children.length - 1; i >= 0; i--) stack.push(rule.children[i])
    set(rule.field, rule.title)
    if (
      rule.type === 'qw-detail-table' &&
      isObject(rule.props) &&
      Array.isArray(rule.props.columns)
    )
      for (const c of rule.props.columns) if (isObject(c)) set(c.sum, c.label)
  }
  return out
}

/** The columns of a snapshot: its fields in form order (fields the schema lacks after), titled. */
function columnsOf(fields: WfFields, schema: unknown): WfDataColumn[] {
  const titles = fieldTitles(schema, FORM_LOCALE[currentLocale()])
  const names = [...titles.keys(), ...Object.keys(fields)].filter((f) => Object.hasOwn(fields, f))
  return [...new Set(names)].map((field) => ({
    field,
    type: fields[field]!,
    label: titles.get(field) || field,
  }))
}

// Field filters as fork conditions compare (engine/condition.ts): a stored value of another JSON
// type never matches, `ne` included; dates compare as instants (a bare date = 00:00 UTC, the session zone).
const INTS = ['INTEGER', 'UNSIGNED INTEGER']
const JSON_TYPES: Record<WfFieldType, string[]> = {
  number: [...INTS, 'DOUBLE', 'DECIMAL'],
  user: INTS,
  dept: INTS,
  string: ['STRING'],
  date: ['STRING'],
}
const SQL_OP = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

/**
 * The WHERE clause of filter `n`: only fixed SQL and the `:path<n>` / `:types<n>` / `:value<n>` params; the
 * JSON path is bound too, built from a snapshot field name (checked by the caller).
 */
function filterClause(n: number, type: WfFieldType, op: WfDataFilter['op']): string {
  const at = `JSON_EXTRACT(i.formValues, :path${n})`
  // text as `===` compares it: JSON_UNQUOTE's utf8mb4_bin pads ('a' = 'a '), utf8mb4_0900_bin does not
  const v =
    type === 'string'
      ? `JSON_UNQUOTE(${at}) COLLATE utf8mb4_0900_bin`
      : type === 'date'
        ? `CAST(JSON_UNQUOTE(${at}) AS DATETIME(3))`
        : `CAST(JSON_UNQUOTE(${at}) AS DOUBLE)`
  const value = type === 'date' ? `CAST(:value${n} AS DATETIME(3))` : `:value${n}`
  const test =
    op === 'in'
      ? `${v} IN (:...value${n})`
      : op === 'contains'
        ? `LOCATE(:value${n}, ${v}) > 0`
        : `${v} ${SQL_OP[op as keyof typeof SQL_OP]} ${value}`
  return `(JSON_TYPE(${at}) IN (:...types${n}) AND ${test})`
}

/** The filters outside the snapshot's fields, or not type-checking against them, as the query's 400. */
function badFilters(fields: WfFields, filters: WfDataFilter[]): ValidationException | null {
  const issues = filters.flatMap((f, n) => {
    const code = fieldConditionError(fields, f)
    return code
      ? [
          {
            code: 'custom',
            path: ['filters', n, WF_CONDITION_KEY[code]],
            message: `validation.wf.filter_${code}`,
            params: { name: f.field },
            input: undefined,
          } as z.core.$ZodIssue,
        ]
      : []
  })
  if (!issues.length) return null
  const e = new ValidationException(issues)
  e.domain = 'wf.data'
  return e
}

/**
 * The fields some step of `version` hides (`hide` in the access of its begin or any review node, as
 * the detail reads them: `readerAccess` over every step; see docs/design-notes.md#workflow): approval data withholds them from all but root and
 * the model's process admins. A tree that no longer compiles: null, every field hidden (its access is
 * unknown; the detail shows no form then either), a value its snapshot lacks included.
 */
function hiddenFields({ treeJson, formSnapshot: { fields } }: WfVersion): Set<string> | null {
  const r = compile(treeJson, fields)
  if (!r.ok) return null
  const steps = [...r.flow.nodes.values()].map(({ node }) =>
    node.type === 'begin' || node.type === 'review' ? node.access : undefined,
  )
  return new Set(Object.keys(readerAccess(steps)))
}

interface Source {
  model: WfModel
  versions: WfVersion[]
  /** the chosen one */
  version: WfVersion | undefined
  /** its fields the caller may see: the columns, what filters may name */
  fields: WfFields
  columns: WfDataColumn[]
  /** how many of its fields are withheld from the caller */
  withheld: number
  /**
   * Does the caller not see `field` of an instance on version `versionId`: hidden on a step of that version
   * (`hiddenFields`; an unknown version, or one whose tree no longer compiles, hides all) unless root or a
   * process admin of the model. Rows span every version: a field the chosen version shows stays
   * withheld where the row's own one hides it.
   */
  hides: (versionId: number, field: string) => boolean
}

/**
 * Approval data: a model's instances (all its versions) with the chosen version's form
 * fields as columns, filtered by state, initiator, start time and field values, limited to the caller's data
 * scope for the route's perm on `wf_instance.initiator_dept_id` (out of scope never listed). Root and the
 * model's process admins see every field; anyone else not the ones a step of the chosen version hides (no column, no filter, not in the export), nor a row's value its own version hides. Unknown model or version
 * → 404; a filter outside the fields the caller sees or of the wrong type → 400.
 */
@Injectable()
export class WfDataService {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>) {}

  /** GET /wf/models/:key/data */
  async page(key: string, q: WfDataQuery): Promise<WfDataPageVo> {
    const src = await this.source(key, q)
    const head = {
      version: src.version?.version ?? null,
      versions: src.versions.map((v) => v.version),
      columns: src.columns,
      withheld: src.withheld,
    }
    if (!src.version) return { ...head, items: [], total: 0 }
    const [insts, total] = await this.filtered(src, q)
      .skip((q.page - 1) * q.pageSize)
      .take(q.pageSize)
      .getManyAndCount()
    return { ...head, items: await this.rows(src, insts), total }
  }

  /**
   * GET /wf/models/:key/data/export: the columns (the page's: `WF_DATA_BASE_COLUMNS`, then the fields) and
   * every filtered row in list order, `EXPORT_BATCH` at a time. The model, version and filters are checked
   * before it returns.
   * Batches as `exportBatches` (an instance started during the export never shifts one).
   */
  async export(key: string, q: WfDataQuery) {
    const src = await this.source(key, q)
    const columns: ExcelColumn[] = [
      { prop: 'id', label: 'field.wf.data.id', type: 'number', width: 10 },
      { prop: 'state', label: 'field.wf.data.state', dict: 'wf.instance_state', width: 12 },
      { prop: 'initiator', label: 'field.wf.data.initiator' },
      { prop: 'dept', label: 'field.wf.data.dept', seedName: true },
      { prop: 'startedAt', label: 'field.wf.data.startedAt', type: 'datetime', width: 20 },
      { prop: 'endedAt', label: 'field.wf.data.endedAt', type: 'datetime', width: 20 },
      ...src.columns.map((c): ExcelColumn => ({
        prop: `f:${c.field}`,
        label: c.label,
        literal: true,
        type: c.type === 'number' ? 'number' : 'string',
        // seeded dept names are i18n keys (see docs/design-notes.md#i18n)
        seedName: c.type === 'dept',
      })),
    ]
    return { columns, rows: this.batches(src, q) }
  }

  private async *batches(src: Source, q: WfDataQuery): AsyncGenerator<object[]> {
    if (!src.version) return
    for await (const insts of exportBatches(() => this.filtered(src, q), EXPORT_BATCH))
      yield (await this.rows(src, insts)).map((r) => cells(r, src.columns))
  }

  /**
   * The model by key, its versions, the chosen one (`version`, default the current) and its fields and
   * columns as the caller may see them.
   */
  private async source(key: string, q: WfDataQuery): Promise<Source> {
    const { tx } = this.txHost
    const model = await tx.getRepository(WfModel).findOneBy({ modelKey: key })
    if (!model) throw new BizError(Err.NOT_FOUND)
    const p = clsGet('principal')!
    const all = p.root || !!model.managerUserIds?.includes(p.userId)
    const repo = tx.getRepository(WfVersion)
    // the snapshots and trees of every version when some may hide fields, else the chosen one alone
    const versions = await repo.find({
      select: { id: true, version: true, treeJson: !all, formSnapshot: !all },
      where: { modelId: model.id },
      order: { version: 'DESC' },
    })
    const chosen =
      q.version === undefined
        ? versions.find((v) => v.id === model.currentVersionId)
        : versions.find((v) => v.version === q.version)
    if (q.version !== undefined && !chosen) throw new BizError(Err.NOT_FOUND)
    const version = chosen && (all ? await repo.findOneByOrFail({ id: chosen.id }) : chosen)
    const hidden = new Map(all ? [] : versions.map((v) => [v.id, hiddenFields(v)]))
    // an unknown version (undefined) or one whose tree no longer compiles (null) hides every field
    const hides = (versionId: number, field: string) =>
      !all && hidden.get(versionId)?.has(field) !== false
    const snapshot = version?.formSnapshot.fields ?? {}
    const fields = version
      ? Object.fromEntries(Object.entries(snapshot).filter(([f]) => !hides(version.id, f)))
      : {}
    // a hidden field is just not there: filtering by it is an unknown field's 400
    const bad = badFilters(fields, q.filters ?? [])
    if (bad) throw bad
    const columns = columnsOf(fields, version?.formSnapshot.schema)
    const withheld = Object.keys(snapshot).length - Object.keys(fields).length
    return { model, versions, version, fields, columns, withheld, hides }
  }

  /** The scoped, filtered, sorted instances of the model. */
  private filtered({ model, versions, fields, hides }: Source, q: WfDataQuery) {
    const qb = scopedInstances(
      this.txHost.tx.getRepository(WfInstanceRow).createQueryBuilder('i'),
    ).andWhere('i.modelKey = :modelKey', { modelKey: model.modelKey })
    if (q.state) qb.andWhere('i.state = :state', { state: q.state })
    if (q.initiatorId) qb.andWhere('i.initiatorId = :initiatorId', { initiatorId: q.initiatorId })
    if (q.startedAtFrom) qb.andWhere('i.startedAt >= :from', { from: new Date(q.startedAtFrom) })
    if (q.startedAtTo) qb.andWhere('i.startedAt <= :to', { to: new Date(q.startedAtTo) })
    for (const [n, f] of (q.filters ?? []).entries()) {
      const type = fields[f.field]!
      // a clause of fixed SQL and numbered params (filterClause); the values are bound
      const clause = filterClause(n, type, f.op)
      qb.andWhere(clause, {
        [`path${n}`]: `$.${JSON.stringify(f.field)}`,
        [`types${n}`]: JSON_TYPES[type],
        [`value${n}`]: f.value,
      })
    }
    // a value the row's version hides from the caller is no value: no filter by it matches there (the
    // chosen version shows every filtered field, so never none; a row on an unknown version matches none)
    if (q.filters?.length) {
      const shown = versions
        .filter((v) => q.filters!.every((f) => !hides(v.id, f.field)))
        .map((v) => v.id)
      qb.andWhere('i.versionId IN (:...shown)', { shown })
    }
    return sorted(qb, q.sort ?? [{ field: 'startedAt', order: 'DESC' }])
  }

  /**
   * List rows of `insts`: refs with names, the columns' values (a user / dept id as its ref) but the ones the
   * row's version hides from the caller.
   */
  private async rows(
    { versions, columns, hides }: Source,
    insts: WfInstanceRow[],
  ): Promise<WfDataRowVo[]> {
    const shown = (i: WfInstanceRow, field: string) =>
      Object.hasOwn(i.formValues, field) && !hides(i.versionId, field)
    const ids = (type: WfFieldType) =>
      columns
        .filter((c) => c.type === type)
        .flatMap((c) => insts.filter((i) => shown(i, c.field)).map((i) => i.formValues[c.field]))
        .filter(isId)
    const view = await instanceView(this.txHost.tx, insts, ids('user'), ids('dept'))
    const numbers = new Map(versions.map((v) => [v.id, v.version]))
    return insts.map((i) => {
      const { id, state, initiator, dept, startedAt, endedAt } = view.instance(i)
      const values: Record<string, unknown> = {}
      for (const { field, type } of columns) {
        if (!shown(i, field)) continue
        const v = i.formValues[field]
        values[field] = (type === 'user' || type === 'dept') && isId(v) ? view[type](v) : v
      }
      return {
        id,
        version: numbers.get(i.versionId) ?? 0,
        state,
        initiator,
        dept,
        startedAt,
        endedAt,
        values,
      }
    })
  }
}

/** A list row as the export's cells: names for user / dept refs, other objects and lists as JSON text. */
function cells(row: WfDataRowVo, columns: WfDataColumn[]): object {
  const name = (r: { id: number; name: string | null }) => r.name ?? `#${r.id}`
  const out: Record<string, unknown> = {
    id: row.id,
    state: row.state,
    initiator: name(row.initiator),
    dept: row.dept && name(row.dept),
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  }
  for (const { field, type } of columns) {
    const v = row.values[field]
    out[`f:${field}`] =
      (type === 'user' || type === 'dept') && isObject(v) && isId(v.id)
        ? name(v as { id: number; name: string | null })
        : typeof v === 'object' && v !== null
          ? JSON.stringify(v)
          : v
  }
  return out
}
