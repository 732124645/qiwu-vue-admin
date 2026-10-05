import { z } from 'zod'
import { LOCALES } from '../../common/locale.js'

/**
 * Settings read contract (see docs/design-notes.md#i18n): GET /api/settings/dicts/:code/entries (any signed-in user) and
 * GET /api/settings/params/public/:key (no session; `is_public` params that are not secret).
 */

/**
 * One enabled entry of the read contract (not `dictEntryVo`: the admin page's VO, dict-entry.schema.ts);
 * display text = `labelI18n[locale]` → `label` → `value`.
 */
export const dictPayloadEntryVo = z.object({
  value: z.string(),
  label: z.string(),
  labelI18n: z.partialRecord(z.enum(LOCALES), z.string()).nullable(),
  /** Element Plus tag type (primary/success/info/warning/danger) */
  tagType: z.string().nullable(),
  cssClass: z.string().nullable(),
  isDefault: z.boolean(),
  sortNo: z.number().int(),
})
export type DictEntry = z.infer<typeof dictPayloadEntryVo>

/** `version` moves whenever the dict changes: clients drop cached entries on a new one. */
export const dictPayloadVo = z.object({
  version: z.number().int(),
  entries: z.array(dictPayloadEntryVo),
})
export type DictPayload = z.infer<typeof dictPayloadVo>

export const publicParamVo = z.object({ key: z.string(), value: z.string() })
export type PublicParam = z.infer<typeof publicParamVo>
