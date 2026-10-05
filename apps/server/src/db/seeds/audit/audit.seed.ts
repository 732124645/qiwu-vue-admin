// audit seed (see docs/design-notes.md#audit): the audit menu group and the log filter dicts (action verbs, user types, sign-in
// kinds, API error states); the log pages seed themselves (modules/platform/audit/*/…seed.ts).
import type { EntityManager } from 'typeorm'
import { type DictSeed, upsertDicts } from '../settings/settings.seed.js'
import { findId, upsert } from '../upsert.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

/** `@ActionLog` verbs in use (a verb without an entry shows as its code). */
const VERBS: [value: string, zh: string, en: string, tagType?: string][] = [
  ['create', '新增', 'Create', 'success'],
  ['modify', '修改', 'Modify', 'primary'],
  ['remove', '删除', 'Delete', 'danger'],
  ['import', '导入', 'Import'],
  ['export', '导出', 'Export'],
  ['upload', '上传', 'Upload'],
  ['grant', '授权', 'Grant', 'warning'],
  ['revoke', '取消授权', 'Revoke', 'warning'],
  ['reset-password', '重置密码', 'Reset password', 'warning'],
  ['reset-password-sms', '短信找回密码', 'Reset password by SMS', 'warning'],
  ['reset-secret', '重置密钥', 'Reset secret', 'warning'],
  ['signup', '注册', 'Sign up'],
  ['kick', '强制退出', 'End session', 'warning'],
  ['change-password', '修改密码', 'Change password'],
  ['change-avatar', '更换头像', 'Change avatar'],
  ['unbind', '解绑', 'Unlink', 'warning'],
  ['refresh-cache', '刷新缓存', 'Refresh cache'],
  ['publish', '发布', 'Publish', 'primary'],
  ['clean', '清空', 'Clear', 'danger'],
  ['unlock', '解锁', 'Unlock', 'warning'],
  ['sync', '同步', 'Sync'],
  ['generate', '生成代码', 'Generate code'],
  ['write', '写入代码', 'Write code', 'warning'],
  ['handle', '处理', 'Handle', 'primary'],
  ['terminate', '终止', 'Terminate', 'danger'],
  ['reassign', '改派', 'Reassign', 'warning'],
  ['run', '执行', 'Run', 'primary'],
  ['test', '测试', 'Test', 'primary'],
  ['send', '发送', 'Send', 'primary'],
  ['approve', '通过', 'Approve', 'success'],
  ['reject', '驳回', 'Reject', 'danger'],
  ['send-back', '退回', 'Send back', 'warning'],
  ['resubmit', '重新提交', 'Resubmit', 'primary'],
  ['transfer', '转办', 'Transfer', 'primary'],
  ['delegate', '委派', 'Delegate', 'primary'],
  ['add-sign', '加签', 'Add signers', 'primary'],
  ['remove-sign', '减签', 'Remove signers', 'warning'],
  ['cc', '抄送', 'Copy'],
  ['comment', '评论', 'Comment'],
  ['withdraw', '撤回', 'Withdraw', 'warning'],
  ['cancel', '撤销', 'Cancel', 'danger'],
  ['urge', '催办', 'Send reminder', 'warning'],
]

const DICTS: DictSeed[] = [
  {
    code: 'audit.user_type',
    nameI18n: both('审计用户类型', 'Audit user type'),
    entries: [
      { value: 'admin', labelI18n: both('管理员', 'Administrator') },
      { value: 'member', labelI18n: both('会员', 'Member') },
    ],
  },
  {
    code: 'audit.verb',
    nameI18n: both('操作动作', 'Action verb'),
    entries: VERBS.map(([value, zh, en, tagType]) => ({
      value,
      labelI18n: both(zh, en),
      ...(tagType && { tagType }),
    })),
  },
  {
    code: 'audit.signin_kind',
    nameI18n: both('登录日志类型', 'Sign-in log kind'),
    entries: [
      { value: 'password', labelI18n: both('密码登录', 'Password sign-in'), tagType: 'primary' },
      { value: 'sms', labelI18n: both('短信登录', 'SMS sign-in'), tagType: 'primary' },
      { value: 'wx-mp', labelI18n: both('微信登录', 'WeChat sign-in'), tagType: 'primary' },
      { value: 'signout', labelI18n: both('退出登录', 'Sign-out'), tagType: 'info' },
      { value: 'kicked', labelI18n: both('被强制退出', 'Signed out by admin'), tagType: 'warning' },
      {
        value: 'refresh_reuse',
        labelI18n: both('刷新令牌重放', 'Refresh token replay'),
        tagType: 'danger',
      },
      { value: 'locked', labelI18n: both('锁定', 'Locked'), tagType: 'danger' },
    ],
  },
  {
    code: 'audit.fault_state',
    nameI18n: both('错误处理状态', 'Error handling state'),
    entries: [
      { value: 'open', labelI18n: both('待处理', 'Open'), tagType: 'danger' },
      { value: 'resolved', labelI18n: both('已处理', 'Resolved'), tagType: 'success' },
      { value: 'ignored', labelI18n: both('已忽略', 'Ignored'), tagType: 'info' },
    ],
  },
]

export async function seedAudit(q: EntityManager): Promise<string[]> {
  const parentId = await findId(q, 'iam_menu', { route_name: 'system' })
  if (parentId === undefined) throw new Error('seedAudit: the system menu group is missing')
  await upsertDicts(q, DICTS)
  await upsert(
    q,
    'iam_menu',
    { route_name: 'audit' },
    {
      parent_id: parentId,
      kind: 'group',
      name: 'menu.audit.title',
      route_path: '/audit',
      icon: 'lucide:history',
      sort_no: 100,
    },
  )
  return []
}
