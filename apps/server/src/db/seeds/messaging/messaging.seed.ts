// messaging seed: the messaging menu group and the bulletin kind dict; the pages seed
// themselves (modules/platform/messaging/*/…seed.ts).
import type { EntityManager } from 'typeorm'
import { upsertDicts } from '../settings/settings.seed.js'
import { findId, upsert } from '../upsert.js'

export async function seedMessaging(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'system' })
  if (parentId === undefined) throw new Error('seedMessaging: the system menu group is missing')
  await upsertDicts(q, [
    {
      code: 'messaging.inbox_category',
      nameI18n: { 'zh-CN': '站内信分类', 'en-US': 'Inbox category' },
      entries: [
        { value: 'system', labelI18n: { 'zh-CN': '系统', 'en-US': 'System' }, isDefault: true },
        { value: 'business', labelI18n: { 'zh-CN': '业务', 'en-US': 'Business' } },
      ],
    },
    {
      code: 'messaging.inbox_status',
      nameI18n: { 'zh-CN': '推送状态', 'en-US': 'Push status' },
      entries: [
        { value: 'pending', labelI18n: { 'zh-CN': '待推送', 'en-US': 'Pending' } },
        { value: 'sending', labelI18n: { 'zh-CN': '推送中', 'en-US': 'Sending' } },
        { value: 'delivered', labelI18n: { 'zh-CN': '已推送', 'en-US': 'Delivered' } },
        { value: 'failed', labelI18n: { 'zh-CN': '推送失败', 'en-US': 'Failed' } },
      ],
    },
    {
      code: 'messaging.bulletin_kind',
      nameI18n: { 'zh-CN': '公告类型', 'en-US': 'Bulletin kind' },
      entries: [
        {
          value: 'notice',
          labelI18n: { 'zh-CN': '通知', 'en-US': 'Notice' },
          tagType: 'primary',
          isDefault: true,
        },
        {
          value: 'announcement',
          labelI18n: { 'zh-CN': '公告', 'en-US': 'Announcement' },
          tagType: 'success',
        },
      ],
    },
  ])
  await upsert(
    q,
    'iam_menu',
    { route_name: 'messaging' },
    {
      parent_id: parentId,
      kind: 'group',
      name: 'menu.messaging.title',
      route_path: '/messaging',
      icon: 'lucide:messages-square',
      sort_no: 90,
    },
  )
  return []
}
