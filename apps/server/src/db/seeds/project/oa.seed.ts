import { oaExpensePerms, oaSealPerms, oaTripPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { upsertDicts } from '../settings/settings.seed.js'
import { findRow, upsert } from '../upsert.js'

/**
 * 办公业务的公共字典与权限：只补首次安装缺少的行，保留管理员修改、停用和逻辑删除。
 * 业务单据与模型在所属租户内按业务入口创建，不为新租户伪造申请或共享默认租户流程。
 */
export async function seedOa(q: EntityManager): Promise<string[]> {
  await upsertDicts(q, [
    {
      code: 'oa.request_state',
      nameI18n: { 'zh-CN': '办公申请状态', 'en-US': 'Office request status' },
      entries: [
        { value: 'draft', labelI18n: { 'zh-CN': '草稿', 'en-US': 'Draft' } },
        {
          value: 'in_review',
          labelI18n: { 'zh-CN': '审批中', 'en-US': 'In review' },
          tagType: 'warning',
        },
        {
          value: 'approved',
          labelI18n: { 'zh-CN': '已通过', 'en-US': 'Approved' },
          tagType: 'success',
        },
        {
          value: 'rejected',
          labelI18n: { 'zh-CN': '已驳回', 'en-US': 'Rejected' },
          tagType: 'danger',
        },
        { value: 'canceled', labelI18n: { 'zh-CN': '已撤销', 'en-US': 'Canceled' } },
      ],
    },
    {
      code: 'oa.expense_kind',
      nameI18n: { 'zh-CN': '报销费用类别', 'en-US': 'Expense category' },
      entries: [
        { value: 'transport', labelI18n: { 'zh-CN': '交通', 'en-US': 'Transport' } },
        { value: 'lodging', labelI18n: { 'zh-CN': '住宿', 'en-US': 'Lodging' } },
        { value: 'meal', labelI18n: { 'zh-CN': '餐饮', 'en-US': 'Meals' } },
        { value: 'office', labelI18n: { 'zh-CN': '办公', 'en-US': 'Office supplies' } },
        { value: 'other', labelI18n: { 'zh-CN': '其他', 'en-US': 'Other' } },
      ],
    },
    {
      code: 'oa.seal_kind',
      nameI18n: { 'zh-CN': '印章类型', 'en-US': 'Seal type' },
      entries: [
        { value: 'company', labelI18n: { 'zh-CN': '公章', 'en-US': 'Company seal' } },
        { value: 'contract', labelI18n: { 'zh-CN': '合同章', 'en-US': 'Contract seal' } },
        { value: 'finance', labelI18n: { 'zh-CN': '财务章', 'en-US': 'Finance seal' } },
        { value: 'other', labelI18n: { 'zh-CN': '其他', 'en-US': 'Other' } },
      ],
    },
  ])

  const group = await findRow(q, 'iam_menu', { route_name: 'oa', kind: 'group' })
  if (!group) throw new Error('seedOa: the office menu group is missing')
  if (group.deleted) return []
  // 页面接入前仅登记功能权限，不提前创建指向缺失组件的页面，也不给员工角色静默授权。
  for (const perms of [oaTripPerms, oaExpensePerms, oaSealPerms])
    for (const [i, [verb, code]] of Object.entries(perms).entries())
      await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms: code },
        {},
        { parent_id: group.id, name: `menu.action.${verb}`, sort_no: (i + 1) * 10 },
      )
  return []
}
