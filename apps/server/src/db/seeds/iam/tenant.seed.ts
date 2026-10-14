// What every tenant other than the default one starts with (see docs/design-notes.md#tenancy): a root dept
// named after the tenant and the builtin `tenant_admin` role. The first seed of TENANT_SEEDS (db/seeds/index.ts),
// run in the tenant when it is opened and by every `db:seed` afterwards. Insert-only: what exists, live or
// deleted, is the tenant's (renamed, or deleted by its administrator) and stays as it is.
import type { EntityManager } from 'typeorm'
import { TENANT_ADMIN_ROLE } from '../../../core/auth/principal.js'
import { findRow, insertRow } from '../upsert.js'

export async function seedTenant(q: EntityManager, tid: number): Promise<string[]> {
  const [top] = await q.query(
    // qw:include-deleted a root dept the tenant deleted is not brought back
    'SELECT id FROM iam_dept WHERE parent_id = 0 AND tenant_id = ? LIMIT 1', // qw:no-data-scope a seed, no caller
    [tid],
  )
  if (!top) {
    const [tenant] = await q.query<{ name: string }[]>(
      'SELECT name FROM iam_tenant WHERE id = ? AND deleted_at IS NULL',
      [tid],
    )
    if (!tenant) throw new Error(`seedTenant: no tenant ${tid}`)
    const id = await insertRow(q, 'iam_dept', {
      parent_id: 0,
      tree_path: '/',
      name: tenant.name,
      sort_no: 10,
    })
    await q.query(
      'UPDATE iam_dept SET tree_path = ? WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [`/${id}/`, id, tid],
    )
  }
  // its perms come from the menus open to tenants (iam-user-lookup.ts), never from menu grants
  if (!(await findRow(q, 'iam_role', { code: TENANT_ADMIN_ROLE })))
    await insertRow(q, 'iam_role', {
      code: TENANT_ADMIN_ROLE,
      name: 'seed.role.tenantAdmin',
      data_scope: 'all',
      is_builtin: 1,
      sort_no: 0,
    })
  return []
}
