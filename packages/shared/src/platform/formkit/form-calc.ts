import type { FormSchema } from './form-schema.js'

// The calc components: fixed rules, no formulas (no eval; see docs/design-notes.md#security). One implementation for
// the browser (what the form shows) and the server (what is stored, branched on and exported): the server
// recomputes every result from its inputs and overwrites what the client sent.

/** rows a `qw-detail-table` keeps */
export const DETAIL_ROWS_MAX = 100
/** characters of a text cell */
export const DETAIL_TEXT_MAX = 500
/** a number cell's magnitude: totals of `DETAIL_ROWS_MAX` such cells stay exact to the cent */
export const DETAIL_NUMBER_MAX = 1e10

const DAY_MS = 86_400_000
const YMD = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/

/** A `YYYY-MM-DD` value (a datetime's date as written) as days since 1970-01-01; null if it is no date. */
function dayOf(value: unknown): number | null {
  const m = typeof value === 'string' ? YMD.exec(value) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  const date = new Date(Date.UTC(y, mo, d))
  // 2026-02-30 rolls over, 0099 maps to 1999: neither is the date written
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo && date.getUTCDate() === d
    ? date.getTime() / DAY_MS
    : null
}

/**
 * `qw-date-range-days`: the calendar days from `start` to `end`, both counted; an afternoon start
 * (`startHalf === 'pm'`) and a morning end (`endHalf === 'am'`) count half a day each. null when a date is
 * missing or the range is empty (end before start).
 */
export function rangeDays(
  start: unknown,
  end: unknown,
  startHalf?: unknown,
  endHalf?: unknown,
): number | null {
  const s = dayOf(start)
  const e = dayOf(end)
  if (s === null || e === null) return null
  const days = e - s + 1 - (startHalf === 'pm' ? 0.5 : 0) - (endHalf === 'am' ? 0.5 : 0)
  return days > 0 ? days : null
}

export interface DetailColumn {
  prop: string
  label?: string
  /** a number column: the field its total goes to */
  sum?: string
}
export type DetailRow = Record<string, string | number>

const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= DETAIL_NUMBER_MAX

/**
 * The rows of a `qw-detail-table` value (the JSON text of a row list; a list is taken as is), first
 * `DETAIL_ROWS_MAX` only: each keeps the columns' cells, a number in a `sum` column, trimmed text in the
 * others; any other cell is left out, and so is a row left empty. Not JSON, not a list → no rows.
 */
export function detailRows(value: unknown, columns: readonly DetailColumn[]): DetailRow[] {
  let list = value
  if (typeof value === 'string')
    try {
      list = JSON.parse(value)
    } catch {
      return []
    }
  if (!Array.isArray(list)) return []
  const rows: DetailRow[] = []
  for (const item of list.slice(0, DETAIL_ROWS_MAX)) {
    if (typeof item !== 'object' || item === null) continue
    const row: DetailRow = {}
    for (const { prop, sum } of columns) {
      const v: unknown = Object.hasOwn(item, prop) ? (item as Record<string, unknown>)[prop] : null
      if (sum !== undefined) {
        if (isNumber(v)) row[prop] = v
      } else if (typeof v === 'string' && v.trim()) row[prop] = v.trim().slice(0, DETAIL_TEXT_MAX)
    }
    if (Object.keys(row).length) rows.push(row)
  }
  return rows
}

/** `qw-detail-table` totals: each `sum` field → the total of its column (binary float noise rounded off). */
export function detailTotals(
  rows: readonly DetailRow[],
  columns: readonly DetailColumn[],
): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const { prop, sum } of columns) {
    if (sum === undefined) continue
    const total = rows.reduce((t, r) => t + (typeof r[prop] === 'number' ? r[prop] : 0), 0)
    totals[sum] = Number(total.toFixed(6))
  }
  return totals
}

/**
 * `values` (a copy) with every calc component's result recomputed from its inputs: a `qw-date-range-days`
 * field holds {@link rangeDays} of the fields it names; a `qw-detail-table` field its {@link detailRows}
 * as JSON text (null for none), and each column `sum` field the column's total. The schema is the
 * sanitized one (`sanitizeFormSchema` checked the names); none → `values` unchanged.
 */
export function applyFormCalc(
  schema: Pick<FormSchema, 'rule'> | undefined,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out = { ...values }
  const at = (field: string | undefined) =>
    field !== undefined && Object.hasOwn(values, field) ? values[field] : undefined
  for (const r of schema?.rule ?? []) {
    if (r.type === 'qw-date-range-days') {
      const p = r.props ?? {}
      const halves = [at(p.startHalfField), at(p.endHalfField)]
      out[r.field] = rangeDays(at(p.startField), at(p.endField), ...halves)
    } else if (r.type === 'qw-detail-table') {
      const columns = r.props?.columns ?? []
      const rows = detailRows(at(r.field), columns)
      out[r.field] = rows.length ? JSON.stringify(rows) : null
      Object.assign(out, detailTotals(rows, columns))
    }
  }
  return out
}
