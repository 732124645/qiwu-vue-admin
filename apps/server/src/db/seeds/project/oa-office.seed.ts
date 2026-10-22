import { oaExpensePerms, oaSealPerms, oaTripPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { addLinks, type LinkTable } from '../../../core/db/links.js'
import { findRow, insertRow, type Row } from '../upsert.js'

const ROLE_MENUS: LinkTable = { table: 'iam_role_menus', owner: 'role_id', target: 'menu_id' }
const RESOURCES = [
  { kind: 'trip', name: 'OaTrip', icon: 'lucide:plane', perms: oaTripPerms },
  { kind: 'expense', name: 'OaExpense', icon: 'lucide:receipt', perms: oaExpensePerms },
  { kind: 'seal', name: 'OaSeal', icon: 'lucide:stamp', perms: oaSealPerms },
] as const

/** 首次补齐办公页面和员工权限；管理者改名、移动、停用或删除后不被种子覆盖。 */
export async function seedOaOffice(q: EntityManager): Promise<string[]> {
  const group = await findRow(q, 'iam_menu', { route_name: 'oa', kind: 'group' })
  if (!group || group.deleted) return []
  const inserted: number[] = []
  const put = async (routeName: string, values: Row): Promise<number | undefined> => {
    const row = await findRow(q, 'iam_menu', { route_name: routeName })
    if (row) return row.deleted ? undefined : row.id
    const id = await insertRow(q, 'iam_menu', { route_name: routeName, ...values })
    inserted.push(id)
    return id
  }
  await put('oa-office', {
    parent_id: group.id,
    kind: 'page',
    name: 'menu.oa.office',
    route_path: '/oa/office',
    component: 'oa/office/index',
    component_name: 'OaOffice',
    icon: 'lucide:briefcase-business',
    keep_alive: 0,
    sort_no: 10,
  })
  for (const [i, resource] of RESOURCES.entries()) {
    const pageId = await put(`oa-${resource.kind}`, {
      parent_id: group.id,
      kind: 'page',
      name: `menu.oa.${resource.kind}`,
      route_path: `/oa/${resource.kind}`,
      component: `oa/${resource.kind}/index`,
      component_name: resource.name,
      icon: resource.icon,
      sort_no: (i + 2) * 10,
    })
    if (!pageId) continue
    for (const action of ['new', 'view'] as const)
      await put(`oa-${resource.kind}-${action}`, {
        parent_id: pageId,
        kind: 'page',
        name: `menu.oa.${resource.kind}`,
        route_path: `/oa/${resource.kind}/${action === 'new' ? 'new' : ':id'}`,
        component: `oa/${resource.kind}/${action}`,
        component_name: resource.name + (action === 'new' ? 'New' : 'View'),
        visible: 0,
        keep_alive: 0,
      })
    // 权限行已由办公基础种子建立；只在对应业务页初次出现时授予员工，不恢复撤销过的链接。
    if (inserted.includes(pageId))
      for (const code of Object.values(resource.perms)) {
        const row = await findRow(q, 'iam_menu', { kind: 'action', perms: code })
        if (row && !row.deleted) inserted.push(row.id)
      }
  }
  // OA 分组是已有平台菜单，仅随新页面首次授予；不向任何角色开放流程管理权限。
  if (inserted.length)
    for (const code of ['staff', 'member']) {
      const role = await findRow(q, 'iam_role', { code })
      if (role && !role.deleted)
        await addLinks(q, ROLE_MENUS, role.id, [group.id, ...inserted], { revive: false })
    }
  return []
}
