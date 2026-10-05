import { z } from 'zod'
import { LOCALES } from './locale.js'
import { PAGE_SIZE_MAX } from './pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'

/** Standard CRUD contract pieces every resource shares (see docs/design-notes.md#api-envelope). */

/** `POST /<resources>/batch-delete` body: 1–200 positive ids. */
export const idsBody = z
  .object({ ids: z.array(z.number().int().positive()).min(1).max(PAGE_SIZE_MAX) })
  .register(fieldDomains, { domain: 'common' })
export type IdsBody = z.infer<typeof idsBody>

/** `PUT /<resources>/:id/enabled` body. */
export const enabledBody = z
  .object({ enabled: z.boolean() })
  .register(fieldDomains, { domain: 'common' })
export type EnabledBody = z.infer<typeof enabledBody>

/** Most rows of one sub table a master-sub document (`master_sub` template) is saved with at once. */
export const SUB_ROWS_MAX = 500

/** Swagger schema of a paged list's `data` (`Page<T>`) for `@ApiEnvelope(pageVo(xVo))`. */
export const pageVo = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int() })

/**
 * A nullable text field whose blank value (a cleared form input) means "none": `''` / spaces parse as `null`,
 * so an empty value neither fails the format check nor collides in a `unique(<col>, alive)` index.
 */
export const blankAsNull = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), schema.nullish())

/** Per-locale texts as stored in a `*_i18n` JSON column (mode B; see docs/design-notes.md#i18n); null = none. */
export const i18nTextVo = z.partialRecord(z.enum(LOCALES), z.string()).nullable()

/**
 * A `*_i18n` input (the `I18nInput` component, admin-created menu names, dict names and labels): one text
 * of at most `max` characters per locale; blank ones are left out, none at all = null.
 */
export const i18nTextInput = (max: number) => {
  const text = z.string().trim().max(max).optional()
  return z.preprocess(
    (v) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v
      const set = Object.entries(v).filter(([, s]) => typeof s !== 'string' || s.trim())
      return set.length ? Object.fromEntries(set) : null
    },
    z.strictObject({ 'zh-CN': text, 'en-US': text }).nullish(),
  )
}

export const IMPORT_MODES = ['insert', 'upsert'] as const
export type ImportMode = (typeof IMPORT_MODES)[number]

/**
 * `POST /<resources>/import` multipart fields besides `file` (see docs/design-notes.md#api-envelope): `insert` only adds rows (an existing
 * natural key is a row error); `upsert` also updates the row with that key, matched only among the rows the
 * caller's data scope can see (a key outside it is a row error, never overwritten; see docs/design-notes.md#data-scope).
 */
export const importBody = z
  .object({ mode: z.enum(IMPORT_MODES).default('insert') })
  .register(fieldDomains, { domain: 'common' })
export type ImportBody = z.infer<typeof importBody>

/**
 * The import of a resource without a natural key to match rows by (no unique column among the imported
 * ones): `insert` only, `upsert` → 400.
 */
export const INSERT_ONLY_MODES = ['insert'] as const satisfies readonly ImportMode[]
export const insertImportBody = z
  .object({ mode: z.enum(INSERT_ONLY_MODES).default('insert') })
  .register(fieldDomains, { domain: 'common' })
export type InsertImportBody = z.infer<typeof insertImportBody>

/** Import outcome: row counts; `reportId` (the per-row error report to download) only when a row failed. */
export const importResultVo = z.object({
  inserted: z.number().int(),
  updated: z.number().int(),
  failed: z.number().int(),
  reportId: z.string().optional(),
})
export type ImportResult = z.infer<typeof importResultVo>
