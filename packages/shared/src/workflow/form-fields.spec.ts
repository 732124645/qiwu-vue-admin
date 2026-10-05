import { describe, expect, it } from 'vitest'
import { sanitizeFormSchema } from '../platform/formkit/form-schema.js'
import {
  FORM_TEXT_MAX,
  fieldsFromFormSchema,
  formRuleRequired,
  formUploadIds,
  formValuesSchema,
} from './form-fields.js'
import { type WfFields, wfFields } from './wf.schema.js'

const rule = (type: string, field?: string, extra: Record<string, unknown> = {}) => ({
  type,
  ...(field === undefined ? {} : { field, title: field }),
  ...extra,
})
const ok = (schema: unknown) => {
  const res = fieldsFromFormSchema(schema)
  if (!res.ok) throw new Error(JSON.stringify(res.errors))
  return res.fields
}

describe('fieldsFromFormSchema', () => {
  it('maps the typed components and makes every other field a string (rate, slider numbers)', () => {
    const rules = [
      rule('inputNumber', 'days'),
      rule('datePicker', 'startAt'),
      rule('qw-user-select', 'approver', { props: { multiple: true } }),
      rule('qw-dept-select', 'ownerDept'),
      ...[
        'input',
        'textarea',
        'select',
        'radio',
        'checkbox',
        'switch',
        'timePicker',
        'rate',
        'slider',
      ].map((t) => rule(t, `f_${t}`)),
      rule('cascader', 'area'),
      rule('qw-dict-select', 'kind'),
      rule('qw-upload', 'files'),
      rule('qw-area-select', 'region'),
    ]
    const fields = ok({ rule: rules, option: { submitBtn: false } })
    expect(fields).toEqual({
      days: 'number',
      startAt: 'date',
      approver: 'user',
      ownerDept: 'dept',
      f_input: 'string',
      f_textarea: 'string',
      f_select: 'string',
      f_radio: 'string',
      f_checkbox: 'string',
      f_switch: 'string',
      f_timePicker: 'string',
      f_rate: 'number',
      f_slider: 'number',
      area: 'string',
      kind: 'string',
      files: 'string',
      region: 'string',
    })
    // a bare rule list works the same, and the result is what `fields` takes
    expect(ok(rules)).toEqual(fields)
    expect(wfFields.parse(fields)).toEqual(fields)
  })

  it('walks nested layouts in document order and skips rules without a field', () => {
    const schema = [
      rule('fcRow', undefined, {
        children: [
          rule('col', undefined, {
            props: { span: 12 },
            children: [rule('input', 'a'), 'plain text'],
          }),
          rule('col', undefined, { children: [rule('inputNumber', 'b')] }),
        ],
      }),
      rule('elTabs', undefined, {
        children: [
          rule('elTabPane', undefined, {
            children: [rule('elCard', undefined, { children: [rule('datePicker', 'c')] })],
          }),
        ],
      }),
      rule('elCollapse', undefined, {
        children: [rule('elCollapseItem', undefined, { children: [rule('qw-dept-select', 'd')] })],
      }),
      rule('text', undefined, { children: ['hello'] }),
      rule('input', ''),
      rule('input', 'e', { children: [rule('qw-user-select', 'f')] }),
      null,
      42,
    ]
    const fields = ok(schema)
    expect(fields).toEqual({
      a: 'string',
      b: 'number',
      c: 'date',
      d: 'dept',
      e: 'string',
      f: 'user',
    })
    expect(Object.keys(fields)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('types a datePicker of one day or datetime as date, any other (lists, month, year, week) as string', () => {
    const date = (field: string, type?: string) =>
      rule('datePicker', field, type === undefined ? {} : { props: { type } })
    expect(
      ok([
        date('plain'),
        date('d', 'date'),
        date('dt', 'datetime'),
        date('m', 'month'),
        date('y', 'year'),
        date('w', 'week'),
        date('dr', 'daterange'),
        date('dtr', 'datetimerange'),
        date('mr', 'monthrange'),
        date('ds', 'dates'),
        date('ms', 'months'),
        date('ys', 'years'),
      ]),
    ).toEqual({
      plain: 'date',
      d: 'date',
      dt: 'date',
      m: 'string',
      y: 'string',
      w: 'string',
      dr: 'string',
      dtr: 'string',
      mr: 'string',
      ds: 'string',
      ms: 'string',
      ys: 'string',
    })
    // a range slider holds two numbers
    expect(ok([rule('slider', 'r', { props: { range: true } })])).toEqual({ r: 'string' })
  })

  it('rejects names `fields` does not take', () => {
    const long = 'x'.repeat(65)
    const res = fieldsFromFormSchema([
      rule('input', '$initiator.dept'),
      rule('input', long),
      rule('input', '__proto__'),
      rule('input', 'x'.repeat(64)),
    ])
    expect(res).toEqual({
      ok: false,
      errors: [
        { code: 'field_name', field: '$initiator.dept' },
        { code: 'field_name', field: long },
        { code: 'field_name', field: '__proto__' },
      ],
    })
  })

  it('rejects a field bound twice, nested or not, whatever the types', () => {
    const res = fieldsFromFormSchema([
      rule('input', 'a'),
      rule('fcRow', undefined, { children: [rule('inputNumber', 'a')] }),
      rule('input', 'b'),
      rule('input', 'b'),
    ])
    expect(res).toEqual({
      ok: false,
      errors: [
        { code: 'duplicate_field', field: 'a' },
        { code: 'duplicate_field', field: 'b' },
      ],
    })
  })

  it('treats inherited names as plain names and junk as no rules', () => {
    const fields = ok([rule('constructor', 'constructor'), rule('toString', 'hasOwnProperty')])
    expect(fields).toEqual({ constructor: 'string', hasOwnProperty: 'string' })
    for (const junk of [
      null,
      undefined,
      'rule',
      5,
      {},
      { rule: {} },
      { rule: 'x' },
      [[rule('input', 'a')]],
    ])
      expect(fieldsFromFormSchema(junk)).toEqual({ ok: true, fields: {} })
    expect(ok([rule('input', 'a', { children: { 0: rule('input', 'b') } }), { field: 7 }])).toEqual(
      {
        a: 'string',
      },
    )
  })

  it('does not overflow the stack on deep nesting', () => {
    let node: Record<string, unknown> = rule('inputNumber', 'deep')
    for (let i = 0; i < 100_000; i++) node = rule('col', undefined, { children: [node] })
    expect(ok([node])).toEqual({ deep: 'number' })
  })
})

describe('formValuesSchema: the values each rule holds, its options, ranges and required', () => {
  const opts = (...values: unknown[]) => values.map((value) => ({ label: String(value), value }))
  const RULES = [
    rule('input', 'text', { props: { maxlength: 5 } }),
    rule('inputNumber', 'amount', { props: { min: 0, max: 100 } }),
    rule('select', 'kind', { options: opts('a', 'b') }),
    rule('select', 'kinds', {
      props: { multiple: true, multipleLimit: 2 },
      options: opts('a', 'b', 'c'),
    }),
    rule('select', 'tag', { props: { allowCreate: true } }),
    rule('radio', 'level', { options: opts(1, 2) }),
    rule('checkbox', 'checks', { options: opts('x', 'y') }),
    rule('switch', 'on'),
    rule('switch', 'yes', { props: { activeValue: 'Y', inactiveValue: 'N' } }),
    rule('datePicker', 'day'),
    rule('datePicker', 'at', { props: { type: 'datetime' } }),
    rule('datePicker', 'month', { props: { type: 'month' } }),
    rule('datePicker', 'span', { props: { type: 'daterange' } }),
    rule('datePicker', 'picks', { props: { type: 'dates' } }),
    rule('timePicker', 'time'),
    rule('timePicker', 'times', { props: { isRange: true } }),
    rule('rate', 'stars'),
    rule('slider', 'band', { props: { range: true, min: 10, max: 20 } }),
    rule('cascader', 'path'),
    rule('cascader', 'paths', { props: { props: { multiple: true } } }),
    rule('qw-dict-select', 'dict', { props: { code: 'x.kind' } }),
    rule('qw-dict-select', 'dicts', { props: { code: 'x.kind', multiple: true } }),
    rule('qw-area-select', 'area'),
    rule('qw-user-select', 'boss'),
    rule('qw-dept-select', 'dept'),
    rule('qw-upload', 'files', { props: { limit: 2 } }),
    rule('qw-detail-table', 'items', {
      props: { columns: [{ prop: 'item' }, { prop: 'cost', sum: 'total' }] },
    }),
    rule('upload', 'pics'),
    rule('qw-date-range-days', 'days', { props: { startField: 'day', endField: 'at' } }),
  ]
  const DICTS = new Map([['x.kind', ['k1', 'k2']]])
  /** the form as saved (sanitized), its fields as published and its values schema */
  const valuesOf = (rules: unknown[], dicts = DICTS) => {
    const r = sanitizeFormSchema({ rule: rules })
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return formValuesSchema(ok(r.schema), r.schema, dicts)
  }
  const values = valuesOf(RULES)
  const VALID = {
    text: 'hello',
    amount: 100,
    kind: 'a',
    kinds: ['a', 'c'],
    tag: 'made up',
    level: 2,
    checks: ['x', 'y'],
    on: true,
    yes: 'N',
    day: '2026-10-01',
    at: '2026-10-01T09:00:00+08:00',
    month: '2026-10',
    span: ['2026-10-01', '2026-10-03'],
    picks: ['2026-10-01', '2026-10-09'],
    time: '09:00:00',
    times: ['09:00:00', '18:00:00'],
    stars: 3.5,
    band: [10, 20],
    path: ['zj', 'hz'],
    paths: [['zj', 'hz'], ['js']],
    dict: 'k1',
    dicts: ['k1', 'k2'],
    area: ['330000', '330100'],
    boss: 7,
    dept: 2,
    files: '12/a.pdf\n13/b.pdf',
    items: JSON.stringify([{ item: 'taxi', cost: 5 }]),
    total: 5,
    pics: ['a.png'],
    days: 2,
  }
  const issues = (schema: typeof values, input: unknown) =>
    schema.safeParse(input).error?.issues.map((i) => [i.path.join('.'), i.message]) ?? []

  it('takes what each component holds: lists, booleans, numbers, ISO dates, ids, upload lines', () => {
    expect(values.parse(VALID)).toEqual(VALID)
    // nothing filled in: every field may be missing, null or ('' for a pick) empty
    expect(values.parse({})).toEqual({})
    const empty = Object.fromEntries(Object.keys(VALID).map((k) => [k, null]))
    expect(values.parse(empty)).toEqual(empty)
    expect(values.parse({ kind: '', dict: '', kinds: [], files: '', text: '  ' })).toEqual({
      kind: '',
      dict: '',
      kinds: [],
      files: '',
      text: '',
    })
  })

  it('rejects values outside the options, ranges, lengths and shapes (400 at the field)', () => {
    const bad = {
      text: 'too long',
      amount: 100.5,
      kind: 'z',
      kinds: ['a', 'b', 'c'],
      level: '2',
      checks: ['x', 'z'],
      on: 'yes',
      yes: true,
      day: '2026-10-01 09:00',
      at: '2026-10-01 09:00:00',
      span: ['2026-10-01'],
      stars: 6,
      band: [5, 15],
      dict: 'k9',
      dicts: ['k1', 'gone'],
      area: '330000',
      boss: 0,
      files: '12/a.pdf\n13/b.pdf\n14/c.pdf',
      times: ['09:00:00'],
      path: 'zj',
      items: { item: 'taxi' },
      pics: { name: 'a.png' },
      days: '2',
    }
    expect(issues(values, { ...VALID, ...bad }).map(([path]) => path)).toEqual([
      'text',
      'amount',
      'kind',
      'kinds',
      'level',
      'checks.1',
      'on',
      'yes',
      'day',
      'at',
      'span',
      'times',
      'stars',
      'band.0',
      'path',
      'dict',
      'dicts.1',
      'area',
      'boss',
      'files',
      'items',
      'pics',
      'days',
    ])
    expect(issues(values, { ...VALID, files: 'nope' })).toEqual([['files', 'validation.invalid']])
    expect(issues(values, { ...VALID, kind: 'z' })).toEqual([['kind', 'validation.invalid']])
    expect(issues(values, { ...VALID, amount: -1 })).toEqual([
      ['amount', 'validation.too_small.number'],
    ])
    // a dict nobody loaded (unknown code, disabled dict): nothing but empty
    expect(issues(valuesOf(RULES, new Map()), { dict: 'k1' })).toEqual([
      ['dict', 'validation.invalid'],
    ])
    // one value where the rule holds one, a list where it holds a list; list sizes as set
    const shapes = valuesOf([
      ...RULES,
      rule('checkbox', 'two', { props: { max: 1 }, options: opts('x', 'y') }),
      rule('textarea', 'story'),
    ])
    const wrong = {
      dict: ['k1'],
      dicts: 'k1',
      path: [['zj']],
      paths: ['zj'],
      band: [10, 15, 20],
      two: ['x', 'y'],
      story: 'x'.repeat(FORM_TEXT_MAX + 1),
    }
    expect(issues(shapes, { ...VALID, ...wrong }).map(([path]) => path)).toEqual([
      'band',
      'path.0',
      'paths.0',
      'dict',
      'dicts',
      'two',
      'story',
    ])
  })

  it('a required rule ($required, validate required) must be filled; a hidden one is not checked', () => {
    const rules = [
      rule('input', 'a', { $required: true }),
      rule('select', 'b', { validate: [{ required: true, message: 'pick' }], options: opts(1) }),
      rule('checkbox', 'c', { validate: [{ mode: 'required' }], options: opts('x') }),
      rule('qw-upload', 'd', { $required: 'attach one' }),
      rule('qw-detail-table', 'e', { $required: true, props: { columns: [{ prop: 'item' }] } }),
      rule('input', 'f', { $required: true, hidden: true }),
      rule('input', 'g', { $required: false }),
      rule('inputNumber', 'h', { $required: true }),
      // not shown, or a calc result (its dates are what is filled in): not checked
      rule('input', 'i', { $required: true, display: false }),
      rule('datePicker', 's'),
      rule('datePicker', 'u'),
      rule('qw-date-range-days', 'n', {
        $required: true,
        props: { startField: 's', endField: 'u' },
      }),
    ]
    const required = valuesOf(rules)
    const all = ['a', 'b', 'c', 'd', 'e', 'h'].map((k) => [k, 'validation.required'])
    // the same rule the mobile renderer marks its required fields by
    const sane = sanitizeFormSchema({ rule: rules })
    if (!sane.ok) throw new Error('unsanitized')
    expect(sane.schema.rule.filter(formRuleRequired).map((r) => r.field)).toEqual(
      all.map(([k]) => k),
    )
    expect(issues(required, {})).toEqual(all)
    expect(issues(required, { a: ' ', b: '', c: [], d: '', e: '[{"item":" "}]', h: null })).toEqual(
      all,
    )
    const filled = { a: 'x', b: 1, c: ['x'], d: '1/a.pdf', e: '[{"item":"taxi"}]', h: 0 }
    expect(required.parse(filled)).toEqual(filled)
    // a required value is still checked as its component holds it
    expect(issues(required, { ...filled, b: 2, h: '0' })).toEqual([
      ['b', 'validation.invalid'],
      ['h', 'validation.invalid_type'],
    ])
  })

  it('without a schema (or a rule) a field is checked by its type', () => {
    const fields: WfFields = {
      amount: 'number',
      reason: 'string',
      on: 'date',
      who: 'user',
      dept: 'dept',
    }
    const schema = formValuesSchema(fields)
    const valid = { amount: 3.5, reason: 'trip', on: '2026-09-29', who: 7, dept: 2 }
    expect(schema.parse({ ...valid, reason: '  trip ', extra: 'x', $initiator: 1 })).toEqual(valid)
    for (const on of ['2026-09-29T08:00:00Z', '2026-09-29T08:00:00+08:00'])
      expect(schema.parse({ ...valid, on }).on).toBe(on)
    for (const on of ['tomorrow', '2026-13-01', '2026-09-29 08:00', 20260929])
      expect(issues(schema, { ...valid, on })).toEqual([['on', expect.any(String)]])
    expect(issues(schema, { ...valid, amount: '5', reason: 5, who: 1.5, dept: -1 })).toEqual([
      ['amount', 'validation.invalid_type'],
      ['reason', 'validation.invalid_type'],
      ['who', 'validation.integer'],
      ['dept', 'validation.too_small.number_exclusive'],
    ])
    expect(schema.parse({ reason: '  ', dept: null })).toEqual({ reason: '', dept: null })
    // a column total has no rule of its own: a number
    expect(issues(values, { ...VALID, total: '5' })).toEqual([['total', 'validation.invalid_type']])
  })
})

describe('formUploadIds', () => {
  it("lists the ids the qw-upload fields name, other fields' and malformed values none", () => {
    const r = sanitizeFormSchema({
      rule: [
        rule('qw-upload', 'a'),
        rule('input', 'b'),
        rule('qw-upload', 'c'),
        rule('qw-upload', 'd'),
      ],
    })
    if (!r.ok) throw new Error('schema')
    expect(
      formUploadIds(r.schema.rule, { a: '3/x.pdf\n4/y.pdf', b: '5/z.pdf', c: 'junk' }),
    ).toEqual([3, 4])
    expect(formUploadIds(r.schema.rule.slice(1), { a: '3/x.pdf' })).toEqual([])
  })
})
