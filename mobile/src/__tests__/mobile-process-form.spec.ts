// Dynamic process forms (see docs/design-notes.md#workflow): the whitelist once more, the fields as views (editable,
// read-only, not on the phone), designer texts by language, dates and times in their formats, the client's
// pre-check (the server's rules), the calc results shown, read-only texts, upload values; the Object.hasOwn polyfill.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DictPayload, FormSchema } from '@qiwu/shared'
import { formatTime } from '@/core/format'
import { setLocale } from '@/core/i18n'
import {
  checkValues,
  dateSpec,
  editableValues,
  fieldText,
  fieldViews,
  formatDate,
  formText,
  formTitles,
  numberInput,
  parseDate,
  pickedValue,
  pickerValue,
  processForm,
  shownValues,
  uploadObjects,
  uploadValue,
  type FieldView,
  type Lookups,
} from '@/pages-wf/form/process-form'

afterEach(() => setLocale('zh-CN'))

const language = {
  'zh-cn': { reason: '事由', low: '低', high: '高' },
  en: { reason: 'Reason', low: 'Low', high: 'High' },
}
const form = (rule: unknown[]) => {
  const f = processForm({ rule, option: { language } })
  if (!f) throw new Error('rejected')
  return f
}
const views = (f: FormSchema, access?: Record<string, 'read' | 'edit' | 'hide'>) =>
  fieldViews(f, access, formText(f))
const view = (f: FormSchema, field: string) => views(f).find((v) => v.field === field)!

describe('the schema', () => {
  it('is whitelisted again (null: not rendered); with access the hide rules are gone', () => {
    expect(processForm({ rule: [{ type: 'input', field: 'a', title: '$FN:alert(1)' }] })).toBeNull()
    expect(processForm({ rule: [{ type: 'html', field: 'a', title: 'x' }] })).toBeNull()
    const schema = {
      rule: [
        { type: 'input', field: 'a', title: 'A', value: 'x' },
        { type: 'input', field: 'secret', title: 'S' },
      ],
    }
    expect(processForm(schema)!.rule.map((r) => [r.field, r.value])).toEqual([
      ['a', 'x'],
      ['secret', undefined],
    ])
    expect(processForm(schema, { secret: 'hide' })!.rule.map((r) => r.field)).toEqual(['a'])
  })

  it('texts: {{$t.<id>}} in the current language, an unknown id as itself, plain text as is', () => {
    const f = form([{ type: 'input', field: 'a', title: '{{$t.reason}}' }])
    expect([formText(f)('{{$t.reason}}'), formText(f)('{{ $t.nope }}'), formText(f)('Plain')]).toEqual([
      '事由',
      'nope',
      'Plain',
    ])
    setLocale('en-US')
    expect(formText(f)('{{$t.reason}} *')).toBe('Reason *')
    expect(views(f)[0]!.title).toBe('Reason')
  })
})

describe('fields', () => {
  const f = form([
    { type: 'input', field: 'a', title: '{{$t.reason}}', $required: true },
    { type: 'input', field: 'long', title: 'L', props: { type: 'textarea' } },
    { type: 'input', field: 'hid', title: 'H', hidden: true },
    { type: 'input', field: 'gone', title: 'G', display: false },
    { type: 'inputNumber', field: 'n', title: 'N', props: { disabled: true } },
    { type: 'select', field: 's', title: 'S', validate: [{ required: true }], options: [] },
    { type: 'datePicker', field: 'week', title: 'W', props: { type: 'week' } },
    { type: 'datePicker', field: 'dates', title: 'Ds', props: { type: 'dates' } },
    { type: 'datePicker', field: 'wo', title: 'Wo', props: { type: 'month', valueFormat: 'YYYY-wo' } },
    { type: 'cascader', field: 'cm', title: 'C', props: { props: { multiple: true } } },
    { type: 'upload', field: 'up', title: 'U' },
    { type: 'datePicker', field: 'd1', title: 'D1' },
    { type: 'datePicker', field: 'd2', title: 'D2' },
    { type: 'qw-date-range-days', field: 'days', title: 'Days', props: { startField: 'd1', endField: 'd2' } },
  ])

  it('renders the shown ones; disabled, calc and not-on-the-phone ones read-only', () => {
    const vs = views(f)
    expect(vs.map((v) => v.field)).not.toContain('hid')
    expect(vs.map((v) => v.field)).not.toContain('gone')
    const by = Object.fromEntries(vs.map((v) => [v.field, v]))
    expect([by.a!.title, by.a!.edit, by.a!.required, by.a!.widget]).toEqual(['事由', true, true, 'input'])
    expect([by.s!.required, by.s!.widget, by.long!.widget]).toEqual([true, 'choice', 'textarea'])
    expect([by.n!.edit, by.n!.required]).toEqual([false, false])
    expect([by.days!.edit, by.days!.widget]).toEqual([false, 'days'])
    for (const k of ['week', 'dates', 'wo', 'cm', 'up'])
      expect([k, by[k]!.unsupported, by[k]!.edit]).toEqual([k, true, false])
    expect([by.d1!.unsupported, by.d1!.date]).toEqual([
      false,
      { picker: 'date', fmt: 'YYYY-MM-DD', range: false },
    ])
  })

  it('with access (the detail): only the edit fields are inputs; read and unlisted are not', () => {
    const by = Object.fromEntries(views(f, { a: 'read', s: 'edit' }).map((v) => [v.field, v.edit]))
    expect([by.a, by.s, by.d1]).toEqual([false, true, false])
  })

  it('titles for the messages, a detail total its column label', () => {
    const t = form([
      { type: 'input', field: 'a', title: '{{$t.reason}}' },
      {
        type: 'qw-detail-table',
        field: 'items',
        title: 'Items',
        props: { columns: [{ prop: 'amount', label: 'Amount', sum: 'total' }] },
      },
    ])
    expect(formTitles(t, formText(t))).toEqual({ a: '事由', items: 'Items', total: 'Amount' })
  })
})

describe('dates and times', () => {
  const local = new Date(2026, 11, 7, 9, 5, 3).getTime()
  const off = -new Date(local).getTimezoneOffset()
  const zone = `${off < 0 ? '-' : '+'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`

  it('formats and parses the value formats, local time with the local offset', () => {
    expect(formatDate(local, 'YYYY-MM-DD')).toBe('2026-12-07')
    expect(formatDate(local, 'YYYY-MM-DD[T]HH:mm:ssZ')).toBe(`2026-12-07T09:05:03${zone}`)
    expect(formatDate(local, 'YYYY-MM')).toBe('2026-12')
    expect(formatDate(local, 'HH:mm:ss')).toBe('09:05:03')
    expect(parseDate(`2026-12-07T09:05:03${zone}`, 'YYYY-MM-DD[T]HH:mm:ssZ')).toBe(local)
    expect(parseDate('2026-12-07T01:05:03Z', 'YYYY-MM-DD[T]HH:mm:ssZ')).toBe(
      Date.UTC(2026, 11, 7, 1, 5, 3),
    )
    expect(parseDate('2026-12-07', 'YYYY-MM-DD')).toBe(new Date(2026, 11, 7).getTime())
    expect(parseDate('2026-12', 'YYYY-MM')).toBe(new Date(2026, 11, 1).getTime())
    expect(parseDate('2026/12/07', 'YYYY-MM-DD')).toBeNull()
    expect(parseDate(20261207, 'YYYY-MM-DD')).toBeNull()
  })

  it('picker ↔ value: a time picked as HH:mm gets its seconds, a range both ends', () => {
    const spec = (rule: unknown) => dateSpec(form([rule]).rule[0]!)!
    const time = spec({ type: 'timePicker', field: 't', title: 'T' })
    expect(pickedValue(time, '08:30')).toBe('08:30:00')
    expect(pickerValue(time, '08:30:15')).toBe('08:30')
    const range = spec({ type: 'datePicker', field: 'r', title: 'R', props: { type: 'daterange' } })
    expect(range).toEqual({ picker: 'date', fmt: 'YYYY-MM-DD', range: true })
    expect(pickerValue(range, ['2026-12-07', '2026-12-09'])).toEqual([
      new Date(2026, 11, 7).getTime(),
      new Date(2026, 11, 9).getTime(),
    ])
    // none yet: now, the end at the start
    const [a, b] = pickerValue(range, null) as number[]
    expect(b).toBe(a)
    expect(pickedValue(range, [local, local])).toEqual(['2026-12-07', '2026-12-07'])
    const dt = spec({ type: 'datePicker', field: 'x', title: 'X', props: { type: 'datetime' } })
    expect(pickedValue(dt, local)).toBe(`2026-12-07T09:05:03${zone}`)
  })
})

const dict = (code: string, values: string[]): DictPayload =>
  ({ code, entries: values.map((value) => ({ value, label: value.toUpperCase() })) }) as never

describe('the pre-check (the server’s formValuesSchema)', () => {
  const f = form([
    { type: 'input', field: 'reason', title: '{{$t.reason}}', $required: true },
    { type: 'select', field: 'level', title: 'Level', options: [{ label: 'L', value: 'low' }] },
    { type: 'inputNumber', field: 'amount', title: 'Amount', props: { max: 10 } },
    { type: 'qw-dict-select', field: 'kind', title: 'Kind', props: { code: 'biz.leave_kind' } },
    { type: 'qw-upload', field: 'files', title: 'Files', props: { limit: 1 } },
    {
      type: 'qw-detail-table',
      field: 'items',
      title: 'Items',
      $required: true,
      props: { columns: [{ prop: 'note' }] },
    },
  ])
  const dicts = new Map([['biz.leave_kind', dict('biz.leave_kind', ['personal'])]])
  const fields = {
    reason: 'string',
    level: 'string',
    amount: 'number',
    kind: 'string',
    files: 'string',
    items: 'string',
  } as const
  const check = (values: Record<string, unknown>, only: Partial<typeof fields> = fields) =>
    checkValues(only, f, values, dicts, formTitles(f, formText(f)))

  it('says what is wrong per field, the title in the message', () => {
    expect(
      check({
        reason: ' ',
        level: 'high',
        amount: 11,
        kind: 'sick',
        files: '1/a.pdf\n2/b.pdf',
        items: '[{"note":" "}]',
      }),
    ).toEqual({
      reason: '事由不能为空',
      level: expect.any(String),
      amount: expect.stringContaining('10'),
      kind: expect.any(String),
      files: expect.any(String),
      items: 'Items不能为空',
    })
    expect(
      check({ reason: 'x', level: 'low', amount: 10, kind: 'personal', files: '1/a.pdf', items: '[{"note":"a"}]' }),
    ).toEqual({})
  })

  it('checks only the fields given (an approver’s edit ones)', () => {
    expect(check({ reason: 'ok' }, { reason: 'string' })).toEqual({})
    expect(check({}, { reason: 'string' })).toEqual({ reason: '事由不能为空' })
  })

  it('sends only the edit fields', () => {
    expect(editableValues({ a: 1, b: 2, c: 3 }, { a: 'edit', b: 'read' })).toEqual({ a: 1 })
    expect(editableValues({ budget: null, x: 1 }, { budget: 'edit', x: 'read' })).toEqual({ budget: null })
  })

  it('clears a blank number; preserves invalid text; null still fails a required number', () => {
    expect(['', '  ', '12.5', 'abc'].map(numberInput)).toEqual([null, null, 12.5, 'abc'])
    setLocale('en-US')
    const required = form([{ type: 'inputNumber', field: 'budget', title: 'Budget', $required: true }])
    expect(checkValues({ budget: 'number' }, required, { budget: null }, new Map(), { budget: 'Budget' }))
      .toEqual({ budget: 'Budget is required' })
  })
})

describe('shown values (calc results)', () => {
  const f = form([
    { type: 'datePicker', field: 'start', title: 'S' },
    { type: 'datePicker', field: 'end', title: 'E' },
    { type: 'qw-date-range-days', field: 'days', title: 'D', props: { startField: 'start', endField: 'end' } },
    {
      type: 'qw-detail-table',
      field: 'items',
      title: 'I',
      props: { columns: [{ prop: 'note' }, { prop: 'amount', sum: 'total' }] },
    },
  ])

  it('recomputes days and totals as the server does', () => {
    const shown = shownValues(f, {
      start: '2026-12-07',
      end: '2026-12-09',
      days: 99,
      items: '[{"note":"a","amount":10},{"amount":5.5},{}]',
      total: 1,
    })
    expect([shown.days, shown.total]).toEqual([3, 15.5])
  })

  it('keeps the server’s days when its dates are hidden from the reader', () => {
    const hidden = processForm(
      { rule: f.rule },
      { start: 'hide', end: 'hide' },
    )!
    expect(shownValues(hidden, { days: 3 }).days).toBe(3)
  })
})

describe('read-only texts', () => {
  const f = form([
    {
      type: 'radio',
      field: 'level',
      title: 'L',
      options: [
        { label: '{{$t.low}}', value: 'low' },
        { label: '{{$t.high}}', value: 'high' },
      ],
    },
    { type: 'switch', field: 'on', title: 'On' },
    { type: 'switch', field: 'yes', title: 'Y', props: { activeValue: 'y', activeText: 'Sure' } },
    { type: 'qw-user-select', field: 'user', title: 'U' },
    { type: 'qw-dept-select', field: 'dept', title: 'D' },
    { type: 'qw-area-select', field: 'area', title: 'A' },
    { type: 'qw-upload', field: 'files', title: 'F' },
    { type: 'qw-dict-select', field: 'kind', title: 'K', props: { code: 'k' } },
    { type: 'datePicker', field: 'at', title: 'At', props: { type: 'datetime' } },
    { type: 'datePicker', field: 'span', title: 'Sp', props: { type: 'daterange' } },
    {
      type: 'cascader',
      field: 'cat',
      title: 'C',
      options: [{ label: 'A', value: 'a', children: [{ label: 'B', value: 'b' }] }],
    },
  ])
  const look: Lookups = {
    users: new Map([[9, 'OA Employee']]),
    depts: [{ id: 1, parentId: 0, name: 'seed.dept.hq', children: [] }],
    areas: [{ label: '北京市', value: '110000', children: [{ label: '东城区', value: '110101' }] }],
    dicts: new Map([['k', dict('k', ['personal'])]]),
  }
  const text = (field: string, value: unknown) => fieldText(view(f, field), value, look, formText(f))

  it('shows labels, names and local times for the values', () => {
    expect(text('level', 'high')).toBe('高')
    expect([text('on', true), text('on', false), text('yes', 'y'), text('yes', 'n')]).toEqual([
      '是',
      '否',
      'Sure',
      '否',
    ])
    expect([text('user', 9), text('user', 10)]).toEqual(['OA Employee', '#10'])
    expect([text('dept', 1), text('dept', 2)]).toEqual(['总部', '2'])
    expect(text('area', ['110000', '110101'])).toBe('北京市 / 东城区')
    expect(text('files', '3/a.pdf\n4/b.png')).toBe('a.pdf · b.png')
    expect(text('kind', 'personal')).toBe('PERSONAL')
    expect(text('at', '2026-12-07T09:00:00+08:00')).toBe(formatTime('2026-12-07T09:00:00+08:00'))
    expect(text('span', ['2026-12-07', '2026-12-09'])).toBe('2026-12-07 ~ 2026-12-09')
    expect(text('cat', ['a', 'b'])).toBe('A / B')
    expect(text('level', null)).toBe('')
    setLocale('en-US')
    expect(fieldText(view(f, 'level'), 'low', look, formText(f))).toBe('Low')
  })

  it('days in words', () => {
    const d = { widget: 'days' } as FieldView
    expect(fieldText(d, 3, look, (s) => s ?? '')).toBe('3 天')
  })
})

it('uploads: lines ↔ QwUpload objects', () => {
  const list = uploadObjects('3/a.pdf\n4/b c.png')
  expect(list.map((o) => [o.id, o.originalName])).toEqual([
    [3, 'a.pdf'],
    [4, 'b c.png'],
  ])
  expect(uploadValue(list)).toBe('3/a.pdf\n4/b c.png')
  expect([uploadObjects(''), uploadObjects(null), uploadObjects('bad'), uploadValue([])]).toEqual([
    [],
    [],
    [],
    null,
  ])
})

it('the Object.hasOwn polyfill is there for older JS engines (jitless, imported first)', async () => {
  const own = Object.hasOwn
  // @ts-expect-error simulating an engine without it
  delete Object.hasOwn
  try {
    vi.resetModules()
    await import('@/core/jitless')
    expect(Object.hasOwn({ a: 1 }, 'a')).toBe(true)
    expect(Object.hasOwn(Object.create({ a: 1 }), 'a')).toBe(false)
  } finally {
    Object.hasOwn = own
  }
})
