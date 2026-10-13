// Sample tenants of the demo site (see docs/design-notes.md#tenancy): seeded only when APP_DEMO_MODE and
// APP_MULTI_TENANT are both on, after the tenant seeds. Made-up companies, each with its own package and
// brand, opened as the tenant console opens one (the tenant seeds, then the owner `admin` holding
// `tenant_admin` in the root dept), the owner's password counted as changed (visitors cannot change it).
// Idempotent by code: a sample tenant that exists, disabled or expired too, is never touched again.
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import type { EntityManager } from 'typeorm'
import { BCRYPT_COST } from '../../../core/auth/password-hash.js'
import { TENANT_ADMIN_ROLE } from '../../../core/auth/principal.js'
import { demoMode } from '../../../core/config/demo-mode.js'
import { multiTenant } from '../../../core/config/multi-tenant.js'
import { withTenant } from '../../../core/context/tenant.js'
import { syncPlatformOnly } from '../../../modules/platform/iam/menu/platform-only.js'
import { runTenantSeeds } from '../index.js'
import { findId, findRow, insertRow } from '../upsert.js'

export interface DemoTenant {
  code: string
  name: string
  brandName: string
  userQuota: number | null
  /** its package: every menu open to tenants but the subtree of menu group `without` */
  package: { name: string; without: string | null }
}

export const DEMO_TENANTS: readonly DemoTenant[] = [
  {
    code: 'yunshan',
    name: 'seed.tenant.yunshan',
    brandName: '云杉协同',
    userQuota: null,
    package: { name: 'seed.tenantPackage.full', without: null },
  },
  {
    code: 'qinghe',
    name: 'seed.tenant.qinghe',
    brandName: '青禾办公',
    userQuota: 20,
    package: { name: 'seed.tenantPackage.noWorkflow', without: 'workflow' },
  },
]

/** Username of each sample tenant's owner. */
export const DEMO_TENANT_ADMIN = 'admin'

async function packageOf(q: EntityManager, pkg: DemoTenant['package']): Promise<number> {
  const found = await findRow(q, 'iam_tenant_package', { name: pkg.name })
  if (found && !found.deleted) return found.id
  const id = await insertRow(q, 'iam_tenant_package', { name: pkg.name })
  await q.query(
    `INSERT INTO iam_tenant_package_menus (package_id, menu_id)
     SELECT ?, m.id FROM iam_menu m
      WHERE m.platform_only = 0 AND m.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM iam_menu g WHERE g.route_name = ? AND g.deleted_at IS NULL
                           AND m.tree_path LIKE CONCAT(g.tree_path, '%'))`,
    [id, pkg.without],
  )
  return id
}

/**
 * The owners of the tenants a run opens share one random password, returned as a notice to print once (as
 * the OA demo users'). The sample tenants have no initial password of their own (users created there
 * without one get 422 until the platform resets it), so nothing else is to publish.
 */
export async function seedTenantDemo(q: EntityManager): Promise<string[]> {
  if (!demoMode() || !multiTenant()) return []
  // the flags as the seeds before this one left the menus: a package holds menus open to tenants only
  await syncPlatformOnly(q)
  let password: string | undefined
  let hash: string | undefined
  const created: string[] = []
  const notices: string[] = []
  for (const t of DEMO_TENANTS) {
    if (await findRow(q, 'iam_tenant', { code: t.code })) continue
    if (!hash) {
      password = randomBytes(12).toString('base64url')
      hash = await bcrypt.hash(password, BCRYPT_COST)
    }
    const tid = await insertRow(q, 'iam_tenant', {
      code: t.code,
      name: t.name,
      brand_name: t.brandName,
      user_quota: t.userQuota,
      package_id: await packageOf(q, t.package),
    })
    notices.push(...(await runTenantSeeds(q, tid)))
    // qw:cross-tenant the sample tenant's owner is its own row
    const ownerId = await withTenant(tid, async () => {
      const userId = await insertRow(q, 'iam_user', {
        username: DEMO_TENANT_ADMIN,
        display_name: 'Administrator',
        dept_id: await findId(q, 'iam_dept', { parent_id: 0 }),
        password_hash: hash,
        password_changed_at: new Date(),
      })
      await insertRow(q, 'iam_user_roles', {
        user_id: userId,
        role_id: await findId(q, 'iam_role', { code: TENANT_ADMIN_ROLE, is_builtin: 1 }),
      })
      return userId
    })
    await q.query('UPDATE iam_tenant SET owner_user_id = ? WHERE id = ? AND deleted_at IS NULL', [
      ownerId,
      tid,
    ])
    created.push(t.code)
  }
  if (!created.length) return []
  return [
    ...notices,
    `seed: demo tenants ${created.join(', ')}, owner ${DEMO_TENANT_ADMIN} (password shown once): ${password}`,
  ]
}
