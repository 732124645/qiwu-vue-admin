// 超时自动处理: the `wf.task.remind` job handles an overdue review task whose
// node has a `timeout.action` (autoPass / autoReject / toManager) once, under the instance lock, re-checked on
// the current rows; never silently: a system `timeout` event on the timeline (said in the reader's language,
// naming whose to-do it was) and `wf.task.timeout` to the initiator, the enabled process managers and the
// assignee of a handled task (who is not told it was "canceled"). A BizError while handling is recorded as
// `failed` (the assignee reminded, the others told); any other error rolls that one back for the next run.
// Instances start through WfStore at a chosen time (due_at = then + hours); WfRemind.remind runs directly.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type WfReviewNode, type WfStep } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { WfDecideService } from '../../src/modules/workflow/center/wf-decide.service.js'
import { WfRoutingService } from '../../src/modules/workflow/center/wf-routing.service.js'
import { reassign } from '../../src/modules/workflow/engine/lifecycle.js'
import { WfHandlers } from '../../src/modules/workflow/runtime/wf-handlers.js'
import { WfRemind } from '../../src/modules/workflow/runtime/wf-remind.js'
import { WfStore } from '../../src/modules/workflow/runtime/wf-store.js'
import { chain, fields, HOUR, review, users } from '../fixtures/wf/flow.js'
import { bearer, signIn } from '../setup/auth.js'

const PREFIX = 'e2e-wft-'
const MINUTE = 60_000
/** depts R ← P ← D (heads r, p, h) and X (no head) */
const DEPTS = ['R', 'P', 'D', 'X'] as const
/**
 * init (X, zh-CN) starts; ann, ben work in D; m1 (en-US) and m2 (disabled) are the process managers, m2
 * first; zed (disabled) is a step's only reviewer when a step must have nobody
 */
const WHO = ['init', 'ann', 'ben', 'h', 'p', 'r', 'm1', 'm2', 'zed'] as const
type Who = (typeof WHO)[number]

let app: NestExpressApplication
let ds: DataSource
let cls: ClsService
const u = {} as Record<Who, number>
const d = {} as Record<(typeof DEPTS)[number], number>
const tokens: Partial<Record<Who, string>> = {}
const nameOf = (id: number) => WHO.find((w) => u[w] === Number(id))
let seq = 0
let mark = 0

/** a review node of `who` whose timeout does `action` after `hours` */
const step = (
  id: string,
  who: Who,
  action?: NonNullable<WfReviewNode['timeout']>['action'],
  extra: Partial<WfReviewNode> = {},
) => review(id, { ...users(u[who]), timeout: { hours: 1, ...(action && { action }) }, ...extra })

/** starts `steps` as init `ago` ms before now (managers m2, m1); the instance id */
async function start(steps: WfStep[], ago = 2 * HOUR, managers = [u.m2, u.m1]): Promise<number> {
  const key = `${PREFIX}m${++seq}`
  const tree = { id: 'begin', type: 'begin', name: 'Begin', next: chain(...steps) }
  const m = await ds.query(
    "INSERT INTO wf_model (model_key, name, form_kind, manager_user_ids) VALUES (?, ?, 'dynamic', ?)",
    [key, key, JSON.stringify(managers)],
  )
  const v = await ds.query(
    'INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot) VALUES (?, ?, 1, ?, ?)',
    [m.insertId, key, JSON.stringify(tree), JSON.stringify({ fields })],
  )
  const input = {
    versionId: v.insertId,
    initiatorId: u.init,
    initiatorDeptId: d.X,
    businessKey: null,
    formValues: { amount: 1 },
    initiatorPicks: {},
    initiatorCtx: { deptTreePath: null, roleIds: [] },
  }
  const { inst } = await cls.run(() => app.get(WfStore).start(input, new Date(Date.now() - ago)))
  return inst.id
}

/** one run of the job; its output */
const runJob = () =>
  cls.run(() =>
    app.get(WfRemind).remind({}, { signal: new AbortController().signal, log: () => {} }),
  ) as Promise<string>
const decide = () => app.get(WfDecideService)
const routing = () => app.get(WfRoutingService)

interface Task {
  id: number
  nodeId: string
  who: Who | undefined
  state: string
  dueAt: Date | null
  remindedAt: Date | null
}
async function tasksOf(instanceId: number): Promise<Task[]> {
  const rows = await ds.query<(Omit<Task, 'who'> & { assigneeId: number })[]>(
    `SELECT id, node_id AS nodeId, assignee_id AS assigneeId, state, due_at AS dueAt,
            reminded_at AS remindedAt
       FROM wf_task WHERE instance_id = ? ORDER BY id`,
    [instanceId],
  )
  return rows.map(({ assigneeId, ...t }) => ({ ...t, id: Number(t.id), who: nameOf(assigneeId) }))
}
/** `who`'s pending task on the instance */
const pendingOf = async (instanceId: number, who: Who) =>
  (await tasksOf(instanceId)).find((t) => t.who === who && t.state === 'pending')!
/** the instance's `timeout` events: [whose task, outcome, targets] */
async function timeouts(instanceId: number) {
  const rows = await ds.query<
    { task: number; actor: number | null; targets: unknown[] | null; comment: string }[]
  >(
    `SELECT e.task_id AS task, e.actor_id AS actor, e.target_ids AS targets, e.comment
       FROM wf_event e WHERE e.instance_id = ? AND e.action = 'timeout' ORDER BY e.id`,
    [instanceId],
  )
  const tasks = await tasksOf(instanceId)
  return rows.map((e) => {
    expect(e.actor).toBeNull()
    const who = tasks.find((t) => t.id === Number(e.task))?.who
    const targets = (e.targets ?? []).map((t) => (typeof t === 'number' ? nameOf(t) : t))
    return [who, e.comment.replace('seed.wf.timeout.', ''), ...targets]
  })
}
const stateOf = async (instanceId: number) =>
  (await ds.query('SELECT state FROM wf_instance WHERE id = ?', [instanceId]))[0].state as string
/** moves the task's due time a minute into the past */
const expire = (taskId: number) =>
  ds.query('UPDATE wf_task SET due_at = ? WHERE id = ?', [new Date(Date.now() - MINUTE), taskId])

/** `who template` of the inbox rows written since `markNow`, sorted */
async function sent(): Promise<string[]> {
  const rows = await ds.query<{ user_id: number; template_code: string }[]>(
    'SELECT user_id, template_code FROM msg_inbox WHERE id > ? AND user_id IN (?) ORDER BY id',
    [mark, Object.values(u)],
  )
  return rows.map((r) => `${nameOf(r.user_id)} ${r.template_code}`).sort()
}
/** the bodies of `who`'s `template` inbox rows since `markNow` */
const bodies = async (who: Who, template: string) =>
  (
    await ds.query<{ body: string }[]>(
      'SELECT body FROM msg_inbox WHERE id > ? AND user_id = ? AND template_code = ? ORDER BY id',
      [mark, u[who], template],
    )
  ).map((r) => r.body)
async function markNow() {
  mark = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
}

const tokenOf = async (who: Who) => (tokens[who] ??= (await signIn(app, PREFIX + who)).accessToken)
/** GET as `who` (`Accept-Language: lang`); the envelope's data */
async function get(who: Who, url: string, lang = 'zh-CN') {
  const res = await request(app.getHttpServer())
    .get(`/api${url}`)
    .set({ ...bearer(await tokenOf(who)), 'Accept-Language': lang })
    .expect(200)
  return res.body.data
}
/** ids of `who`'s done list */
const doneOf = async (who: Who) =>
  ((await get(who, '/wf/tasks/done?pageSize=100')).items as { id: number }[]).map((t) => t.id)

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

async function dropOrg() {
  await ds.query('DELETE FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])
  await ds.query('DELETE FROM iam_dept WHERE name LIKE ?', [`${PREFIX}%`])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  cls = app.get(ClsService)
  await dropOrg()
  let path = '/'
  for (const name of DEPTS) {
    const parent = name === 'P' ? d.R : name === 'D' ? d.P : 0
    d[name] = await insertRow(ds.manager, 'iam_dept', {
      parent_id: parent,
      name: PREFIX + name,
      tree_path: '/',
    })
    path = name === 'X' ? `/${d.X}/` : `${path}${d[name]}/`
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [path, d[name]])
  }
  const deptOf: Partial<Record<Who, number>> = {
    init: d.X,
    ann: d.D,
    ben: d.D,
    h: d.D,
    p: d.P,
    r: d.R,
  }
  for (const who of WHO) {
    const en = who === 'm1' || who === 'ben'
    u[who] = await insertRow(ds.manager, 'iam_user', {
      username: PREFIX + who,
      display_name: who,
      dept_id: deptOf[who] ?? null,
      enabled: who === 'm2' || who === 'zed' ? 0 : 1,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
      locale: en ? 'en-US' : 'zh-CN',
      timezone: 'UTC',
    })
  }
  for (const [dept, head] of [
    ['R', 'r'],
    ['P', 'p'],
    ['D', 'h'],
  ] as const)
    await ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ?', [u[head], d[dept]])
  await cleanup()
})

beforeEach(markNow)

afterEach(async () => {
  vi.restoreAllMocks()
  await cleanup()
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    await dropOrg()
  }
  await app?.close()
})

it('leaves a task alone before its due time; a node without an action is only reminded', async () => {
  const early = await start([step('a', 'ann', 'autoPass')], 30 * MINUTE)
  const plain = await start([step('a', 'ben')])
  await markNow()
  await runJob()
  await runJob()
  expect(await timeouts(early)).toEqual([])
  expect(await timeouts(plain)).toEqual([])
  expect((await tasksOf(early)).map((t) => t.state)).toEqual(['pending'])
  expect((await tasksOf(plain)).map((t) => t.state)).toEqual(['pending'])
  expect(await sent()).toEqual(['ben wf.task.overdue'])
})

it('autoPass: approved for the assignee, said on the timeline, told to all but the disabled manager', async () => {
  const id = await start([step('a', 'ann', 'autoPass'), step('b', 'ben')])
  const a = await pendingOf(id, 'ann')
  await markNow()
  expect(await runJob()).toMatch(/timed out 1, timeout failed 0, errors 0 of/)
  expect((await tasksOf(id)).map((t) => [t.who, t.state])).toEqual([
    ['ann', 'approved'],
    ['ben', 'pending'],
  ])
  expect(await timeouts(id)).toEqual([['ann', 'autoPass']])
  // the assignee is told what the system did in their name, not that the to-do was canceled
  expect(await sent()).toEqual([
    'ann wf.task.timeout',
    'ben wf.task.assigned',
    'init wf.task.timeout',
    'm1 wf.task.timeout',
  ])
  const [zh] = await bodies('init', 'wf.task.timeout')
  expect(zh).toContain('由 ann 办理')
  expect(zh).toContain('超时未处理，系统已自动通过')
  const [en] = await bodies('m1', 'wf.task.timeout')
  expect(en).toContain('The to-do of ann')
  expect(en).toContain('Not handled in time; approved automatically')
  // an auto-passed approval is not taken back: no withdraw on the detail, 409 on the action
  expect((await get('ann', `/wf/instances/${id}`)).withdrawable).toBeNull()
  await expect(cls.run(() => routing().withdraw(a.id, u.ann, {}))).rejects.toMatchObject({
    err: { status: 409 },
  })
  // a user's comment that reads like the system's key stays as written
  const b = await pendingOf(id, 'ben')
  await cls.run(() => decide().approve(b.id, u.ben, { comment: 'seed.wf.timeout.autoPass' }))
  expect(await stateOf(id)).toBe('approved')
  const said = async (lang: string) =>
    (
      (await get('init', `/wf/instances/${id}`, lang)).timeline as {
        action: string
        actor: unknown
        comment: string | null
      }[]
    )
      .filter((e) => e.action === 'timeout' || e.action === 'approve')
      .map((e) => [e.action, e.actor === null, e.comment])
  expect(await said('zh-CN')).toEqual([
    ['timeout', true, 'ann 的待办：超时未处理，系统已自动通过'],
    ['approve', false, 'seed.wf.timeout.autoPass'],
  ])
  expect((await said('en-US'))[0]).toEqual([
    'timeout',
    true,
    "ann's to-do: Not handled in time; approved automatically",
  ])
  // only a timeout key is said so: another actorless event of the task (none written today) stays as is
  await ds.query(
    `INSERT INTO wf_event (instance_id, task_id, node_id, action, actor_id, comment, created_at)
     VALUES (?, ?, 'a', 'comment', NULL, 'hello', NOW())`,
    [id, a.id],
  )
  const timeline = (await get('init', `/wf/instances/${id}`)).timeline as { comment: string }[]
  expect(timeline.at(-1)!.comment).toBe('hello')
  // the done lists: not ann's (the system's), ben's own
  expect(await doneOf('ann')).not.toContain(a.id)
  expect(await doneOf('ben')).toContain(b.id)
})

it('autoReject (finish): the instance ends rejected, the assignee is told of the timeout only', async () => {
  const id = await start([step('a', 'ann', 'autoReject'), step('b', 'ben')])
  await markNow()
  await runJob()
  expect(await stateOf(id)).toBe('rejected')
  expect((await tasksOf(id)).map((t) => [t.who, t.state])).toEqual([['ann', 'rejected']])
  expect(await timeouts(id)).toEqual([['ann', 'autoReject']])
  expect(await sent()).toEqual([
    'ann wf.task.timeout',
    'init wf.instance.rejected',
    'init wf.task.timeout',
    'm1 wf.task.timeout',
  ])
  expect((await bodies('init', 'wf.task.timeout'))[0]).toContain('超时未处理，系统已自动驳回')
  expect(await doneOf('ann')).toEqual([])
})

it('toManager: up the dept chain to the root head, then a process manager, then remind only', async () => {
  const id = await start([step('a', 'ann', 'toManager')])
  const holder = async () => (await tasksOf(id)).find((t) => t.state === 'pending')!
  await markNow()
  // ann (a member of D) → D's head h, due one hour from now
  const before = Date.now()
  await runJob()
  const h = await holder()
  expect(h.who).toBe('h')
  expect(h.dueAt!.getTime()).toBeGreaterThanOrEqual(before + HOUR - 1000)
  expect(await sent()).toEqual([
    'ann wf.task.timeout',
    'h wf.task.assigned',
    'init wf.task.timeout',
    'm1 wf.task.timeout',
  ])
  expect((await bodies('m1', 'wf.task.timeout'))[0]).toContain(
    "transferred to the assignee's superior",
  )
  // not due yet: stays with h
  await runJob()
  expect((await holder()).id).toBe(h.id)
  // h heads D → P's head p → R's head r; r heads the root: a process manager (m2 disabled → m1)
  for (const next of ['p', 'r', 'm1'] as const) {
    await expire((await holder()).id)
    await runJob()
    expect((await holder()).who).toBe(next)
  }
  // m1 has no superior, the other manager is disabled, everyone else held it: remind only, once
  await markNow()
  await expire((await holder()).id)
  await runJob()
  await runJob()
  const last = await holder()
  expect(last.who).toBe('m1')
  expect(last.remindedAt).not.toBeNull()
  expect(await timeouts(id)).toEqual([
    ['ann', 'toManager', 'h'],
    ['h', 'toManager', 'p'],
    ['p', 'toManager', 'r'],
    ['r', 'toAdmin', 'm1'],
    ['m1', 'remindOnly'],
  ])
  // the assignee is reminded (not told twice as a manager), the initiator told
  expect(await sent()).toEqual(['init wf.task.timeout', 'm1 wf.task.overdue'])
  expect((await bodies('init', 'wf.task.timeout'))[0]).toContain('没有可以转交的人')
  // after a remind-only record the task is still m1's: approved, it is in m1's done list
  await cls.run(() => decide().approve(last.id, u.m1, {}))
  expect(await stateOf(id)).toBe('approved')
  expect(await doneOf('m1')).toEqual([last.id])
  for (const who of ['ann', 'h', 'p', 'r'] as const) expect(await doneOf(who)).toEqual([])
})

it('remind only: recorded once, by runs at once too; from then on reminded every remindEvery hours', async () => {
  // m1 has no dept and the model's only manager is disabled: nobody to hand it to
  const timeout = { hours: 1, remindEvery: 1, action: 'toManager' as const }
  const id = await start([step('a', 'm1', 'toManager', { timeout })], 2 * HOUR, [u.m2])
  await markNow()
  for (const out of await Promise.all([runJob(), runJob()])) expect(out).toMatch(/errors 0 of/)
  expect(await timeouts(id)).toEqual([['m1', 'remindOnly']])
  expect(await sent()).toEqual(['init wf.task.timeout', 'm1 wf.task.overdue'])
  const t = await pendingOf(id, 'm1')
  await ds.query('UPDATE wf_task SET reminded_at = ? WHERE id = ?', [
    new Date(Date.now() - HOUR - MINUTE),
    t.id,
  ])
  await runJob()
  expect(await timeouts(id)).toHaveLength(1)
  expect(await sent()).toEqual(['init wf.task.timeout', 'm1 wf.task.overdue', 'm1 wf.task.overdue'])
})

it('no loop: an auto-reject sends back past an auto-passed step, to the initiator, and stops', async () => {
  const id = await start([
    step('a', 'ann', 'autoPass'),
    step('b', 'ben', 'autoReject', { onReject: 'sendBack' }),
  ])
  await runJob()
  await expire((await pendingOf(id, 'ben')).id)
  await markNow()
  await runJob()
  const begin = await pendingOf(id, 'init')
  expect(begin.nodeId).toBe('begin')
  expect(begin.dueAt).toBeNull()
  for (let i = 0; i < 3; i++) await runJob()
  expect(await stateOf(id)).toBe('running')
  expect(await timeouts(id)).toEqual([
    ['ann', 'autoPass'],
    ['ben', 'autoReject', 'begin'],
  ])
  expect(await sent()).toEqual([
    'ben wf.task.timeout',
    'init wf.instance.sent_back',
    'init wf.task.timeout',
    'm1 wf.task.timeout',
  ])
})

it('a failed handling is recorded and told once; fixed and reassigned, it is handled when due again', async () => {
  // b's only reviewer is disabled and so is its fallback: the auto-pass cannot move on (WF_NO_ASSIGNEE)
  const nobody = review('b', { ...users(u.zed), whenNobody: 'toUser', fallbackUserId: u.zed })
  const id = await start([step('a', 'ann', 'autoPass'), nobody])
  const a = await pendingOf(id, 'ann')
  await markNow()
  expect(await runJob()).toMatch(/timed out 0, timeout failed 1, errors 0 of/)
  await runJob()
  const [still] = await tasksOf(id)
  expect([still!.state, still!.remindedAt === null]).toEqual(['pending', false])
  expect(await timeouts(id)).toEqual([['ann', 'failed']])
  expect(await sent()).toEqual([
    'ann wf.task.overdue',
    'init wf.task.timeout',
    'm1 wf.task.timeout',
  ])
  expect((await bodies('init', 'wf.task.timeout'))[0]).toContain('超时自动处理失败')
  await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ?', [u.zed])
  try {
    const before = Date.now()
    await cls.run(() =>
      app.get(WfStore).act(id, (run) => {
        const task = run.tasks.find((t) => t.id === a.id)!
        return reassign(run.ctx, run.inst, run.tasks, task, {
          actorId: u.m1,
          to: u.ben,
          comment: null,
        })
      }),
    )
    const moved = await pendingOf(id, 'ben')
    expect(moved.id).toBe(a.id)
    expect(moved.remindedAt).toBeNull()
    expect(moved.dueAt!.getTime()).toBeGreaterThanOrEqual(before + HOUR - 1000)
    await runJob()
    expect(await timeouts(id)).toHaveLength(1)
    await expire(a.id)
    await runJob()
    expect(await timeouts(id)).toEqual([
      ['ben', 'failed'],
      ['ben', 'autoPass'],
    ])
    expect((await tasksOf(id)).map((t) => [t.who, t.state])).toEqual([
      ['ben', 'approved'],
      ['zed', 'pending'],
    ])
  } finally {
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [u.zed])
  }
})

it('withdrawn after its due time, an approval is due again from now: not handled at the next run', async () => {
  const id = await start([step('a', 'ann', 'autoPass'), step('b', 'ben')], 0)
  const a = await pendingOf(id, 'ann')
  await cls.run(() => decide().approve(a.id, u.ann, {}))
  await expire(a.id)
  const before = Date.now()
  await cls.run(() => routing().withdraw(a.id, u.ann, {}))
  const back = await pendingOf(id, 'ann')
  expect(back.id).toBe(a.id)
  expect(back.dueAt!.getTime()).toBeGreaterThanOrEqual(before + HOUR - 1000)
  await runJob()
  expect(await timeouts(id)).toEqual([])
  expect((await pendingOf(id, 'ann')).remindedAt).toBeNull()
})

it('a manual transfer gives the new holder a fresh due time: not handled at the next run', async () => {
  const id = await start([step('a', 'ann', 'autoPass')])
  const a = await pendingOf(id, 'ann')
  await cls.run(() => routing().transfer(a.id, u.ann, { userId: u.ben }))
  await runJob()
  expect(await timeouts(id)).toEqual([])
  expect((await pendingOf(id, 'ben')).dueAt!.getTime()).toBeGreaterThan(Date.now())
})

it('a delegated or before-signed task and the child tasks are only reminded, as is the owner after', async () => {
  const delegated = await start([step('a', 'ann', 'autoPass')])
  const signed = await start([step('a', 'ben', 'autoPass')])
  const a = await pendingOf(delegated, 'ann')
  const b = await pendingOf(signed, 'ben')
  await cls.run(() => routing().delegate(a.id, u.ann, { userId: u.h }))
  await cls.run(() => routing().addSign(b.id, u.ben, { kind: 'before', userIds: [u.p] }))
  await expire((await pendingOf(signed, 'p')).id)
  await markNow()
  await runJob()
  expect(await sent()).toEqual(['h wf.task.overdue', 'p wf.task.overdue'])
  // the delegate approves: the owner's task is pending again, past due, but it had a child
  await cls.run(async () => decide().approve((await pendingOf(delegated, 'h')).id, u.h, {}))
  await markNow()
  await runJob()
  expect(await sent()).toEqual(['ann wf.task.overdue'])
  for (const id of [delegated, signed]) expect(await timeouts(id)).toEqual([])
  expect((await tasksOf(signed)).find((t) => t.id === b.id)!.state).toBe('waiting')
})

describe('races', () => {
  it('a user approving while the job runs: one of the two takes effect', async () => {
    const id = await start([step('a', 'ann', 'autoPass')])
    const a = await pendingOf(id, 'ann')
    const [user] = await Promise.all([
      cls
        .run(() => decide().approve(a.id, u.ann, {}))
        .then(
          () => 'ok',
          (e: { err?: { status: number } }) => e.err?.status,
        ),
      runJob(),
    ])
    const won = await ds.query<{ action: string }[]>(
      "SELECT action FROM wf_event WHERE task_id = ? AND action IN ('approve', 'timeout')",
      [a.id],
    )
    expect(won).toHaveLength(1)
    expect(user).toBe(won[0]!.action === 'approve' ? 'ok' : 409)
    expect(await stateOf(id)).toBe('approved')
  })

  it('a handling that lost to a user (409) records nothing: the task is re-checked under the lock', async () => {
    const id = await start([step('a', 'ann', 'autoPass')])
    const a = await pendingOf(id, 'ann')
    const remind = app.get(WfRemind) as unknown as { handle: () => Promise<unknown> }
    // the user's approval commits between the handling's read and its write
    vi.spyOn(remind, 'handle').mockImplementationOnce(async () => {
      await cls.run(() => decide().approve(a.id, u.ann, {}))
      throw new BizError(Err.CONFLICT)
    })
    expect(await runJob()).toMatch(/timed out 0, timeout failed 0, errors 0 of/)
    expect(await timeouts(id)).toEqual([])
    expect(await stateOf(id)).toBe('approved')
  })

  it('a handling that lost to a reassign (due anew) records nothing: the due time is re-checked too', async () => {
    const id = await start([step('a', 'ann', 'autoPass')])
    const a = await pendingOf(id, 'ann')
    const remind = app.get(WfRemind) as unknown as { handle: () => Promise<unknown> }
    vi.spyOn(remind, 'handle').mockImplementationOnce(async () => {
      await cls.run(() =>
        app.get(WfStore).act(id, (run) => {
          const task = run.tasks.find((t) => t.id === a.id)!
          return reassign(run.ctx, run.inst, run.tasks, task, {
            actorId: u.m1,
            to: u.ben,
            comment: null,
          })
        }),
      )
      throw new BizError(Err.CONFLICT)
    })
    expect(await runJob()).toMatch(/timed out 0, timeout failed 0, errors 0 of/)
    expect(await timeouts(id)).toEqual([])
    expect((await pendingOf(id, 'ben')).remindedAt).toBeNull()
  })

  it('a remind-only record whose reminder claim is lost is rolled back', async () => {
    const id = await start([step('a', 'm1', 'toManager')], 2 * HOUR, [u.m2])
    // another run took the claim (not possible under the instance lock: the rule backs it)
    vi.spyOn(app.get(WfRemind), 'remindOne').mockResolvedValue(false)
    expect(await runJob()).toMatch(/timed out 0, timeout failed 0, errors 1 of/)
    expect(await timeouts(id)).toEqual([])
  })

  it('two runs at once handle a task once', async () => {
    const id = await start([step('a', 'ann', 'autoPass')])
    await markNow()
    await Promise.all([runJob(), runJob()])
    expect(await timeouts(id)).toEqual([['ann', 'autoPass']])
    expect(await sent()).toEqual([
      'ann wf.task.timeout',
      'init wf.instance.approved',
      'init wf.task.timeout',
      'm1 wf.task.timeout',
    ])
  })
})

it('an error that is no BizError rolls that one back, the others go on, the next run retries', async () => {
  // eleven: one past the error lines of the output, whose counts come last and must not be clipped away
  const bad: number[] = []
  for (let i = 0; i < 11; i++) bad.push(await start([step('a', 'ann', 'autoPass')]))
  const good = await start([step('a', 'ben', 'autoPass')])
  const [{ key }] = await ds.query('SELECT model_key AS `key` FROM wf_instance WHERE id = ?', [
    good,
  ])
  const handlers = app.get(WfHandlers)
  const real = handlers.get.bind(handlers)
  const down = {
    onStateChange: () => Promise.reject(new Error(`handler down ${'x'.repeat(5000)}`)),
  }
  vi.spyOn(handlers, 'get').mockImplementation((k) =>
    k.startsWith(PREFIX) && k !== key ? (down as unknown as ReturnType<typeof real>) : real(k),
  )
  const lines: string[] = []
  const out = await cls.run(() =>
    app
      .get(WfRemind)
      .remind({}, { signal: new AbortController().signal, log: (l) => lines.push(l) }),
  )
  expect(out).toMatch(/timed out 1, timeout failed 0, errors 11 of/)
  expect(lines).toHaveLength(10)
  for (const line of lines) expect(line).toMatch(/^task \d+: handler down x{1,300}$/)
  expect(await stateOf(good)).toBe('approved')
  for (const id of bad) {
    expect(await stateOf(id)).toBe('running')
    expect(await timeouts(id)).toEqual([])
  }
  expect((await pendingOf(bad[0]!, 'ann')).remindedAt).toBeNull()
  vi.restoreAllMocks()
  await runJob()
  for (const id of bad) {
    expect(await stateOf(id)).toBe('approved')
    expect(await timeouts(id)).toEqual([['ann', 'autoPass']])
  }
})
