import type { MenuNode } from '@qiwu/shared'
import type { Env } from '../config/env.schema.js'

export type Switch = { [K in keyof Env]-?: Env[K] extends boolean ? K : never }[keyof Env]

/**
 * Menus that exist only while a server feature is on: `route_name` → the env switch. GET /menus
 * leaves such a menu (and what is under it) out while the switch is off, whatever the roles grant.
 * The API docs page (iframe on /api/docs, served only with SWAGGER_ENABLED); the tenant and tenant
 * package pages (multi-tenancy, see docs/design-notes.md#tenancy); the Official Account group with its
 * pages (see docs/design-notes.md#wxoa); the MCP tool and access token pages (see docs/mcp.md); the agent
 * group with its pages (see docs/agent.md).
 */
export const MENU_FEATURES: Readonly<Record<string, Switch>> = {
  'devtools-api-docs': 'SWAGGER_ENABLED',
  'iam-tenant': 'APP_MULTI_TENANT',
  'iam-tenant-package': 'APP_MULTI_TENANT',
  wxoa: 'APP_WXOA',
  'mcp-tool': 'APP_MCP',
  'mcp-token': 'APP_MCP',
  agent: 'APP_AGENT',
}

/** The switches whose menus the role grant tree hides too (the API docs page stays grantable). */
export const GRANT_SWITCHES: ReadonlySet<Switch> = new Set([
  'APP_MULTI_TENANT',
  'APP_WXOA',
  'APP_MCP',
  'APP_AGENT',
])

/** Whether the menu with `routeName` belongs to a switched-off feature (`on` judges the switches). */
export const switchedOff = (routeName: string | null, on: (s: Switch) => boolean): boolean => {
  const s = routeName ? MENU_FEATURES[routeName] : undefined
  return s !== undefined && !on(s)
}

/** The tree without the menus of switched-off features nor those named in `hidden` (route names). */
export function withFeatures(
  tree: MenuNode[],
  on: (s: Switch) => boolean,
  hidden: readonly string[] = [],
): MenuNode[] {
  return tree
    .filter((n) => !switchedOff(n.routeName, on) && !(n.routeName && hidden.includes(n.routeName)))
    .map((n) => ({ ...n, children: withFeatures(n.children, on, hidden) }))
}
