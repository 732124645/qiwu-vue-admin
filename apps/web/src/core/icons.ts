import { addCollection, Icon } from '@iconify/vue/offline'
import { icons as lucide } from '@iconify-json/lucide'

// Icons are DB strings like 'lucide:house' (menus). Offline build + bundled Lucide set (ISC): nothing is
// fetched from the Iconify API (the SPA CSP only allows connect-src 'self'). Lucide draws a 2px stroke on
// its 24px grid; the visual system uses 1.8 (docs/design/visual-system.md §10).
addCollection({
  ...lucide,
  icons: Object.fromEntries(
    Object.entries(lucide.icons).map(([name, icon]) => [
      name,
      { ...icon, body: icon.body.replaceAll('stroke-width="2"', 'stroke-width="1.8"') },
    ]),
  ),
})

/** Every bundled Lucide icon as `lucide:<name>` (IconPicker; menu icons are these strings). */
export const LUCIDE_ICONS = Object.keys(lucide.icons).map((name) => `lucide:${name}`)

export { Icon }
