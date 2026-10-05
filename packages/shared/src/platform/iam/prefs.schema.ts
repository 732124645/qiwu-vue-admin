import { z } from 'zod'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Per-user UI preferences (`iam_user_pref`), `/api/iam/profile/prefs/:key`: always the
 * signed-in user's own. Keys are dotted `<family>.<…>`; the only family is `table` (column settings of
 * a list page, `table.<domain>.<name>`), so the key regex admits nothing else (400). A second family
 * adds its prefix here and a key → value-schema check in the service.
 */

/** `table.iam.position`: `table` + 2–4 lowercase kebab segments, ASCII ≤ 96 (the column size). */
export const prefKey = z
  .string()
  .max(96)
  .regex(/^table\.[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/)

/** A `table.*` value: column order and visibility, `prop` = the column's `prop` in the page code. */
export const tableColumnsPref = z.object({
  v: z.literal(1),
  columns: z
    .array(
      z.object({
        prop: z
          .string()
          .max(64)
          .regex(/^[a-zA-Z][\w.]*$/),
        visible: z.boolean(),
      }),
    )
    .max(100),
})
export type TableColumnsPref = z.infer<typeof tableColumnsPref>

/** PUT body (upsert). */
export const prefBody = z
  .object({ value: tableColumnsPref })
  .register(fieldDomains, { domain: 'iam.pref' })
export type PrefBody = z.infer<typeof prefBody>

/** GET result: `value` is `null` while unset (the page uses its code defaults). */
export const prefVo = z.object({ value: tableColumnsPref.nullable() })
export type PrefVo = z.infer<typeof prefVo>

/** Largest stored value as UTF-8 JSON; bigger → 413 `payload_too_large`. */
export const PREF_VALUE_MAX_BYTES = 8192
