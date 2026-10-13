import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'

/**
 * The menus tenant `tenantId` may use (see docs/design-notes.md#tenancy): null = unrestricted (the
 * default tenant); otherwise the menus its package holds, none when it has no package or its package is
 * disabled or deleted (a tenant left without one uses nothing, never everything). `q`: a data source or
 * the caller's transaction.
 */
export async function packageMenuIds(
  q: Pick<EntityManager, 'query'>,
  tenantId: number,
): Promise<Set<number> | null> {
  if (tenantId === DEFAULT_TENANT_ID) return null
  const rows = await q.query<{ menu_id: number }[]>(
    `SELECT pm.menu_id FROM iam_tenant t
       JOIN iam_tenant_package p ON p.id = t.package_id AND p.enabled = 1 AND p.deleted_at IS NULL
       JOIN iam_tenant_package_menus pm ON pm.package_id = p.id AND pm.deleted_at IS NULL
      WHERE t.id = ? AND t.deleted_at IS NULL`,
    [tenantId],
  )
  return new Set(rows.map((r) => Number(r.menu_id)))
}
