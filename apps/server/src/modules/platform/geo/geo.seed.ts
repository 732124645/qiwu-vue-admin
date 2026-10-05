// Regions menus: the page under the `system` group (found by route_name, never by id)
// and its `browse` action (the IP lookup; the area tree needs no permission). Names are i18n keys: the
// page's in the web geo fragment (geo.area.json), the action's in menu.json.
import { geoPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../db/seeds/upsert.js'

export async function seedGeo(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'system' })
  if (parentId === undefined) throw new Error('seedGeo: the system menu group is missing')
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'geo-area' },
    {
      parent_id: parentId,
      kind: 'page',
      name: 'menu.geo.area',
      route_path: '/geo/areas',
      component: 'platform/geo/area/index',
      component_name: 'GeoArea',
      keep_alive: 1,
      icon: 'lucide:map',
      sort_no: 80,
    },
  )
  await upsert(
    q,
    'iam_menu',
    { kind: 'action', perms: geoPerms.browse },
    { parent_id: pageId, name: 'menu.action.browse', sort_no: 10 },
  )
  return []
}
