import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import { clsGet } from '../../../core/context/cls.js'

/**
 * The API access and error logs hold the requests of every tenant (a plain, unfiltered `tenant_id`):
 * a caller other than root reads, exports and handles only the rows of the default tenant and of no
 * tenant (requests before sign-in), whether multi-tenancy is on or not, since another tenant's rows stay
 * once it is turned off (see docs/design-notes.md#tenancy). Every read and locked write of the two
 * services goes through it (their `scopedQb`), so another tenant's row is a 404.
 */
export function platformRowsOnly<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  alias: string,
): SelectQueryBuilder<E> {
  if (clsGet('principal')?.root) return qb
  return qb.andWhere(
    // arch-allow: sql-concat the alias is the query builder's own, never a value; tenant: this is the tenant condition itself
    `(${alias}.tenant_id IS NULL OR ${alias}.tenant_id = :platformTenant)`,
    { platformTenant: DEFAULT_TENANT_ID },
  )
}
