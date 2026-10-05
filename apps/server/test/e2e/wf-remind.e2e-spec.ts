// 超时提醒 (see docs/design-notes.md#workflow): the seeded `wf.task.remind` job (every 5 minutes) sends `wf.task.overdue`
// to the assignee of each pending task past its due_at: once, or every `timeout.remindEvery` hours while it
// stays pending. The claim is a conditional UPDATE of reminded_at, so racing runs remind once; a failed send
// rolls the claim back. Instances start through WfStore at a chosen time (due_at = then + hours).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { WfReviewNode } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { JobRegistry } from '../../src/modules/platform/scheduler/job-registry.js'
import { reassign } from '../../src/modules/workflow/engine/lifecycle.js'
import { WfNotify } from '../../src/modules/workflow/runtime/wf-notify.js'
import { WfRemind } from '../../src/modules/workflow/runtime/wf-remind.js'
import { WfStore } from '../../src/modules/workflow/runtime/wf-store.js'
import { chain, fields, HOUR, review, users } from '../fixtures/wf/flow.js'

const PREFIX = 'e2e-wfr-'
const MINUTE = 60_000

let app: NestExpressApplication
let ds: DataSource
let cls: ClsService
const u = {} as Record<'init' | 'ann' | 'ben', number>
let seq = 0
let mark = 0

/** starts a one-review process for ann at `ago` ms before now; its task id */
async function startTask(timeout: WfReviewNode['timeout'], ago = 0, who = u.ann): Promise<number> {
  const key = `${PREFIX}m${++seq}`
  const tree = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: chain(review('r', { ...users(who), timeout })),
  }
  const m = await ds.query(
    "INSERT INTO wf_model (model_key, name, form_kind) VALUES (?, ?, 'dynamic')",
    [key, key],
  )
  const v = await ds.query(
    'INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot) VALUES (?, ?, 1, ?, ?)',
    [m.insertId, key, JSON.stringify(tree), JSON.stringify({ fields })],
  )
  const input = {
    versionId: v.insertId,
    initiatorId: u.init,
    initiatorDeptId: null,
    businessKey: null,
    formValues: { amount: 1 },
    initiatorPicks: {},
    initiatorCtx: { deptTreePath: null, roleIds: [] },
  }
  const { taskIds } = await cls.run(() => app.get(WfStore).start(input, new Date(Date.now() - ago)))
  return taskIds[0]!
}

/** one run of the registered handler (as the scheduler calls it) */
const runJob = () =>
  app
    .get(JobRegistry)
    .get('wf.task.remind')!
    .run({}, { signal: new AbortController().signal, log: () => {} })
/** recipients of the overdue reminders written since the test began */
const reminded = async () =>
  (
    await ds.query<{ user_id: number }[]>(
      "SELECT user_id FROM msg_inbox WHERE id > ? AND user_id IN (?) AND template_code = 'wf.task.overdue' ORDER BY id",
      [mark, Object.values(u)],
    )
  ).map((r) => Number(r.user_id))
const remindedAt = async (taskId: number) =>
  (await ds.query('SELECT reminded_at FROM wf_task WHERE id = ?', [taskId]))[0]
    .reminded_at as Date | null
const setRemindedAt = (taskId: number, at: Date) =>
  ds.query('UPDATE wf_task SET reminded_at = ? WHERE id = ?', [at, taskId])

async function cleanup() {
  const sub = `SELECT id FROM wf_instance WHERE model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
  const ids = Object.values(u)
  if (ids.length) {
    await app.get(NotifyDispatcher).idle()
    for (const t of ['msg_inbox', 'msg_mail_record'])
      await ds.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [ids])
  }
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  cls = app.get(ClsService)
  await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
  for (const who of ['init', 'ann', 'ben'] as const)
    u[who] = await insertRow(ds.manager, 'iam_user', {
      username: PREFIX + who,
      display_name: who,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
    })
  await cleanup()
})

beforeEach(async () => {
  // only this spec's users are counted: overdue leftovers of other specs do not matter
  mark = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
  }
  await app?.close()
})

it('is a registered handler with a seeded task every 5 minutes (off in test runs)', async () => {
  expect(app.get(JobRegistry).get('wf.task.remind')).toBeDefined()
  const rows = await ds.query(
    "SELECT name, cron, enabled, group_code FROM job_task WHERE handler = 'wf.task.remind'",
  )
  expect(rows).toEqual([
    { name: 'seed.task.wfTaskRemind', cron: '0 */5 * * * *', enabled: 0, group_code: 'system' },
  ])
})

it('reminds the assignee of a pending task past its due time once, without remindEvery', async () => {
  const due = await startTask({ hours: 2 }, 3 * HOUR)
  const early = await startTask({ hours: 2 }, HOUR, u.ben)
  const none = await startTask(undefined, 3 * HOUR, u.ben)
  const handled = await startTask({ hours: 1 }, 2 * HOUR, u.ben)
  await ds.query("UPDATE wf_task SET state = 'approved', handled_at = NOW(3) WHERE id = ?", [
    handled,
  ])
  await runJob()
  expect(await reminded()).toEqual([u.ann])
  expect(await remindedAt(due)).not.toBeNull()
  for (const id of [early, none, handled]) expect(await remindedAt(id)).toBeNull()
  await runJob()
  // long after the first reminder: still once
  await setRemindedAt(due, new Date(Date.now() - 100 * HOUR))
  await runJob()
  expect(await reminded()).toEqual([u.ann])
})

it('reminds again every remindEvery hours while the task stays pending', async () => {
  const id = await startTask({ hours: 1, remindEvery: 3 }, 2 * HOUR)
  await runJob()
  await runJob()
  expect(await reminded()).toEqual([u.ann])
  // 2 hours on: not yet (the job's 1-hour candidate filter lets it through, the claim does not)
  await setRemindedAt(id, new Date(Date.now() - 2 * HOUR))
  await runJob()
  expect(await reminded()).toEqual([u.ann])
  await setRemindedAt(id, new Date(Date.now() - 3 * HOUR - MINUTE))
  await runJob()
  expect(await reminded()).toEqual([u.ann, u.ann])
  // handled: no more reminders
  await ds.query("UPDATE wf_task SET state = 'approved' WHERE id = ?", [id])
  await setRemindedAt(id, new Date(Date.now() - 10 * HOUR))
  await runJob()
  expect(await reminded()).toEqual([u.ann, u.ann])
})

it('a reminded task reassigned (改派) reminds its new holder, on the same due time', async () => {
  const id = await startTask({ hours: 1 }, 2 * HOUR)
  await runJob()
  expect(await reminded()).toEqual([u.ann])
  const [{ instance_id: inst, due_at: due }] = await ds.query(
    'SELECT instance_id, due_at FROM wf_task WHERE id = ?',
    [id],
  )
  await cls.run(() =>
    app.get(WfStore).act(Number(inst), async (run) => {
      const task = run.tasks.find((t) => t.id === id)!
      return reassign(run.ctx, run.inst, run.tasks, task, {
        actorId: u.init,
        to: u.ben,
        comment: null,
      })
    }),
  )
  expect(await remindedAt(id)).toBeNull()
  await runJob()
  await runJob()
  expect(await reminded()).toEqual([u.ann, u.ben])
  expect((await ds.query('SELECT due_at FROM wf_task WHERE id = ?', [id]))[0].due_at).toEqual(due)
})

describe('the claim (conditional UPDATE of reminded_at)', () => {
  const remindOne = (id: number, every: number | null) =>
    app.get(WfRemind).remindOne(id, every, new Date())

  it('of racing runs on one task, one wins', async () => {
    const once = await startTask({ hours: 1 }, 2 * HOUR)
    const again = await startTask({ hours: 1, remindEvery: 1 }, 2 * HOUR, u.ben)
    const races = await Promise.all([
      cls.run(() => remindOne(once, null)),
      cls.run(() => remindOne(once, null)),
      cls.run(() => remindOne(again, 1)),
      cls.run(() => remindOne(again, 1)),
    ])
    expect(races.filter(Boolean)).toHaveLength(2)
    expect((await reminded()).sort()).toEqual([u.ann, u.ben].sort())
  })

  it('a stale candidate loses: handled, or no longer due, since the job read it', async () => {
    const handled = await startTask({ hours: 1 }, 2 * HOUR)
    await ds.query("UPDATE wf_task SET state = 'approved' WHERE id = ?", [handled])
    const later = await startTask({ hours: 1 }, 2 * HOUR)
    await ds.query('UPDATE wf_task SET due_at = ? WHERE id = ?', [
      new Date(Date.now() + HOUR),
      later,
    ])
    expect(await cls.run(() => remindOne(handled, null))).toBe(false)
    expect(await cls.run(() => remindOne(later, null))).toBe(false)
    expect(await reminded()).toEqual([])
  })

  it('a failed send rolls the claim back: the next run reminds', async () => {
    const id = await startTask({ hours: 1 }, 2 * HOUR)
    const spy = vi.spyOn(app.get(WfNotify), 'overdue').mockRejectedValueOnce(new Error('boom'))
    try {
      await expect(runJob()).rejects.toThrow('boom')
    } finally {
      spy.mockRestore()
    }
    expect(await remindedAt(id)).toBeNull()
    await runJob()
    expect(await reminded()).toEqual([u.ann])
    expect(await remindedAt(id)).not.toBeNull()
  })
})
