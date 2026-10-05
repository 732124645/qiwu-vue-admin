import type { MenuNode } from '@qiwu/shared'
import type { Env } from '../config/env.schema.js'

type Switch = { [K in keyof Env]-?: Env[K] extends boolean ? K : never }[keyof Env]

/**
 * Menus that exist only while a server feature is on: `route_name` → the env switch. GET /menus
 * leaves such a menu (and what is under it) out while the switch is off, whatever the roles grant.
 * v1: the API docs page (iframe on /api/docs, served only with SWAGGER_ENABLED).
 */
export const MENU_FEATURES: Readonly<Record<string, Switch>> = {
  'devtools-api-docs': 'SWAGGER_ENABLED',
}

/** The tree without the menus of switched-off features. */
export function withFeatures(tree: MenuNode[], on: (s: Switch) => boolean): MenuNode[] {
  return tree
    .filter((n) => {
      const s = n.routeName ? MENU_FEATURES[n.routeName] : undefined
      return !s || on(s)
    })
    .map((n) => ({ ...n, children: withFeatures(n.children, on) }))
}
