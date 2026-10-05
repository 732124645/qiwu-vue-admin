// Online users menus: the page under the `monitor` group (found by route_name, never by
// id) and one action row per sessionPerms, upserted by route_name / perms. Names are i18n keys: the page's
// and `kick` in the module's web locale fragment (iam.session.json), the others in menu.json.
import { sessionPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../../db/seeds/upsert.js'

const ACTIONS: [perms: string, name: string][] = [
  [sessionPerms.browse, 'menu.action.browse'],
  [sessionPerms.kick, 'menu.action.kick'],
]

export async function seedSession(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'monitor' })
  if (parentId === undefined) throw new Error('seedSession: the monitor menu group is missing')
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'iam-session' },
    {
      parent_id: parentId,
      kind: 'page',
      name: 'menu.iam.session',
      route_path: '/monitor/sessions',
      component: 'platform/iam/session/index',
      component_name: 'IamSession',
      keep_alive: 1,
      icon: 'lucide:user-round-check',
      sort_no: 10,
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
