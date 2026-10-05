// Column and table initialization rules of the code generator (rule table, our own; see docs/design-notes.md#codegen): the
// defaults an imported table starts with, all editable afterwards. Pure functions over information_schema
// facts; every output passes the `@qiwu/shared` codegen whitelist when the names it derives from do.
import {
  CG_IDENT,
  type CgColumnFields,
  cgClassName,
  cgDictCode,
  type CgImportHint,
  type CgTableFields,
  type CgTsType,
  Err,
  RESERVED_NAMES,
  safeFieldName,
} from '@qiwu/shared'
import * as shared from '@qiwu/shared'
import type { ColumnInfo, TableInfo } from '../../../core/db/schema-info.js'
import { BizError } from '../../../core/http/biz-error.js'

/** Framework tables, never offered for import: TypeORM's `meta_`, test fixtures, the generator's own. */
export const EXCLUDED_TABLE = /^(meta|test|cg)_/

/** Built-in table prefixes → code group and domain; stripped to derive the business name. */
export const TABLE_PREFIXES: Record<
  string,
  Pick<CgTableFields, 'groupCode' | 'domain' | 'parentMenuRouteName'>
> = {
  iam_: { groupCode: 'platform', domain: 'iam', parentMenuRouteName: 'system' },
  cfg_: { groupCode: 'platform', domain: 'settings', parentMenuRouteName: 'system' },
  msg_: { groupCode: 'platform', domain: 'messaging', parentMenuRouteName: 'messaging' },
  aud_: { groupCode: 'platform', domain: 'audit', parentMenuRouteName: 'audit' },
  fs_: { groupCode: 'platform', domain: 'storage', parentMenuRouteName: 'storage' },
  job_: { groupCode: 'platform', domain: 'scheduler', parentMenuRouteName: 'monitor' },
  oauth_: { groupCode: 'platform', domain: 'oauth', parentMenuRouteName: 'system' },
  im_: { groupCode: 'platform', domain: 'im', parentMenuRouteName: 'system' },
  wf_: { groupCode: 'workflow', domain: 'wf', parentMenuRouteName: 'wf-admin' },
  biz_: { groupCode: 'biz', domain: 'biz', parentMenuRouteName: 'biz' },
  demo_: { groupCode: 'biz', domain: 'demo', parentMenuRouteName: 'demo' },
}
/**
 * A project table without a domain of its own (no underscore, or a reserved first name segment): group
 * and domain `biz`, business = its whole name.
 */
const UNPREFIXED: Pick<CgTableFields, 'groupCode' | 'domain' | 'parentMenuRouteName'> = {
  groupCode: 'biz',
  domain: 'biz',
  parentMenuRouteName: 'biz',
}

/**
 * Group, domain and the name rest of a table (no config): a built-in prefix's;
 * else the first name segment is the project domain (`erp_sale_order` → `erp`, `sale_order`), unless the
 * table has no underscore or that segment is reserved (`RESERVED_NAMES`) or no domain name: `biz`, the
 * whole name.
 */
export function domainOf(tableName: string) {
  const prefix = Object.keys(TABLE_PREFIXES).find((p) => tableName.startsWith(p))
  if (prefix) return { ...TABLE_PREFIXES[prefix]!, rest: tableName.slice(prefix.length) }
  const [first = '', ...more] = tableName.split('_')
  const rest = more.join('_').replace(/^_+/, '')
  return rest && CG_IDENT.domain.test(first) && !RESERVED_NAMES.has(first)
    ? { ...UNPREFIXED, domain: first, rest }
    : { ...UNPREFIXED, rest: tableName }
}

/** Audit columns: never in forms; only `created_at` is listed and searched (a range). */
const AUDIT = new Set(['created_by', 'created_at', 'updated_by', 'updated_at', 'deleted_at'])
const INTEGER = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint'])
const DECIMAL = new Set(['decimal', 'numeric', 'float', 'double'])
/**
 * Digits a JS number holds exactly (IEEE 754 double: 15 significant decimal digits). A wider fixed-point
 * `decimal` / `numeric` stays the driver's string end to end (`bigDecimal`).
 */
const SAFE_DIGITS = 15
const TEXT = new Set(['tinytext', 'text', 'mediumtext', 'longtext'])
const CHARS = new Set(['varchar', 'char'])
/** "short varchar" of the enum-code rule: enums are varchar(24) codes */
const SHORT_VARCHAR = 32
const INPUT_MAX = 255
const LABEL_MAX = 64
const FEATURE_MAX = 128

/** The DB facts of a column, stored next to its config and refreshed by sync. */
export interface ColumnFacts {
  columnName: string
  columnType: string
  columnComment: string
  columnDefault: string | null
  nullable: boolean
  isPk: boolean
  isAutoInc: boolean
}
export type ColumnConfig = ColumnFacts & CgColumnFields
export type TableConfig = { tableName: string; tableComment: string } & CgTableFields

/** `varchar(64)` → `varchar`, `bigint unsigned` → `bigint`. */
const baseType = (columnType: string) => /^[a-z]+/.exec(columnType.toLowerCase())?.[0] ?? ''
/** `varchar(64)` → 64, `decimal(10,2)` → 10; none → undefined. */
const lengthOf = (columnType: string) => {
  const m = /\((\d+)/.exec(columnType)
  return m ? Number(m[1]) : undefined
}
const isBoolean = (columnType: string) => /^tinyint\(1\)/i.test(columnType)

/** `sort_no` → `sortNo`. */
export const camel = (snake: string): string =>
  snake.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/_+$/, '')
/** `leave_request` → `LeaveRequest`. */
export const pascal = (snake: string): string =>
  camel(snake).replace(/^[a-z]/, (c) => c.toUpperCase())
/** `published_on` → `Published on` (the en-US label default; see docs/design-notes.md#i18n). */
export const humanize = (snake: string): string =>
  snake
    .replace(/_+/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase())
/** A comment's label: the text before a parenthesised note, ASCII or full-width (U+FF08). */
export const labelOf = (comment: string): string => comment.split(/[(\uFF08]/)[0]!.trim()

/** A fixed-point column wider than a JS number holds exactly: `decimal(16,2)` and up. */
const bigDecimal = (columnType: string) =>
  /^(decimal|numeric)$/.test(baseType(columnType)) && (lengthOf(columnType) ?? 10) > SAFE_DIGITS

/**
 * TS type of a column: `tinyint(1)` boolean, integers and decimals number (the driver returns DECIMAL
 * as a string: templates convert), except a decimal of more than 15 digits: a string (a decimal-string
 * check, a text input and a text Excel cell), datetime/timestamp Date, json unknown, the rest string
 * (`date` too: TypeORM hydrates it as `YYYY-MM-DD`).
 * `bigint` stays a number too (ids, counters): exact only up to 2^53 - 1
 * (Number.MAX_SAFE_INTEGER), beyond it the driver hands a string (`supportBigNumbers`) that the number
 * schemas refuse; a column whose values get that big needs the string path of `bigDecimal`.
 */
export function tsTypeOf(columnType: string): CgTsType {
  const base = baseType(columnType)
  if (isBoolean(columnType)) return 'boolean'
  if (bigDecimal(columnType)) return 'string'
  if (INTEGER.has(base) || DECIMAL.has(base)) return 'number'
  if (base === 'datetime' || base === 'timestamp') return 'Date'
  if (base === 'json') return 'unknown'
  return 'string'
}

/**
 * A tree table (`tree`; see docs/design-notes.md#codegen): `parent_id` + `tree_path`; its label column is the first `*name` /
 * `*title` one. Null for any other table.
 */
function treeOf(columns: Pick<ColumnInfo, 'name'>[]) {
  const names = columns.map((c) => c.name)
  if (!names.includes('parent_id') || !names.includes('tree_path')) return null
  return {
    template: 'tree' as const,
    treeParentCol: 'parent_id',
    treeLabelCol: names.find((n) => /(^|_)(name|title)$/.test(n)) ?? null,
  }
}

/**
 * Table defaults: group, domain and business from the name (`domainOf`; a class name the templates use
 * already gets the domain in front), the feature name from the table comment; a table
 * with `parent_id` + `tree_path` gets the `tree` template (no export: a tree page has none).
 */
export function initTable(
  table: Pick<TableInfo, 'name' | 'comment'> & { columns?: Pick<ColumnInfo, 'name'>[] },
): TableConfig {
  const { groupCode, domain, parentMenuRouteName, rest } = domainOf(table.name)
  const feature = (labelOf(table.comment) || humanize(rest)).slice(0, FEATURE_MAX)
  const en = humanize(rest)
  const tree = treeOf(table.columns ?? [])
  const business = rest.replace(/_+/g, '-')
  return {
    tableName: table.name,
    tableComment: table.comment,
    groupCode,
    domain,
    business,
    // never a name the templates import or declare next to it (`cfg_param` → `SettingsParam`)
    className: cgClassName(domain, business),
    featureName: feature,
    featureNameI18n: { 'zh-CN': feature, 'en-US': en },
    template: 'crud',
    parentMenuRouteName,
    treeParentCol: null,
    treeLabelCol: null,
    ...tree,
    // a sub table of a master_sub module is linked by hand (on the page or in a .cg.ts seed)
    masterTableId: null,
    subFkCol: null,
    formCols: 1,
    withDetailView: false,
    readonly: false,
    options: {
      withExport: !tree,
      withImport: false,
      withOptions: false,
      menuIcon: 'lucide:table',
      menuSortNo: 10,
      entityI18n: { 'zh-CN': feature.slice(0, LABEL_MAX), 'en-US': en.toLowerCase() },
    },
    note: null,
  }
}

type Names = Pick<TableConfig, 'tableName' | 'domain' | 'business' | 'className'>

/**
 * A config's names against the other configs': another's class name (its exported
 * identifiers) or module (domain + business) → 422 C3011 naming that table.
 */
export function assertNamesFree(t: Names, others: readonly Names[]): void {
  const other = others.find(
    (o) => o.className === t.className || (o.domain === t.domain && o.business === t.business),
  )
  if (other) throw new BizError(Err.CODEGEN_NAME_CONFLICT, { table: other.tableName })
}

/** The values the generated shared schema of class `className` exports (`leavePerms`, `leaveVo` …). */
const SHARED_EXPORTS = 'Perms Create Update Query Vo DetailVo NodeVo OptionVo'.split(' ')

/**
 * Whether `@qiwu/shared` exports one of them already for another module (`erp_leave` → `Leave` beside the
 * hand-written `biz/leave`); the table's own module (re-imported `iam_position`, the hand-written
 * `iam_role`: its perms under `<domain>.<business>`) is no clash.
 */
const takenInShared = ({ domain, business, className }: Names): boolean => {
  const b = className.replace(/^./, (c) => c.toLowerCase())
  const perms: unknown = (shared as Record<string, unknown>)[`${b}Perms`]
  const key = `${domain}.${camel(business.replace(/-/g, '_'))}.`
  if (perms && Object.values(perms).some((p) => String(p).startsWith(key))) return false
  return SHARED_EXPORTS.some((s) => `${b}${s}` in shared)
}

/**
 * The import defaults `t` beside the configs there are and the other tables' derivations: a
 * business another domain has too (a config's or a table's, the hand-written `iam_user` included: its
 * `userPerms`), a config's class name, or one whose exports `@qiwu/shared` holds already (`erp_leave`
 * beside the hand-written `biz/leave`), → the domain in front of the class name (`ErpCustomer`,
 * `erpCustomerPerms`; whatever the import order); still taken by a config, or the same domain and business
 * as a config → 422 C3011. Import / defaults only: once generated, a config's own exports are in shared.
 */
export function qualifyNames<T extends Names>(
  t: T,
  others: readonly Names[],
  tables: readonly Pick<Names, 'domain' | 'business'>[] = [],
): T {
  const twin =
    [...others, ...tables].some((o) => o.business === t.business && o.domain !== t.domain) ||
    others.some((o) => o.className === t.className) ||
    takenInShared(t)
  const named = twin ? { ...t, className: cgClassName(t.domain, t.business, true) } : t
  assertNamesFree(named, others)
  return named
}

/** Whether the table has `deleted_at`: every generated entity maps it (`BaseEntity`, soft delete). */
export const hasDeletedAt = (info: Pick<TableInfo, 'columns'>) =>
  info.columns.some((c) => c.name === 'deleted_at')

/**
 * A table without `deleted_at` is neither imported nor generated (its page would fail
 * on the first query) → 422 C3010.
 */
export function assertDeletedAt(info: Pick<TableInfo, 'name' | 'columns'>): void {
  if (!hasDeletedAt(info)) throw new BizError(Err.CODEGEN_NO_DELETED_AT, { table: info.name })
}

/**
 * The rest of the soft-delete convention a table misses: a unique key without the
 * generated `alive` column (a deleted row's value would stay taken). The import goes on: a hint to fix the
 * DDL first.
 */
export function importHints(info: Pick<TableInfo, 'name' | 'uniqueKeys'>): CgImportHint[] {
  return info.uniqueKeys
    .filter((k) => !k.columns.includes('alive'))
    .map((k) => ({ tableName: info.name, missing: 'alive', key: k.name }))
}

/**
 * The rule table's `required` ("NOT NULL 且无默认值"; see docs/design-notes.md#codegen): NOT NULL without a default, never the key
 * (an auto-increment needs none) or an audit column. Sync recomputes it when the stored value still is
 * this default of the old DB facts (not edited by hand) and the facts changed.
 */
export const requiredByRule = (
  c: Pick<ColumnFacts, 'columnName' | 'nullable' | 'columnDefault' | 'isPk' | 'isAutoInc'>,
): boolean =>
  !c.nullable && c.columnDefault === null && !c.isAutoInc && !c.isPk && !AUDIT.has(c.columnName)

/** `name`, or `name2`, `name3` … when another column of the table has it already (added to `used`). */
export function freeName(name: string, used: Set<string>): string {
  let free = name
  for (let i = 2; used.has(free); i++) free = `${name}${i}`
  used.add(free)
  return free
}

/**
 * Column defaults by the rule table below, first matching row wins. `null` = not imported at all:
 * generated columns (`alive` and the like) are computed by MySQL and never mapped.
 * `domain` names the dict an enum-code column is pointed at (`<domain>.<column>`; a bare `kind` /
 * `type` / `status` gets the table's business in front: `<domain>.<business>_kind`, snake case).
 */
export function initColumn(
  col: ColumnInfo,
  domain: string,
  sortNo: number,
  business = '',
): ColumnConfig | null {
  if (col.generated || col.name === 'alive') return null
  const { name, columnType } = col
  const base = baseType(columnType)
  const length = lengthOf(columnType) ?? 0
  const c: ColumnConfig = {
    columnName: name,
    columnType,
    columnComment: col.comment,
    columnDefault: col.default,
    nullable: col.nullable,
    isPk: col.isPk,
    isAutoInc: col.autoIncrement,
    // never a reserved word or a template local (`default` → `defaultValue`)
    fieldName: safeFieldName(camel(name)),
    tsType: tsTypeOf(columnType),
    widget: 'input',
    inList: true,
    inForm: true,
    inQuery: false,
    queryOp: 'eq',
    sortable: false,
    required: requiredByRule({
      columnName: name,
      nullable: col.nullable,
      columnDefault: col.default,
      isPk: col.isPk,
      isAutoInc: col.autoIncrement,
    }),
    dictCode: null,
    labelI18n: {
      'zh-CN': (labelOf(col.comment) || humanize(name)).slice(0, LABEL_MAX),
      'en-US': humanize(name).slice(0, LABEL_MAX),
    },
    options: col.unique ? { unique: true } : {},
    sortNo,
    example: null,
  }
  // primary key: read-only, not listed
  if (col.isPk) return { ...c, inList: false, inForm: false }
  // audit columns: never in forms; created_at listed and searched as a range
  if (AUDIT.has(name)) {
    const createdAt = name === 'created_at'
    return {
      ...c,
      widget: createdAt ? 'datetime' : c.widget,
      inList: createdAt,
      inForm: false,
      inQuery: createdAt,
      queryOp: createdAt ? 'between' : 'eq',
      sortable: createdAt,
    }
  }
  // tree columns: the path is the service's, the parent is picked in the form, not listed
  if (name === 'tree_path') return { ...c, inList: false, inForm: false }
  if (name === 'parent_id') return { ...c, widget: 'number', inList: false }
  if (name.endsWith('_enc') && CHARS.has(base) && col.nullable)
    return {
      ...c,
      widget: 'secret',
      inList: false,
      inQuery: false,
      sortable: false,
      inForm: true,
      required: false,
      labelI18n: {
        'zh-CN': (labelOf(col.comment) || humanize(name.slice(0, -4))).slice(0, LABEL_MAX),
        'en-US': humanize(name.slice(0, -4)).slice(0, LABEL_MAX),
      },
    }
  // pickers by name (id columns)
  if (INTEGER.has(base) && name.endsWith('_user_id'))
    return { ...c, widget: 'user-picker', inQuery: true }
  if (INTEGER.has(base) && name === 'dept_id')
    return { ...c, widget: 'dept-tree-select', inQuery: true }
  // uploads by name (url columns)
  if (CHARS.has(base) && /image|avatar/.test(name)) return { ...c, widget: 'image-upload' }
  if (CHARS.has(base) && /file|attachment/.test(name)) return { ...c, widget: 'file-upload' }
  // booleans (`enabled`, `is_*`, any tinyint(1)): a switch over the yes/no dicts
  if (isBoolean(columnType))
    return {
      ...c,
      widget: 'switch',
      inQuery: true,
      dictCode: name === 'enabled' ? 'core.enabled' : 'core.yes_no',
    }
  // short enum-code varchar (`*_kind`, `kind` alone …): a select, pointed at the dict `<domain>.<column>`
  if (base === 'varchar' && length <= SHORT_VARCHAR && /(^|_)(kind|type|status)$/.test(name))
    return { ...c, widget: 'select', inQuery: true, dictCode: cgDictCode(domain, business, name) }
  // text: a textarea (a rich text editor for content/body), not listed
  if (TEXT.has(base))
    return { ...c, widget: /content|body/.test(name) ? 'richtext' : 'textarea', inList: false }
  // varchar ≤ 255: an input, names/titles/codes searched by LIKE; longer: a textarea
  if (CHARS.has(base)) {
    if (length > INPUT_MAX) return { ...c, widget: 'textarea' }
    const like = /(name|title|code)$/.test(name)
    return { ...c, sortable: true, inQuery: like, queryOp: like ? 'like' : 'eq' }
  }
  // dates: searched as a range
  if (base === 'date' || base === 'datetime' || base === 'timestamp')
    return {
      ...c,
      widget: base === 'date' ? 'date' : 'datetime',
      inQuery: true,
      queryOp: 'between',
      sortable: true,
    }
  // a decimal wider than a JS number: its digits typed as text (tsTypeOf)
  if (bigDecimal(columnType)) return { ...c, sortable: true }
  if (INTEGER.has(base) || DECIMAL.has(base)) return { ...c, widget: 'number', sortable: true }
  // json and anything else: kept for the entity, not in lists or forms
  return { ...c, inList: false, inForm: false }
}
