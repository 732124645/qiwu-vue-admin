import { Err } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { BizError } from '../../../../core/http/biz-error.js'

/**
 * Tenant `tid`'s user quota (see docs/design-notes.md#tenancy), checked by every path that creates users
 * (admin create and import, sign-up, opening a tenant) in the transaction that inserts them: locks the
 * tenant row, so creators in one tenant take turns, then its live users plus `adding` above `user_quota`
 * → 409 `B1013`; no quota, no limit. Call it first in the transaction: the count is a plain read, and
 * its snapshot has to start once the lock is held (an earlier read would pin an older one).
 */
export async function assertUserQuota(q: EntityManager, tid: number, adding = 1): Promise<void> {
  const [tenant] = await q.query<{ user_quota: number | null }[]>(
    'SELECT user_quota FROM iam_tenant WHERE id = ? AND deleted_at IS NULL FOR UPDATE',
    [tid],
  )
  if (!tenant) throw new Error(`no tenant ${tid}`)
  if (tenant.user_quota === null) return
  const [{ n }] = await q.query<{ n: number | string }[]>(
    // qw:no-data-scope the quota counts every live user of the tenant
    'SELECT COUNT(*) AS n FROM iam_user WHERE tenant_id = ? AND deleted_at IS NULL',
    [tid],
  )
  if (Number(n) + adding > Number(tenant.user_quota)) throw new BizError(Err.IAM_TENANT_USER_QUOTA)
}
