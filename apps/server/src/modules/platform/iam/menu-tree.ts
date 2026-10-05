import type { I18nText, MenuLinkType, MenuNode } from '@qiwu/shared'

/** One `iam_menu` row as read for the menu tree. */
export interface MenuRow {
  id: number
  parent_id: number
  kind: 'group' | 'page' | 'action'
  name: string
  name_i18n: I18nText | null
  route_path: string
  component: string | null
  component_name: string | null
  route_name: string | null
  route_query: string | null
  link_type: MenuLinkType
  link_url: string | null
  icon: string | null
  sort_no: number
  visible: number
  keep_alive: number
  always_show: number
  enabled: number
}

const toNode = (r: MenuRow): MenuNode => ({
  id: Number(r.id),
  parentId: Number(r.parent_id),
  kind: r.kind as MenuNode['kind'],
  name: r.name,
  nameI18n: r.name_i18n,
  routePath: r.route_path,
  routeName: r.route_name,
  component: r.component,
  componentName: r.component_name,
  routeQuery: r.route_query,
  linkType: r.link_type,
  linkUrl: r.link_url,
  icon: r.icon,
  visible: Number(r.visible) === 1,
  keepAlive: Number(r.keep_alive) === 1,
  alwaysShow: Number(r.always_show) === 1,
  sortNo: r.sort_no,
  children: [],
})

/** Deeper than any sane menu: a longer parent chain is a cycle. */
const MAX_DEPTH = 32

/**
 * The granted menus that count, plus all of their ancestors. A menu counts only when it and every
 * ancestor are enabled (a disabled group hides its subtree); orphans and cycles never count. The one
 * rule for both GET /menus and the perms a role gets from its menus (see docs/design-notes.md#permissions).
 */
export function countedMenus(
  rows: Pick<MenuRow, 'id' | 'parent_id' | 'enabled'>[],
  granted: Iterable<number>,
): Set<number> {
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const keep = new Set<number>()
  for (const id of granted) {
    const chain: number[] = []
    let row = byId.get(Number(id))
    while (row && Number(row.enabled) === 1 && chain.length < MAX_DEPTH) {
      chain.push(Number(row.id))
      if (Number(row.parent_id) === 0) {
        for (const c of chain) keep.add(c)
        break
      }
      row = byId.get(Number(row.parent_id))
    }
  }
  return keep
}

/**
 * GET /api/auth/menus (see docs/design-notes.md#layering, #permissions): every granted menu plus all of its ancestors
 * (`countedMenus`), so a role granted only an action still sees group → page. Actions become perms
 * elsewhere and never appear; `visible = 0` pages stay in the tree (hidden routes such as detail
 * pages), flagged `visible: false`. `rows` must be ordered by sort_no, id: children keep that order.
 */
export function menuTree(rows: MenuRow[], granted: Iterable<number>): MenuNode[] {
  const keep = countedMenus(rows, granted)
  const nodes = new Map<number, MenuNode>()
  for (const r of rows)
    if (keep.has(Number(r.id)) && r.kind !== 'action') nodes.set(Number(r.id), toNode(r))
  const roots: MenuNode[] = []
  for (const n of nodes.values()) {
    if (n.parentId === 0) roots.push(n)
    // a parent that is not a node (an action) makes the row unreachable
    else nodes.get(n.parentId)?.children.push(n)
  }
  return roots
}
