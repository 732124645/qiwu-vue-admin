// workflow notification templates (通知; see docs/design-notes.md#workflow): the nine codes WfNotify sends
// (modules/workflow/runtime/wf-notify.ts), inbox and mail only (no SMS), both languages, names as seed keys.
// Params: model / node / outcome are {i18n}, startedAt / dueAt {datetime} (the Notifier renders them per
// recipient); outcome of wf.task.timeout = a seed.wf.timeout.* key.
// Texts made up for this project.
import type { EntityManager } from 'typeorm'
import { upsertTemplates } from '../messaging/templates.js'

const INBOX = { category: 'business', sender_label: null, enabled: 1 }
const MAIL = { account_id: null, sender_label: null, enabled: 1 }
/** what every template can name */
const BASE = ['model', 'initiator', 'instanceId', 'startedAt']

export async function seedWorkflowTemplates(q: EntityManager): Promise<string[]> {
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.task.assigned',
    {
      'zh-CN': {
        title: '待审批：{initiator}的{model}',
        body: '{initiator} 于 {startedAt} 发起的{model}（编号 {instanceId}）已到「{node}」，等待您审批。',
      },
      'en-US': {
        title: 'Approval needed: {model} from {initiator}',
        body: '{model} #{instanceId}, started by {initiator} at {startedAt}, is waiting for your approval at "{node}".',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.taskAssigned', param_names: [...BASE, 'node'] },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.task.assigned',
    {
      'zh-CN': {
        subject: '待审批：{initiator}的{model}',
        body: '<p>{initiator} 于 {startedAt} 发起的{model}（编号 {instanceId}）已到「{node}」，等待您审批。</p><p>请登录系统，在“我的待办”中处理。</p>',
      },
      'en-US': {
        subject: 'Approval needed: {model} from {initiator}',
        body: '<p>{model} #{instanceId}, started by {initiator} at {startedAt}, is waiting for your approval at "{node}".</p><p>Sign in and open My to-dos to handle it.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.taskAssigned', param_names: [...BASE, 'node'] },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.instance.approved',
    {
      'zh-CN': {
        title: '已通过：{model}',
        body: '您于 {startedAt} 发起的{model}（编号 {instanceId}）已审批通过。',
      },
      'en-US': {
        title: 'Approved: {model}',
        body: 'Your {model} #{instanceId}, started at {startedAt}, has been approved.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.instanceApproved', param_names: BASE },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.instance.approved',
    {
      'zh-CN': {
        subject: '已通过：{model}',
        body: '<p>您于 {startedAt} 发起的{model}（编号 {instanceId}）已审批通过。</p>',
      },
      'en-US': {
        subject: 'Approved: {model}',
        body: '<p>Your {model} #{instanceId}, started at {startedAt}, has been approved.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.instanceApproved', param_names: BASE },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.instance.rejected',
    {
      'zh-CN': {
        title: '已驳回：{model}',
        body: '您于 {startedAt} 发起的{model}（编号 {instanceId}）已被驳回，审批意见见流程详情。',
      },
      'en-US': {
        title: 'Rejected: {model}',
        body: 'Your {model} #{instanceId}, started at {startedAt}, has been rejected. The comments are in the process details.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.instanceRejected', param_names: BASE },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.instance.rejected',
    {
      'zh-CN': {
        subject: '已驳回：{model}',
        body: '<p>您于 {startedAt} 发起的{model}（编号 {instanceId}）已被驳回，审批意见见流程详情。</p>',
      },
      'en-US': {
        subject: 'Rejected: {model}',
        body: '<p>Your {model} #{instanceId}, started at {startedAt}, has been rejected. The comments are in the process details.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.instanceRejected', param_names: BASE },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.cc',
    {
      'zh-CN': {
        title: '抄送：{initiator}的{model}',
        body: '{initiator} 于 {startedAt} 发起的{model}（编号 {instanceId}）抄送给您，请知悉。',
      },
      'en-US': {
        title: 'CC: {model} from {initiator}',
        body: '{model} #{instanceId}, started by {initiator} at {startedAt}, has been copied to you for your information.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.cc', param_names: BASE },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.cc',
    {
      'zh-CN': {
        subject: '抄送：{initiator}的{model}',
        body: '<p>{initiator} 于 {startedAt} 发起的{model}（编号 {instanceId}）抄送给您，请知悉。</p>',
      },
      'en-US': {
        subject: 'CC: {model} from {initiator}',
        body: '<p>{model} #{instanceId}, started by {initiator} at {startedAt}, has been copied to you for your information.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.cc', param_names: BASE },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.task.canceled',
    {
      'zh-CN': {
        title: '待办已取消：{initiator}的{model}',
        body: '{initiator} 发起的{model}（编号 {instanceId}）在「{node}」的待办已取消，您无需再处理。',
      },
      'en-US': {
        title: 'To-do canceled: {model} from {initiator}',
        body: 'Your to-do at "{node}" on {model} #{instanceId}, started by {initiator}, was canceled. No action is needed.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.taskCanceled', param_names: [...BASE, 'node'] },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.task.canceled',
    {
      'zh-CN': {
        subject: '待办已取消：{initiator}的{model}',
        body: '<p>{initiator} 发起的{model}（编号 {instanceId}）在「{node}」的待办已取消，您无需再处理。</p>',
      },
      'en-US': {
        subject: 'To-do canceled: {model} from {initiator}',
        body: '<p>Your to-do at "{node}" on {model} #{instanceId}, started by {initiator}, was canceled. No action is needed.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.taskCanceled', param_names: [...BASE, 'node'] },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.instance.sent_back',
    {
      'zh-CN': {
        title: '已退回：{model}',
        body: '您于 {startedAt} 发起的{model}（编号 {instanceId}）已退回给您，请修改后重新提交，或撤销申请。',
      },
      'en-US': {
        title: 'Sent back: {model}',
        body: 'Your {model} #{instanceId}, started at {startedAt}, was sent back to you. Edit and resubmit it, or cancel it.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.instanceSentBack', param_names: BASE },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.instance.sent_back',
    {
      'zh-CN': {
        subject: '已退回：{model}',
        body: '<p>您于 {startedAt} 发起的{model}（编号 {instanceId}）已退回给您，请修改后重新提交，或撤销申请。</p>',
      },
      'en-US': {
        subject: 'Sent back: {model}',
        body: '<p>Your {model} #{instanceId}, started at {startedAt}, was sent back to you. Edit and resubmit it, or cancel it.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.instanceSentBack', param_names: BASE },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.task.urged',
    {
      'zh-CN': {
        title: '催办：{initiator}的{model}',
        body: '{initiator} 催您尽快处理{model}（编号 {instanceId}）在「{node}」的待办。',
      },
      'en-US': {
        title: 'Reminder from {initiator}: {model}',
        body: '{initiator} asks you to handle your to-do at "{node}" on {model} #{instanceId} soon.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.taskUrged', param_names: [...BASE, 'node'] },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.task.urged',
    {
      'zh-CN': {
        subject: '催办：{initiator}的{model}',
        body: '<p>{initiator} 催您尽快处理{model}（编号 {instanceId}）在「{node}」的待办。</p>',
      },
      'en-US': {
        subject: 'Reminder from {initiator}: {model}',
        body: '<p>{initiator} asks you to handle your to-do at "{node}" on {model} #{instanceId} soon.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.taskUrged', param_names: [...BASE, 'node'] },
  )

  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.task.overdue',
    {
      'zh-CN': {
        title: '待办已超时：{initiator}的{model}',
        body: '{initiator} 发起的{model}（编号 {instanceId}）在「{node}」的待办已于 {dueAt} 到期，请尽快处理。',
      },
      'en-US': {
        title: 'Overdue: {model} from {initiator}',
        body: 'Your to-do at "{node}" on {model} #{instanceId}, started by {initiator}, was due at {dueAt}. Please handle it soon.',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.taskOverdue', param_names: [...BASE, 'node', 'dueAt'] },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.task.overdue',
    {
      'zh-CN': {
        subject: '待办已超时：{initiator}的{model}',
        body: '<p>{initiator} 发起的{model}（编号 {instanceId}）在「{node}」的待办已于 {dueAt} 到期，请尽快处理。</p>',
      },
      'en-US': {
        subject: 'Overdue: {model} from {initiator}',
        body: '<p>Your to-do at "{node}" on {model} #{instanceId}, started by {initiator}, was due at {dueAt}. Please handle it soon.</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.taskOverdue', param_names: [...BASE, 'node', 'dueAt'] },
  )

  // the remind job handled an overdue task: to the initiator, the process managers and the assignee
  const TIMEOUT = [...BASE, 'node', 'assignee', 'dueAt', 'outcome']
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'wf.task.timeout',
    {
      'zh-CN': {
        title: '待办超时：{initiator}的{model}',
        body: '{initiator} 发起的{model}（编号 {instanceId}）在「{node}」由 {assignee} 办理的待办已于 {dueAt} 到期。处理结果：{outcome}',
      },
      'en-US': {
        title: 'To-do timed out: {model} from {initiator}',
        body: 'The to-do of {assignee} at "{node}" on {model} #{instanceId}, started by {initiator}, was due at {dueAt}. Outcome: {outcome}',
      },
    },
    { ...INBOX, name: 'seed.wfTemplate.taskTimeout', param_names: TIMEOUT },
  )
  await upsertTemplates(
    q,
    'msg_mail_template',
    'wf.task.timeout',
    {
      'zh-CN': {
        subject: '待办超时：{initiator}的{model}',
        body: '<p>{initiator} 发起的{model}（编号 {instanceId}）在「{node}」由 {assignee} 办理的待办已于 {dueAt} 到期。</p><p>处理结果：{outcome}</p>',
      },
      'en-US': {
        subject: 'To-do timed out: {model} from {initiator}',
        body: '<p>The to-do of {assignee} at "{node}" on {model} #{instanceId}, started by {initiator}, was due at {dueAt}.</p><p>Outcome: {outcome}</p>',
      },
    },
    { ...MAIL, name: 'seed.wfTemplate.taskTimeout', param_names: TIMEOUT },
  )
  return []
}
