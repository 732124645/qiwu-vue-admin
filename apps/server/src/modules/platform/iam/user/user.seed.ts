// User menus: the page under the `system` group (found by route_name, never by id), one action
// row per permission and the hidden assign-roles page (`visible = 0`; see docs/design-notes.md#layering) holding the
// `assign-roles` action, so granting that action also delivers its route. Upserted by route_name /
// perms; names are i18n keys (menu.json). The initial password param is seeded in iam.seed.ts.
import { userPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../../db/seeds/upsert.js'

const ACTIONS: [perms: string, name: string][] = [
  [userPerms.browse, 'menu.action.browse'],
  [userPerms.view, 'menu.action.view'],
  [userPerms.create, 'menu.action.create'],
  [userPerms.modify, 'menu.action.modify'],
  [userPerms.remove, 'menu.action.remove'],
  [userPerms.export, 'menu.action.export'],
  [userPerms.import, 'menu.action.import'],
  [userPerms['reset-password'], 'menu.action.resetPassword'],
]

export async function seedUser(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'system' })
  if (parentId === undefined) throw new Error('seedUser: the system menu group is missing')
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'iam-user' },
    {
      parent_id: parentId,
      kind: 'page',
      name: 'menu.iam.user',
      route_path: '/iam/users',
      component: 'platform/iam/user/index',
      component_name: 'IamUser',
      keep_alive: 1,
      icon: 'lucide:users',
      sort_no: 10,
    },
  )
  for (const [i, [perms, name]] of ACTIONS.entries())
    await upsert(
      q,
      'iam_menu',
      { kind: 'action', perms },
      { parent_id: pageId, name, sort_no: (i + 1) * 10 },
    )
  const rolesPageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'iam-user-roles' },
    {
      parent_id: pageId,
      kind: 'page',
      name: 'menu.iam.userRoles',
      route_path: '/iam/users/:id/roles',
      component: 'platform/iam/user/assign-roles',
      component_name: 'IamUserAssignRoles',
      visible: 0,
      keep_alive: 0,
      icon: 'lucide:user-cog',
      sort_no: (ACTIONS.length + 1) * 10,
    },
  )
  await upsert(
    q,
    'iam_menu',
    { kind: 'action', perms: userPerms['assign-roles'] },
    { parent_id: rolesPageId, name: 'menu.action.assignRoles', sort_no: 10 },
  )
  return []
}
