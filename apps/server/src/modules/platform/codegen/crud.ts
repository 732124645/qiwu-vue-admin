// Render model of the CRUD, tree and master-sub templates (docs/codegen-golden.md; see docs/design-notes.md#codegen): everything
// the templates print, derived from one cg_table config and its columns (a master-sub module: also its
// sub tables' configs). The tree template is the CRUD one with tree branches (`kind: 'tree'`) plus its own
// e2e spec; master-sub is the CRUD one with branches for the sub tables (`kind: 'master_sub'`, `subs`).
// Every identifier is checked against the
// generator whitelist again (config seeded or edited outside `save` still never reaches code unchecked);
// free texts (comments, labels) reach the templates only through str() / comment() / json().
import {
  BUILTIN_MENU_GROUPS,
  CG_IDENT,
  CG_RESERVED,
  cgDomainAllowed,
  Err,
  type Locale,
  LOCALES,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import type { CgColumn } from './cg-column.entity.js'
import type { CgTableDetail } from './codegen.service.js'
import { Code, comment, type RenderedFile, renderTargets, str, type Target } from './render.js'
import { camel, humanize } from './rules.js'
import { hasMobile, MOBILE } from './workspace.js'

/**
 * Audit columns every CRUD table has (BaseEntity), and the soft-delete one every entity maps (IdEntity); an append-only table (a log) has none of the audit ones but maybe `created_at` (CreatedEntity /
 * IdEntity).
 */
const AUDIT = ['created_by', 'created_at', 'updated_by', 'updated_at'] as const
const DELETED_AT = 'deleted_at'
const INT_BITS: Record<string, number> = { tinyint: 8, smallint: 16, mediumint: 24, int: 32 }
/** utf8mb4 characters that fit a TEXT column's bytes */
const TEXT_CHARS: Record<string, number> = { tinytext: 63, text: 16_383, mediumtext: 4_194_303 }
/** `sort_no` convention: 0 … 999 999 */
const SORT_NO_MAX = 999_999

export interface ColModel {
  column: string
  field: string
  /** comment text (one line, comment marks removed) */
  comment: Code
  label: Record<Locale, string>
  /** `field.<domain>.<biz>.<field>`, `field.common.<field>` for audit columns */
  labelKey: string
  tsType: CgColumn['tsType']
  base: string
  length: number | undefined
  /** digits after the point of a decimal */
  scale: number | undefined
  nullable: boolean
  hasDefault: boolean
  required: boolean
  widget: CgColumn['widget']
  /** Write-only request property and its safe plaintext limit. */
  secret?: { body: string; max: number }
  dict: string | null
  seedName: boolean
  unique: boolean
  inList: boolean
  inForm: boolean
  inQuery: boolean
  queryOp: CgColumn['queryOp']
  sortable: boolean
  audit: boolean
  /** free text (textarea): last in lists, wide in Excel */
  freeText: boolean
  /** entity property type, e.g. `string | null` */
  ts: Code
  /** `@Column(…)` options */
  entity: Code
  /** zod of the POST body field (the example, if any, as its Swagger `example`) */
  create: Code
  /** zod of the response field */
  vo: Code
  /** zod of an eq/like query filter; for `between` the zod of each end */
  query: Code
  /** ExcelColumn literal */
  excel: Code
  /** the DB default as a TS literal (none for expressions like CURRENT_TIMESTAMP) */
  dflt: Code | undefined
  /** the config's example value as a TS literal (test data, the body field's Swagger example) */
  example: Code | undefined
  web: WebCol
}

/** What the web templates print for a column (values are plain literals or checked tokens). */
export interface WebCol {
  /** the form input's length limit (chars) */
  maxlength: number | undefined
  /** a number input's range and decimals */
  min: string | undefined
  max: string | undefined
  scale: number | undefined
  /**
   * the add form's empty value: the DB default, else '' / false / null; undefined (left out) for a
   * NOT NULL column whose default is an expression
   */
  empty: Code
  /** the dict of a dict or boolean column (booleans fall back to `core.yes_no`) */
  dict: string | null
  /** the list query's key: the field, or `<field>Range` (datetime, whole days) / `<field>Dates` (date) */
  filterKey: string
  /** its initial value in `useCrudList({ filters })` */
  filterInit: Code
  /** the `QwColumn` literal of a list column (set by `crudModel`, it depends on the other columns) */
  column: Code
}

/**
 * A column of another table holding ids of the entity's rows (no foreign keys): the entity file
 * registers it with core/db/references.ts, so a delete checks it (restrict: 409 `in_use` while a live row
 * holds one) or takes its rows along (`cascade`: a master-sub document's sub rows).
 */
export interface RefModel {
  table: string
  column: string
  cascade: boolean
  /** what the rows are (comment text): the config's label, a sub table's comment */
  label: Code
}

/**
 * One sub table of a `master_sub` module (docs/codegen-golden.md "Master-sub"): its rows are edited in the
 * master's form and saved with the master row as one document; its entity lives in the master's module.
 */
export interface SubModel {
  table: string
  /** table comment as comment text */
  about: Code
  /** class name: `InvoiceLine` */
  Biz: string
  /** the class name camelCase: `invoiceLine` (`invoiceLineInput`, `invoiceLineVo`) */
  biz: string
  /** the master's `up` (the sub's entity lives in the master's module) */
  up: string
  /** the entity file's name: `invoice-line` (`invoice-line.entity.ts`) */
  file: string
  /**
   * the master body's and detail's property holding the rows: the sub's business without the master's,
   * plural (`invoice-line` of `invoice` → `lines`); `Prop` for method names (`saveLines`)
   */
  prop: string
  Prop: string
  /** the rows' label (section title, the field label of `prop`): the sub's feature name */
  label: Record<Locale, string>
  /** the column holding the master row's id: set by the server, never in a body */
  fk: ColModel
  /** every column besides the key and the audit columns, the fk included (the entity) */
  own: ColModel[]
  /** the editable columns of a row: the sub's form columns, never the fk */
  form: ColModel[]
  /** web: the `QwEditTable` column literal of each form column, in form order */
  columns: Code[]
  /** `richtext` form columns: sanitized when a row is saved (a cell edits them as text) */
  rich: ColModel[]
  /** the rows' order: `sort_no` when the table has it, then id */
  sortNo: ColModel | undefined
  /** for the entity template: a sub row is never data-scoped itself; its own config's references */
  scope: undefined
  entityBase: 'BaseEntity'
  refs: RefModel[]
}

export interface CrudModel {
  /**
   * `crud`; `tree` (`parent_id` + `tree_path`: a forest list, a parent picker; docs "Tree"); `master_sub`
   * (the CRUD page whose form edits the rows of `subs` too; docs "Master-sub")
   */
  kind: 'crud' | 'tree' | 'master_sub'
  table: string
  /** table comment as comment text */
  about: Code
  group: string
  domain: string
  business: string
  /**
   * the module's path below `modules/`, `views/` (directories), `api/` and shared `src/` (files),
   * `<domain>/<business>` for a project domain, `<group>/<domain>/<business>` for platform /
   * workflow
   */
  home: string
  /**
   * a project module (group `biz`: its domain's own directories): its seed writes the page's
   * parent, icon and sort only when it inserts the page
   */
  project: boolean
  /** `../` from the server module's directory up to `apps/server/src/` */
  up: string
  /** `../` from the shared schema's directory up to `packages/shared/src/` */
  sharedUp: string
  /**
   * the class name camelCase, the stem of every exported identifier: `position` (`positionPerms`),
   * `erpCustomer` for class `ErpCustomer`
   */
  biz: string
  /** class name: `Position` */
  Biz: string
  /** `positions` (variables, Excel sheet / file name) */
  bizs: string
  /** English words from the names: `position`, `positions`, `a position` */
  noun: string
  nouns: string
  aNoun: string
  /** perms, field labels, action-log domain, table id: `iam.position` */
  key: string
  /** `iam/positions` (controller path; URL `/api/iam/positions`) */
  url: string
  routeName: string
  routePath: string
  component: string
  componentName: string
  parentMenu: string
  /** the parent is a built-in group (`BUILTIN_MENU_GROUPS`), not one of menu-groups.seed.ts */
  parentBuiltin: boolean
  menuIcon: string
  menuSortNo: number
  entity: Record<Locale, string>
  withExport: boolean
  withImport: boolean
  withOptions: boolean
  /**
   * the uni-app pages too (`options.withMobile`): api, list, detail and form pages and the locale
   * fragments below `mobile/src/`, rendered only where the repository has the client (`hasMobile`)
   */
  withMobile: boolean
  /**
   * the entity's base class (core/db/base.entity.ts, every one soft-deletes: `deleted_at`):
   * BaseEntity, or for an append-only table (no created_by / updated_by / updated_at) CreatedEntity
   * (`created_at`) / IdEntity
   */
  entityBase: 'BaseEntity' | 'CreatedEntity' | 'IdEntity'
  /**
   * who holds ids of the rows (the entity registers them): `options.referencedBy` (restrict), a
   * master-sub master's sub tables by their fk (cascade) first
   */
  refs: RefModel[]
  /**
   * `@DataScoped` columns (see docs/design-notes.md#data-scope): the table's `dept_id`, owner `created_by`; on unless the
   * `dataScope` option is false, none without a `dept_id` column. BaseCrudService then scopes every read
   * (`scopedQb`), locks every write by id (`lockScopedIds`) and checks created / updated rows
   * (`assertWritableScope`); the import's upsert matches only rows in scope.
   */
  scope: { dept: string; owner: string | null } | undefined
  /** the scope's dept column */
  dept: ColModel | undefined
  /** columns besides the key and the audit columns, in config order */
  own: ColModel[]
  /** list (and export) columns: own list columns, `created_at`, free text last */
  list: ColModel[]
  form: ColModel[]
  filters: ColModel[]
  /** `pageQuery` sort whitelist: `sortNo` first, `id` last */
  sortFields: string[]
  /** Excel columns: the list's, plus form columns for import (`only` marks the one-way ones) */
  excel: ColModel[]
  enabled: ColModel | undefined
  sortNo: ColModel | undefined
  /** the options' non-dict label column (`name` / `title`, else text); a tree's `tree_label_col` */
  label: ColModel | undefined
  /** tree: the parent column (`parentId`, the form's parent picker; never listed or searched) */
  parent: ColModel | undefined
  uniques: ColModel[]
  /**
   * the import's natural key: the first unique column that is imported (a form column); none → the
   * import only inserts (`upsert` is not offered)
   */
  importKey: ColModel | undefined
  /**
   * the generated e2e spec's text key: a text form column (no dict) searched by `like`, at least 7
   * characters long (test tags); it adds the list filter cases. The spec finds its rows by id either way.
   */
  specKey: ColModel | undefined
  /** the audit columns the table has (all four; an append-only one at most `created_at`) */
  audit: Partial<Record<(typeof AUDIT)[number], ColModel>>
  /** web: the menu / page name (`menu.<key>`) */
  title: Record<Locale, string>
  /** web: the list's default sort (`sortNo` with a sortable sort_no, else newest first) */
  listSort: string
  /** web: a detail drawer (`with_detail_view`), opened from the label column */
  withDetail: boolean
  /**
   * web: the add / edit form's field columns (`cg_table.form_cols` 1–3); with more than one, free text and
   * uploads (and a master-sub form's row tables) take a whole row, the dialog is wider
   */
  formCols: number
  /**
   * a read-only page (`cg_table.readonly`, log-like tables; always for an append-only table): list, view
   * and export only; no create, modify, remove, enabled or import routes, perms, menu actions, buttons or
   * form
   */
  readonly: boolean
  /** the perm verbs (`<biz>Perms`, menu actions): browse, view, the writes unless read-only, export, import */
  verbs: string[]
  /** web: the detail drawer's rows: every listed or form column, `created_at` last */
  detail: ColModel[]
  /**
   * the `richtext` columns: the form edits them with the core RichEditor, the service passes them
   * through core/sanitize.ts on create / update and on `get` (GET /:id: rows stored before or behind
   * the API's back too), so the detail drawer shows that HTML (`v-html`); a list cell shows its text
   */
  rich: ColModel[]
  /** Write-only body columns boxed by SecretBox. */
  secrets: ColModel[]
  /** `master_sub`: the sub tables, in config id order; none for the other templates */
  subs: SubModel[]
}

/** A config to render: the table's, and for a `master_sub` master the configs of its sub tables. */
export type RenderConfig = CgTableDetail & { subs?: CgTableDetail[] }

/** `value` if it matches `re` and is none of the `reserved` names (CG_RESERVED), else 422 C3002. */
function ident(
  re: RegExp,
  value: string | null | undefined,
  reserved?: ReadonlySet<string>,
): string {
  if (typeof value !== 'string' || !re.test(value) || reserved?.has(value))
    throw new BizError(Err.CODEGEN_IDENTIFIER_INVALID, { name: String(value).slice(0, 64) })
  return value
}

/**
 * `options.referencedBy` of a config as restrict references (identifiers whitelisted again: they become
 * SQL identifiers in core/db/references.ts); a pair in `taken` (a sub table's cascade) is left out.
 */
const refsOf = (t: Pick<CgTableDetail, 'options'>, taken: RefModel[] = []): RefModel[] =>
  (t.options?.referencedBy ?? [])
    .filter((r) => !taken.some((c) => c.table === r.table && c.column === r.column))
    .map((r) => ({
      table: ident(CG_IDENT.dbName, r.table),
      column: ident(CG_IDENT.dbName, r.column),
      cascade: false,
      label: comment(r.label),
    }))

/** A column of the table's own: not the key, an audit or the soft-delete column. */
const isOwn = (c: Pick<CgColumn, 'isPk' | 'columnName'>) =>
  !c.isPk && c.columnName !== DELETED_AT && !(AUDIT as readonly string[]).includes(c.columnName)
/** The label: first `name` / `title`, else first text; neither dict-backed nor secret. */
const labelOf = <
  C extends { column: string; tsType: string; widget?: string; dict: string | null },
>(
  own: C[],
): C | undefined =>
  own.find(
    (c) => c.dict === null && c.widget !== 'secret' && /(^|_)(name|title)$/.test(c.column),
  ) ?? own.find((c) => c.dict === null && c.widget !== 'secret' && c.tsType === 'string')

/** Secret columns are never exposed as response or lookup fields, even if config flags were edited. */
export function assertSecretColumns(
  t: Pick<CgTableDetail, 'columns' | 'template' | 'masterTableId'>,
): void {
  const fields = new Set(t.columns.map((c) => c.fieldName))
  for (const c of t.columns) {
    if (c.widget !== 'secret') continue
    const body = c.fieldName.endsWith('Enc') ? c.fieldName.slice(0, -3) : ''
    if (
      !c.nullable ||
      !/^(varchar|char)\(/i.test(c.columnType) ||
      c.tsType !== 'string' ||
      !CG_IDENT.fieldName.test(body) ||
      CG_RESERVED.fieldName.has(body) ||
      fields.has(body) ||
      t.template === 'master_sub' ||
      t.masterTableId !== null
    )
      throw new BizError(Err.CODEGEN_IDENTIFIER_INVALID, { name: c.fieldName.slice(0, 64) })
  }
}

/**
 * `GET /options` lists `{ id, <label> }`: `withOptions` needs a label column (`labelOf`), else 422
 * C3003 (dict-backed and secret columns are skipped). The `tree` template needs `parent_id` + `tree_path`
 * (as `parentId` / `treePath`, the tree base's properties) and a text label column (`tree_label_col`, else
 * `labelOf`), else 422 C3004.
 * Checked on save and on render; returns the tree's label column.
 */
export function assertTemplateColumns(
  t: Pick<
    CgTableDetail,
    | 'id'
    | 'tableName'
    | 'options'
    | 'columns'
    | 'template'
    | 'treeParentCol'
    | 'treeLabelCol'
    | 'masterTableId'
    | 'subFkCol'
  >,
): string | undefined {
  const table = t.tableName.slice(0, 64)
  assertSecretColumns(t)
  const own = t.columns
    .filter(isOwn)
    .map((c) => ({ column: c.columnName, tsType: c.tsType, widget: c.widget, dict: c.dictCode }))
  if (t.options?.withOptions && t.template !== 'tree' && !labelOf(own))
    throw new BizError(Err.CODEGEN_OPTIONS_LABEL_MISSING, { table })
  assertSubLink(t)
  if (t.template !== 'tree') return undefined
  const field = (name: string) => t.columns.find((c) => c.columnName === name)?.fieldName
  const texts = own.filter(
    (c) => c.column !== 'tree_path' && c.tsType === 'string' && c.widget !== 'secret',
  )
  const label = t.treeLabelCol ? texts.find((c) => c.column === t.treeLabelCol) : labelOf(texts)
  if (
    (t.treeParentCol ?? 'parent_id') !== 'parent_id' ||
    field('parent_id') !== 'parentId' ||
    field('tree_path') !== 'treePath' ||
    !label
  )
    throw new BizError(Err.CODEGEN_TREE_COLUMNS, { table })
  return label.column
}

const INTEGER = /^(tinyint|smallint|mediumint|int|integer|bigint)\b/i
/**
 * A sub-table link (`master_sub`, set on the sub's config): the master and the fk column set together,
 * the master another config, the fk one of the sub's own integer columns (not its key); a sub is never a
 * master or a tree itself. Else 422 C3007.
 */
function assertSubLink(
  t: Pick<
    CgTableDetail,
    'id' | 'tableName' | 'columns' | 'template' | 'masterTableId' | 'subFkCol'
  >,
): void {
  if (t.masterTableId === null && t.subFkCol === null) return
  const fk = t.columns.find((c) => c.columnName === t.subFkCol)
  if (
    t.masterTableId === null ||
    t.masterTableId === t.id ||
    t.template !== 'crud' ||
    !fk ||
    fk.isPk ||
    !INTEGER.test(fk.columnType)
  )
    throw new BizError(Err.CODEGEN_SUB_TABLES, { table: t.tableName.slice(0, 64) })
}

const kebabCamel = (kebab: string) => camel(kebab.replace(/-/g, '_'))
const lowerFirst = (name: string) => name.replace(/^./, (c) => c.toLowerCase())
const pluralOf = (word: string) =>
  /[^aeiou]y$/.test(word)
    ? `${word.slice(0, -1)}ies`
    : /(s|x|z|ch|sh)$/.test(word)
      ? `${word}es`
      : `${word}s`

/** A number as a TS literal, digits grouped (`999_999`). */
export function num(n: number | string): string {
  const [int, frac] = String(n).replace(/^-/, '').split('.')
  const grouped = int!.length > 4 ? int!.replace(/\B(?=(\d{3})+$)/g, '_') : int
  return `${String(n).startsWith('-') ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`
}

/** `{ a: 1, b: 'x' }` of the entries whose value is not undefined (values are code already). */
const object = (entries: [string, string | undefined][]) => {
  const set = entries.filter(([, v]) => v !== undefined)
  return set.length ? `{ ${set.map(([k, v]) => `${k}: ${v}`).join(', ')} }` : ''
}

function typeFacts(columnType: string) {
  const t = columnType.toLowerCase()
  const base = /^[a-z]+/.exec(t)?.[0] ?? ''
  const m = /\((\d+)(?:,\s*(\d+))?\)/.exec(t)
  return {
    base: t.startsWith('tinyint(1)') ? 'boolean' : base === 'integer' ? 'int' : base,
    length: m ? Number(m[1]) : undefined,
    scale: m?.[2] === undefined ? undefined : Number(m[2]),
    unsigned: /\bunsigned\b/.test(t),
  }
}

/** A decimal kept as the driver's string (wider than a JS number, rules.ts `tsTypeOf`). */
const decimalText = (c: CgColumn, facts: ReturnType<typeof typeFacts>) =>
  facts.base === 'decimal' && c.tsType === 'string'
/** Characters of a decimal text: its digits, the point, the sign. */
const decimalChars = ({ length = 10, scale = 0, unsigned }: ReturnType<typeof typeFacts>) =>
  length + (scale ? 1 : 0) + (unsigned ? 0 : 1)

/** The DB default as an entity `default` literal; none for expressions (CURRENT_TIMESTAMP …). */
function defaultOf(c: CgColumn, base: string): string | undefined {
  const d = c.columnDefault
  if (d === null || /^current_timestamp/i.test(d)) return undefined
  if (base === 'boolean') return String(d === '1')
  if (c.tsType === 'number') return Number.isFinite(Number(d)) ? num(Number(d)) : undefined
  if (c.tsType === 'string') return str(d).text
  return undefined
}

function entityOptions(c: CgColumn, facts: ReturnType<typeof typeFacts>): string {
  const { base, length, scale, unsigned } = facts
  const chars = base === 'varchar' || base === 'char'
  const type = base === 'varchar' && !c.nullable ? undefined : `'${base}'`
  return object([
    ['name', c.columnName === c.fieldName ? undefined : `'${c.columnName}'`],
    ['type', type],
    ['length', chars ? String(length) : undefined],
    [
      'precision',
      base === 'decimal' ? String(length) : base === 'datetime' ? String(length ?? 0) : undefined,
    ],
    ['scale', base === 'decimal' ? String(scale ?? 0) : undefined],
    ['unsigned', unsigned ? 'true' : undefined],
    ['nullable', c.nullable ? 'true' : undefined],
    ['select', c.widget === 'secret' ? 'false' : undefined],
    ['default', defaultOf(c, base)],
    ['transformer', base === 'decimal' && c.tsType === 'number' ? 'decimalNumber' : undefined],
  ])
}

/** A number column's accepted range as plain number literals (`sort_no` by convention, else its type). */
function boundsOf(
  c: CgColumn,
  facts: ReturnType<typeof typeFacts>,
): { min?: string; max?: string } {
  const { base, length, scale, unsigned } = facts
  if (c.columnName === 'sort_no') return { min: '0', max: String(SORT_NO_MAX) }
  if (base in INT_BITS) {
    const bits = INT_BITS[base]!
    return unsigned
      ? { min: '0', max: String(2 ** bits - 1) }
      : { min: String(-(2 ** (bits - 1))), max: String(2 ** (bits - 1) - 1) }
  }
  if (base === 'decimal' && length !== undefined) {
    const s = scale ?? 0
    const top = `${'9'.repeat(length - s) || '0'}${s ? `.${'9'.repeat(s)}` : ''}`
    return { min: unsigned ? '0' : `-${top}`, max: top }
  }
  return unsigned ? { min: '0' } : {}
}

/** zod of the column's value (no optional/nullable yet); `input` = a request field, else a response one. */
function zodOf(c: CgColumn, facts: ReturnType<typeof typeFacts>, input: boolean): string {
  const { base, length, scale } = facts
  if (base === 'boolean') return 'z.boolean()'
  if (base === 'date') return 'z.iso.date()'
  if (c.tsType === 'Date') return input ? 'z.iso.datetime({ offset: true })' : 'z.iso.datetime()'
  if (c.tsType === 'unknown') return 'z.unknown()'
  if (c.tsType === 'number') {
    const int = base in INT_BITS || base === 'bigint'
    if (!input) return int ? 'z.number().int()' : 'z.number()'
    const { min, max } = boundsOf(c, facts)
    const step = base === 'decimal' && scale ? `.multipleOf(0.${'0'.repeat(scale - 1)}1)` : ''
    return `z.number()${int ? '.int()' : ''}${min ? `.min(${num(min)})` : ''}${max ? `.max(${num(max)})` : ''}${step}`
  }
  if (!input) return 'z.string()'
  if (decimalText(c, facts)) {
    // the digits as text: at most precision - scale before the point, scale after it
    const int = (length ?? 10) - (scale ?? 0)
    const sign = facts.unsigned ? '' : '-?'
    const frac = scale ? `(\\.\\d{1,${scale}})?` : ''
    return `z.string().trim().regex(/^${sign}${int ? `\\d{1,${int}}` : '0'}${frac}$/)`
  }
  const max = base in TEXT_CHARS ? TEXT_CHARS[base] : length
  return `z.string().trim()${c.required ? '.min(1)' : ''}${max ? `.max(${num(max)})` : ''}`
}

function colModel(c: CgColumn, key: string): ColModel {
  const column = ident(CG_IDENT.dbName, c.columnName)
  const field = ident(CG_IDENT.fieldName, c.fieldName, CG_RESERVED.fieldName)
  const dict = c.dictCode === null ? null : ident(CG_IDENT.dictCode, c.dictCode)
  const facts = typeFacts(c.columnType)
  const secret =
    c.widget === 'secret'
      ? {
          body: field.slice(0, -3),
          max: Math.floor(Math.floor((((facts.length ?? 0) - 43) * 3) / 4) / 3),
        }
      : undefined
  const audit = (AUDIT as readonly string[]).includes(column)
  const nullable = c.nullable
  const hasDefault = c.columnDefault !== null
  const required = c.required && !nullable
  const freeText = c.widget === 'textarea' || c.widget === 'richtext'
  const labelKey = audit ? `field.common.${field}` : `field.${key}.${secret?.body ?? field}`
  const dflt = defaultOf(c, facts.base)
  const example = exampleOf(c, facts)
  const tsBase = c.tsType
  const ts = tsBase === 'unknown' || !nullable ? tsBase : `${tsBase} | null`
  const optional = nullable ? '.nullish()' : required ? '' : '.optional()'
  const vo = zodOf(c, facts, false) + (nullable && c.tsType !== 'unknown' ? '.nullable()' : '')
  let query = ''
  if (c.queryOp === 'between') query = `${zodOf(c, facts, true)}.optional()`
  else if (facts.base === 'boolean') query = 'z.stringbool().optional()'
  else if (c.tsType === 'number')
    query = `z.coerce.number()${facts.base === 'decimal' ? '' : '.int()'}.optional()`
  else if (c.tsType === 'string')
    query = `z.string().trim()${facts.length ? `.max(${num(facts.length)})` : ''}.optional()`
  const excelType =
    facts.base === 'boolean'
      ? 'boolean'
      : c.tsType === 'number'
        ? 'number'
        : c.tsType === 'Date'
          ? 'datetime'
          : undefined
  const excel = object([
    ['prop', `'${field}'`],
    ['label', `'${labelKey}'`],
    ['type', excelType && `'${excelType}'`],
    ['dict', dict === null ? undefined : `'${dict}'`],
    ['seedName', c.options?.seedName ? 'true' : undefined],
    ['only', audit || !c.inForm ? "'export'" : !c.inList ? "'import'" : undefined],
    ['width', freeText ? '40' : undefined],
  ])
  return {
    column,
    field,
    comment: comment(c.columnComment),
    label: c.labelI18n ?? { 'zh-CN': field, 'en-US': humanize(column) },
    labelKey,
    tsType: c.tsType,
    base: facts.base,
    length: facts.length,
    scale: facts.scale,
    nullable,
    hasDefault,
    required,
    widget: c.widget,
    secret,
    dict,
    seedName: !!c.options?.seedName,
    unique: !!c.options?.unique,
    inList: c.inList && !secret,
    inForm: c.inForm && !audit,
    inQuery: c.inQuery && !secret,
    queryOp: c.queryOp,
    sortable: c.sortable && !secret,
    audit,
    freeText,
    ts: new Code(ts),
    entity: new Code(entityOptions(c, facts)),
    // the example as the OpenAPI 3.0 `example` (zod copies meta keys into the JSON Schema as they are)
    create: new Code(
      secret
        ? `z.string().max(${num(secret.max)}).optional()`
        : zodOf(c, facts, true) + (example ? `.meta({ example: ${example.text} })` : '') + optional,
    ),
    vo: new Code(vo),
    query: new Code(query),
    excel: new Code(excel),
    dflt: dflt === undefined ? undefined : new Code(dflt),
    example,
    web: webOf(c, facts, dict, dflt),
  }
}

/** The web templates' column facts (see WebCol); `column` is filled in by `crudModel`. */
function webOf(
  c: CgColumn,
  facts: ReturnType<typeof typeFacts>,
  dict: string | null,
  dflt: string | undefined,
): WebCol {
  const { base } = facts
  const bool = base === 'boolean'
  const { min, max } = c.tsType === 'number' ? boundsOf(c, facts) : {}
  const range = c.queryOp === 'between'
  const webDict = dict ?? (bool ? 'core.yes_no' : null)
  let filterInit = "''"
  if (range) filterInit = 'null as [string, string] | null'
  else if (webDict) filterInit = 'null as string | null'
  else if (c.tsType === 'number') filterInit = 'null as number | null'
  const text = decimalText(c, facts)
  let empty = dflt
  // a NOT NULL column with an expression default (CURRENT_TIMESTAMP …): its schema only allows leaving
  // it out, so it starts undefined and is not sent until set (the DB fills it)
  if (empty === undefined && !c.nullable && c.columnDefault !== null) empty = 'undefined'
  if (empty === undefined)
    empty = bool ? 'false' : c.tsType === 'string' && base !== 'date' && !text ? "''" : 'null'
  let maxlength = c.tsType === 'string' ? (TEXT_CHARS[base] ?? facts.length) : undefined
  if (text) maxlength = decimalChars(facts)
  return {
    maxlength,
    min,
    max,
    scale: base === 'decimal' && !text ? (facts.scale ?? 0) : undefined,
    empty: new Code(empty),
    dict: webDict,
    filterKey: range ? `${c.fieldName}${base === 'date' ? 'Dates' : 'Range'}` : c.fieldName,
    filterInit: new Code(filterInit),
    column: new Code(''),
  }
}

/** Rough px width of a header text (12px semibold): CJK 12.5, capitals 8, anything else 6.6. */
const headerText = (s: string) =>
  [...s].reduce((w, ch) => w + (/[\u2E80-\uFFFF]/.test(ch) ? 12.5 : /[A-Z]/.test(ch) ? 8 : 6.6), 0)
const ceil10 = (n: number) => Math.ceil(n / 10) * 10
/** the cell's horizontal padding (styles/element.css) and the sort caret */
const CELL_PAD = 32
const CARET = 18

/**
 * The `QwColumn` of a list column: labels are keys; short columns a fixed width by kind (a short text as
 * wide as its longest value, ≈ 7px a character), never narrower than the longest locale's header plus
 * the sort caret; `wide` (the free-text column, else the label column) a `minWidth` so it takes the
 * spare width; numbers right-aligned; text and dict labels cut with a tooltip. `sortable` = server sort
 * (a tree list has none: siblings come in `sort_no` order); a `tree`'s label column is 240px at least.
 */
function qwColumn(
  c: ColModel,
  wide: ColModel | undefined,
  label: ColModel | undefined,
  sortable = c.sortable,
  tree = false,
): string {
  const dictText = !!c.web.dict && c.base !== 'boolean'
  // a wide decimal is a string too (rules.ts tsTypeOf), still a number to read
  const numeric = c.tsType === 'number' || c.base === 'decimal'
  const text =
    (c.tsType === 'string' &&
      !numeric &&
      !c.web.dict &&
      !['date', 'image-upload'].includes(c.widget)) ||
    dictText
  const picker = c.widget === 'user-picker' || c.widget === 'dept-tree-select'
  let width = 160
  if (c.base === 'boolean') width = 100
  else if (c.widget === 'image-upload') width = 80
  else if (c.tsType === 'Date') width = 160
  else if (c.tsType !== 'number' && c.base === 'decimal')
    width = Math.max(120, ceil10(c.web.maxlength! * 7 + CELL_PAD))
  else if (c.tsType === 'number' || c.base === 'date' || c.web.dict) width = 120
  else if (c !== label && /(^|_)code$/.test(c.column)) width = 140
  else if (c !== label && (c.length ?? 256) <= 32)
    width = Math.max(140, ceil10(c.length! * 7 + CELL_PAD))
  // a tree's label column also holds the expand arrows and one indent per level
  if (tree && c === label) width = Math.max(width, 240)
  const header = Math.max(...Object.values(c.label).map(headerText))
  width = Math.max(width, ceil10(header + CELL_PAD + (sortable ? CARET : 0)))
  return object([
    ['prop', `'${c.field}'`],
    ['label', `'${c.labelKey}'`],
    ['sortable', sortable ? 'true' : undefined],
    [c === wide ? 'minWidth' : 'width', String(c === wide && c.freeText ? 120 : width)],
    ['align', numeric && !picker ? "'right'" : undefined],
    ['showOverflowTooltip', text ? 'true' : undefined],
  ])
}

/**
 * The `QwEditTable` column of a sub row's editor: switches, numbers, dates and dict selects a fixed width
 * (never narrower than the longest locale's header), text inputs a `minWidth` (they share the rest);
 * `required` puts the asterisk into the header.
 */
function editColumn(c: ColModel): string {
  const header = ceil10(Math.max(...Object.values(c.label).map(headerText)) + CELL_PAD + 8)
  let width: number | undefined
  if (c.base === 'boolean') width = 90
  else if (c.tsType === 'Date') width = 220
  else if (c.tsType === 'number' || c.base === 'decimal' || c.base === 'date' || c.web.dict)
    width = 160
  return object([
    ['prop', `'${c.field}'`],
    ['label', `'${c.labelKey}'`],
    [width ? 'width' : 'minWidth', String(Math.max(width ?? 160, header))],
    ['required', c.required ? 'true' : undefined],
  ])
}

/**
 * `example` typed like the column (a number, a boolean, else a string literal; a decimal text with all
 * its scale's digits, as MySQL answers it).
 */
function exampleOf(c: CgColumn, facts: ReturnType<typeof typeFacts>): Code | undefined {
  const e = c.example
  if (e === null) return undefined
  if (facts.base === 'boolean') return new Code(String(e === '1' || e === 'true'))
  if (c.tsType === 'number')
    return Number.isFinite(Number(e)) ? new Code(num(Number(e))) : undefined
  const m = decimalText(c, facts) && facts.scale ? /^(-?\d+)(?:\.(\d*))?$/.exec(e) : null
  return str(m ? `${m[1]}.${(m[2] ?? '').padEnd(facts.scale!, '0')}` : e)
}

/**
 * The CRUD / tree / master-sub template's model of `t`; a table needs the key and either every audit
 * column or none but `created_at` (append-only: the CRUD template only, always read-only). A tree (`template` `tree`) has no export, import, options, detail drawer or read-only mode
 * (like the dept golden sample): those options are ignored; a master-sub module has no import or
 * read-only mode (a document is saved whole through its form) and needs its sub tables (`t.subs`).
 */
export function crudModel(t: RenderConfig): CrudModel {
  const table = ident(CG_IDENT.dbName, t.tableName)
  const domain = ident(CG_IDENT.domain, t.domain)
  const business = ident(CG_IDENT.business, t.business)
  const Biz = ident(CG_IDENT.className, t.className, CG_RESERVED.className)
  const group = ident(/^(platform|workflow|biz)$/, t.groupCode)
  if (!cgDomainAllowed(group, domain))
    throw new BizError(Err.CODEGEN_IDENTIFIER_INVALID, { name: domain })
  const home = `${group === 'biz' ? '' : `${group}/`}${domain}/${business}`
  const depth = home.split('/').length
  const up = '../'.repeat(depth + 1)
  const parentMenu = ident(CG_IDENT.routeName, t.parentMenuRouteName)
  const o = t.options ?? {}
  const menuIcon = ident(CG_IDENT.icon, o.menuIcon ?? 'lucide:table')
  const biz = lowerFirst(Biz)
  const key = `${domain}.${kebabCamel(business)}`
  const words = business.split('-')
  const noun = words.join(' ')
  const nouns = [...words.slice(0, -1), pluralOf(words.at(-1)!)].join(' ')
  const base = baseOf(t)
  const tree = t.template === 'tree'
  const masterSub = t.template === 'master_sub'
  // an append-only table (a log) renders as a read-only CRUD page only
  if (!base || (base === 'append' && (tree || masterSub)))
    throw new BizError(Err.CODEGEN_TABLE_UNAVAILABLE, { table })
  const appendOnly = base === 'append'
  const byName = new Map(t.columns.map((c) => [c.columnName, c]))
  const treeLabel = assertTemplateColumns(t)
  for (const sub of t.subs ?? []) assertSecretColumns(sub)
  // a tree's own columns: the path only ever in the entity and the VO, the parent only in the form
  const treeRole = (c: CgColumn): CgColumn =>
    c.columnName === 'tree_path'
      ? { ...c, inList: false, inForm: false, inQuery: false, sortable: false }
      : c.columnName === 'parent_id'
        ? { ...c, inList: false, inForm: true, inQuery: false, sortable: false }
        : c

  const cols = [...t.columns]
    .sort((a, b) => a.sortNo - b.sortNo || a.id - b.id)
    .filter((c) => isOwn(c) || (AUDIT as readonly string[]).includes(c.columnName))
    .map((c) => colModel(tree ? treeRole(c) : c, key))
  const own = cols.filter((c) => !c.audit)
  const audit = Object.fromEntries(
    cols.filter((c) => c.audit).map((c) => [c.column, c]),
  ) as CrudModel['audit']
  const createdAt = audit.created_at
  const sortNo = own.find((c) => c.column === 'sort_no')
  const label = tree ? own.find((c) => c.column === treeLabel) : labelOf(own)
  // a tree lists its label column first: el-table puts the expand arrows into the first column
  const listed = [
    ...(tree && label ? [label] : []),
    ...own.filter((c) => c.inList && !(tree && c === label)),
    ...(createdAt?.inList ? [createdAt] : []),
  ]
  const list = [...listed.filter((c) => !c.freeText), ...listed.filter((c) => c.freeText)]
  const readonly = (t.readonly || appendOnly) && !tree && !masterSub
  const withExport = !!o.withExport && !tree
  const withImport = !!o.withImport && !readonly && !tree && !masterSub
  const withOptions = !!o.withOptions && !tree
  const dept = own.find((c) => c.column === 'dept_id')
  const scoped = o.dataScope !== false && !!dept
  const excel = withImport
    ? [
        ...list.filter((c) => !c.freeText),
        ...own.filter((c) => c.inForm && !c.inList && !c.secret),
        ...list.filter((c) => c.freeText),
      ]
    : list
  const wide = list.find((c) => c.freeText) ?? (label?.inList ? label : undefined)
  for (const c of list) c.web.column = new Code(qwColumn(c, wide, label, !tree && c.sortable, tree))
  const withCreatedAt = [...own, ...(createdAt ? [createdAt] : [])]
  const sortable = withCreatedAt.filter((c) => c.sortable)
  const sortFields = [
    ...(sortNo?.sortable ? [sortNo.field] : []),
    ...sortable.filter((c) => c !== sortNo).map((c) => c.field),
    'id',
  ]
  const text = (v: Record<Locale, string> | undefined, fallback: Record<Locale, string>) =>
    v ?? fallback
  const en = humanize(business.replace(/-/g, '_'))
  const form = own.filter((c) => c.inForm)
  const secrets = own.filter((c) => c.secret)
  const subs = masterSub ? subModels(t, business, key, form, up) : []
  const cascades = subs.map((s) => ({
    table: s.table,
    column: s.fk.column,
    cascade: true,
    label: s.about.text ? s.about : new Code(s.table),
  }))
  return {
    kind: tree ? 'tree' : masterSub ? 'master_sub' : 'crud',
    table,
    about: comment(t.tableComment),
    group,
    domain,
    business,
    home,
    project: group === 'biz',
    up,
    sharedUp: '../'.repeat(depth - 1),
    biz,
    Biz,
    bizs: kebabCamel(pluralOf(business)),
    noun,
    nouns,
    aNoun: `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`,
    key,
    url: `${domain}/${[...words.slice(0, -1), pluralOf(words.at(-1)!)].join('-')}`,
    routeName: `${domain}-${business}`,
    routePath: `/${domain}/${[...words.slice(0, -1), pluralOf(words.at(-1)!)].join('-')}`,
    component: `${home}/index`,
    componentName: `${domain.replace(/^./, (c) => c.toUpperCase())}${Biz}`,
    parentMenu,
    parentBuiltin: BUILTIN_MENU_GROUPS.includes(parentMenu),
    menuIcon,
    menuSortNo: o.menuSortNo ?? 10,
    entity: text(o.entityI18n, { 'zh-CN': t.featureName, 'en-US': en.toLowerCase() }),
    withExport,
    withImport,
    withOptions,
    withMobile: !!o.withMobile,
    entityBase: appendOnly ? (createdAt ? 'CreatedEntity' : 'IdEntity') : 'BaseEntity',
    refs: [...cascades, ...refsOf(t, cascades)],
    scope: scoped
      ? { dept: 'dept_id', owner: byName.has('created_by') ? 'created_by' : null }
      : undefined,
    dept: scoped ? dept : undefined,
    own,
    list,
    form,
    filters: withCreatedAt.filter((c) => c.inQuery),
    sortFields,
    excel,
    enabled: own.find((c) => c.column === 'enabled' && c.base === 'boolean'),
    sortNo,
    label,
    parent: tree ? own.find((c) => c.column === 'parent_id') : undefined,
    uniques: own.filter((c) => c.unique && !c.secret),
    importKey: withImport ? own.find((c) => c.unique && c.inForm && !c.secret) : undefined,
    specKey: own.find(
      (c) =>
        c.inForm &&
        !c.secret &&
        c.tsType === 'string' &&
        c.base !== 'date' &&
        c.base !== 'decimal' &&
        !c.dict &&
        c.inQuery &&
        c.queryOp === 'like' &&
        (c.length ?? 64) >= 7,
    ),
    audit,
    title: t.featureNameI18n ?? { 'zh-CN': t.featureName, 'en-US': en },
    listSort: sortNo?.sortable ? sortNo.field : createdAt ? '-createdAt' : '-id',
    withDetail: t.withDetailView && !tree,
    formCols: t.formCols,
    readonly,
    verbs: [
      'browse',
      'view',
      ...(readonly ? [] : ['create', 'modify', 'remove']),
      ...(withExport ? ['export'] : []),
      ...(withImport ? ['import'] : []),
    ],
    detail: [
      ...own.filter((c) => !c.secret && (c.inList || c.inForm)),
      ...(createdAt ? [createdAt] : []),
    ],
    rich: own.filter((c) => c.widget === 'richtext'),
    secrets,
    subs,
  }
}

/**
 * The base a table maps: `full` = the auto-increment key `id` and every audit column (BaseEntity, every
 * template); `append` = the key and no audit column but maybe `created_at` (`deleted_at`, which every
 * table has: an append-only log, CreatedEntity / IdEntity, a read-only CRUD page); else none
 * (422 C3001).
 */
function baseOf(t: Pick<CgTableDetail, 'columns'>): 'full' | 'append' | undefined {
  const pk = t.columns.find((c) => c.columnName === 'id')
  if (!pk?.isPk || !pk.isAutoInc) return undefined
  const has = (name: string) => t.columns.some((c) => c.columnName === name)
  if (AUDIT.every(has)) return 'full'
  return ['created_by', 'updated_by', 'updated_at'].some(has) ? undefined : 'append'
}

/**
 * The sub tables of master `t` (config id order): each linked to it (`assertSubLink`), with the key and
 * audit columns, a `prop` no master form field has and no other sub takes; none → 422 C3007. Their field
 * labels are the master's (`field.<domain>.<master biz>.<field>`, one fragment and validation domain for
 * the whole document): a sub field named like a master field shares its label.
 */
function subModels(
  t: RenderConfig,
  business: string,
  key: string,
  form: ColModel[],
  up: string,
): SubModel[] {
  const refuse = (table: string) =>
    new BizError(Err.CODEGEN_SUB_TABLES, { table: table.slice(0, 64) })
  const subs = [...(t.subs ?? [])].sort((a, b) => a.id - b.id)
  if (!subs.length) throw refuse(t.tableName)
  const props = new Set(form.map((c) => c.field))
  return subs.map((s) => {
    assertSubLink(s)
    if (s.masterTableId !== t.id || baseOf(s) !== 'full') throw refuse(s.tableName)
    const file = ident(CG_IDENT.business, s.business)
    const rest = file.startsWith(`${business}-`) ? file.slice(business.length + 1) : file
    const prop = kebabCamel(pluralOf(rest))
    if (props.has(prop)) throw refuse(s.tableName)
    props.add(prop)
    const own = [...s.columns]
      .sort((a, b) => a.sortNo - b.sortNo || a.id - b.id)
      .filter(isOwn)
      .map((c) => colModel(c, key))
    const fk = own.find((c) => c.column === s.subFkCol)!
    return {
      table: ident(CG_IDENT.dbName, s.tableName),
      about: comment(s.tableComment),
      Biz: ident(CG_IDENT.className, s.className, CG_RESERVED.className),
      biz: lowerFirst(s.className),
      up,
      file,
      prop,
      Prop: prop.replace(/^./, (c) => c.toUpperCase()),
      label: s.featureNameI18n ?? { 'zh-CN': s.featureName, 'en-US': humanize(prop) },
      fk,
      own,
      form: own.filter((c) => c.inForm && c !== fk),
      columns: own.filter((c) => c.inForm && c !== fk).map((c) => new Code(editColumn(c))),
      rich: own.filter((c) => c.inForm && c !== fk && c.widget === 'richtext'),
      sortNo: own.find((c) => c.column === 'sort_no' && c.tsType === 'number'),
      scope: undefined,
      entityBase: 'BaseEntity',
      refs: refsOf(s),
    }
  })
}

/**
 * The CRUD / tree template's files and where they go (repository paths, layout; see docs/design-notes.md#layering); a tree has
 * its own e2e spec template. `mobile`: the repository has the uni-app client (`hasMobile`), where a
 * `withMobile` config's pages go too (`mobileTargets`).
 */
export function crudTargets(m: CrudModel, mobile: boolean): Target[] {
  const dir = `apps/server/src/modules/${m.home}`
  const mod = `${dir}/${m.business}`
  const view = `apps/web/src/views/${m.home}`
  return [
    { template: 'server/entity.ts.ejs', path: `${mod}.entity.ts` },
    // a master-sub module's sub tables: their entities beside the master's
    ...m.subs.map((sub) => ({
      template: 'server/entity.ts.ejs',
      path: `${dir}/${sub.file}.entity.ts`,
      locals: { m: sub },
    })),
    { template: 'server/service.ts.ejs', path: `${mod}.service.ts` },
    { template: 'server/controller.ts.ejs', path: `${mod}.controller.ts` },
    { template: 'server/module.ts.ejs', path: `${mod}.module.ts` },
    { template: 'seed/seed.ts.ejs', path: `${mod}.seed.ts` },
    {
      template: 'shared/schema.ts.ejs',
      path: `packages/shared/src/${m.home}.schema.ts`,
    },
    ...LOCALES.map((lang) => ({
      template: 'shared/fields.json.ejs',
      path: `packages/shared/src/i18n/${lang}/modules/${m.domain}.${m.business}.json`,
      locals: { lang },
    })),
    {
      template: m.kind === 'tree' ? 'test/tree-e2e-spec.ts.ejs' : 'test/e2e-spec.ts.ejs',
      path: `apps/server/test/e2e/${m.domain}-${m.business}.e2e-spec.ts`,
    },
    {
      template: 'web/api.ts.ejs',
      path: `apps/web/src/api/${m.home}.ts`,
    },
    { template: 'web/index.vue.ejs', path: `${view}/index.vue` },
    ...(m.readonly ? [] : [{ template: 'web/form.vue.ejs', path: `${view}/form.vue` }]),
    ...(m.withDetail ? [{ template: 'web/detail.vue.ejs', path: `${view}/detail.vue` }] : []),
    ...LOCALES.map((lang) => ({
      template: 'web/locale.json.ejs',
      path: `apps/web/src/locales/${lang}/${m.domain}.${m.business}.json`,
      locals: { lang },
    })),
    ...(m.withMobile && mobile ? mobileTargets(m) : []),
  ]
}

/**
 * The uni-app pages of a `withMobile` module (docs/codegen-golden.md "Mobile"): the api, the list, the
 * detail (mobile has no drawer) and, unless read-only, the form page in the `pages-biz` subpackage; the
 * page texts as the web's locale fragment (field labels come from the shared one).
 */
function mobileTargets(m: CrudModel): Target[] {
  const page = `${MOBILE}pages-biz/${m.home}`
  return [
    { template: 'uni/api.ts.ejs', path: `${MOBILE}api/${m.home}.ts` },
    { template: 'uni/index.vue.ejs', path: `${page}/index.vue` },
    { template: 'uni/detail.vue.ejs', path: `${page}/detail.vue` },
    ...(m.readonly ? [] : [{ template: 'uni/form.vue.ejs', path: `${page}/form.vue` }]),
    ...LOCALES.map((lang) => ({
      template: 'web/locale.json.ejs',
      path: `${MOBILE}locales/${lang}/${m.domain}.${m.business}.json`,
      locals: { lang },
    })),
  ]
}

/**
 * Every file of the CRUD, tree or master-sub module of `t` (the header names the template); `mobile`:
 * with the uni-app pages of a `withMobile` config (default: when the repository has the client).
 */
export async function renderCrud(t: RenderConfig, mobile = hasMobile()): Promise<RenderedFile[]> {
  const m = crudModel(t)
  return renderTargets(crudTargets(m, mobile), { m }, m.kind)
}

/**
 * What to add by hand once the files are in (the generator never edits an existing file): the
 * module import, the seed, the shared export; with the uni-app pages (`mobile`, as `renderCrud`) their
 * `pages.json` entries and where an entry point could go.
 */
export function crudRegistration(t: RenderConfig, mobile = hasMobile()): string[] {
  const m = crudModel(t)
  // project business registers in project.module.ts and SEEDS.project (the samples: SEEDS.demo) only
  //; platform / workflow in the domain's module
  const biz = m.group === 'biz'
  const host = biz
    ? 'apps/server/src/modules/project.module.ts:'
    : `apps/server/src/modules/${m.group}/${m.domain}/${m.domain}.module.ts (or the module that imports this domain's modules):`
  const from = `./${biz ? `${m.domain}/` : ''}${m.business}/${m.business}.module.js`
  const seeds = `SEEDS.${biz && m.domain !== 'demo' ? 'project' : m.domain}`
  return [
    host,
    // arch-allow: sql-concat an import statement for the user to paste, not SQL
    `  import { ${m.Biz}Module } from '${from}'  + ${m.Biz}Module in \`imports\``,
    'apps/server/src/db/seeds/index.ts:',
    // arch-allow: sql-concat an import statement for the user to paste, not SQL
    `  import { seed${m.Biz} } from '../../modules/${m.home}/${m.business}.seed.js'  + seed${m.Biz} in ${seeds}`,
    'packages/shared/src/index.ts:',
    // arch-allow: sql-concat an export statement for the user to paste, not SQL
    `  export * from './${m.home}.schema.js'`,
    ...(m.withMobile && mobile
      ? [
          `${MOBILE}pages.json (subpackage "pages-biz"):`,
          ...['index', 'detail', ...(m.readonly ? [] : ['form'])].map(
            (p) => `  { "path": "${m.home}/${p}", "style": {} }`,
          ),
          `  an entry point is up to the project, e.g. a shortcut in ${MOBILE}pages/home/index.vue (SHORTCUTS) to /pages-biz/${m.home}/index`,
        ]
      : []),
  ]
}
