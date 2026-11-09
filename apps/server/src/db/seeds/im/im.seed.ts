// 员工即时通讯种子（see docs/im.md）：聊天参数（值只在插入时写，之后归管理员）、`im.sync.epoch` 首次随机
// UUID、每日清理任务 `im.purge`（测试运行时停用，规格自己调用处理器）、隐藏的顶层分组菜单 `im`（没有页面与
// 权限，只供租户套餐勾选聊天功能）。不论 APP_IM 开关都执行：开关关时分组由 core/auth/menu-features.ts 隐藏。
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_IM_FILE_EXTS,
  DEFAULT_IM_GROUP_RECALL_ANYTIME,
  IM_INT_PARAMS,
  imParams,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { findRow, upsert } from '../upsert.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

const PARAMS: { key: string; value: () => string; nameI18n: Record<string, string> }[] = [
  {
    key: imParams.voiceMaxSeconds,
    value: () => String(IM_INT_PARAMS.voiceMaxSeconds.fallback),
    nameI18n: both('语音消息时长上限（秒）', 'Voice message duration limit in seconds'),
  },
  {
    key: imParams.voiceMaxMb,
    value: () => String(IM_INT_PARAMS.voiceMaxMb.fallback),
    nameI18n: both(
      '语音消息大小上限（MB，不超过存储上限）',
      'Voice message size limit in MB (at most storage limit)',
    ),
  },
  {
    key: imParams.callEnabled,
    value: () => 'false',
    nameI18n: both(
      '启用员工音视频通话（还须配置 LiveKit）',
      'Enable employee calls (LiveKit configuration required)',
    ),
  },
  {
    key: imParams.retentionDays,
    value: () => String(IM_INT_PARAMS.retentionDays.fallback),
    nameI18n: both('聊天记录保留天数（0 为永久）', 'Chat history retention in days (0 = forever)'),
  },
  {
    key: imParams.epoch,
    // 每个库首次种子各自随机；恢复备份或重置库后由 root 改值，所有客户端缓存随之重建
    value: () => randomUUID(),
    nameI18n: both(
      '聊天同步纪元（改值让所有客户端重建本地缓存）',
      'Chat sync epoch (changing it makes every client rebuild its local cache)',
    ),
  },
  {
    key: imParams.textMaxChars,
    value: () => String(IM_INT_PARAMS.textMaxChars.fallback),
    nameI18n: both('聊天文字最多字数', 'Most characters of a chat text'),
  },
  {
    key: imParams.recallMinutes,
    value: () => String(IM_INT_PARAMS.recallMinutes.fallback),
    nameI18n: both(
      '聊天消息可撤回的分钟数（0 为不可撤回自己的消息）',
      'Minutes to recall an own chat message (0 = no recall)',
    ),
  },
  {
    key: imParams.editMinutes,
    value: () => String(IM_INT_PARAMS.editMinutes.fallback),
    nameI18n: both(
      '聊天文字可编辑的分钟数（0 为不可编辑）',
      'Minutes to edit an own chat text (0 = no editing)',
    ),
  },
  {
    key: imParams.groupRecallAnytime,
    value: () => String(DEFAULT_IM_GROUP_RECALL_ANYTIME),
    nameI18n: both(
      '群主与管理员可随时撤回成员消息',
      'Group owners and moderators may recall members’ messages at any time',
    ),
  },
  {
    key: imParams.groupMaxMembers,
    value: () => String(IM_INT_PARAMS.groupMaxMembers.fallback),
    nameI18n: both('群成员上限（含群主）', 'Most members of a group (owner included)'),
  },
  {
    key: imParams.fileMaxMb,
    value: () => String(IM_INT_PARAMS.fileMaxMb.fallback),
    nameI18n: both(
      '聊天图片与文件大小上限（MB，不超过存储上限）',
      'Chat image and file size limit in MB (at most the storage limit)',
    ),
  },
  {
    key: imParams.fileExts,
    value: () => DEFAULT_IM_FILE_EXTS,
    nameI18n: both(
      '聊天可发送的文件扩展名（逗号分隔，与存储允许的类型取交集）',
      'File extensions chat may send (comma-separated, within the storage’s allowed types)',
    ),
  },
]

export async function seedIm(q: EntityManager): Promise<string[]> {
  for (const p of PARAMS)
    await upsert(
      q,
      'cfg_param',
      { param_key: p.key },
      {
        name: p.nameI18n['zh-CN'],
        name_i18n: p.nameI18n,
        group_code: 'im',
        is_builtin: 1,
        is_public: 0,
      },
      { param_value: p.value() },
    )
  await upsert(
    q,
    'job_task',
    { handler: 'im.purge', name: 'seed.task.imPurge' },
    {},
    {
      group_code: 'system',
      cron: '0 50 3 * * *',
      misfire: 'run_once',
      timeout_ms: 600_000,
      // 与其它内置清理一样：单元/端到端测试运行时停用，规格自己调用处理器
      enabled: process.env.NODE_ENV === 'test' ? 0 : 1,
    },
  )
  // 隐藏的顶层分组：没有页面与权限，只让套餐能勾选“聊天”；侧栏不显示
  const fresh = !(await findRow(q, 'iam_menu', { route_name: 'im' }))
  const groupId = await upsert(
    q,
    'iam_menu',
    { route_name: 'im' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.im.title',
      route_path: '/im',
      icon: 'lucide:messages-square',
      visible: 0,
      sort_no: 9,
    },
  )
  // 套餐按菜单 id 保存：分组第一次建出时补进全部现有套餐（升级后已有租户不丢聊天）；之后 root 从套餐里
  // 去掉的不会被再次加回
  if (fresh)
    await q.query(
      `INSERT IGNORE INTO iam_tenant_package_menus (package_id, menu_id)
        SELECT id, ? FROM iam_tenant_package WHERE deleted_at IS NULL`,
      [groupId],
    )
  return []
}
