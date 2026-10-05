// workflow seed (see docs/design-notes.md#workflow): the dicts of the wf tables and of the OA leave
// sample (biz/leave, whose pages sit in the workflow menu group). States and actions follow the shared
// engine constants: a code added there fails to compile here until it has its labels.
// Codes and texts made up for this project.
import {
  WF_ACTIONS,
  WF_INSTANCE_STATES,
  WF_TASK_STATES,
  type WfAction,
  type WfInstanceState,
  type WfTaskState,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { type DictSeed, upsertDicts } from '../settings/settings.seed.js'
import { upsert } from '../upsert.js'

type Entry = DictSeed['entries'][number]
type Label = Omit<Entry, 'value'>
const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })
const entry = (labelI18n: Entry['labelI18n'], tagType?: string): Label => ({ labelI18n, tagType })
/** Entries in the order of the shared constant, one per code. */
const byCode = <T extends string>(codes: readonly T[], entries: Record<T, Label>) =>
  codes.map((value) => ({ value, ...entries[value] }))

const INSTANCE_STATES: Record<WfInstanceState, Label> = {
  running: entry(both('审批中', 'In progress'), 'primary'),
  approved: entry(both('已通过', 'Approved'), 'success'),
  rejected: entry(both('已驳回', 'Rejected'), 'danger'),
  canceled: entry(both('已撤销', 'Canceled'), 'info'),
  terminated: entry(both('已终止', 'Terminated'), 'warning'),
}

const TASK_STATES: Record<WfTaskState, Label> = {
  waiting: entry(both('未开始', 'Waiting'), 'info'),
  pending: entry(both('待处理', 'Pending'), 'primary'),
  approved: entry(both('已通过', 'Approved'), 'success'),
  rejected: entry(both('已驳回', 'Rejected'), 'danger'),
  transferred: entry(both('已转办', 'Transferred'), 'info'),
  delegated: entry(both('已委派', 'Delegated'), 'info'),
  canceled: entry(both('已取消', 'Canceled'), 'info'),
  sent_back: entry(both('已退回', 'Sent back'), 'warning'),
  withdrawn: entry(both('已撤回', 'Withdrawn'), 'info'),
}

const ACTIONS: Record<WfAction, Label> = {
  begin: entry(both('发起', 'Start')),
  resubmit: entry(both('重新提交', 'Resubmit')),
  approve: entry(both('通过', 'Approve'), 'success'),
  reject: entry(both('驳回', 'Reject'), 'danger'),
  send_back: entry(both('退回', 'Send back'), 'warning'),
  transfer: entry(both('转办', 'Transfer')),
  delegate: entry(both('委派', 'Delegate')),
  add_sign: entry(both('加签', 'Add signers')),
  remove_sign: entry(both('减签', 'Remove signers')),
  cc: entry(both('抄送', 'CC')),
  cancel: entry(both('撤销', 'Cancel'), 'info'),
  withdraw: entry(both('撤回', 'Withdraw'), 'info'),
  terminate: entry(both('终止', 'Terminate'), 'warning'),
  reassign: entry(both('改派', 'Reassign')),
  comment: entry(both('评论', 'Comment')),
  urge: entry(both('催办', 'Send reminder')),
  timeout: entry(both('超时处理', 'Timed out'), 'warning'),
}

const DICTS: DictSeed[] = [
  {
    code: 'wf.category',
    nameI18n: both('流程分类', 'Process category'),
    entries: [
      { value: 'hr', labelI18n: both('人事', 'HR') },
      { value: 'finance', labelI18n: both('财务', 'Finance') },
      { value: 'admin', labelI18n: both('行政', 'Administration') },
      // wf_model.category's column default
      { value: 'other', labelI18n: both('其他', 'Other'), isDefault: true },
    ],
  },
  {
    code: 'wf.instance_state',
    nameI18n: both('流程状态', 'Process state'),
    entries: byCode(WF_INSTANCE_STATES, INSTANCE_STATES),
  },
  {
    code: 'wf.task_state',
    nameI18n: both('任务状态', 'Task state'),
    entries: byCode(WF_TASK_STATES, TASK_STATES),
  },
  {
    code: 'wf.action',
    nameI18n: both('审批动作', 'Approval action'),
    entries: byCode(WF_ACTIONS, ACTIONS),
  },
  {
    code: 'biz.leave_kind',
    nameI18n: both('请假类型', 'Leave type'),
    entries: [
      { value: 'annual', labelI18n: both('年假', 'Annual leave'), isDefault: true },
      { value: 'personal', labelI18n: both('事假', 'Personal leave') },
      { value: 'sick', labelI18n: both('病假', 'Sick leave') },
      { value: 'compensatory', labelI18n: both('调休', 'Time off in lieu') },
      { value: 'marriage', labelI18n: both('婚假', 'Marriage leave') },
      { value: 'maternity', labelI18n: both('产假', 'Maternity leave') },
      { value: 'paternity', labelI18n: both('陪产假', 'Paternity leave') },
      { value: 'bereavement', labelI18n: both('丧假', 'Bereavement leave') },
    ],
  },
  {
    // biz_leave_request.state: the handler mirrors its instance's state (leave-wf.handler.ts)
    code: 'biz.leave_state',
    nameI18n: both('请假单状态', 'Leave request state'),
    entries: [
      { value: 'draft', ...entry(both('草稿', 'Draft'), 'info') },
      { value: 'in_review', ...entry(both('审批中', 'In review'), 'primary') },
      { value: 'approved', ...entry(both('已通过', 'Approved'), 'success') },
      { value: 'rejected', ...entry(both('已驳回', 'Rejected'), 'danger') },
      { value: 'canceled', ...entry(both('已撤销', 'Canceled'), 'info') },
    ],
  },
]

export async function seedWorkflow(q: EntityManager): Promise<string[]> {
  await upsertDicts(q, DICTS)
  // the overdue reminders, every 5 minutes; like notify.dispatch off in unit/e2e test runs (specs
  // invoke the handler themselves), admins own its schedule and switch after the first seed
  await upsert(
    q,
    'job_task',
    { handler: 'wf.task.remind', name: 'seed.task.wfTaskRemind' },
    {},
    {
      group_code: 'system',
      cron: '0 */5 * * * *',
      misfire: 'skip',
      timeout_ms: 60_000,
      enabled: process.env.NODE_ENV === 'test' ? 0 : 1,
    },
  )
  return []
}
