// Project menu groups: the groups the project's generated pages hang under, built in the menu
// page (菜单管理) and copied here from the generator's registration printout (`pnpm gen render|write`, the
// preview), so a fresh database gets them too. The first seed of SEEDS.project, before the generated
// modules' seeds that look their parent up. Parents first: `parent` is a built-in group's route name (`biz`
// …), one listed above, or null (top level). Insert-only: a group that exists, or one an administrator
// deleted, is left as it is (the administrator owns it); one under a deleted parent is stored deleted too,
// with a notice, so the groups below it and the generated module seeds under it skip as under any deleted
// group (re-create it in 菜单管理 to show it: the seeds then find the live row first).
// This file belongs to the project (the template ships it empty); Chinese names are fine here.
import type { I18nText } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, insertRow } from '../upsert.js'

export interface ProjectMenuGroup {
  /** the generator's format (lowercase letters, digits, hyphens), fixed once the group is saved */
  routeName: string
  parent: string | null
  /** shown when the language has no entry in `nameI18n` */
  name: string
  nameI18n: Required<I18nText>
  routePath: string
  icon: string | null
  sortNo: number
}

export const PROJECT_MENU_GROUPS: ProjectMenuGroup[] = []

export async function seedProjectMenuGroups(
  q: EntityManager,
  groups: readonly ProjectMenuGroup[] = PROJECT_MENU_GROUPS,
): Promise<string[]> {
  const notices: string[] = []
  for (const g of groups) {
    if (await findRow(q, 'iam_menu', { route_name: g.routeName })) continue
    let parent: Awaited<ReturnType<typeof findRow>>
    if (g.parent !== null) {
      parent = await findRow(q, 'iam_menu', { route_name: g.parent, kind: 'group' })
      if (!parent)
        throw new Error(
          `menu-groups.seed.ts: the parent group ${g.parent} of ${g.routeName} is missing (list it above)`,
        )
      if (parent.deleted)
        notices.push(
          `seed: menu group ${g.routeName} stored as deleted: its parent ${g.parent} was deleted`,
        )
    }
    await insertRow(q, 'iam_menu', {
      parent_id: parent?.id ?? 0,
      deleted_at: parent?.deleted ? new Date() : null,
      kind: 'group',
      route_name: g.routeName,
      name: g.name,
      name_i18n: g.nameI18n,
      route_path: g.routePath,
      icon: g.icon,
      sort_no: g.sortNo,
    })
  }
  return notices
}
