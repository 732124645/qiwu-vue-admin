// monitor seed: the 系统监控 menu group; its pages seed themselves (online users:
// modules/platform/iam/session/session.seed.ts; server, Redis, cache, MySQL:
// modules/platform/monitor/monitor.seed.ts). The group's name is in the web monitor fragments.
import type { EntityManager } from 'typeorm'
import { upsert } from '../upsert.js'

export async function seedMonitorGroup(q: EntityManager): Promise<string[]> {
  await upsert(
    q,
    'iam_menu',
    { route_name: 'monitor' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.monitor.title',
      route_path: '/monitor',
      icon: 'lucide:activity',
      sort_no: 20,
    },
  )
  return []
}
