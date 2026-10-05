import {
  fieldConditionError,
  WF_FIELD_OPS,
  type WfDataColumn,
  type WfDataFilter,
  type WfFieldType,
  type WfOp,
} from '@qiwu/shared'
import { i18n, refName, tx } from '@/core/i18n'
import { at } from '../center/use-center-list'

/** The table prop of a form field column: apart from the fixed ones (`id`, `state`, …) */
export const fieldProp = (field: string) => `f:${field}`

/** The hint over the table when the server withheld `n` fields a step hides; none → ''. */
export const withheldHint = (n = 0) => (n > 0 ? i18n.global.t('wf.data.withheld', { n }, n) : '')

/** A new field filter on `field` (of `type`): its type's first op, no value yet. */
export function blankFilter(field: string, type: WfFieldType): WfDataFilter {
  const op = WF_FIELD_OPS[type][0]
  return { field, op, value: '' }
}

/** A new op keeps the value unless it switches between one value and a list (`in`). */
export function withOp(f: WfDataFilter, op: WfOp): WfDataFilter {
  const list = op === 'in'
  return { ...f, op, value: list === Array.isArray(f.value) ? f.value : list ? [] : '' }
}

/**
 * The `filters` query param: the field filters that type-check against the columns (the server's own
 * `fieldConditionError`; one still being filled in is left out) as JSON, none → undefined.
 */
export function filtersParam(filters: WfDataFilter[], columns: WfDataColumn[]): string | undefined {
  const fields = Object.fromEntries(columns.map((c) => [c.field, c.type]))
  const ready = filters.filter((f) => !fieldConditionError(fields, f))
  return ready.length ? JSON.stringify(ready) : undefined
}

const isRef = (v: unknown): v is { id: number; name: string | null } =>
  typeof v === 'object' && v !== null && 'id' in v && 'name' in v

/**
 * A form value as a cell: a user / dept by name (a seeded dept name translated), a datetime in local
 * time, a date as stored, other objects and lists as JSON text (as the export writes them).
 */
export function cellText(v: unknown, type: WfFieldType): string {
  if (v === null || v === undefined) return ''
  if ((type === 'user' || type === 'dept') && isRef(v))
    return type === 'dept' && v.name ? tx(v.name) : refName(v.id, v.name)
  if (typeof v === 'object') return JSON.stringify(v)
  if (type === 'date' && typeof v === 'string' && v.includes('T')) return at(v)
  return String(v)
}
