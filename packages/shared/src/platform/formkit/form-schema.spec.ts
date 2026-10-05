import { describe, expect, it } from 'vitest'
import {
  DATE_VALUE_FORMAT,
  FORM_ERRORS_MAX,
  FORM_JSON_DEPTH_MAX,
  FORM_JSON_VALUES_MAX,
  FORM_RULES_MAX,
  isCodeString,
  sanitizeFormSchema,
  type FormSchemaError,
} from './form-schema.js'

type Json = Record<string, unknown>
const select = (extra: Json = {}): Json => ({
  type: 'select',
  field: 'kind',
  title: 'Kind',
  options: [{ label: 'A', value: 'a' }],
  ...extra,
})
const schema = (...rule: unknown[]) => ({ rule })
/** `n` options, or `n` copies of `item` */
const many = (n: number, item?: unknown) =>
  Array.from({ length: n }, (_, i) => item ?? { label: 'a', value: i })
const errorsOf = (input: unknown): FormSchemaError[] => {
  const r = sanitizeFormSchema(input)
  if (r.ok) throw new Error(`expected a rejection, got ${JSON.stringify(r.schema)}`)
  return r.errors
}
const codes = (input: unknown) => errorsOf(input).map((e) => e.code)
const clean = (input: unknown) => {
  const r = sanitizeFormSchema(input)
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`)
  return r.schema
}

describe('sanitizeFormSchema: designer output', () => {
  // the shape @form-create/designer 3.5 getRule()/getOption() produce, incl. its blank `effect.fetch`
  const designed = {
    rule: [
      {
        type: 'input',
        field: 'Fa1b2c3',
        title: 'Reason',
        info: '',
        $required: 'Reason is required',
        props: { type: 'textarea', maxlength: 200, placeholder: 'Why' },
        validate: [
          { mode: 'minLen', minLen: 2, trigger: 'blur', adapter: true, message: 'Too short' },
        ],
        _fc_id: 'id_Fa1b2c3',
        name: 'ref_Fa1b2c3',
        display: true,
        hidden: false,
        _fc_drag_tag: 'textarea',
      },
      select({ effect: { fetch: '' }, props: { multiple: true }, $required: false }),
      {
        type: 'cascader',
        field: 'area',
        props: {
          props: { checkStrictly: true },
          options: [{ label: 'x', value: 1, children: [{ label: 'y', value: 2 }] }],
        },
      },
      { type: 'qw-dict-select', field: 'gender', props: { code: 'iam.gender' } },
      { type: 'qw-upload', field: 'files', props: { limit: 3, accept: '.pdf' } },
    ],
    option: {
      form: { labelPosition: 'right', size: 'default', labelWidth: '125px' },
      submitBtn: { show: true, innerText: 'Submit' },
      resetBtn: false,
      language: { 'zh-cn': { k1: 'a' }, en: { k1: 'b' } },
    },
  }

  it('keeps whitelisted keys and drops the blank effect', () => {
    const out = clean(designed)
    const { effect: _dropped, ...kept } = designed.rule[1] as Json
    expect(out.rule[1]).toEqual(kept)
    expect(out.rule[0]).toEqual(designed.rule[0])
    expect(out.rule.slice(2)).toEqual(designed.rule.slice(2))
    expect(out.option).toEqual(designed.option)
  })

  it('is idempotent (server save → browser render run the same filter)', () => {
    const once = clean(designed)
    expect(clean(once)).toEqual(once)
    expect(clean(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('strips keys and props outside the whitelist, returning fresh objects', () => {
    const input = schema(
      select({
        style: { background: 'url(https://x.test/leak)' },
        class: 'x',
        children: [{ type: 'html', field: 'h' }],
        slot: 'default',
        native: true,
        props: { innerHTML: '<img src=x>', remote: true, remoteMethod: 'x', filterable: true },
        options: [{ label: 'A', value: 'a', class: 'x', style: 'color:red', disabled: true }],
        validate: [{ required: true, transform: 'x', enum: ['a'], fields: { a: 1 } }],
        col: { span: 12, push: 3 },
        wrap: { labelWidth: '80px', class: 'x' },
      }),
      {
        type: 'upload',
        field: 'u',
        props: {
          action: 'https://x.test',
          headers: { a: 'b' },
          data: { a: 1 },
          withCredentials: true,
          limit: 2,
        },
      },
      {
        type: 'cascader',
        field: 'c',
        props: { props: { lazy: true, value: 'id', multiple: true } },
      },
      { type: 'input', field: 'i', props: { autosize: { minRows: 2, style: 'x' } } },
    )
    const out = clean({
      ...input,
      config: { a: 1 },
      option: {
        formData: { kind: 'x' },
        globalData: {},
        style: '*{}',
        form: { labelPosition: 'top', model: { kind: 'x' }, rules: {}, class: 'x' },
        submitBtn: { show: false, type: 'danger', icon: 'x' },
      },
    })
    expect(out.rule[0]).toEqual({
      type: 'select',
      field: 'kind',
      title: 'Kind',
      props: { filterable: true },
      options: [{ label: 'A', value: 'a', disabled: true }],
      validate: [{ required: true }],
      col: { span: 12 },
      wrap: { labelWidth: '80px' },
    })
    expect(out.rule[1]).toEqual({ type: 'upload', field: 'u', props: { limit: 2 } })
    expect(out.rule[2]).toEqual({
      type: 'cascader',
      field: 'c',
      props: { props: { multiple: true } },
    })
    expect(out.rule[3]).toEqual({ type: 'input', field: 'i', props: { autosize: { minRows: 2 } } })
    expect(out.option).toEqual({ form: { labelPosition: 'top' }, submitBtn: { show: false } })
    expect(Object.keys(out)).toEqual(['rule', 'option'])
    expect(out.rule[0]).not.toBe(input.rule[0])
  })
})

describe('sanitizeFormSchema: code strings anywhere', () => {
  const payloads = [
    '$FN:alert(1)',
    '$FNX:$inject.api.submit()',
    '$EXEC:fetch("/x")',
    '$GLOBAL:leak',
    '$fn:alert(1)',
    '[[FORM-CREATE-PREFIX-function(){alert(1)}-FORM-CREATE-SUFFIX]]',
    'function () { alert(1) }',
    'function(){}',
    'function\n x(){}',
    'async () => 1',
    '(a, b) => a',
    '(\n) \n=> alert(1)',
    'x => x',
    '$x=>1',
    '  \t\n$FN:alert(1)',
    '\u00a0\ufeff\u2028$FN:alert(1)',
    '\u200b\u200d\u2060$FN:alert(1)',
    // JS escapes as literal text: decoded before the check
    '\\u0024FN:alert(1)',
    '\\u{24}FN:alert(1)',
    '\\u{00000024}FN:alert(1)',
    '\\x24FN:alert(1)',
    '\\u0066unction(){}',
    '\\u0020\\u00a0$EXEC:x',
    JSON.parse('"\\u0024FN:alert(1)"') as string,
  ]
  it.each(payloads)('rejects %j', (p) => {
    expect(isCodeString(p)).toBe(true)
    expect(codes(schema(select({ title: p })))).toEqual(['code'])
  })

  it.each([
    'functionality',
    'Function key',
    '$100',
    '(optional) note',
    'x >= 1',
    'a == b',
    '\\u{110000}x',
    '',
  ])('accepts plain %j', (p) => expect(isCodeString(p)).toBe(false))

  it('finds code at any depth, in keys the whitelist would strip too', () => {
    const at = (input: unknown) => errorsOf(input).map((e) => [e.code, e.path.join('.')])
    expect(
      at(
        schema(
          select({
            options: [{ label: 'a', value: 'a', children: [{ label: '$FN:x', value: 1 }] }],
          }),
          select({ field: 'b', props: { placeholder: 'x', unknown: { deep: ['function(){}'] } } }),
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        ['code', 'rule.0.options.0.children.0.label'],
        ['code', 'rule.1.props.unknown.deep.0'],
      ]),
    )
    expect(at({ rule: [], option: { submitBtn: { innerText: '$FNX:x' } } })).toEqual([
      ['code', 'option.submitBtn.innerText'],
    ])
    expect(at(schema(select({ value: ['a', '$EXEC:x'] })))).toEqual([['code', 'rule.0.value.1']])
    expect(errorsOf(schema(select({ title: '$FN:x' })))[0]!.message).toEqual({
      key: 'validation.form.code',
      params: { path: 'rule.0.title' },
    })
  })

  it('rejects function values (an in-memory schema in the browser)', () => {
    expect(codes(schema(select({ props: { formatter: () => 1 } })))).toEqual(['code'])
    expect(codes(() => 1)).toEqual(['code'])
  })

  it('bounds the keys it echoes in paths and params', () => {
    const long = 'k'.repeat(5000)
    const errors = errorsOf({ rule: [], option: { [long]: ['$FN:a', '$FN:b'], ['$' + long]: 1 } })
    expect(errors).toHaveLength(3)
    for (const e of errors) expect(JSON.stringify(e).length).toBeLessThan(400)
    const [type] = errorsOf(schema({ type: long, field: 'x' }))
    expect(type!.code).toBe('unknown_type')
    expect(JSON.stringify(type).length).toBeLessThan(400)
    // zod's own issues: a `language` key failing its regex
    const [shape] = errorsOf({ rule: [], option: { language: { [long]: {} } } })
    expect(shape!.code).toBe('shape')
    expect(JSON.stringify(shape).length).toBeLessThan(400)
  })

  it('checks what zod kept too (inherited, hidden or getter properties of an in-memory rule)', () => {
    const rule = { type: 'input', field: 'x' }
    const inherited = Object.assign(Object.create({ title: '$FN:a' }) as Json, rule)
    const hidden = Object.defineProperty({ ...rule }, 'title', { value: '$FN:a' })
    let reads = 0
    const getter = {
      ...rule,
      get title() {
        return reads++ ? '$FN:a' : 'ok'
      },
    }
    for (const r of [inherited, hidden, getter]) expect(codes(schema(r))).toEqual(['code'])
  })

  it('checks long strings in linear time', () => {
    const started = Date.now()
    for (const s of [
      '(' + ')'.repeat(1e6),
      '(' + ') '.repeat(5e5),
      'a'.repeat(1e6) + '!',
      ' '.repeat(1e6),
      '\\u{'.repeat(1e5) + '0'.repeat(1e6),
    ])
      expect(isCodeString(s)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("rejects the designer's stock upload (its onSuccess default is $FNX)", () => {
    const upload = {
      type: 'upload',
      field: 'u',
      props: { action: '/', onSuccess: '$FNX:const res = $inject.args[0];' },
    }
    expect(codes(schema(upload))).toEqual(['forbidden_key'])
  })
})

describe('sanitizeFormSchema: behaviour keys anywhere', () => {
  const keys = [
    'on',
    'nativeOn',
    'hook',
    'update',
    'fetch',
    'inject',
    'emit',
    'nativeEmit',
    'computed',
    'control',
    'effect',
    'validator',
    'asyncValidator',
    'component',
    'render',
    'template',
    'vm',
    'directives',
    'slotUpdate',
    'onClick',
    'onUpdate:modelValue',
    '$loadData',
    '$fetch',
    '$t',
    '$componentValidate',
  ]
  it.each(keys)('rejects %j on a rule, in props, options and validate', (key) => {
    const bad = { [key]: { x: 'alert' } }
    expect(errorsOf(schema(select(bad)))[0]).toMatchObject({
      code: 'forbidden_key',
      path: ['rule', 0, key],
      message: { key: 'validation.form.forbidden_key', params: { key } },
    })
    expect(codes(schema(select({ props: bad })))).toEqual(['forbidden_key'])
    expect(codes(schema(select({ options: [{ label: 'a', value: 1, ...bad }] })))).toEqual([
      'forbidden_key',
    ])
    expect(codes(schema(select({ validate: [{ required: true, ...bad }] })))).toEqual([
      'forbidden_key',
    ])
    expect(codes({ rule: [], option: { form: bad } })).toEqual(['forbidden_key'])
  })

  it('rejects a validate[].validator given as text (form-create would compile it)', () => {
    expect(codes(schema(select({ validate: [{ validator: 'return true' }] })))).toEqual([
      'forbidden_key',
    ])
  })

  it('keeps $required; drops blank behaviour keys (designer defaults) instead of rejecting', () => {
    const out = clean(
      schema(
        select({
          $required: true,
          on: {},
          hook: null,
          effect: { fetch: '', loadData: null },
          control: [],
        }),
      ),
    )
    expect(out.rule[0]).toEqual({ ...select(), $required: true })
    expect(codes(schema(select({ effect: { fetch: { action: '/x' } } })))).toEqual([
      'forbidden_key',
    ])
    expect(codes(schema(select({ effect: { fetch: 'x' } })))).toEqual(['forbidden_key'])
    expect(codes(schema(select({ on: false })))).toEqual(['forbidden_key'])
  })

  it('rejects prototype keys even when blank', () => {
    const proto = JSON.parse(
      '{"rule":[],"option":{"form":{"__proto__":{"polluted":1}}}}',
    ) as unknown
    expect(codes(proto)).toEqual(['forbidden_key'])
    expect(({} as Json).polluted).toBeUndefined()
    expect(codes(schema(select({ constructor: '' })))).toEqual(['forbidden_key'])
    expect(codes(schema(select({ props: { prototype: null } })))).toEqual(['forbidden_key'])
    expect(codes(JSON.parse('{"rule":[],"__proto__":""}'))).toEqual(['forbidden_key'])
  })

  it('names a key set on an in-memory array', () => {
    expect(errorsOf({ rule: Object.assign([], { on: 'x' }) })[0]!.path).toEqual(['rule', 'on'])
  })

  it(`reports at most ${FORM_ERRORS_MAX} errors`, () => {
    const many = Array.from({ length: 100 }, (_, i) => select({ field: `f${i}`, on: { x: 1 } }))
    expect(errorsOf(schema(...many))).toHaveLength(FORM_ERRORS_MAX)
    const types = Array.from({ length: 100 }, (_, i) => ({ type: 'html', field: `f${i}` }))
    expect(errorsOf(schema(...types))).toHaveLength(FORM_ERRORS_MAX)
    const shapes = Array.from({ length: 100 }, () => ({ type: 'input', field: 'a b' }))
    expect(errorsOf(schema(...shapes))).toHaveLength(FORM_ERRORS_MAX)
    const twins = Array.from({ length: 100 }, () => select())
    expect(errorsOf(schema(...twins))).toHaveLength(FORM_ERRORS_MAX)
  })
})

describe('sanitizeFormSchema: size', () => {
  const nest = (levels: number) => {
    let v: unknown = 'leaf'
    for (let i = 0; i < levels; i++) v = { children: [v] }
    return v
  }
  it(`rejects nesting past ${FORM_JSON_DEPTH_MAX}, without recursion`, () => {
    // schema, rule list, rule, options list = 4 containers; each option adds itself + its children list
    let opt: Json = { label: 'a', value: 1, children: [] }
    for (let i = 1; i < (FORM_JSON_DEPTH_MAX - 4) / 2; i++)
      opt = { label: 'a', value: i, children: [opt] }
    expect(sanitizeFormSchema(schema(select({ options: [opt] }))).ok).toBe(true)
    expect(codes(schema(select({ options: [{ label: 'a', value: 1, children: [opt] }] })))).toEqual(
      ['too_large'],
    )
    expect(codes({ rule: [], option: { x: nest(100_000) } })).toEqual(['too_large'])
    expect(errorsOf(nest(FORM_JSON_DEPTH_MAX))[0]).toEqual({
      code: 'too_large',
      path: [],
      message: {
        key: 'validation.form.too_large',
        params: { rules: FORM_RULES_MAX, depth: FORM_JSON_DEPTH_MAX, values: FORM_JSON_VALUES_MAX },
      },
    })
  })

  it(`rejects more than ${FORM_JSON_VALUES_MAX} values, cycles and shared references`, () => {
    const wide = Array.from({ length: FORM_JSON_VALUES_MAX }, (_, i) => i)
    expect(codes({ rule: [], option: { wide } })).toEqual(['too_large'])
    const cyclic: Json = { rule: [] }
    cyclic.option = { form: cyclic }
    expect(codes(cyclic)).toEqual(['too_large'])
    const row = Array.from({ length: 1000 }, () => 'x')
    expect(codes({ rule: [], option: { rows: Array.from({ length: 1000 }, () => row) } })).toEqual([
      'too_large',
    ])
  })

  it(`rejects more than ${FORM_RULES_MAX} rules`, () => {
    const rules = Array.from({ length: FORM_RULES_MAX + 1 }, (_, i) => select({ field: `f${i}` }))
    expect(codes(schema(...rules))).toEqual(['shape'])
    expect(sanitizeFormSchema(schema(...rules.slice(1))).ok).toBe(true)
  })
})

describe('sanitizeFormSchema: types and shape', () => {
  it.each([
    'html',
    'fcEditor',
    'iframe',
    'elButton',
    'fcRow',
    'Input',
    'el-input',
    'ElInput',
    'span',
    'script',
  ])('rejects component type %j', (type) => {
    expect(errorsOf(schema(select(), { type, field: 'x' }))).toEqual([
      {
        code: 'unknown_type',
        path: ['rule', 1, 'type'],
        message: { key: 'validation.form.unknown_type', params: { type } },
      },
    ])
  })

  it.each([
    ['no type', { field: 'x' }],
    ['a non-string type', { type: ['input'], field: 'x' }],
    ['a text rule', 'hello'],
    ['no field', { type: 'input' }],
    ['a field with a space', { type: 'input', field: 'a b' }],
    ['a $ field', { type: 'input', field: '$initiator' }],
    ['an _ field', { type: 'input', field: '_x' }],
    ['a field read through Object.prototype', { type: 'input', field: 'toString' }],
    ['a constructor field', { type: 'input', field: 'constructor' }],
    ['a non-string title', { type: 'input', field: 'x', title: { a: 1 } }],
    [
      'a css injection colour',
      { type: 'switch', field: 'x', props: { activeColor: 'red;background:url(x)' } },
    ],
    [
      'a broken pattern',
      { type: 'input', field: 'x', validate: [{ mode: 'pattern', pattern: '(' }] },
    ],
    ['a validator mode', { type: 'input', field: 'x', validate: [{ mode: 'validator' }] }],
    ['an unknown check trigger', { type: 'input', field: 'x', validate: [{ trigger: 'hover' }] }],
    ['a bad dict code', { type: 'qw-dict-select', field: 'x', props: { code: 'A:B' } }],
    // fcUpload's `text` list previews a file with window.open(<value>)
    ['a text upload list', { type: 'upload', field: 'x', props: { listType: 'text' } }],
    ['an object value', { type: 'input', field: 'x', value: { a: 1 } }],
    ['an object option value', { ...select(), options: [{ label: 'a', value: { a: 1 } }] }],
    [
      'an unknown expand trigger',
      { type: 'cascader', field: 'x', props: { props: { expandTrigger: 'x' } } },
    ],
    // size bounds per value
    ['a long title', { type: 'input', field: 'x', title: 't'.repeat(201) }],
    ['a long required message', { type: 'input', field: 'x', $required: 't'.repeat(201) }],
    ['a long option label', { ...select(), options: [{ label: 't'.repeat(201), value: 1 }] }],
    ['a long option value', { ...select(), options: [{ label: 'a', value: 't'.repeat(201) }] }],
    ['too many values', { type: 'checkbox', field: 'x', value: many(501, 'a') }],
    ['too many nested values', { type: 'cascader', field: 'x', value: [many(51, 'a')] }],
    ['a long info', { type: 'input', field: 'x', info: 't'.repeat(501) }],
    ['a long value', { type: 'input', field: 'x', value: 't'.repeat(2001) }],
    ['too many options', { ...select(), options: many(501) }],
    [
      'too many cascader children',
      { type: 'cascader', field: 'x', options: [{ label: 'a', value: 0, children: many(501) }] },
    ],
    ['too many checks', { type: 'input', field: 'x', validate: many(21, { required: true }) }],
    ['a col span past 24', { type: 'input', field: 'x', col: { span: 25 } }],
    ['a long label width', { type: 'input', field: 'x', wrap: { labelWidth: '1'.repeat(21) } }],
  ])('rejects %s', (_, rule) => {
    expect(codes(schema(rule))).toEqual(['shape'])
  })

  it.each([
    ['a bad text id', { language: { en: { '9x': 'a' } } }],
    ['a long text', { language: { en: { k: 't'.repeat(501) } } }],
    ['an unknown label position', { form: { labelPosition: 'x' } }],
    ['an unknown size', { form: { size: 'huge' } }],
    ['a long label width', { form: { labelWidth: '1'.repeat(21) } }],
  ])('rejects an option with %s', (_, option) => {
    expect(codes({ rule: [], option })).toEqual(['shape'])
  })

  it('rejects a non-object schema and a missing rule list', () => {
    expect(codes(null)).toEqual(['shape'])
    expect(codes({ option: {} })).toEqual(['shape'])
    expect(codes({ rule: {} })).toEqual(['shape'])
  })

  it('rejects a field used twice', () => {
    expect(errorsOf(schema(select(), select({ type: 'radio' })))).toEqual([
      {
        code: 'duplicate_field',
        path: ['rule', 1, 'field'],
        message: { key: 'validation.form.duplicate_field', params: { name: 'kind' } },
      },
    ])
  })

  it('accepts every whitelisted component with an empty form', () => {
    const types = [
      'input',
      'textarea',
      'inputNumber',
      'select',
      'radio',
      'checkbox',
      'switch',
      'datePicker',
    ]
    const more = [
      'timePicker',
      'rate',
      'slider',
      'cascader',
      'upload',
      'qw-user-select',
      'qw-dept-select',
    ]
    const ours = ['qw-dict-select', 'qw-upload', 'qw-area-select']
    const rules = [...types, ...more, ...ours].map((type, i) => ({ type, field: `f${i}` }))
    expect(clean(schema(...rules)).rule).toEqual(
      rules.map((r) =>
        r.type === 'datePicker' ? { ...r, props: { valueFormat: DATE_VALUE_FORMAT.date } } : r,
      ),
    )
  })

  it("sets a one-day date picker's valueFormat (ISO values), leaves the other pickers alone", () => {
    const picker = (type?: string, valueFormat?: string) => ({
      type: 'datePicker',
      field: `f_${type ?? 'plain'}`,
      props: { ...(type && { type }), ...(valueFormat && { valueFormat }), format: 'YYYY/MM/DD' },
    })
    const rules = clean(
      schema(
        picker(),
        picker('date', 'YYYY/MM/DD'),
        picker('datetime', 'YYYY-MM-DD HH:mm:ss'),
        picker('month', 'YYYY-MM'),
        picker('daterange'),
      ),
    ).rule.map((r) => r.props)
    expect(rules).toEqual([
      { valueFormat: 'YYYY-MM-DD', format: 'YYYY/MM/DD' },
      { type: 'date', valueFormat: 'YYYY-MM-DD', format: 'YYYY/MM/DD' },
      { type: 'datetime', valueFormat: 'YYYY-MM-DD[T]HH:mm:ssZ', format: 'YYYY/MM/DD' },
      { type: 'month', valueFormat: 'YYYY-MM', format: 'YYYY/MM/DD' },
      { type: 'daterange', format: 'YYYY/MM/DD' },
    ])
  })
})
