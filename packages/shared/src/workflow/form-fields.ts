import { z } from 'zod'
import { detailRows } from '../platform/formkit/form-calc.js'
import {
  DATE_VALUE_FORMAT,
  FORM_OPTIONS_MAX,
  type FormOptionItem,
  type FormRule,
  type FormSchema,
} from '../platform/formkit/form-schema.js'
import { storageRefs } from '../platform/storage/storage.schema.js'
import { wfFieldName, type WfFields, type WfFieldType } from './wf.schema.js'

/**
 * form-create rule `type` → field type; a rule of any other type that binds a `field` is a `string` field
 * (a `qw-detail-table`'s rows are JSON text; each column total it names is a `number` field). A
 * field type is what conditions compare: list values (checkbox, multiple select, ranges …) stay `string`
 * fields, which no condition value equals.
 */
const FIELD_TYPES = new Map<unknown, WfFieldType>([
  ['inputNumber', 'number'],
  ['rate', 'number'],
  ['slider', 'number'],
  ['qw-date-range-days', 'number'],
  ['datePicker', 'date'],
  ['qw-user-select', 'user'],
  ['qw-dept-select', 'dept'],
])

export const WF_FORM_FIELDS_CODES = [
  /** a name `fields` does not take (over 64 chars, leading `$`), or `__proto__` (`wfFields` drops it) */
  'field_name',
  /** two rules bind the same field */
  'duplicate_field',
] as const
export type WfFormFieldsCode = (typeof WF_FORM_FIELDS_CODES)[number]
export interface WfFormFieldsError {
  code: WfFormFieldsCode
  field: string
}
export type WfFormFieldsResult =
  { ok: true; fields: WfFields } | { ok: false; errors: WfFormFieldsError[] }

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
/** a `datePicker` `props.type` of one day (`DATE_VALUE_FORMAT`): unset, `date` or `datetime` */
const isDayType = (t: unknown) =>
  t === undefined || (typeof t === 'string' && Object.hasOwn(DATE_VALUE_FORMAT, t))

/**
 * A dynamic form's `fields` (see docs/design-notes.md#workflow) from its form-create schema, a rule list or `{ rule }`. Every
 * rule with a non-empty string `field` counts, in document order, rules nested in layout `children` (row / col,
 * tabs, card, collapse …) at any depth included; rules without one (layouts, text) and anything not a rule are
 * skipped. The schema is expected sanitized (`control`, `group` / `subForm` rejected there), so no other key is
 * walked. Iterative, so deep nesting cannot overflow the stack.
 */
export function fieldsFromFormSchema(schema: unknown): WfFormFieldsResult {
  const rules = Array.isArray(schema) ? schema : isObject(schema) ? schema.rule : undefined
  const stack: unknown[] = []
  const pushAll = (list: unknown) => {
    // reversed, so the pops come in document order; a loop, not a spread (argument count limit)
    if (Array.isArray(list)) for (let i = list.length - 1; i >= 0; i--) stack.push(list[i])
  }
  pushAll(rules)

  const fields: WfFields = {}
  const errors: WfFormFieldsError[] = []
  const add = (field: string, type: WfFieldType) => {
    if (field === '__proto__' || !wfFieldName.safeParse(field).success)
      errors.push({ code: 'field_name', field })
    else if (Object.hasOwn(fields, field)) errors.push({ code: 'duplicate_field', field })
    else fields[field] = type
  }
  while (stack.length > 0) {
    const rule = stack.pop()
    if (!isObject(rule)) continue
    pushAll(rule.children)
    const { field, props } = rule
    if (typeof field !== 'string' || field === '') continue
    let type = FIELD_TYPES.get(rule.type) ?? 'string'
    // one day or one datetime only (month, year, week and the lists are text); a range slider is a list
    if (type === 'date' && isObject(props) && !isDayType(props.type)) type = 'string'
    if (rule.type === 'slider' && isObject(props) && props.range === true) type = 'string'
    add(field, type)
    if (rule.type === 'qw-detail-table' && isObject(props) && Array.isArray(props.columns))
      for (const c of props.columns)
        if (isObject(c) && typeof c.sum === 'string' && c.sum !== '') add(c.sum, 'number')
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, fields }
}

// ---- the values (发起 / 通过 / 重新提交; see docs/design-notes.md#workflow) ----

/** characters of a text value whose rule sets no `maxlength` */
export const FORM_TEXT_MAX = 5000

const id = z.number().int().positive()
/** a select / radio / checkbox / cascader option value */
const option = z.union([z.string().max(200), z.number(), z.boolean()])
/** an item of a list value or a short text: a date, a time, an area code */
const item = z.string().max(200)
const text = (max = FORM_TEXT_MAX) => z.string().trim().max(max)
const list = (of: z.ZodType, max = FORM_OPTIONS_MAX) => z.array(of).max(max)
const pair = z.array(item).length(2)
const between = (min?: number, max?: number) => {
  let n = z.number()
  if (min !== undefined) n = n.min(min)
  return max === undefined ? n : n.max(max)
}
/** one of `values`, or '' (nothing picked) */
const oneOf = (values: readonly unknown[]) =>
  option.refine((v) => v === '' || values.includes(v), 'validation.invalid')
const optionsOf = (r: { options?: FormOptionItem[]; props?: { options?: FormOptionItem[] } }) =>
  [...(r.options ?? []), ...(r.props?.options ?? [])].map((o) => o.value)

/** A value by its field type alone: a field without a rule (a column total, a snapshot without schema). */
const BY_TYPE: Record<WfFieldType, z.ZodType> = {
  number: z.number(),
  string: text(),
  // what `compile` takes for date conditions, what DATE_VALUE_FORMAT writes
  date: z.union([z.iso.date(), z.iso.datetime({ offset: true })]),
  user: id,
  dept: id,
}

/** The value a rule's component holds, bounded by its settings (no own checks: `validate` is the browser's). */
function ruleValue(r: FormRule, dicts: ReadonlyMap<string, readonly string[]>): z.ZodType {
  switch (r.type) {
    case 'input':
    case 'textarea':
      return text(r.props?.maxlength)
    case 'inputNumber':
      return between(r.props?.min, r.props?.max)
    case 'rate':
      return between(0, r.props?.max ?? 5)
    case 'slider': {
      const n = between(r.props?.min ?? 0, r.props?.max ?? 100)
      return r.props?.range ? z.array(n).length(2) : n
    }
    case 'switch':
      return z.literal([r.props?.activeValue ?? true, r.props?.inactiveValue ?? false])
    case 'radio':
      return oneOf(optionsOf(r))
    case 'select': {
      const one = r.props?.allowCreate ? option : oneOf(optionsOf(r))
      return r.props?.multiple ? list(one, r.props.multipleLimit || undefined) : one
    }
    case 'checkbox':
      return list(oneOf(optionsOf(r)), r.props?.max)
    case 'qw-dict-select': {
      // the dict's enabled entries (the server reads them; none known → nothing to pick)
      const one = oneOf(dicts.get(r.props?.code ?? '') ?? [])
      return r.props?.multiple ? list(one) : one
    }
    case 'cascader': {
      // a path of option values (`emitPath: false`: its last one), a list of them when `multiple`
      const p = r.props?.props
      const one = p?.emitPath === false ? option : list(option, 32)
      return p?.multiple ? list(one) : one
    }
    case 'qw-area-select':
      return list(item, 10)
    case 'datePicker': {
      const t = r.props?.type
      if (isDayType(t)) return BY_TYPE.date
      return t!.endsWith('range') ? pair : t!.endsWith('s') ? list(item) : item
    }
    case 'timePicker':
      return r.props?.isRange ? pair : item
    case 'upload':
      // the stock stub uploads nothing (no target): at most a list of names
      return z.union([text(), list(z.string().max(FORM_TEXT_MAX))])
    case 'qw-upload': {
      const limit = r.props?.limit
      // `storageRefs` lines, `limit` files at most; binding them checks whose they are
      return z.string().refine((v) => {
        const refs = storageRefs(v)
        return refs !== null && (limit === undefined || refs.length <= limit)
      }, 'validation.invalid')
    }
    case 'qw-user-select':
    case 'qw-dept-select':
      return id
    case 'qw-date-range-days':
      // recomputed from its dates (applyFormCalc), whatever number was sent
      return z.number()
    case 'qw-detail-table':
      // the rows as JSON text (or the list): applyFormCalc keeps what detailRows reads of it
      return z.union([z.string(), z.array(z.unknown())])
  }
}

/**
 * Whether form-create checks a rule as required: `$required`, or a `required` check in `validate`; not a
 * hidden rule (nobody fills it), nor a calc result (its inputs are what is filled in).
 */
export const formRuleRequired = (r: FormRule) =>
  r.hidden !== true &&
  r.display !== false &&
  r.type !== 'qw-date-range-days' &&
  (!!r.$required || !!r.validate?.some((v) => v.required === true || v.mode === 'required'))

/** a required value: present, not blank, not an empty list; a detail table with a row left */
const filled = (r: FormRule) => (v: unknown) =>
  r.type === 'qw-detail-table'
    ? detailRows(v, r.props?.columns ?? []).length > 0
    : v != null && !(typeof v === 'string' && !v.trim()) && !(Array.isArray(v) && !v.length)

/**
 * zod schema of a dynamic form's values (start, approve and resubmit parse what the client
 * sent with it, 400 at the field; see docs/design-notes.md#workflow): each field of `fields` as its rule in the sanitized `schema` holds it
 * (types, options, `min` / `max`, lengths, `limit`), by its field type when it has no rule; a required rule's
 * value must be filled ('validation.required'), any other may be missing or null. `dicts`: a
 * `qw-dict-select` dict code → its enabled entry values. Keys outside `fields` are dropped.
 */
export function formValuesSchema(
  fields: WfFields,
  schema?: Pick<FormSchema, 'rule'>,
  dicts: ReadonlyMap<string, readonly string[]> = new Map(),
) {
  const rules = new Map(schema?.rule.map((r) => [r.field, r]))
  const shape: Record<string, z.ZodType> = {}
  for (const [name, type] of Object.entries(fields)) {
    const r = rules.get(name)
    const value = r ? ruleValue(r, dicts) : BY_TYPE[type]
    shape[name] =
      r && formRuleRequired(r)
        ? z.unknown().refine(filled(r), 'validation.required').pipe(value)
        : value.nullish()
  }
  return z.object(shape)
}

/** The storage objects the `qw-upload` fields among `rules` name in `values` (`storageRefs` ids). */
export const formUploadIds = (
  rules: readonly FormRule[],
  values: Readonly<Record<string, unknown>>,
): number[] =>
  rules.flatMap((r) =>
    r.type === 'qw-upload'
      ? (storageRefs(Object.hasOwn(values, r.field) ? values[r.field] : null) ?? []).map(
          (x) => x.id,
        )
      : [],
  )
