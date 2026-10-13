// The tenant management pages (see docs/design-notes.md#tenancy): 租户管理 and 租户套餐 under the `system`
// group (found by route_name, never by id), each with one action row per permission, upserted by
// route_name / perms. Seeded whatever APP_MULTI_TENANT says: the switch hides them from the side menu and
// the role grant tree (core/auth/menu-features.ts), and they are platform pages (PLATFORM_ONLY_ROUTES).
// Names are i18n keys: the pages' in their web locale fragments (iam.tenant.json, iam.tenant-package.json),
// the actions' in menu.json (menu.action.*). A tenant is never deleted: no remove action for it.
import { tenantPackagePerms, tenantPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, upsert } from '../upsert.js'

const PAGES: {
  route: string
  name: string
  path: string
  component: string
  componentName: string
  icon: string
  sortNo: number
  actions: [perms: string, name: string][]
}[] = [
  {
    route: 'iam-tenant',
    name: 'menu.iam.tenant',
    path: '/iam/tenants',
    component: 'platform/iam/tenant/index',
    componentName: 'IamTenant',
    icon: 'lucide:building',
    sortNo: 130,
    actions: [
      [tenantPerms.browse, 'menu.action.browse'],
      [tenantPerms.view, 'menu.action.view'],
      [tenantPerms.create, 'menu.action.create'],
      [tenantPerms.modify, 'menu.action.modify'],
      [tenantPerms.enter, 'menu.action.enterTenant'],
      [tenantPerms['reset-password'], 'menu.action.resetInitialPassword'],
    ],
  },
  {
    route: 'iam-tenant-package',
    name: 'menu.iam.tenantPackage',
    path: '/iam/tenant-packages',
    component: 'platform/iam/tenant-package/index',
    componentName: 'IamTenantPackage',
    icon: 'lucide:package',
    sortNo: 140,
    actions: [
      [tenantPackagePerms.browse, 'menu.action.browse'],
      [tenantPackagePerms.view, 'menu.action.view'],
      [tenantPackagePerms.create, 'menu.action.create'],
      [tenantPackagePerms.modify, 'menu.action.modify'],
      [tenantPackagePerms.remove, 'menu.action.remove'],
    ],
  },
]

export async function seedTenantMenus(q: EntityManager): Promise<string[]> {
  // the group menu: one an administrator deleted skips these menus, a missing one is an error
  const parent = await findRow(q, 'iam_menu', { route_name: 'system', kind: 'group' })
  if (!parent) throw new Error('seedTenantMenus: the system menu group is missing')
  if (parent.deleted)
    return ['seed: the system menu group was deleted: the tenant management menus are skipped']
  for (const page of PAGES) {
    const pageId = await upsert(
      q,
      'iam_menu',
      { route_name: page.route },
      {
        parent_id: parent.id,
        kind: 'page',
        name: page.name,
        route_path: page.path,
        component: page.component,
        component_name: page.componentName,
        keep_alive: 1,
        icon: page.icon,
        sort_no: page.sortNo,
      },
    )
    for (const [i, [perms, name]] of page.actions.entries())
      await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms },
        { parent_id: pageId, name, sort_no: (i + 1) * 10 },
      )
  }
  return []
}
