// Dynamic process forms on the phone (the web's process-form.ts and formkit
// widgets; see docs/design-notes.md#workflow): the sanitized schema → one view per field, value ↔ picker conversions, read-only texts, the
// client's pre-check (the server's own formValuesSchema) and the calc results shown (the server recomputes
// and stores them). Pure logic (vitest runs it); QwProcessForm.vue renders it. In the pages-wf subpackage:
// nothing in core may import it (the main package would require the subpackage).
import {
  applyFormCalc,
  formRuleRequired,
  formValuesSchema,
  sanitizeFormSchema,
  storageRefs,
  validationMessage,
  type DeptTreeNode,
  type DetailColumn,
  type DictPayload,
  type FormOptionItem,
  type FormRule,
  type FormSchema,
  type FsObjectVo,
  type WfFieldAccess,
  type WfFields,
} from '@qiwu/shared'
import { formatTime } from '@/core/format'
import { locale, t, tx } from '@/core/i18n'
import { choiceText, deptPath, dictChoices, joinNames, loadDict } from '@/core/pickers'

/** form-create's language (the `option.language` keys the designer writes) of each of ours (as the server) */
const FORM_LOCALE = { 'zh-CN': 'zh-cn', 'en-US': 'en' } as const
const TEXT_ID = /\{\{\s*\$t\.([A-Za-z][\w-]*)\s*\}\}/g

export type Text = (s?: string) => string

/** The designer's `{{$t.<id>}}` texts in the current language (`option.language`); an unknown id as itself. */
export function formText(form: Pick<FormSchema, 'option'>): Text {
  const texts = form.option?.language?.[FORM_LOCALE[locale()]] ?? {}
  return (s) =>
    (s ?? '').replace(TEXT_ID, (_, id: string) => (Object.hasOwn(texts, id) ? texts[id]! : id))
}

/**
 * The schema through the same `sanitizeFormSchema` as on save once more (null when it fails: not rendered);
 * with `access` (the detail) without the reader's `hide` rules (the server sent neither them nor their values).
 */
export function processForm(schema: unknown, access?: WfFieldAccess): FormSchema | null {
  const r = sanitizeFormSchema(schema)
  if (!r.ok) return null
  return access ? { ...r.schema, rule: r.schema.rule.filter((x) => access[x.field] !== 'hide') } : r.schema
}

/** The props the renderer reads (each rule type has some of them). */
export interface RuleProps {
  disabled?: boolean
  readonly?: boolean
  placeholder?: string
  type?: string
  valueFormat?: string
  maxlength?: number
  min?: number
  max?: number
  step?: number
  allowHalf?: boolean
  range?: boolean
  isRange?: boolean
  multiple?: boolean
  multipleLimit?: number
  options?: FormOptionItem[]
  activeValue?: string | number | boolean
  inactiveValue?: string | number | boolean
  activeText?: string
  inactiveText?: string
  code?: string
  limit?: number
  maxSize?: number
  columns?: DetailColumn[]
  props?: { multiple?: boolean; checkStrictly?: boolean; emitPath?: boolean }
}

export type Widget =
  | 'input'
  | 'textarea'
  | 'number'
  | 'choice'
  | 'switch'
  | 'date'
  | 'rate'
  | 'slider'
  | 'cascader'
  | 'area'
  | 'user'
  | 'dept'
  | 'dict'
  | 'upload'
  | 'days'
  | 'table'
  | 'none'

const WIDGETS: Partial<Record<FormRule['type'], Widget>> = {
  input: 'input',
  textarea: 'textarea',
  inputNumber: 'number',
  select: 'choice',
  radio: 'choice',
  checkbox: 'choice',
  switch: 'switch',
  datePicker: 'date',
  timePicker: 'date',
  rate: 'rate',
  slider: 'slider',
  cascader: 'cascader',
  'qw-area-select': 'area',
  'qw-user-select': 'user',
  'qw-dept-select': 'dept',
  'qw-dict-select': 'dict',
  'qw-upload': 'upload',
  'qw-date-range-days': 'days',
  'qw-detail-table': 'table',
}

/** A date or time field's picker (wd-datetime-picker `type`), its value format, two values (a range). */
export interface DateSpec {
  picker: 'date' | 'datetime' | 'year-month' | 'year' | 'time'
  fmt: string
  range: boolean
}
// form-create's default value formats (one-day ones forced by sanitizeFormSchema)
const DATE_TYPES: Record<string, [DateSpec['picker'], string, boolean]> = {
  date: ['date', 'YYYY-MM-DD', false],
  datetime: ['datetime', 'YYYY-MM-DD[T]HH:mm:ssZ', false],
  month: ['year-month', 'YYYY-MM', false],
  year: ['year', 'YYYY', false],
  daterange: ['date', 'YYYY-MM-DD', true],
  monthrange: ['year-month', 'YYYY-MM', true],
  datetimerange: ['datetime', 'YYYY-MM-DD HH:mm:ss', true],
}
const TOKENS = /\[[^\]]*\]|YYYY|MM|DD|HH|mm|ss|Z/g

/** null: not on the phone (dates / week / years / months, or a format token beyond YYYY MM DD HH mm ss Z) */
export function dateSpec(r: FormRule): DateSpec | null {
  const p = (r.props ?? {}) as RuleProps
  let spec: DateSpec
  if (r.type === 'timePicker')
    spec = { picker: 'time', fmt: p.valueFormat ?? 'HH:mm:ss', range: !!p.isRange }
  else if (r.type === 'datePicker') {
    const type = p.type ?? 'date'
    if (!Object.hasOwn(DATE_TYPES, type)) return null
    const [picker, fmt, range] = DATE_TYPES[type]!
    spec = { picker, fmt: p.valueFormat ?? fmt, range }
  } else return null
  return /[A-Za-z]/.test(spec.fmt.replace(TOKENS, '')) ? null : spec
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Local time `ms` in `fmt` (`Z`: the local offset, `+08:00`; `[x]`: literal x). */
export function formatDate(ms: number, fmt: string): string {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const parts: Record<string, string> = {
    YYYY: String(d.getFullYear()).padStart(4, '0'),
    MM: pad(d.getMonth() + 1),
    DD: pad(d.getDate()),
    HH: pad(d.getHours()),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    Z: `${off < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`,
  }
  return fmt.replace(TOKENS, (x) => (x.startsWith('[') ? x.slice(1, -1) : parts[x]!))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `value` written in `fmt` as epoch ms (no date part: today; no day: the 1st); null when it does not match. */
export function parseDate(value: unknown, fmt: string): number | null {
  if (typeof value !== 'string') return null
  const keys: string[] = []
  let re = ''
  let at = 0
  for (const m of fmt.matchAll(TOKENS)) {
    re += escape(fmt.slice(at, m.index))
    if (m[0].startsWith('[')) re += escape(m[0].slice(1, -1))
    else {
      keys.push(m[0])
      re += m[0] === 'YYYY' ? '(\\d{4})' : m[0] === 'Z' ? '(Z|[+-]\\d{2}:\\d{2})' : '(\\d{2})'
    }
    at = m.index + m[0].length
  }
  const m = new RegExp(`^${re}${escape(fmt.slice(at))}$`).exec(value)
  if (!m) return null
  const p = Object.fromEntries(keys.map((k, i) => [k, m[i + 1]!]))
  const now = new Date()
  const dated = p.YYYY !== undefined
  const y = dated ? Number(p.YYYY) : now.getFullYear()
  const mo = p.MM ? Number(p.MM) - 1 : dated ? 0 : now.getMonth()
  const day = p.DD ? Number(p.DD) : dated ? 1 : now.getDate()
  const [h, mi, s] = [p.HH, p.mm, p.ss].map((x) => Number(x ?? 0)) as [number, number, number]
  if (p.Z === undefined) return new Date(y, mo, day, h, mi, s).getTime()
  const sign = p.Z.startsWith('-') ? -1 : 1
  const off = p.Z === 'Z' ? 0 : sign * (Number(p.Z.slice(1, 3)) * 60 + Number(p.Z.slice(4)))
  return Date.UTC(y, mo, day, h, mi, s) - off * 60_000
}

type PickerValue = number | string
/** The picker's value for `value` (unset: now; a range's unset end: its start): epoch ms, a time `HH:mm`. */
export function pickerValue(spec: DateSpec, value: unknown): PickerValue | PickerValue[] {
  const ms = (v: unknown) => parseDate(v, spec.fmt)
  const out = (x: number) => (spec.picker === 'time' ? formatDate(x, 'HH:mm') : x)
  if (!spec.range) return out(ms(value) ?? Date.now())
  const [a, b] = Array.isArray(value) ? value : []
  const start = ms(a) ?? Date.now()
  return [out(start), out(ms(b) ?? start)]
}

/** The value of what the picker confirmed, in the field's format (a time `HH:mm` with 00 seconds). */
export function pickedValue(spec: DateSpec, picked: PickerValue | PickerValue[]): string | string[] {
  const one = (x: PickerValue) =>
    formatDate(typeof x === 'number' ? x : (parseDate(x, 'HH:mm') ?? Date.now()), spec.fmt)
  return Array.isArray(picked) ? picked.map(one) : one(picked)
}

/** A rule as the renderer shows it. */
export interface FieldView {
  rule: FormRule
  field: string
  props: RuleProps
  /** select / radio / checkbox / cascader: the rule's options, then its props' (as the server reads them) */
  options: FormOptionItem[]
  title: string
  info: string
  placeholder: string
  /** marked required (formRuleRequired, as the server checks it) and editable */
  required: boolean
  /** an input; else a read-only row */
  edit: boolean
  widget: Widget
  /** not on the phone: read-only, "fill it in on a computer" */
  unsupported: boolean
  /** a date or time field's picker */
  date: DateSpec | null
}

/**
 * The fields to render, in order: not `hidden` / `display: false` ones (their values stay and are sent). One
 * is editable unless disabled or read-only, a calc result (`qw-date-range-days`), not on the phone, or (with
 * `access`, the detail) not the reader's `edit`.
 */
export function fieldViews(form: FormSchema, access: WfFieldAccess | undefined, text: Text) {
  return form.rule
    .filter((r) => r.hidden !== true && r.display !== false)
    .map((rule): FieldView => {
      const props = (rule.props ?? {}) as RuleProps
      // an input of type textarea is one (as Element Plus draws it)
      const widget = props.type === 'textarea' ? 'textarea' : (WIDGETS[rule.type] ?? 'none')
      const date = widget === 'date' ? dateSpec(rule) : null
      const unsupported =
        widget === 'none' || (widget === 'date' && !date) || (widget === 'cascader' && !!props.props?.multiple)
      const edit =
        !unsupported &&
        widget !== 'days' &&
        !props.disabled &&
        !props.readonly &&
        (!access || access[rule.field] === 'edit')
      return {
        rule,
        field: rule.field,
        props,
        options: [...(rule.options ?? []), ...(props.options ?? [])],
        title: text(rule.title) || rule.field,
        info: text(rule.info),
        placeholder: text(props.placeholder),
        required: edit && formRuleRequired(rule),
        edit,
        widget,
        unsupported,
        date,
      }
    })
}

/** field → its title (a detail table's column total: the column's label), for the messages */
export function formTitles(form: FormSchema, text: Text): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of form.rule) {
    out[r.field] = text(r.title) || r.field
    if (r.type === 'qw-detail-table')
      for (const c of r.props?.columns ?? []) if (c.sum) out[c.sum] = text(c.label) || c.sum
  }
  return out
}

/** The start page's first values: the rules' default `value`s (form-create fills them in too). */
export const defaultValues = (form: FormSchema): Record<string, unknown> =>
  Object.fromEntries(form.rule.filter((r) => r.value !== undefined).map((r) => [r.field, r.value]))

/**
 * The values with every calc result as shared computes it (what the server will store); a days field whose
 * dates are not in this form (hidden from the reader) keeps the value given (the server's).
 */
export function shownValues(form: FormSchema, values: Record<string, unknown>) {
  const out = applyFormCalc(form, values)
  const has = (f?: string) => !!f && form.rule.some((r) => r.field === f)
  for (const r of form.rule)
    if (r.type === 'qw-date-range-days' && !(has(r.props?.startField) && has(r.props?.endField)))
      out[r.field] = values[r.field]
  return out
}

/** The names the read-only texts need. */
export interface Lookups {
  /** user id → display name (GET /wf/users/options, and the ones picked here) */
  users: ReadonlyMap<number, string>
  /** every dept (GET /wf/depts/options) */
  depts: readonly DeptTreeNode[]
  /** the area tree as options (code, name) */
  areas: readonly FormOptionItem[]
  /** dict code → its entries */
  dicts: ReadonlyMap<string, DictPayload>
}

/** The labels of a path of option values through a tree (one not found: as itself). */
export function pathNames(nodes: readonly FormOptionItem[], path: readonly unknown[], text: Text) {
  const out: string[] = []
  let level: readonly FormOptionItem[] | undefined = nodes
  for (const v of path) {
    const n: FormOptionItem | undefined = level?.find((o) => o.value === v)
    out.push(n ? text(n.label) : String(v))
    level = n?.children
  }
  return out.join(' / ')
}

/** A field's value as text (read-only rows, a picker cell's value). */
export function fieldText(v: FieldView, value: unknown, look: Lookups, text: Text): string {
  if (value === null || value === undefined || value === '') return ''
  const list = [value].flat()
  switch (v.widget) {
    case 'choice':
      return joinNames(
        list.map((x) => text(v.options.find((o) => o.value === x)?.label) || String(x)),
      )
    case 'switch':
      return value === (v.props.activeValue ?? true)
        ? text(v.props.activeText) || t('approval.dynamic.yes')
        : text(v.props.inactiveText) || t('approval.dynamic.no')
    case 'date':
      if (v.date && !v.date.range && v.date.fmt.endsWith('Z') && typeof value === 'string')
        return formatTime(value)
      return list.map(String).join(' ~ ')
    case 'slider':
    case 'number':
    case 'rate':
      return list.map(String).join(' ~ ')
    case 'cascader':
      return pathNames(v.options, list, text)
    case 'area':
      return pathNames(look.areas, list, text)
    case 'user':
      return typeof value === 'number' ? (look.users.get(value) ?? `#${value}`) : String(value)
    case 'dept': {
      const d = typeof value === 'number' ? deptPath([...look.depts], value).pop() : undefined
      return d ? tx(d.name) : String(value)
    }
    case 'dict':
      return choiceText(dictChoices(look.dicts.get(v.props.code ?? '')), list.map(String))
    case 'upload':
      // Names only, no opening a file on the phone (QwUpload's note)
      return joinNames((storageRefs(value) ?? []).map((r) => r.name))
    case 'days':
      return t('approval.dynamic.days', { n: String(value) })
    default:
      return list.map(String).join(', ')
  }
}

/** The dicts of the form's `qw-dict-select` fields (the pre-check needs them all: an unloaded one has no values). */
export async function formDicts(form: FormSchema): Promise<Map<string, DictPayload>> {
  const codes = new Set<string>()
  for (const r of form.rule) if (r.type === 'qw-dict-select' && r.props?.code) codes.add(r.props.code)
  return new Map(await Promise.all([...codes].map(async (c) => [c, await loadDict(c)] as const)))
}

// A rule's `validate` checks beyond required (pattern, email, len …) are the web form's hints only
// (the server does not run them either); port them when a form needs them on the phone
/**
 * The client's pre-check: the server's own `formValuesSchema` over `fields` (start: all; approve, resubmit:
 * the reader's `edit` ones); field → its first message (`{field}`: its title). Experience only: the server
 * checks again.
 */
export function checkValues(
  fields: WfFields,
  form: FormSchema,
  values: Record<string, unknown>,
  dicts: ReadonlyMap<string, DictPayload>,
  titles: Record<string, string>,
): Record<string, string> {
  const enabled = new Map([...dicts].map(([c, d]) => [c, d.entries.map((e) => e.value)]))
  const out: Record<string, string> = {}
  const parsed = formValuesSchema(fields, form, enabled).safeParse(values)
  for (const issue of parsed.error?.issues ?? []) {
    const f = String(issue.path[0] ?? '')
    const { key, params } = validationMessage(issue)
    out[f] ??= t(key, { ...params, field: titles[f] ?? f })
  }
  return out
}

/** The values of the fields `access` lets the reader edit: what an approval or a resubmit sends. */
export const editableValues = (values: Record<string, unknown>, access: WfFieldAccess) =>
  Object.fromEntries(Object.entries(values).filter(([k]) => access[k] === 'edit'))

/** A blank number clears the stored value; invalid text stays for the pre-check. */
export const numberInput = (s: string): number | string | null =>
  !s.trim() ? null : Number.isFinite(Number(s)) ? Number(s) : s

/** A `qw-upload` value as QwUpload's objects (`storageRefs`; bad or none: no files). */
export const uploadObjects = (value: unknown): FsObjectVo[] =>
  (storageRefs(value) ?? []).map(({ id, name }) => ({
    id,
    originalName: name,
    mime: '',
    size: 0,
    url: null,
    isPublic: false,
    bizTag: 'wf.attachment',
    createdAt: '',
  }))

/** QwUpload's objects as a `qw-upload` value: `<id>/<name>` lines; none → null. */
export const uploadValue = (list: readonly FsObjectVo[]) =>
  list.length ? list.map((o) => `${o.id}/${o.originalName}`).join('\n') : null
