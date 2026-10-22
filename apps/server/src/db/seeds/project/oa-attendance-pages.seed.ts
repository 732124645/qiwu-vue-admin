import type { EntityManager } from 'typeorm'
import { addLinks, type LinkTable } from '../../../core/db/links.js'
import { findRow, insertRow } from '../upsert.js'

const ROLE_MENUS: LinkTable = { table: 'iam_role_menus', owner: 'role_id', target: 'menu_id' }
const PAGES = [
  ['oa-clock-records', '/oa/attendance', 'index', 'OaAttendance', 'attendance'],
  [
    'oa-attendance-policy',
    '/oa/attendance/policy',
    'policy',
    'OaAttendancePolicy',
    'attendancePolicy',
  ],
  ['oa-attendance-sites', '/oa/attendance/sites', 'sites', 'OaAttendanceSites', 'attendanceSites'],
] as const

/** 只补可用页面；个人入口首次授予员工，管理页面与权限由管理员分配，不恢复撤销链接。 */
export async function seedOaAttendancePages(q: EntityManager): Promise<string[]> {
  const group = await findRow(q, 'iam_menu', { route_name: 'oa', kind: 'group' })
  if (!group || group.deleted) return []
  for (const [i, [route, path, component, name, label]] of PAGES.entries()) {
    if (await findRow(q, 'iam_menu', { route_name: route })) continue
    const id = await insertRow(q, 'iam_menu', {
      parent_id: group.id,
      route_name: route,
      route_path: path,
      kind: 'page',
      name: `menu.oa.${label}`,
      component: `oa/attendance/${component}`,
      component_name: name,
      icon: i ? 'lucide:settings' : 'lucide:clock',
      keep_alive: 0,
      sort_no: 50 + i * 10,
    })
    if (i !== 0) continue
    for (const code of ['staff', 'member']) {
      const role = await findRow(q, 'iam_role', { code })
      if (role && !role.deleted)
        await addLinks(q, ROLE_MENUS, role.id, [group.id, id], { revive: false })
    }
  }
  return []
}
