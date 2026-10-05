import { z } from 'zod'
import { type I18nText, LOCALES } from '../../common/locale.js'
import { PAGE_SIZE_MAX, pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import {
  CG_GROUPS,
  CG_TEMPLATES,
  cgColumnFields,
  cgColumnOptions,
  cgTableFields,
  cgTableOptions,
} from './codegen.schema.js'

/**
 * HTTP contract of the generator page (see docs/design-notes.md#codegen), all under `/api/codegen/tables` (static
 * segments before `:id`), every route behind one of `codegenPerms`:
 *
 * - `GET /` `cgTableQuery` → `Page<cgTableVo>` (browse): the imported configs
 * - `GET /importable` → `cgImportableVo[]` (import): base tables of this database not imported yet, without
 *   the framework tables `meta_%` / `test_%` / `cg_%`; `noDeletedAt` marks the ones import refuses
 * - `POST /import` `cgImportBody` → `cgImportVo` (import): all or none; a name not importable → 422 C3001,
 *   outside the identifier whitelist → 422 C3002, a table without `deleted_at` → 422 C3010; hints
 *   name the unique keys without `alive` and a missing default parent group
 * - `GET /writable` → `cgWritableVo` (browse): whether `POST /write` is on here (shows the write button)
 * - `GET /parent-menus` → `cgParentMenuNodeVo[]` (view): the parent-menu picker of the edit page
 * - `GET /download` `cgDownloadQuery` → `application/zip` (generate): the files of one or many configs
 * - `POST /write` `cgWriteBody` → `cgWriteResultVo` (write): into the repository (below)
 * - `POST /batch-delete` `idsBody` (remove), `DELETE /:id` (remove): configs with their columns
 * - `GET /:id` → `cgTableDetailVo` (view) · `PUT /:id` `cgTableUpdate` (modify, codegen.schema.ts; a
 *   `referencedBy` column that is not in this database or whose table has no `deleted_at` → 422 C3009)
 * - `POST /:id/sync` → `cgSyncVo` (modify): re-read the table's DDL, manual config kept
 * - `GET /:id/preview` → `cgPreviewVo` (generate)
 *
 * Preview, download and write render the stored config: a config the templates refuse → 422 C3003 / C3004;
 * its table (or a sub table) without `deleted_at` by now → 422 C3010, like sync (config unchanged).
 */

/**
 * Perms of the generator page. Leaner than one per button: preview and download hand out the same
 * rendered files, so one `generate`; `write` stays apart (it changes the repository, dev only); `sync`
 * rewrites stored config, so it is `modify`; the edit page loads `GET /:id` with `view`.
 */
export const codegenPerms = {
  browse: 'codegen.table.browse',
  view: 'codegen.table.view',
  import: 'codegen.table.import',
  modify: 'codegen.table.modify',
  remove: 'codegen.table.remove',
  generate: 'codegen.table.generate',
  write: 'codegen.table.write',
} as const

/** Most configs one download or write renders (each renders ~20 files through Prettier). */
export const CG_BATCH_MAX = 50

/** Per-locale text as stored (`*_i18n` JSON, may be null). */
const storedTexts = z.partialRecord(z.enum(LOCALES), z.string()).nullable()

/** GET / query: paging, sort, table name / comment contains. */
export const cgTableQuery = pageQuery(['tableName', 'createdAt', 'updatedAt', 'id'])
  .extend({
    tableName: z.string().trim().max(64).optional(),
    tableComment: z.string().trim().max(128).optional(),
  })
  .register(fieldDomains, { domain: 'codegen' })
export type CgTableQuery = z.output<typeof cgTableQuery>

export const cgTableVo = z.object({
  id: z.number().int(),
  tableName: z.string(),
  tableComment: z.string(),
  groupCode: z.enum(CG_GROUPS),
  domain: z.string(),
  business: z.string(),
  className: z.string(),
  featureName: z.string(),
  featureNameI18n: storedTexts,
  template: z.enum(CG_TEMPLATES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})
export type CgTableVo = z.infer<typeof cgTableVo>

/** One column: the DB facts (refreshed by sync) + its editable config (`cgColumnFields`). */
export const cgColumnVo = z.object({
  ...cgColumnFields.shape,
  id: z.number().int(),
  columnName: z.string(),
  columnType: z.string(),
  columnComment: z.string(),
  columnDefault: z.string().nullable(),
  nullable: z.boolean(),
  isPk: z.boolean(),
  isAutoInc: z.boolean(),
  labelI18n: storedTexts,
  options: cgColumnOptions.nullable(),
})
export type CgColumnVo = z.infer<typeof cgColumnVo>

/** GET /:id: the table's editable config (`cgTableFields`), its DB names and its columns in sort order. */
export const cgTableDetailVo = z.object({
  ...cgTableFields.shape,
  id: z.number().int(),
  tableName: z.string(),
  tableComment: z.string(),
  featureNameI18n: storedTexts,
  options: cgTableOptions.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  columns: z.array(cgColumnVo),
})
export type CgTableDetailVo = z.infer<typeof cgTableDetailVo>

/** `noDeletedAt`: the table has no `deleted_at` column, so import refuses it (422 C3010). */
export const cgImportableVo = z.object({
  tableName: z.string(),
  tableComment: z.string(),
  noDeletedAt: z.boolean(),
})
export type CgImportableVo = z.infer<typeof cgImportableVo>

/** POST /import: exact names as `GET /importable` lists them. */
export const cgImportBody = z
  .object({ tableNames: z.array(z.string().min(1).max(64)).min(1).max(PAGE_SIZE_MAX) })
  .register(fieldDomains, { domain: 'codegen' })
export type CgImportBody = z.infer<typeof cgImportBody>

/**
 * What an imported table misses; the config is imported anyway (a table without
 * `deleted_at` is not: 422 C3010): `alive` = unique key `key` lacks the
 * generated `alive` column (a deleted row keeps its value taken), `parent_menu` = no pickable group `key`
 * (the table's domain, or a built-in prefix's group) nor one below it matches: the page's parent is `biz`
 *.
 */
export const cgImportHint = z.object({
  tableName: z.string(),
  missing: z.enum(['alive', 'parent_menu']),
  key: z.string().nullable(),
})
export type CgImportHint = z.infer<typeof cgImportHint>

/** the new config ids, in the order of `tableNames`, and the conventions the tables miss */
export const cgImportVo = z.object({ ids: z.array(z.number().int()), hints: z.array(cgImportHint) })
export type CgImportVo = z.infer<typeof cgImportVo>

/** POST /:id/sync: column names added (rules' defaults), removed, and changed (type, comment, …). */
export const cgSyncVo = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
})
export type CgSyncVo = z.infer<typeof cgSyncVo>

/** shiki language of a generated file, by extension: `.ts` typescript, `.vue` vue, `.json` json */
export const CG_FILE_LANGUAGES = ['typescript', 'vue', 'json'] as const
export type CgFileLanguage = (typeof CG_FILE_LANGUAGES)[number]

/** A rendered file; `path` is repository-relative (`apps/server/src/modules/…`). */
export const cgFileVo = z.object({
  path: z.string(),
  language: z.enum(CG_FILE_LANGUAGES),
  content: z.string(),
})
export type CgFileVo = z.infer<typeof cgFileVo>

/**
 * GET /:id/preview: the files as `pnpm gen render` prints them, and the lines to add by hand (module
 * import, seed entry, shared export: the generator edits no existing file).
 */
export const cgPreviewVo = z.object({
  files: z.array(cgFileVo),
  registration: z.array(z.string()),
})
export type CgPreviewVo = z.infer<typeof cgPreviewVo>

/** `1,2,3` (a query string carries the list comma-separated) or repeated `ids=`. */
const idList = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',') : v),
  z.array(z.coerce.number().int().positive()).min(1).max(CG_BATCH_MAX),
)

/**
 * GET /download: one zip of the configs' files at their repository paths. Two configs rendering the same
 * path (same group, domain and business) → 422 C3006.
 */
export const cgDownloadQuery = z
  .object({ ids: idList })
  .register(fieldDomains, { domain: 'codegen' })
export type CgDownloadQuery = z.output<typeof cgDownloadQuery>

/**
 * POST /write: the configs' files into the repository, only where the server runs with
 * `NODE_ENV=development` and `CODEGEN_WRITE=true` (else 422 C3005), all or none: an existing file is never
 * overwritten (see docs/design-notes.md#codegen). Two configs rendering the same path → 422 C3006.
 */
export const cgWriteBody = z
  .object({ ids: z.array(z.number().int().positive()).min(1).max(CG_BATCH_MAX) })
  .register(fieldDomains, { domain: 'codegen' })
export type CgWriteBody = z.infer<typeof cgWriteBody>

/**
 * The write's outcome (200). `conflicts` not empty = existing files differ: **nothing was written**, each
 * difference comes back as a `diff -u` (disk → rendered). `unchanged` = already there, identical.
 */
export const cgWriteResultVo = z.object({
  written: z.array(z.string()),
  unchanged: z.array(z.string()),
  conflicts: z.array(z.object({ path: z.string(), diff: z.string() })),
  registration: z.array(z.string()),
})
export type CgWriteResultVo = z.infer<typeof cgWriteResultVo>

export const cgWritableVo = z.object({ writable: z.boolean() })
export type CgWritableVo = z.infer<typeof cgWritableVo>

/**
 * Why a group cannot be a generated page's parent: its own route name is missing or outside
 * the generator format (`route_name`), or an ancestor's is (`ancestor`): the registration printout copies
 * the chain into menu-groups.seed.ts by route name.
 */
export const CG_PARENT_MENU_REASONS = ['route_name', 'ancestor'] as const
export type CgParentMenuReason = (typeof CG_PARENT_MENU_REASONS)[number]

/**
 * GET /parent-menus: every live group menu as a forest (siblings by `sort_no, id`), each marked pickable
 * or not with the reason; the edit page stores the picked `routeName` as `parentMenuRouteName` (a save
 * of an unpickable one → 422 C3008). Display name like the menus: `nameI18n[locale]` → the `name` key's
 * translation → `name`.
 */
export interface CgParentMenuNode {
  id: number
  routeName: string | null
  name: string
  nameI18n: I18nText | null
  pickable: boolean
  reason: CgParentMenuReason | null
  children: CgParentMenuNode[]
}
export const cgParentMenuNodeVo: z.ZodType<CgParentMenuNode> = z.object({
  id: z.number().int(),
  routeName: z.string().nullable(),
  name: z.string(),
  nameI18n: storedTexts,
  pickable: z.boolean(),
  reason: z.enum(CG_PARENT_MENU_REASONS).nullable(),
  get children() {
    return z.array(cgParentMenuNodeVo)
  },
})
