// Monitor menus: the server, Redis, cache and MySQL pages under the `monitor` group
// (found by route_name, never by id), each with its actions (upserted by perms). Names are i18n keys: the
// pages' in the web monitor fragments (monitor.<page>.json), the actions' in menu.json.
import { monitorPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../db/seeds/upsert.js'

interface PageSeed {
  routeName: string
  name: string
  path: string
  component: string
  componentName: string
  icon: string
  actions: [perms: string, name: string][]
}

const PAGES: PageSeed[] = [
  {
    routeName: 'monitor-server',
    name: 'menu.monitor.server',
    path: '/monitor/server',
    component: 'platform/monitor/server/index',
    componentName: 'MonitorServer',
    icon: 'lucide:server',
    actions: [[monitorPerms.server, 'menu.action.browse']],
  },
  {
    routeName: 'monitor-redis',
    name: 'menu.monitor.redis',
    path: '/monitor/redis',
    component: 'platform/monitor/redis/index',
    componentName: 'MonitorRedis',
    icon: 'lucide:database-zap',
    actions: [[monitorPerms.redis, 'menu.action.browse']],
  },
  {
    routeName: 'monitor-cache',
    name: 'menu.monitor.cache',
    path: '/monitor/cache',
    component: 'platform/monitor/cache/index',
    componentName: 'MonitorCache',
    icon: 'lucide:layers',
    actions: [
      [monitorPerms.cache, 'menu.action.browse'],
      [monitorPerms.cacheClear, 'menu.action.remove'],
    ],
  },
  {
    routeName: 'monitor-mysql',
    name: 'menu.monitor.mysql',
    path: '/monitor/mysql',
    component: 'platform/monitor/mysql/index',
    componentName: 'MonitorMysql',
    icon: 'lucide:database',
    actions: [[monitorPerms.mysql, 'menu.action.browse']],
  },
]

export async function seedMonitor(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'monitor' })
  if (parentId === undefined) throw new Error('seedMonitor: the monitor menu group is missing')
  // after the online users (10) and scheduler pages (20, 30)
  for (const [i, p] of PAGES.entries()) {
    const pageId = await upsert(
      q,
      'iam_menu',
      { route_name: p.routeName },
      {
        parent_id: parentId,
        kind: 'page',
        name: p.name,
        route_path: p.path,
        component: p.component,
        component_name: p.componentName,
        keep_alive: 1,
        icon: p.icon,
        sort_no: (i + 4) * 10,
      },
    )
    for (const [j, [perms, name]] of p.actions.entries())
      await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms },
        { parent_id: pageId, name, sort_no: (j + 1) * 10 },
      )
  }
  return []
}
