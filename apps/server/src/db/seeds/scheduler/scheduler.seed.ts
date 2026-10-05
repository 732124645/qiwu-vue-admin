// scheduler seed: the scheduler dicts and the built-in tasks (by handler + name; admins own their
// schedule and switches after the first seed); the task and task log pages seed themselves (their
// <biz>.seed.ts).
import type { EntityManager } from 'typeorm'
import { type DictSeed, upsertDicts } from '../settings/settings.seed.js'
import { upsertTemplates } from '../messaging/templates.js'
import { upsert } from '../upsert.js'

const both = (zh: string, en: string) => ({ 'zh-CN': zh, 'en-US': en })

const DICTS: DictSeed[] = [
  {
    code: 'scheduler.job_group',
    nameI18n: both('任务分组', 'Task group'),
    entries: [
      { value: 'default', labelI18n: both('默认', 'Default'), isDefault: true },
      { value: 'system', labelI18n: both('系统', 'System'), tagType: 'primary' },
    ],
  },
  {
    code: 'scheduler.misfire',
    nameI18n: both('错过策略', 'Misfire policy'),
    entries: [
      { value: 'skip', labelI18n: both('跳过', 'Skip'), isDefault: true },
      { value: 'run_once', labelI18n: both('补跑一次', 'Run once') },
    ],
  },
  {
    code: 'scheduler.run_outcome',
    nameI18n: both('执行结果', 'Run outcome'),
    entries: [
      { value: 'ok', labelI18n: both('成功', 'Succeeded'), tagType: 'success' },
      { value: 'failed', labelI18n: both('失败', 'Failed'), tagType: 'danger' },
      { value: 'skipped', labelI18n: both('跳过', 'Skipped'), tagType: 'info' },
      { value: 'timeout', labelI18n: both('超时', 'Timed out'), tagType: 'warning' },
    ],
  },
]

/** Built-in tasks: names are `seed.task.*` keys (texts in the shared seed.json). */
const TASKS: { name: string; handler: string; onInsert: Record<string, unknown> }[] = [
  {
    name: 'seed.task.auditPurge',
    handler: 'audit.purge',
    // daily 03:30; a day missed while down is made up at the next start
    onInsert: { cron: '0 30 3 * * *', misfire: 'run_once', timeout_ms: 600_000 },
  },
  {
    name: 'seed.task.sessionSweep',
    handler: 'session.sweep',
    onInsert: { cron: '0 */10 * * * *', misfire: 'skip', timeout_ms: 60_000 },
  },
  {
    // the outbox recovery scan
    name: 'seed.task.notifyDispatch',
    handler: 'notify.dispatch',
    // Specs invoke the handler themselves; avoid a minute tick in unrelated tests.
    onInsert: {
      cron: '0 * * * * *',
      misfire: 'skip',
      timeout_ms: 60_000,
      enabled: process.env.NODE_ENV === 'test' ? 0 : 1,
    },
  },
  {
    name: 'seed.task.demoEcho',
    handler: 'demo.echo',
    onInsert: {
      cron: '0 0 * * * *',
      misfire: 'skip',
      timeout_ms: 60_000,
      enabled: 0,
      group_code: 'default',
      params: { message: 'hello' },
    },
  },
]

export async function seedScheduler(q: EntityManager): Promise<string[]> {
  await upsertDicts(q, DICTS)
  await upsertTemplates(
    q,
    'msg_inbox_template',
    'scheduler.job.timeout',
    {
      'zh-CN': {
        title: '任务超时：{task}',
        body: '处理器：{handler}\n超时：{timeoutMs} 毫秒\n开始时间：{startedAt}\n第 {attempt} 次尝试',
      },
      'en-US': {
        title: 'Job timed out: {task}',
        body: 'Handler: {handler}\nTimeout: {timeoutMs} ms\nStarted: {startedAt}\nAttempt: {attempt}',
      },
    },
    {
      name: 'seed.inboxTemplate.schedulerJobTimeout',
      category: 'system',
      sender_label: null,
      enabled: 1,
      param_names: ['task', 'handler', 'timeoutMs', 'startedAt', 'attempt'],
    },
  )
  for (const t of TASKS)
    await upsert(
      q,
      'job_task',
      { handler: t.handler, name: t.name },
      {},
      { group_code: 'system', ...t.onInsert },
    )
  return []
}
