import { z } from 'zod'
import { LOCALES } from '../../common/locale.js'
import { PROJECT_BUILTIN_DOMAINS, RESERVED_NAMES } from '../../common/reserved-names.js'
import { MENU_GROUP_ROUTE_NAME } from '../iam/menu.schema.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Code generator config (`cg_table` / `cg_column`; see docs/design-notes.md#codegen). Generator input is untrusted: every
 * identifier the templates write into code, file paths, permission strings or i18n keys must match
 * `CG_IDENT` (the generator's identifier whitelist), and config that fails it is never saved. Free texts (labels,
 * descriptions) are no identifiers: templates only ever write them as escaped string literals.
 */

/** Generator identifier whitelist (+ menu route name and icon, which the menu seed writes). */
export const CG_IDENT = {
  /** table / column names, as read from information_schema */
  dbName: /^[a-z][a-z0-9_]{0,63}$/,
  className: /^[A-Z][A-Za-z0-9]{0,63}$/,
  /** a domain: one word, no hyphen (joined to a business by one) */
  domain: /^[a-z][a-z0-9]{0,31}$/,
  /** business: kebab-case */
  business: /^[a-z][a-z0-9-]{0,63}$/,
  fieldName: /^[a-z][a-zA-Z0-9]{0,63}$/,
  dictCode: /^[a-z][a-z0-9_.]{0,99}$/,
  /** a group menu's route name (required of every group, the menu form's rule too) */
  routeName: MENU_GROUP_ROUTE_NAME,
  icon: /^lucide:[a-z0-9]+(?:-[a-z0-9]+)*$/,
} as const

/** whitespace-separated names */
const nameSet = (names: string) => new Set(names.trim().split(/\s+/))

/**
 * Names the rendered code already uses next to a generated class or field (see docs/design-notes.md#codegen), which
 * the regexes above let through: a class is declared beside the templates' imports and constants
 * (`Param` of @nestjs/common for `cfg_param`, `Entity`, `URL` …) and the globals its code is typed with
 * (`Date`); a field is also a local binding (the list filter destructures its query, a sub-row save
 * takes its fk as a parameter), so no JS/TS reserved word and no local of those templates. Import
 * derives another default (`safeClassName` / `safeFieldName`); save and render refuse them (422 C3002).
 */
export const CG_RESERVED = {
  // templates' imports (@nestjs/*, typeorm, swagger, @qiwu/shared, core) and constants; globals; the
  // web / mobile api files' `crudApi` / `treeApi` imports beside `<biz>Api` (class Crud / Tree)
  className: nameSet(`
    ActionLog ApiBody ApiEnvelope ApiOperation ApiProduces ApiTags AppModule BaseCrudService
    BaseEntity BaseTreeService BizError Body Column Controller DataScoped DataSource Delete
    EnabledBody Entity Err ExcelColumn ExcelJS ExcelService Get HttpCode Idempotent IdsBody
    ImportBody ImportMode ImportResult In Injectable InsertImportBody Module
    NestExpressApplication NotFoundException Param ParseIntPipe Post Put Query Redis RequirePerm
    SelectQueryBuilder SoftDeleteEntity Test TransactionHost TransactionalAdapterTypeOrm
    TypeOrmModule UploadFile UploadedFile UploadedFileData ACTIONS BASE DEPT FORM HEADERS IMPORT
    MISSING PREFIX URL Array BigInt Boolean Buffer Date Error Function JSON Map Math Number
    Object Omit Partial Pick Promise Record RegExp Set String Symbol
    Crud Tree
  `),
  // JS/TS reserved words (strict mode); the service's locals and imports beside the filter / sub-row
  // bindings
  fieldName: nameSet(`
    arguments await break case catch class const constructor continue debugger default delete do
    else enum eval export extends false finally for function if implements import in instanceof
    interface let new null package private protected public return static super switch this
    throw true try typeof undefined var void while with yield contains dto gone qb repo row rows
    sanitizeFields seedKeysLike seeded sent stored clean
  `),
} as const

/** `sale-order` → `SaleOrder`. */
const pascalOf = (kebab: string) =>
  kebab
    .split('-')
    .map((w) => w.replace(/^./, (c) => c.toUpperCase()))
    .join('')

/**
 * `Param` → `SettingsParam` (`Error` → `BizError` is taken too → `BizErrorItem`): a derived class name
 * the templates cannot clash with.
 */
export function safeClassName(name: string, domain: string): string {
  const Domain = pascalOf(domain)
  return (
    [name, `${Domain}${name}`].find((n) => !CG_RESERVED.className.has(n)) ?? `${Domain}${name}Item`
  )
}

/**
 * The class name a config's domain and business derive (`sale-order` → `SaleOrder`, a taken one like
 * `safeClassName`); `qualified` (another domain has the same business) the domain in front:
 * `ErpCustomer`. The exported identifiers follow the class name (`erpCustomerPerms`).
 */
export const cgClassName = (domain: string, business: string, qualified = false): string =>
  qualified
    ? safeClassName(`${pascalOf(domain)}${pascalOf(business)}`, '')
    : safeClassName(pascalOf(business), domain)

/**
 * The dict an enum-code column (`*_kind` …) is pointed at: `<domain>.<column>`; a bare `kind` / `type` /
 * `status` gets the business in front (`<domain>.<business>_kind`, snake case).
 */
export const cgDictCode = (domain: string, business: string, column: string): string =>
  `${domain}.${!column.includes('_') && business ? `${business.replace(/-/g, '_')}_` : ''}${column}`

/**
 * A project config (group `biz`) never takes a reserved name as its domain, except the
 * built-in project domains `biz` and `demo`; platform / workflow configs use their built-in domains.
 */
export const cgDomainAllowed = (groupCode: string, domain: string): boolean =>
  groupCode !== 'biz' || PROJECT_BUILTIN_DOMAINS.includes(domain) || !RESERVED_NAMES.has(domain)

/** `default` → `defaultValue`: a derived field name that is no reserved word or template local. */
export const safeFieldName = (name: string): string =>
  CG_RESERVED.fieldName.has(name) ? `${name}Value` : name

export const CG_GROUPS = ['platform', 'workflow', 'biz'] as const
export const CG_TEMPLATES = ['crud', 'tree', 'master_sub'] as const
export const CG_TS_TYPES = ['string', 'number', 'boolean', 'Date', 'unknown'] as const
export const CG_WIDGETS = [
  'input',
  'textarea',
  'richtext',
  'secret',
  'number',
  'switch',
  'select',
  'radio',
  'date',
  'datetime',
  'image-upload',
  'file-upload',
  'user-picker',
  'dept-tree-select',
] as const
export const CG_QUERY_OPS = ['eq', 'like', 'between'] as const

export type CgTsType = (typeof CG_TS_TYPES)[number]
export type CgWidget = (typeof CG_WIDGETS)[number]
export type CgQueryOp = (typeof CG_QUERY_OPS)[number]

/** A text in every language (both keys required). */
const texts = (max: number) => z.record(z.enum(LOCALES), z.string().trim().min(1).max(max))

/** `cg_table.options`: what the CRUD template renders besides the table and its columns. */
export const cgTableOptions = z.strictObject({
  /** `GET /export` + the list's export button */
  withExport: z.boolean().optional(),
  /** import template + `POST /import` + the import dialog */
  withImport: z.boolean().optional(),
  /** `GET /options` (enabled rows `{ id, <label> }` for pickers) */
  withOptions: z.boolean().optional(),
  /**
   * the uni-app pages too: `mobile/src/` api, list / detail / form pages and locale fragments; nothing
   * when the repository has no `mobile/` (PC only, docs/mobile.md)
   */
  withMobile: z.boolean().optional(),
  /**
   * data scope (see docs/design-notes.md#data-scope) by the table's `dept_id` (owner `created_by`): `@DataScoped` on the entity;
   * unset = on when the table has a `dept_id` column, `false` switches it off
   */
  dataScope: z.boolean().optional(),
  menuIcon: z.string().max(64).regex(CG_IDENT.icon).optional(),
  menuSortNo: z.number().int().min(0).max(999_999).optional(),
  /** the noun in dialog titles ("Add {entity}") */
  entityI18n: texts(64).optional(),
  /**
   * the columns of other tables holding ids of this table's rows (no foreign keys): the generated
   * entity registers each with core/db/references.ts, so deleting a row a live one still holds → 409
   * `in_use`; `label` names it in the generated code. Checked on save: a column of a table of this
   * database that has `deleted_at`.
   */
  referencedBy: z
    .array(
      z.strictObject({
        table: z.string().regex(CG_IDENT.dbName),
        column: z.string().regex(CG_IDENT.dbName),
        label: z.string().trim().min(1).max(64),
      }),
    )
    .max(20)
    .optional(),
})
export type CgTableOptions = z.infer<typeof cgTableOptions>

/** `cg_column.options`. */
export const cgColumnOptions = z.strictObject({
  /** a name column that seeds fill with `seed.<biz>.*` keys: its search also matches their texts */
  seedName: z.boolean().optional(),
  /**
   * alone in a unique index (set on import): the generated e2e spec expects 409 on a duplicate, an
   * import in `upsert` mode matches rows by it
   */
  unique: z.boolean().optional(),
})
export type CgColumnOptions = z.infer<typeof cgColumnOptions>

/** The editable config of one table (everything but the names read from the database). */
export const cgTableFields = z
  .strictObject({
    groupCode: z.enum(CG_GROUPS),
    domain: z.string().regex(CG_IDENT.domain),
    business: z.string().regex(CG_IDENT.business),
    className: z.string().regex(CG_IDENT.className),
    featureName: z.string().trim().min(1).max(128),
    featureNameI18n: texts(128),
    template: z.enum(CG_TEMPLATES),
    /** the group menu the page goes into (its route name; checked on save): never empty */
    parentMenuRouteName: z.string().regex(CG_IDENT.routeName),
    /**
     * `tree` template: the parent column (`parent_id`, the only one the tree base supports) and the label
     * column (the tree column of the list, the parent picker's text); null for other templates
     */
    treeParentCol: z.string().regex(CG_IDENT.dbName).nullable(),
    treeLabelCol: z.string().regex(CG_IDENT.dbName).nullable(),
    /**
     * `master_sub` template, set on each SUB-table config: the master's config id (its template
     * `master_sub`) and this table's column holding the master row's id; null for any other config. The
     * master renders one module with an editable table of each sub's rows (docs/codegen-golden.md
     * "Master-sub"); both are set together or both null.
     */
    masterTableId: z.number().int().positive().nullable(),
    subFkCol: z.string().regex(CG_IDENT.dbName).nullable(),
    formCols: z.number().int().min(1).max(3),
    withDetailView: z.boolean(),
    readonly: z.boolean(),
    options: cgTableOptions,
    note: z.string().trim().max(500).nullable(),
  })
  .register(fieldDomains, { domain: 'codegen' })
export type CgTableFields = z.infer<typeof cgTableFields>

/** The editable config of one column. */
export const cgColumnFields = z
  .strictObject({
    fieldName: z.string().regex(CG_IDENT.fieldName),
    tsType: z.enum(CG_TS_TYPES),
    widget: z.enum(CG_WIDGETS),
    inList: z.boolean(),
    inForm: z.boolean(),
    inQuery: z.boolean(),
    queryOp: z.enum(CG_QUERY_OPS),
    sortable: z.boolean(),
    required: z.boolean(),
    dictCode: z.string().regex(CG_IDENT.dictCode).nullable(),
    labelI18n: texts(64),
    options: cgColumnOptions,
    sortNo: z.number().int().min(0).max(999_999),
    example: z.string().max(255).nullable(),
  })
  .register(fieldDomains, { domain: 'codegen' })
export type CgColumnFields = z.infer<typeof cgColumnFields>

/** Save: the table fields and the columns (by id) sent are changed, the others kept. */
export const cgTableUpdate = cgTableFields
  .partial()
  .extend({
    columns: z
      .array(cgColumnFields.partial().extend({ id: z.number().int().positive() }))
      .max(200)
      .optional(),
  })
  .register(fieldDomains, { domain: 'codegen' })
export type CgTableUpdate = z.infer<typeof cgTableUpdate>
