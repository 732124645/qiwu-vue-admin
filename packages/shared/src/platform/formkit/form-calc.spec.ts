import { describe, expect, it } from 'vitest'
import { fieldsFromFormSchema } from '../../workflow/form-fields.js'
import {
  applyFormCalc,
  DETAIL_NUMBER_MAX,
  DETAIL_ROWS_MAX,
  DETAIL_TEXT_MAX,
  detailRows,
  detailTotals,
  rangeDays,
} from './form-calc.js'
import { sanitizeFormSchema, type FormSchema } from './form-schema.js'

// The calc components, one implementation for the browser and the server.

const date = (field: string, type?: string) => ({
  type: 'datePicker',
  field,
  ...(type ? { props: { type } } : {}),
})
const half = (field: string) => ({
  type: 'radio',
  field,
  options: [
    { label: 'AM', value: 'am' },
    { label: 'PM', value: 'pm' },
  ],
})
const days = (props: Record<string, unknown> = { startField: 'start', endField: 'end' }) => ({
  type: 'qw-date-range-days',
  field: 'days',
  props,
})
const COLUMNS = [
  { prop: 'item', label: 'Item' },
  { prop: 'amount', label: 'Amount', sum: 'total' },
  { prop: 'qty', label: 'Qty', sum: 'qtyTotal' },
]
const table = (columns: unknown = COLUMNS) => ({
  type: 'qw-detail-table',
  field: 'items',
  props: { columns },
})
const LEAVE = [
  date('start'),
  half('startHalf'),
  date('end'),
  half('endHalf'),
  days({
    startField: 'start',
    endField: 'end',
    startHalfField: 'startHalf',
    endHalfField: 'endHalf',
  }),
  table(),
]
const clean = (rule: unknown[]): FormSchema => {
  const r = sanitizeFormSchema({ rule })
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return r.schema
}
const errorsOf = (rule: unknown[]) => {
  const r = sanitizeFormSchema({ rule })
  return r.ok ? [] : r.errors.map(({ code, path }) => ({ code, path: path.join('.') }))
}

describe('rangeDays', () => {
  it.each([
    ['2026-10-01', '2026-10-01', undefined, undefined, 1],
    ['2026-10-01', '2026-10-03', undefined, undefined, 3],
    ['2026-10-01', '2026-10-03', 'pm', undefined, 2.5],
    ['2026-10-01', '2026-10-03', 'pm', 'am', 2],
    ['2026-10-01', '2026-10-01', 'am', 'pm', 1],
    ['2026-10-01', '2026-10-01', 'pm', 'pm', 0.5],
    ['2026-10-01', '2026-10-01', 'am', 'am', 0.5],
    // across a month, a leap day and a year
    ['2028-02-27', '2028-03-01', undefined, undefined, 4],
    ['2026-12-31', '2027-01-01', undefined, undefined, 2],
    // a datetime counts by the date written (its own offset): no time zone shifts the day
    ['2026-10-01T23:30:00+08:00', '2026-10-02T00:10:00-05:00', undefined, undefined, 2],
    ['2026-10-01 09:00:00', '2026-10-02', undefined, undefined, 2],
  ])('%s → %s (%s, %s) = %s', (start, end, s, e, want) => {
    expect(rangeDays(start, end, s, e)).toBe(want)
  })

  it('is null without two real dates or for an empty range', () => {
    expect(rangeDays('2026-10-02', '2026-10-01')).toBeNull()
    expect(rangeDays('2026-10-01', '2026-10-01', 'pm', 'am')).toBeNull()
    for (const bad of [undefined, null, '', 20261001, '2026-02-30', '2026-13-01', '0099-01-01'])
      expect(rangeDays(bad, '2026-10-01')).toBeNull()
    expect(rangeDays('2026-10-01', '2026-10-011')).toBeNull()
    expect(rangeDays(new Date(), '2026-10-01')).toBeNull()
  })

  it('only the exact half-day codes count', () => {
    expect(rangeDays('2026-10-01', '2026-10-02', 'PM', 'morning')).toBe(2)
  })
})

describe('detailRows / detailTotals', () => {
  it('keeps the columns, numbers in sum columns and trimmed text in the others', () => {
    const value = JSON.stringify([
      { item: ' Taxi ', amount: 12.5, qty: 1, extra: 'dropped' },
      { item: 'Hotel', amount: '300', qty: 2 }, // a number as text is no number
      { item: 7, amount: 0.1 },
      { item: '   ' }, // empty once trimmed: the row goes
      null,
      'row',
      [1, 2],
      { amount: Number.NaN, qty: DETAIL_NUMBER_MAX * 10 }, // nothing valid
    ])
    const rows = detailRows(value, COLUMNS)
    expect(rows).toEqual([
      { item: 'Taxi', amount: 12.5, qty: 1 },
      { item: 'Hotel', qty: 2 },
      { amount: 0.1 },
    ])
    expect(detailTotals(rows, COLUMNS)).toEqual({ total: 12.6, qtyTotal: 3 })
    // a list as is (what the browser holds) reads the same
    expect(detailRows(JSON.parse(value), COLUMNS)).toEqual(rows)
  })

  it('rounds float noise off totals, a column with no numbers totals 0', () => {
    const rows = detailRows(
      JSON.stringify([{ amount: 0.1 }, { amount: 0.2 }, { amount: -0.05 }]),
      COLUMNS,
    )
    expect(detailTotals(rows, COLUMNS)).toEqual({ total: 0.25, qtyTotal: 0 })
    expect(detailTotals([], [{ prop: 'item' }])).toEqual({})
  })

  it('bounds rows and text; anything but a JSON list is no rows', () => {
    const many = Array.from({ length: DETAIL_ROWS_MAX + 5 }, () => ({ amount: 1 }))
    expect(detailRows(JSON.stringify(many), COLUMNS)).toHaveLength(DETAIL_ROWS_MAX)
    const long = detailRows(JSON.stringify([{ item: 'x'.repeat(DETAIL_TEXT_MAX + 1) }]), COLUMNS)
    expect(long[0]!.item).toHaveLength(DETAIL_TEXT_MAX)
    for (const bad of ['', 'not json', '{"amount":1}', '1e400', null, 42, { 0: { amount: 1 } }])
      expect(detailRows(bad, COLUMNS)).toEqual([])
    // an inherited or prototype key is no cell
    const proto = detailRows('[{"__proto__":{"amount":5}}]', COLUMNS)
    expect(proto).toEqual([])
  })
})

describe('applyFormCalc', () => {
  const schema = clean(LEAVE)

  it('overwrites the results with what the inputs give, keeping the other values', () => {
    const sent = {
      start: '2026-10-01',
      startHalf: 'pm',
      end: '2026-10-03',
      endHalf: 'pm',
      days: 1, // forged
      items: JSON.stringify([{ item: 'Taxi', amount: 12.5, qty: 2 }, { amount: 7.5 }, {}]),
      total: 1, // forged
      qtyTotal: 99, // forged
      note: 'kept',
    }
    const out = applyFormCalc(schema, sent)
    expect(out).toEqual({
      ...sent,
      days: 2.5,
      items: JSON.stringify([{ item: 'Taxi', amount: 12.5, qty: 2 }, { amount: 7.5 }]),
      total: 20,
      qtyTotal: 2,
    })
    // a copy: the input stays as sent
    expect(sent.days).toBe(1)
  })

  it('gives null days and no rows (totals 0) when the inputs are missing', () => {
    expect(applyFormCalc(schema, { days: 3, items: 'garbage', total: 5 })).toEqual({
      days: null,
      items: null,
      total: 0,
      qtyTotal: 0,
    })
  })

  it('leaves values alone without a schema or calc components', () => {
    const values = { a: 1, days: 9 }
    expect(applyFormCalc(undefined, values)).toEqual(values)
    expect(applyFormCalc(clean([{ type: 'input', field: 'a' }]), values)).toEqual(values)
  })

  it('reads only own values (a field named like an Object.prototype member is no input)', () => {
    const s = clean([date('start'), date('end'), days()])
    const values = Object.create({ start: '2026-10-01', end: '2026-10-02' }) as object
    expect(applyFormCalc(s, values)).toEqual({ days: null })
  })
})

describe('sanitizeFormSchema: calc components', () => {
  it('keeps their settings; a blank designer setting is unset', () => {
    const blank = days({ startField: 'start', endField: 'end', startHalfField: '' })
    const tbl = table([
      { prop: 'item', label: 'Item', sum: '' },
      { prop: 'amount', sum: 'total' },
    ])
    const s = clean([date('start'), date('end', 'date'), blank, tbl])
    expect(s.rule[2]!.props).toEqual({ startField: 'start', endField: 'end' })
    expect(JSON.parse(JSON.stringify(s.rule[3]!.props))).toEqual({
      columns: [
        { prop: 'item', label: 'Item' },
        { prop: 'amount', sum: 'total' },
      ],
    })
    expect(clean(LEAVE).rule).toHaveLength(LEAVE.length)
  })

  it('days need start and end single-date fields of the form; half-day fields another field', () => {
    expect(errorsOf([days({})])).toEqual([
      { code: 'calc_ref', path: 'rule.0.props.startField' },
      { code: 'calc_ref', path: 'rule.0.props.endField' },
    ])
    expect(errorsOf([date('start', 'daterange'), { type: 'input', field: 'end' }, days()])).toEqual(
      [
        { code: 'calc_ref', path: 'rule.2.props.startField' },
        { code: 'calc_ref', path: 'rule.2.props.endField' },
      ],
    )
    const halves = days({
      startField: 'start',
      endField: 'end',
      startHalfField: 'nope',
      endHalfField: 'days',
    })
    expect(errorsOf([date('start', 'datetime'), date('end'), halves])).toEqual([
      { code: 'calc_ref', path: 'rule.2.props.startHalfField' },
      { code: 'calc_ref', path: 'rule.2.props.endHalfField' },
    ])
  })

  it('a column total is a field: a name taken twice is a duplicate; bad names and shapes are rejected', () => {
    const taken = table([
      { prop: 'amount', sum: 'note' },
      { prop: 'qty', sum: 'items' },
    ])
    expect(errorsOf([{ type: 'input', field: 'note' }, taken])).toEqual([
      { code: 'duplicate_field', path: 'rule.1.props.columns.0.sum' },
      { code: 'duplicate_field', path: 'rule.1.props.columns.1.sum' },
    ])
    for (const columns of [
      [{ prop: '1bad' }],
      [{ prop: 'a', sum: 'constructor' }],
      [{ label: 'no prop' }],
      Array.from({ length: 21 }, (_, i) => ({ prop: `c${i}` })),
    ])
      expect(errorsOf([table(columns)]).map((e) => e.code)).toEqual(['shape'])
  })
})

describe('fieldsFromFormSchema: calc components', () => {
  it('days and each column total are numbers, the rows a string', () => {
    const r = fieldsFromFormSchema(clean(LEAVE))
    expect(r).toEqual({
      ok: true,
      fields: {
        start: 'date',
        startHalf: 'string',
        end: 'date',
        endHalf: 'string',
        days: 'number',
        items: 'string',
        total: 'number',
        qtyTotal: 'number',
      },
    })
  })

  it('reports a total that clashes or a bad name (an unsanitized schema)', () => {
    const r = fieldsFromFormSchema([
      { type: 'input', field: 'total' },
      table([{ prop: 'a', sum: 'total' }, { prop: 'b', sum: '$x' }, { prop: 'c', sum: '' }, 'x']),
    ])
    expect(r).toEqual({
      ok: false,
      errors: [
        { code: 'duplicate_field', field: 'total' },
        { code: 'field_name', field: '$x' },
      ],
    })
  })
})
