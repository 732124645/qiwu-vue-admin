// Storage seed (see docs/design-notes.md#storage): the 文件管理 menu group (before any generated page names it as parent,
// #8), the primary local storage (name = seed key, root from STORAGE_LOCAL_ROOT) and the upload
// params. The pages (storage configs, file list) seed their own menus.
import {
  STORAGE_ALLOWED_EXTS_DEFAULT,
  STORAGE_MAX_SIZE_DEFAULT,
  storageParams,
  type Locale,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findId, upsert } from '../upsert.js'

/** `isPublic`: the upload limit is readable before the upload (the pickers check and show it). */
const PARAMS: {
  key: string
  value: string
  nameI18n: Record<Locale, string>
  isPublic: boolean
}[] = [
  {
    key: storageParams.maxSizeMb,
    value: String(STORAGE_MAX_SIZE_DEFAULT / 1024 / 1024),
    nameI18n: { 'zh-CN': '上传文件大小上限（MB）', 'en-US': 'Upload size limit (MB)' },
    isPublic: true,
  },
  {
    key: storageParams.allowedExts,
    value: STORAGE_ALLOWED_EXTS_DEFAULT.join(','),
    nameI18n: { 'zh-CN': '允许上传的扩展名', 'en-US': 'Allowed upload extensions' },
    isPublic: false,
  },
]

export async function seedStorage(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'system' })
  if (parentId === undefined) throw new Error('seedStorage: the system menu group is missing')
  await upsert(
    q,
    'iam_menu',
    { route_name: 'storage' },
    {
      parent_id: parentId,
      kind: 'group',
      name: 'menu.storage.title',
      route_path: '/storage',
      icon: 'lucide:hard-drive',
      sort_no: 110,
    },
  )
  // is_primary on insert only: an admin may make another storage primary later
  await upsert(
    q,
    'fs_storage',
    { name: 'seed.storage.local' },
    { driver: 'local', config: {} },
    { is_primary: 1 },
  )
  for (const p of PARAMS)
    await upsert(
      q,
      'cfg_param',
      { param_key: p.key },
      {
        name: p.nameI18n['zh-CN'],
        name_i18n: p.nameI18n,
        group_code: 'storage',
        is_builtin: 1,
        is_public: p.isPublic ? 1 : 0,
      },
      { param_value: p.value },
    )
  return []
}
