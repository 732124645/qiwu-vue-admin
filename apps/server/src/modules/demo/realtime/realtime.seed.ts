// Realtime demo menus: the page under the `demo` group (found by route_name, never by id), after
// the generated samples, and one action row per permission, upserted by route_name / perms. Names are
// i18n keys: the page's in the web locale fragment demo.realtime.json, the actions' in menu.json.
import { demoRealtimePerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../db/seeds/upsert.js'

const ACTIONS: [perms: string, name: string][] = [
  [demoRealtimePerms.send, 'menu.action.send'],
  [demoRealtimePerms.broadcast, 'menu.action.broadcast'],
]

export async function seedDemoRealtime(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'demo' })
  if (parentId === undefined) throw new Error('seedDemoRealtime: the demo menu group is missing')
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'demo-realtime' },
    {
      parent_id: parentId,
      kind: 'page',
      name: 'menu.demo.realtime',
      route_path: '/demo/realtime',
      component: 'demo/realtime/index',
      component_name: 'DemoRealtime',
      // the receive log survives switching tabs
      keep_alive: 1,
      icon: 'lucide:radio',
      sort_no: 40,
    },
  )
  for (const [i, [perms, name]] of ACTIONS.entries())
    await upsert(
      q,
      'iam_menu',
      { kind: 'action', perms },
      { parent_id: pageId, name, sort_no: (i + 1) * 10 },
    )
  return []
}
