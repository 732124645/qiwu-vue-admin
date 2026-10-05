// File list menus (hand-written page; see docs/design-notes.md#storage): the page under the `storage` group (found by
// route_name, never by id) and one action row per storageObjectPerms, upserted by route_name / perms. Names
// are i18n keys: the page's in the web fragment storage.object.json, the actions' in menu.json.
import { storageObjectPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../../../db/seeds/upsert.js'

const ACTIONS: [perms: string, name: string][] = [
  [storageObjectPerms.browse, 'menu.action.browse'],
  [storageObjectPerms.view, 'menu.action.view'],
  [storageObjectPerms.export, 'menu.action.export'],
  [storageObjectPerms.remove, 'menu.action.remove'],
]

export async function seedStorageObject(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'storage' })
  if (parentId === undefined)
    throw new Error('seedStorageObject: the storage menu group is missing')
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'storage-object' },
    {
      parent_id: parentId,
      kind: 'page',
      name: 'menu.storage.object',
      route_path: '/storage/objects',
      component: 'platform/storage/object/index',
      component_name: 'StorageObject',
      keep_alive: 1,
      icon: 'lucide:files',
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
