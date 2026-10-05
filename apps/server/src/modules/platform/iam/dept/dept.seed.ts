// Dept menus: the page under the `system` group (found by route_name, never by id) and one
// action row per permission, upserted by route_name / perms. Names are i18n keys: the page's in the
// module's web locale fragment (iam.dept.json), the actions' in menu.json (menu.action.*). The demo
// dept tree is seeded in iam.seed.ts (users need it first).
import { deptPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../../db/seeds/upsert.js'

const ACTIONS: [perms: string, name: string][] = [
  [deptPerms.browse, 'menu.action.browse'],
  [deptPerms.view, 'menu.action.view'],
  [deptPerms.create, 'menu.action.create'],
  [deptPerms.modify, 'menu.action.modify'],
  [deptPerms.remove, 'menu.action.remove'],
]

export async function seedDept(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'system' })
  if (parentId === undefined) throw new Error('seedDept: the system menu group is missing')
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'iam-dept' },
    {
      parent_id: parentId,
      kind: 'page',
      name: 'menu.iam.dept',
      route_path: '/iam/depts',
      component: 'platform/iam/dept/index',
      component_name: 'IamDept',
      keep_alive: 1,
      icon: 'lucide:network',
      sort_no: 40,
    },
  )
  for (const [i, [perms, name]] of ACTIONS.entries())
    await upsert(
      q,
      'iam_menu',
      { kind: 'action', perms },
      { parent_id: pageId, name, sort_no: (i + 1) * 10 },
    )
  return []
}
