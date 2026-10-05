import { z } from 'zod'
import { fieldDomains } from '../validation/zod-i18n.js'

export const PAGE_SIZE_DEFAULT = 20
export const PAGE_SIZE_MAX = 200

export interface SortOrder<F extends string> {
  field: F
  order: 'ASC' | 'DESC'
}

/**
 * `sort=createdAt,-id` → `[{ field: 'createdAt', order: 'ASC' }, { field: 'id', order: 'DESC' }]`.
 * Only whitelisted fields pass, so the result is safe to map onto ORDER BY columns (see docs/design-notes.md#security).
 */
export function sortParam<F extends string>(fields: readonly [F, ...F[]]) {
  return z.string().transform((raw, ctx): SortOrder<F>[] => {
    const out: SortOrder<F>[] = []
    for (const part of raw.split(',')) {
      const desc = part.startsWith('-')
      const field = fields.find((f) => f === (desc ? part.slice(1) : part))
      if (!field) {
        ctx.addIssue({
          code: 'custom',
          message: 'validation.sort',
          params: { allowed: fields.join(', ') },
        })
        return z.NEVER
      }
      out.push({ field, order: desc ? 'DESC' : 'ASC' })
    }
    return out
  })
}

/**
 * Paged list query (see docs/design-notes.md#api-envelope): `page` ≥ 1 (default 1), `pageSize` 1–200 (default 20), `sort` from `sortable`.
 * Query strings are coerced; extend it with filters: `pageQuery(['createdAt', 'id']).extend({ ... })`.
 */
export function pageQuery<F extends string>(sortable: readonly [F, ...F[]]) {
  return z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
      sort: sortParam(sortable).optional(),
    })
    .register(fieldDomains, { domain: 'common' })
}
