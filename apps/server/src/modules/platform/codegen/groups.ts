// Menu groups as the generator sees them: the parent picker's forest (pickable when a group's
// route name and every ancestor's are in the generator format), a table's default parent, and the lines
// of menu-groups.seed.ts a parent chain needs. Pure over the live group rows the service reads.
import {
  BUILTIN_MENU_GROUPS,
  CG_IDENT,
  type CgImportHint,
  type CgParentMenuNode,
  type I18nText,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { humanize, type TableConfig } from './rules.js'

/** A live group menu row. */
export interface GroupRow {
  id: number
  parentId: number
  routeName: string | null
  name: string
  nameI18n: I18nText | null
  routePath: string
  icon: string | null
  sortNo: number
}

/** Every live group menu, siblings by `sort_no, id`. */
export const liveGroups = (q: EntityManager): Promise<GroupRow[]> =>
  q.query(
    'SELECT id, parent_id AS parentId, route_name AS routeName, name, name_i18n AS nameI18n,' +
      ' route_path AS routePath, icon, sort_no AS sortNo' +
      " FROM iam_menu WHERE kind = 'group' AND deleted_at IS NULL ORDER BY sort_no, id",
  )

/**
 * The groups as a forest (a group under one missing is a root), each pickable as a generated page's
 * parent when its own route name and every ancestor's match `CG_IDENT.routeName`, else with the reason.
 */
export function groupForest(rows: GroupRow[]): CgParentMenuNode[] {
  const nodes = new Map<number, CgParentMenuNode>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        routeName: r.routeName,
        name: r.name,
        nameI18n: r.nameI18n,
        pickable: true,
        reason: null,
        children: [],
      },
    ]),
  )
  const roots: CgParentMenuNode[] = []
  for (const r of rows) (nodes.get(r.parentId)?.children ?? roots).push(nodes.get(r.id)!)
  const mark = (list: CgParentMenuNode[], ancestorsOk: boolean) => {
    for (const n of list) {
      const own = n.routeName !== null && CG_IDENT.routeName.test(n.routeName)
      n.reason = !own ? 'route_name' : ancestorsOk ? null : 'ancestor'
      n.pickable = n.reason === null
      mark(n.children, n.pickable)
    }
  }
  mark(roots, true)
  return roots
}

/** Route names of the pickable groups of a forest. */
export function pickableGroups(forest: CgParentMenuNode[]): Set<string> {
  const out = new Set<string>()
  const walk = (list: CgParentMenuNode[]) =>
    list.forEach((n) => {
      if (n.pickable) out.add(n.routeName!)
      walk(n.children)
    })
  walk(forest)
  return out
}

/**
 * A table's default parent group: for a project table the longest pickable group whose
 * route name is a leading run of the table's name segments, never the whole name (`erp_sale_order`:
 * `erp-sale`, then `erp`); for a platform / workflow table its prefix's group; otherwise `biz`. Falling
 * back to `biz` from the table's own domain (or prefix group), or `biz` itself not pickable, adds a hint.
 */
export function defaultParent(
  t: Pick<TableConfig, 'tableName' | 'groupCode' | 'domain' | 'parentMenuRouteName'>,
  pickable: Set<string>,
): { parent: string; hint?: CgImportHint } {
  const segments = t.tableName.split('_').filter(Boolean)
  const project = t.groupCode === 'biz'
  const candidates = project
    ? segments.slice(1).map((_, i) => segments.slice(0, segments.length - 1 - i).join('-'))
    : [t.parentMenuRouteName]
  const found = candidates.find((c) => pickable.has(c))
  if (found) return { parent: found }
  const wanted = project ? t.domain : t.parentMenuRouteName
  return wanted !== 'biz' || !pickable.has('biz')
    ? { parent: 'biz', hint: { tableName: t.tableName, missing: 'parent_menu', key: wanted } }
    : { parent: 'biz' }
}

/**
 * What to add to menu-groups.seed.ts for a page under group `routeName`: its chain of
 * project groups up to the first built-in one, top first, as `PROJECT_MENU_GROUPS` entries (texts as
 * JSON string literals; an English name the group lacks is derived from its route name and marked).
 * Nothing under a built-in group; a note when `routeName` is no pickable group of this database.
 */
export function groupLines(rows: GroupRow[], routeName: string | null): string[] {
  if (routeName === null || BUILTIN_MENU_GROUPS.includes(routeName)) return []
  const file = 'apps/server/src/db/seeds/project/menu-groups.seed.ts'
  if (!pickableGroups(groupForest(rows)).has(routeName))
    return [
      `${file}: ${routeName} is no group of this database whose route names are all in the generator format; build it in the menu page, then pick it again`,
    ]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const chain: GroupRow[] = []
  for (
    let g = rows.find((r) => r.routeName === routeName);
    g && !BUILTIN_MENU_GROUPS.includes(g.routeName!);
    g = byId.get(g.parentId)
  )
    chain.unshift(g)
  const s = (v: string | null) => JSON.stringify(v)
  return [
    `${file}, in PROJECT_MENU_GROUPS (the groups not there yet, parents first):`,
    ...chain.map((g) => {
      const en = g.nameI18n?.['en-US']?.trim()
      const texts = `{ "zh-CN": ${s(g.nameI18n?.['zh-CN']?.trim() || g.name)}, "en-US": ${s(en || humanize(g.routeName!.replace(/-/g, '_')))} }`
      return `  { routeName: ${s(g.routeName)}, parent: ${s(byId.get(g.parentId)?.routeName ?? null)}, name: ${s(g.name)}, nameI18n: ${texts}, routePath: ${s(g.routePath)}, icon: ${s(g.icon)}, sortNo: ${g.sortNo} },${en ? '' : ' // en-US derived from the route name: check it'}`
    }),
  ]
}
