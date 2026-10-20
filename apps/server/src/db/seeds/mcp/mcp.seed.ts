// Agent access seed (see docs/mcp.md): the platform page "MCP 工具" and the tenant page "访问令牌" under
// the system group, one action row per permission. Seeded whatever APP_MCP says: while it is off the
// menus are hidden by core/auth/menu-features.ts (side menu and grant trees). The `mcp.paused` param is
// a settings param (db/seeds/settings). Names are i18n keys (the web locale fragments mcp.*.json).
import { mcpPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, upsert } from '../upsert.js'

const PAGES: {
  route: string
  name: string
  path: string
  component: string
  componentName: string
  icon: string
  sort: number
  actions: [perms: string, name: string][]
}[] = [
  {
    route: 'mcp-tool',
    name: 'menu.mcp.tool',
    path: '/mcp/tools',
    component: 'platform/mcp/tool/index',
    componentName: 'McpTool',
    icon: 'lucide:bot',
    sort: 125,
    actions: [
      [mcpPerms.tool.browse, 'menu.action.browse'],
      [mcpPerms.tool.modify, 'menu.action.modify'],
    ],
  },
  {
    route: 'mcp-token',
    name: 'menu.mcp.token',
    path: '/mcp/tokens',
    component: 'platform/mcp/token/index',
    componentName: 'McpToken',
    icon: 'lucide:key-square',
    sort: 126,
    actions: [
      [mcpPerms.token.browse, 'menu.action.browse'],
      [mcpPerms.token.revoke, 'menu.action.revoke'],
    ],
  },
]

export async function seedMcp(q: EntityManager): Promise<string[]> {
  // the group menu: one an administrator deleted skips these menus, a missing one is an error
  const parent = await findRow(q, 'iam_menu', { route_name: 'system', kind: 'group' })
  if (!parent) throw new Error('seedMcp: the system menu group is missing')
  if (parent.deleted) return ['seed: the system menu group was deleted: the MCP menus are skipped']
  for (const p of PAGES) {
    const pageId = await upsert(
      q,
      'iam_menu',
      { route_name: p.route },
      {
        parent_id: parent.id,
        kind: 'page',
        name: p.name,
        route_path: p.path,
        component: p.component,
        component_name: p.componentName,
        keep_alive: 1,
        icon: p.icon,
        sort_no: p.sort,
      },
    )
    for (const [i, [perms, name]] of p.actions.entries())
      await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms },
        { parent_id: pageId, name, sort_no: (i + 1) * 10 },
      )
  }
  return []
}
