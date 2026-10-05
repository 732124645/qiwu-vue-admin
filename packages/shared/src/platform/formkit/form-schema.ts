import { z } from 'zod'
import { validationMessage, type ValidationMessage } from '../../validation/zod-i18n.js'
import { CG_IDENT } from '../codegen/codegen.schema.js'

/**
 * form-create rule `type`s a form may use (see docs/design-notes.md#workflow): Element Plus inputs plus our `qw-*` components.
 * No layout, html, iframe, rich text, api-select or other container / markup types.
 */
export const FORM_COMPONENT_TYPES = [
  'input',
  'textarea',
  'inputNumber',
  'select',
  'radio',
  'checkbox',
  'switch',
  'datePicker',
  'timePicker',
  'rate',
  'slider',
  'cascader',
  'upload',
  'qw-user-select',
  'qw-dept-select',
  'qw-dict-select',
  'qw-upload',
  'qw-area-select',
  // calc components: their results are recomputed by the server (form-calc.ts)
  'qw-date-range-days',
  'qw-detail-table',
] as const
export type FormComponentType = (typeof FORM_COMPONENT_TYPES)[number]

export const FORM_RULES_MAX = 200
export const FORM_OPTIONS_MAX = 500
/** nesting of objects / arrays in the whole schema */
export const FORM_JSON_DEPTH_MAX = 32
/** keys + array items in the whole schema */
export const FORM_JSON_VALUES_MAX = 50_000
/** errors reported at most (a hostile payload may hold thousands) */
export const FORM_ERRORS_MAX = 20

export const FORM_SCHEMA_CODES = [
  /** past `FORM_JSON_DEPTH_MAX` nesting or `FORM_JSON_VALUES_MAX` values; reported alone */
  'too_large',
  /** an event / data-loading / linkage key (`on`, `fetch`, `effect`, `$x`, …) or a prototype key, anywhere */
  'forbidden_key',
  /** a function, or a string form-create would run as code (`$FN:`, `function …`, arrow, …), anywhere */
  'code',
  /** a rule `type` outside `FORM_COMPONENT_TYPES` */
  'unknown_type',
  /** two rules with the same `field` (a `qw-detail-table` total counts as one) */
  'duplicate_field',
  /** a `qw-date-range-days` without its start / end date fields, or naming a field the form lacks */
  'calc_ref',
  /** wrong shape of a whitelisted key; `message` holds the zod key + params */
  'shape',
] as const
export type FormSchemaCode = (typeof FORM_SCHEMA_CODES)[number]

export interface FormSchemaError {
  code: FormSchemaCode
  path: (string | number)[]
  message: ValidationMessage
}

// ---- whitelist (zod objects strip every key they do not list) ----

const b = z.boolean().optional()
const n = z.number().optional()
const s = z.string().max(200).optional()
const color = z
  .string()
  .regex(/^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,20}|rgba?\(\s*[\d.,\s%]+\))$/)
  .optional()
const scalar = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])
const optionValue = z.union([z.string().max(200), z.number(), z.boolean()])

export interface FormOptionItem {
  label: string
  value: string | number | boolean
  disabled?: boolean
  children?: FormOptionItem[]
}
// cascader trees nest `children`; FORM_JSON_DEPTH_MAX bounds the recursion
const optionItem: z.ZodType<FormOptionItem> = z.object({
  label: z.string().max(200),
  value: optionValue,
  disabled: b,
  children: z.lazy(() => z.array(optionItem).max(FORM_OPTIONS_MAX)).optional(),
})
const options = z.array(optionItem).max(FORM_OPTIONS_MAX).optional()

const isRegExp = (p: string) => {
  try {
    new RegExp(p)
    return true
  } catch {
    return false
  }
}
/** form-create 3.3 `adapter` checks plus async-validator keys; no `validator` / `computed` */
const validateItem = z.object({
  mode: z
    .enum([
      'required',
      'pattern',
      'len',
      'maxLen',
      'minLen',
      'min',
      'max',
      'uppercase',
      'lowercase',
      'email',
      'url',
      'ip',
      'phone',
      'positive',
      'negative',
      'integer',
      'number',
    ])
    .optional(),
  trigger: z.enum(['blur', 'change', 'submit']).optional(),
  adapter: b,
  required: b,
  message: s,
  type: s,
  pattern: z.string().max(200).refine(isRegExp).optional(),
  len: n,
  min: n,
  max: n,
  minLen: n,
  maxLen: n,
  whitespace: b,
  uppercase: b,
  lowercase: b,
  email: b,
  url: b,
  ip: b,
  phone: b,
  positive: b,
  negative: b,
  integer: b,
  number: b,
})

const fieldName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  // `constructor`, `toString`, … would read through to Object.prototype in a values map
  .refine((f) => !(f in Object.prototype))
/** a field another rule names; the designer's settings leave an unset one blank */
const fieldRef = z.preprocess((v) => (v === '' ? undefined : v), fieldName.optional())

export const DETAIL_COLUMNS_MAX = 20
/** a `qw-detail-table` column: a text cell, or a number cell when `sum` names the field of its total */
const detailColumn = z.object({ prop: fieldName, label: s, sum: fieldRef })

const base = {
  field: fieldName,
  title: s,
  info: z.string().max(500).optional(),
  $required: z.union([z.boolean(), z.string().max(200)]).optional(),
  value: z
    .union([scalar, z.array(z.union([scalar, z.array(scalar).max(50)])).max(FORM_OPTIONS_MAX)])
    .optional(),
  validate: z.array(validateItem).max(20).optional(),
  hidden: b,
  display: b,
  col: z.object({ span: z.number().int().min(1).max(24).optional() }).optional(),
  wrap: z.object({ labelWidth: z.string().max(20).optional() }).optional(),
  // designer bookkeeping: inert ids / its own menu name
  _fc_id: s,
  _fc_drag_tag: s,
  name: s,
}

const state = { disabled: b, readonly: b, clearable: b, placeholder: s }
const inputProps = {
  ...state,
  type: s,
  maxlength: n,
  minlength: n,
  showWordLimit: b,
  rows: n,
  autosize: z.union([z.boolean(), z.object({ minRows: n, maxRows: n })]).optional(),
}
const pickerProps = {
  ...state,
  editable: b,
  startPlaceholder: s,
  endPlaceholder: s,
  format: s,
  valueFormat: s,
  align: s,
}

const rule = <T extends FormComponentType, P extends z.ZodRawShape>(type: T, props: P) =>
  z.object({ ...base, type: z.literal(type), props: z.object(props).optional(), options })

const formRule = z.discriminatedUnion('type', [
  rule('input', inputProps),
  rule('textarea', inputProps),
  rule('inputNumber', {
    ...state,
    min: n,
    max: n,
    precision: n,
    step: n,
    stepStrictly: b,
    controls: b,
    controlsPosition: s,
  }),
  rule('select', {
    ...state,
    multiple: b,
    collapseTags: b,
    multipleLimit: n,
    filterable: b,
    allowCreate: b,
    noMatchText: s,
    noDataText: s,
    reserveKeyword: b,
    defaultFirstOption: b,
    options,
  }),
  rule('radio', { disabled: b, type: s, textColor: color, fill: color, options }),
  rule('checkbox', {
    disabled: b,
    type: s,
    min: n,
    max: n,
    textColor: color,
    fill: color,
    options,
  }),
  rule('switch', {
    disabled: b,
    width: n,
    activeText: s,
    inactiveText: s,
    activeValue: optionValue.optional(),
    inactiveValue: optionValue.optional(),
    activeColor: color,
    inactiveColor: color,
  }),
  rule('datePicker', { ...pickerProps, type: s, rangeSeparator: s, unlinkPanels: b }),
  rule('timePicker', { ...pickerProps, isRange: b, arrowControl: b, rangeSeparator: s }),
  rule('rate', {
    disabled: b,
    max: n,
    allowHalf: b,
    showScore: b,
    showText: b,
    scoreTemplate: s,
    voidColor: color,
    disabledVoidColor: color,
    textColor: color,
  }),
  rule('slider', {
    disabled: b,
    range: b,
    min: n,
    max: n,
    step: n,
    showInput: b,
    showInputControls: b,
    showStops: b,
    vertical: b,
    height: s,
  }),
  rule('cascader', {
    ...state,
    // label / value / children key remapping and lazy loading are not taken
    props: z
      .object({
        multiple: b,
        checkStrictly: b,
        emitPath: b,
        expandTrigger: z.enum(['click', 'hover']).optional(),
      })
      .optional(),
    showAllLevels: b,
    collapseTags: b,
    collapseTagsTooltip: b,
    separator: s,
    filterable: b,
    tagType: s,
    options,
  }),
  // stock upload without a target (no action / headers / data / hooks): files go through qw-upload;
  // no `text` list: its preview does `window.open(<value>)`
  rule('upload', {
    disabled: b,
    listType: z.enum(['picture', 'picture-card']).optional(),
    multiple: b,
    accept: s,
    limit: n,
  }),
  rule('qw-user-select', state),
  rule('qw-dept-select', state),
  rule('qw-dict-select', {
    ...state,
    multiple: b,
    code: z.string().regex(CG_IDENT.dictCode).optional(),
  }),
  rule('qw-upload', { disabled: b, limit: n, accept: s, maxSize: n }),
  rule('qw-area-select', state),
  rule('qw-date-range-days', {
    // always read-only; allowed so a read-only process form can disable every rule alike
    disabled: b,
    startField: fieldRef,
    endField: fieldRef,
    // radio / select fields whose `'pm'` start or `'am'` end counts half a day
    startHalfField: fieldRef,
    endHalfField: fieldRef,
  }),
  rule('qw-detail-table', {
    disabled: b,
    columns: z.array(detailColumn).max(DETAIL_COLUMNS_MAX).optional(),
  }),
])
export type FormRule = z.infer<typeof formRule>

const button = z.union([z.boolean(), z.object({ show: b, innerText: s })]).optional()
const formOption = z.object({
  form: z
    .object({
      labelPosition: z.enum(['left', 'right', 'top']).optional(),
      size: z.enum(['large', 'default', 'small']).optional(),
      labelWidth: z.string().max(20).optional(),
      labelSuffix: s,
      hideRequiredAsterisk: b,
      showMessage: b,
      inlineMessage: b,
    })
    .optional(),
  submitBtn: button,
  resetBtn: button,
  // the designer's `{{$t.<id>}}` texts: locale → id → text
  language: z
    .record(
      z.string().regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/),
      z.record(z.string().regex(/^[A-Za-z][\w-]{0,63}$/), z.string().max(500)),
    )
    .optional(),
})

export const formSchema = z.object({
  rule: z.array(formRule).max(FORM_RULES_MAX),
  option: formOption.optional(),
})
export type FormSchema = z.infer<typeof formSchema>

// ---- blacklist scan of the raw input (everything, including what the whitelist would strip) ----

/** form-create keys that carry behaviour (events, loading, linkage, render hooks); `$x` keys are effects */
const FORBIDDEN_KEYS = new Set([
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
])
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const forbiddenKey = (k: string) =>
  FORBIDDEN_KEYS.has(k) || /^on[A-Z]/.test(k) || (k.startsWith('$') && k !== '$required')
/** the designer's own defaults hold blank ones (`effect: { fetch: '' }`): nothing to run, stripped below */
const blank = (v: unknown) =>
  v == null ||
  v === '' ||
  (typeof v === 'object' && Object.values(v).every((x) => x == null || x === ''))

const ESCAPE = /\\u\{0*([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g
// whitespace as String#trim (form-create trims before its checks) plus zero-width characters
const LEADING = /^[\s\u200b-\u200d\u2060]+/
/** form-create `parseFn` prefixes (`$FN:`, `$FNX:`, `$EXEC:`, `$GLOBAL:`, `[[FORM-CREATE-PREFIX-`) */
const FC_CODE = /^(\$(FN|EXEC|GLOBAL)|\[\[FORM-CREATE-PREFIX-)/i
/** function sources: `function …`, `async …`, `(…) =>`, `x =>` */
const JS_CODE = /^(function\b|async\b|\([\s\S]*?\)\s*=>|[\w$]+\s*=>)/
/** A string form-create would turn into a function, or one that reads as a function (JS escapes decoded). */
export function isCodeString(str: string): boolean {
  const head = str
    .replace(ESCAPE, (_, cp?: string, u?: string, x?: string) =>
      String.fromCodePoint(Math.min(parseInt(cp ?? u ?? x ?? '0', 16), 0x10ffff)),
    )
    .replace(LEADING, '')
  return FC_CODE.test(head) || JS_CODE.test(head)
}

type Path = (string | number)[]
const fail = (code: FormSchemaCode, path: Path, params: Record<string, string | number> = {}) => ({
  code,
  path,
  message: { key: `validation.form.${code}`, params },
})
const TOO_LARGE = () =>
  fail('too_large', [], {
    rules: FORM_RULES_MAX,
    depth: FORM_JSON_DEPTH_MAX,
    values: FORM_JSON_VALUES_MAX,
  })

/**
 * Walks every value with an explicit stack (a deep payload would overflow the call stack in zod's
 * recursive parse), stopping past `FORM_JSON_DEPTH_MAX` nesting or `FORM_JSON_VALUES_MAX` values (the
 * latter keeps shared references or cycles in an in-memory schema linear).
 */
function scan(input: unknown): FormSchemaError[] {
  const errors: FormSchemaError[] = []
  const stack: [unknown, Path][] = [[input, []]]
  let values = 0
  while (stack.length && errors.length < FORM_ERRORS_MAX) {
    const [value, path] = stack.pop()!
    if (typeof value === 'function' || (typeof value === 'string' && isCodeString(value))) {
      errors.push(fail('code', path, { path: path.join('.') }))
      continue
    }
    if (!value || typeof value !== 'object') continue
    if (path.length >= FORM_JSON_DEPTH_MAX) return [TOO_LARGE()]
    const list = Array.isArray(value)
    for (const key of Object.keys(value)) {
      if (++values > FORM_JSON_VALUES_MAX) return [TOO_LARGE()]
      // a reported path repeats its keys in every error below them: bound what a hostile key echoes
      const at = [...path, list && /^\d+$/.test(key) ? Number(key) : key.slice(0, 64)]
      const child = (value as Record<string, unknown>)[key]
      if (PROTO_KEYS.has(key) || (forbiddenKey(key) && !blank(child)))
        errors.push(fail('forbidden_key', at, { key: key.slice(0, 64) }))
      else stack.push([child, at])
    }
  }
  return errors
}

const DAY_TYPES = [undefined, 'date', 'datetime']
const HALF_KEYS = ['startHalfField', 'endHalfField'] as const

/**
 * The `valueFormat` of a one-day `datePicker` (`props.type` unset, `date` or `datetime`), forced on save and
 * before rendering: a process form's `date` fields take ISO dates and datetimes with an offset only,
 * form-create's own defaults (`YYYY-MM-DD HH:mm:ss`) are neither. The display `format` stays the designer's.
 */
export const DATE_VALUE_FORMAT = { date: 'YYYY-MM-DD', datetime: 'YYYY-MM-DD[T]HH:mm:ssZ' } as const

/** `qw-date-range-days` settings: start / end name single-date fields, a half-day field another rule. */
function calcRefs(rules: FormRule[]): FormSchemaError[] {
  const fields = new Set(rules.map((r) => r.field))
  const dates = new Set(
    rules
      .filter((r) => r.type === 'datePicker' && DAY_TYPES.includes(r.props?.type))
      .map((r) => r.field),
  )
  return rules.flatMap((r, i) => {
    if (r.type !== 'qw-date-range-days') return []
    const p = r.props ?? {}
    const bad = [
      ...(['startField', 'endField'] as const).filter((k) => !dates.has(p[k] ?? '')),
      ...HALF_KEYS.filter((k) => p[k] !== undefined && (!fields.has(p[k]) || p[k] === r.field)),
    ]
    return bad.map((k) => fail('calc_ref', ['rule', i, 'props', k]))
  })
}

export type FormSchemaResult =
  { ok: true; schema: FormSchema } | { ok: false; errors: FormSchemaError[] }

/**
 * The form-create schema `{ rule, option }` as a deep whitelist (see docs/design-notes.md#workflow, docs/adr/004-form-create.md): rejects code,
 * behaviour keys and unknown component types anywhere, strips every key the whitelist does not list, sets
 * a one-day date picker's `valueFormat` ({@link DATE_VALUE_FORMAT}). Same code on save (server, 400 on
 * errors) and before rendering (browser).
 */
export function sanitizeFormSchema(input: unknown): FormSchemaResult {
  let errors = scan(input)
  if (errors.length) return { ok: false, errors }

  const rules = (input as { rule?: unknown } | null)?.rule
  if (Array.isArray(rules))
    rules.forEach((r, i) => {
      const type = (r as { type?: unknown } | null)?.type
      if (typeof type === 'string' && !(FORM_COMPONENT_TYPES as readonly string[]).includes(type))
        errors.push(fail('unknown_type', ['rule', i, 'type'], { type: type.slice(0, 64) }))
    })
  if (errors.length) return { ok: false, errors: errors.slice(0, FORM_ERRORS_MAX) }

  const parsed = formSchema.safeParse(input)
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, FORM_ERRORS_MAX).map((issue) => ({
        code: 'shape',
        // a `language` key that fails its regex is echoed here: bounded like the scan's paths
        path: issue.path.map((p) => (typeof p === 'number' ? p : String(p).slice(0, 64))),
        message: validationMessage(issue),
      })),
    }

  // zod also reads inherited, non-enumerable and getter properties the scan did not see: check what it kept
  errors = scan(parsed.data)
  const { rule } = parsed.data
  const seen = new Set<string>()
  // param `name`: translators put the field label into `field`
  const once = (name: string, path: Path) => {
    if (seen.has(name)) errors.push(fail('duplicate_field', path, { name }))
    seen.add(name)
  }
  rule.forEach((r, i) => {
    once(r.field, ['rule', i, 'field'])
    if (r.type === 'qw-detail-table')
      r.props?.columns?.forEach(({ sum }, j) => {
        if (sum !== undefined) once(sum, ['rule', i, 'props', 'columns', j, 'sum'])
      })
  })
  errors.push(...calcRefs(rule))
  for (const r of rule)
    if (r.type === 'datePicker' && DAY_TYPES.includes(r.props?.type))
      r.props = {
        ...r.props,
        valueFormat: DATE_VALUE_FORMAT[r.props?.type === 'datetime' ? 'datetime' : 'date'],
      }
  return errors.length
    ? { ok: false, errors: errors.slice(0, FORM_ERRORS_MAX) }
    : { ok: true, schema: parsed.data }
}
