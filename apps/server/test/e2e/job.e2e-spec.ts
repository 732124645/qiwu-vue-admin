// Scheduler engine (the generated CRUD cases are scheduler-task /
// scheduler-run): the @JobHandler whitelist, cron jobs synced with task writes, run once (`-t registry`);
// single execution: task lock, fire-time dedupe, timeout abort (`-t lock`); retries, misfire at start and
// the built-in handlers, audit.purge over the log and record tables and deleted files (`-t retry`); the page extras beyond the
// generated CRUD: task detail (next fire times, latest runs), next-fire-times, run log delete / clean
// (`-t pages`).
// Test handlers are a provider of this spec's testing module; tasks are added through the API or straight
// into job_task, runs read from job_run.
import { setTimeout as sleep } from 'node:timers/promises'
import { Injectable } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { SchedulerRegistry } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AUDIT_RETENTION_PARAM, Err, runPerms, taskPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { clsGet } from '../../src/core/context/cls.js'
import { RedisLock } from '../../src/core/guard/redis-lock.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { JobHandler, type JobContext } from '../../src/core/scheduler/job-handler.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'
import { findId, insertRow, type Row } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-job-'
const URL = '/api/scheduler/tasks'

/** Handlers of this spec only (registered like any provider's). */
@Injectable()
class TestJobs {
  @JobHandler('test.whoami')
  whoami() {
    // a fire runs in its own CLS context, never in the request that scheduled or triggered it
    return `principal=${clsGet('principal')?.userId ?? 'none'}`
  }

  @JobHandler('test.strict', z.object({ days: z.number().int().min(1) }).strict())
  strict({ days }: { days: number }) {
    return `days=${days}`
  }

  /** runs of `test.block` / `test.stubborn` by key, in start order */
  readonly started: string[] = []
  readonly aborted: string[] = []
  private readonly gates = new Map<string, (() => void)[]>()

  /** Waits until `open(key)` (or its signal: then fails). */
  @JobHandler('test.block', z.object({ key: z.string() }))
  async block({ key }: { key: string }, { signal }: JobContext) {
    this.started.push(key)
    await new Promise<void>((resolve, reject) => {
      this.gates.set(key, [...(this.gates.get(key) ?? []), resolve])
      signal.addEventListener('abort', () => reject(signal.reason as Error))
    })
    return `opened ${key}`
  }

  open(key: string) {
    for (const resolve of this.gates.get(key) ?? []) resolve()
    this.gates.delete(key)
  }

  private readonly failures = new Map<string, number>()

  /** Fails its first `fail` runs (per key), then succeeds. */
  @JobHandler('test.flaky', z.object({ key: z.string(), fail: z.number().int() }))
  flaky({ key, fail }: { key: string; fail: number }, { log }: JobContext) {
    const n = (this.failures.get(key) ?? 0) + 1
    this.failures.set(key, n)
    log(`try ${n}`)
    if (n <= fail) throw new Error(`boom ${n}`)
    return 'recovered'
  }

  /** Ignores nothing but takes its time: after the abort it still needs `graceMs` to return. */
  @JobHandler('test.stubborn', z.object({ key: z.string(), graceMs: z.number().int() }))
  async stubborn({ key, graceMs }: { key: string; graceMs: number }, { signal }: JobContext) {
    this.started.push(key)
    await new Promise((resolve) => signal.addEventListener('abort', resolve))
    this.aborted.push(`${key}:${(signal.reason as Error).name}`)
    await sleep(graceMs)
  }
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let scheduler: JobScheduler
let jobs: TestJobs
const tokens: Record<'admin' | 'noRun' | 'plain', string> = { admin: '', noRun: '', plain: '' }
const userIds: number[] = []
let roleId: number
let lastTaskId = 0
let lastRunId = 0
let lastInboxId = 0
let seq = 0
const unique = () => `${PREFIX}${++seq}`

async function boot(): Promise<NestExpressApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    providers: [TestJobs],
  }).compile()
  const a = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await a.listen(0, '127.0.0.1')
  return a
}

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
  base = URL,
) => {
  const req = request(app.getHttpServer())[method](`${base}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const RUNS = '/api/scheduler/runs'
const runsCall = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'delete',
  path = '',
  body?: object,
) => call(who, method, path, body, RUNS)
const task = (over: object = {}) => ({
  name: unique(),
  handler: 'demo.echo',
  cron: '0 0 3 * * *',
  ...over,
})
const add = async (over: object = {}) =>
  (await call('admin', 'post', '', task(over)).expect(201)).body.data as { id: number }
/** A task row straight into the table (no sync: the scheduler sees it at its next start). */
const insertTask = (over: Row = {}) =>
  insertRow(ds.manager, 'job_task', {
    name: unique(),
    handler: 'demo.echo',
    cron: '0 0 3 * * *',
    ...over,
  })
interface RunRow {
  id: number
  attempt: number
  outcome: string
  output: string | null
  error: string | null
  task_name: string
  handler: string
}
const runsOf = (taskId: number): Promise<RunRow[]> =>
  ds.query(
    'SELECT id, attempt, outcome, output, error, task_name, handler FROM job_run WHERE task_id = ? AND deleted_at IS NULL ORDER BY id',
    [taskId],
  )
/** Polls until `check()` holds (handlers run in the background). */
async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('until: timed out')
    await sleep(20)
  }
}
const startedOf = (key: string) => jobs.started.filter((k) => k === key).length
/** Another instance starts (its misfire checks run), finishes what it started, stops. */
async function startOnce(): Promise<void> {
  const other = await boot()
  await other.get(JobScheduler).idle()
  await other.close()
}
/** Fire times of this spec: whole seconds far from now (cron fires never collide with them). */
let at = Date.UTC(2031, 0, 1)
const nextAt = () => (at += 1000)

/** Polls until the task has at least `n` runs (cron fires are asynchronous). */
async function waitRuns(taskId: number, n: number, ms = 5000): Promise<RunRow[]> {
  const until = Date.now() + ms
  for (;;) {
    const rows = await runsOf(taskId)
    if (rows.length >= n || Date.now() > until) return rows
    await sleep(50)
  }
}

beforeAll(async () => {
  app = await boot()
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  scheduler = app.get(JobScheduler)
  jobs = app.get(TestJobs)
  await cleanRedis(redis)
  lastTaskId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM job_task'))[0].n)
  lastRunId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM job_run'))[0].n)
  lastInboxId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
  // every task perm but `run`; browse + view of the run log
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}no-run`,
    name: `${PREFIX}no-run`,
    data_scope: 'all',
  })
  for (const perm of [
    taskPerms.browse,
    taskPerms.view,
    taskPerms.create,
    taskPerms.modify,
    runPerms.browse,
    runPerms.view,
  ])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      roleId,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
    ])
  const noRun = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}no-run`,
    display_name: 'no-run',
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  userIds.push(noRun)
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [noRun, roleId])
  tokens.admin = (await signIn(app)).accessToken
  tokens.noRun = (await signIn(app, `${PREFIX}no-run`)).accessToken
  const plain = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}plain`,
    display_name: 'plain',
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  userIds.push(plain)
  tokens.plain = (await signIn(app, `${PREFIX}plain`)).accessToken
})

afterAll(async () => {
  if (ds) {
    await scheduler.idle()
    await ds.query('DELETE FROM msg_inbox WHERE id > ? AND template_code = ?', [
      lastInboxId,
      'scheduler.job.timeout',
    ])
    await ds.query('DELETE FROM job_run WHERE id > ?', [lastRunId])
    await ds.query('DELETE FROM job_task WHERE id > ?', [lastTaskId])
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('registry', () => {
  it('lists the registered handlers with the params a new task starts with', async () => {
    const res = await call('admin', 'get', '/handlers').expect(200)
    const list = res.body.data as { name: string; defaultParams: string | null }[]
    const names = list.map((h) => h.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(names).toEqual(expect.arrayContaining(['demo.echo', 'test.strict', 'test.whoami']))
    expect(JSON.parse(list.find((h) => h.name === 'demo.echo')!.defaultParams!)).toEqual({
      message: 'hello',
      delayMs: 0,
    })
    expect(list.find((h) => h.name === 'test.whoami')!.defaultParams).toBeNull()
  })

  it('refuses a handler outside the whitelist (422), on create and on update', async () => {
    const before = Number((await ds.query('SELECT COUNT(*) AS n FROM job_task'))[0].n)
    const res = await call('admin', 'post', '', task({ handler: 'fs.rm' })).expect(422)
    expect(res.body.code).toBe(Err.SCHEDULER_HANDLER_UNKNOWN.code)
    expect(res.body.msg).toContain('fs.rm')
    expect(Number((await ds.query('SELECT COUNT(*) AS n FROM job_task'))[0].n)).toBe(before)
    const { id } = await add()
    await call('admin', 'put', `/${id}`, { handler: 'Function' }).expect(422)
    const [row] = await ds.query('SELECT handler FROM job_task WHERE id = ?', [id])
    expect(row.handler).toBe('demo.echo')
  })

  it("checks params against the handler's schema, also when only the handler changes", async () => {
    const bad = await call(
      'admin',
      'post',
      '',
      task({ handler: 'test.strict', params: '{"days":0}' }),
    )
      .set('Accept-Language', 'en-US')
      .expect(400)
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(['params.days'])
    await call(
      'admin',
      'post',
      '',
      task({ handler: 'test.strict', params: '{"days":1,"x":1}' }),
    ).expect(400)
    await call('admin', 'post', '', task({ params: '[1]' })).expect(400)
    const ok = await add({ handler: 'test.strict', params: '{"days": 30}' })
    const got = (await call('admin', 'get', `/${ok.id}`).expect(200)).body.data
    expect(JSON.parse(got.params)).toEqual({ days: 30 })
    // demo.echo's params don't fit test.strict
    const echo = await add({ params: '{"message":"hi"}' })
    await call('admin', 'put', `/${echo.id}`, { handler: 'test.strict' }).expect(400)
    await call('admin', 'put', `/${echo.id}`, {
      handler: 'test.strict',
      params: '{"days":7}',
    }).expect(200)
  })

  it('refuses a cron the cron library rejects (400 on cron)', async () => {
    const res = await call('admin', 'post', '', task({ cron: '0 0 25 * * *' }))
      .set('Accept-Language', 'en-US')
      .expect(400)
    expect(res.body.errors.map((e: { path: string }) => e.path)).toEqual(['cron'])
    await call('admin', 'post', '', task({ cron: '0 0 12 ? * MON' })).expect(400)
  })

  it('keeps the cron jobs in step with task writes: add, disable, enable, change, delete', async () => {
    const { id } = await add()
    expect(scheduler.isScheduled(id)).toBe(true)
    await call('admin', 'put', `/${id}/enabled`, { enabled: false }).expect(200)
    expect(scheduler.isScheduled(id)).toBe(false)
    await call('admin', 'put', `/${id}/enabled`, { enabled: true }).expect(200)
    expect(scheduler.isScheduled(id)).toBe(true)
    await call('admin', 'put', `/${id}`, { enabled: false, cron: '0 0 4 * * *' }).expect(200)
    expect(scheduler.isScheduled(id)).toBe(false)
    await call('admin', 'put', `/${id}`, { enabled: true }).expect(200)
    expect(scheduler.isScheduled(id)).toBe(true)
    await call('admin', 'delete', `/${id}`).expect(200)
    expect(scheduler.isScheduled(id)).toBe(false)
    const off = await add({ enabled: false })
    expect(scheduler.isScheduled(off.id)).toBe(false)
  })

  it('task writes reach every instance (job:sync): another scheduler follows add, change, disable, enable, delete', async () => {
    const other = await boot()
    try {
      const crons = other.get(SchedulerRegistry)
      const cronOf = (id: number) =>
        crons.doesExist('cron', `job_task:${id}`)
          ? String(crons.getCronJob(`job_task:${id}`).cronTime.source)
          : null
      const { id } = await add()
      await until(() => cronOf(id) === '0 0 3 * * *')
      await call('admin', 'put', `/${id}`, { cron: '0 30 4 * * *' }).expect(200)
      await until(() => cronOf(id) === '0 30 4 * * *')
      await call('admin', 'put', `/${id}/enabled`, { enabled: false }).expect(200)
      await until(() => cronOf(id) === null)
      await call('admin', 'put', `/${id}/enabled`, { enabled: true }).expect(200)
      await until(() => cronOf(id) === '0 30 4 * * *')
      await call('admin', 'delete', `/${id}`).expect(200)
      await until(() => cronOf(id) === null)
      // this instance kept in step too
      expect(scheduler.isScheduled(id)).toBe(false)
    } finally {
      await other.close()
    }
  })

  it('a tick of a stale schedule (the task re-timed or disabled, its broadcast missed) runs nothing and re-syncs', async () => {
    const crons = app.get(SchedulerRegistry)
    const id = await insertTask({ handler: 'test.whoami', cron: '0 0 3 * * *' })
    await scheduler.changed([id])
    // edited behind this instance's back (another instance whose message never arrived)
    await ds.query('UPDATE job_task SET cron = ? WHERE id = ?', ['0 15 3 * * *', id])
    await crons.getCronJob(`job_task:${id}`).fireOnTick()
    await scheduler.idle()
    expect(await runsOf(id)).toEqual([])
    expect(String(crons.getCronJob(`job_task:${id}`).cronTime.source)).toBe('0 15 3 * * *')
    await ds.query('UPDATE job_task SET enabled = 0 WHERE id = ?', [id])
    await crons.getCronJob(`job_task:${id}`).fireOnTick()
    await scheduler.idle()
    expect(await runsOf(id)).toEqual([])
    expect(scheduler.isScheduled(id)).toBe(false)
  })

  it('a missed job:sync heals at the next reconcile (every minute): new, re-timed, disabled tasks', async () => {
    const other = await boot()
    try {
      const s = other.get(JobScheduler)
      const reconcile = () => (s as unknown as { reconcile(): Promise<void> }).reconcile()
      const crons = other.get(SchedulerRegistry)
      // written behind the instance's back: no message
      const id = await insertTask({ cron: '0 0 5 * * *' })
      expect(s.isScheduled(id)).toBe(false)
      await reconcile()
      expect(String(crons.getCronJob(`job_task:${id}`).cronTime.source)).toBe('0 0 5 * * *')
      await ds.query('UPDATE job_task SET cron = ? WHERE id = ?', ['0 0 6 * * *', id])
      await reconcile()
      expect(String(crons.getCronJob(`job_task:${id}`).cronTime.source)).toBe('0 0 6 * * *')
      await ds.query('UPDATE job_task SET enabled = 0 WHERE id = ?', [id])
      await reconcile()
      expect(s.isScheduled(id)).toBe(false)
    } finally {
      await other.close()
    }
  })

  it('loads the enabled tasks at start', async () => {
    const on = await insertTask()
    const off = await insertTask({ enabled: 0 })
    const other = await boot()
    try {
      const s = other.get(JobScheduler)
      expect(s.isScheduled(on)).toBe(true)
      expect(s.isScheduled(off)).toBe(false)
    } finally {
      await other.close()
    }
  })

  it('fires by its cron, every second here, until disabled', async () => {
    const { id } = await add({ handler: 'test.whoami', cron: '* * * * * *' })
    const runs = await waitRuns(id, 2)
    expect(runs.slice(0, 2).map((r) => r.outcome)).toEqual(['ok', 'ok'])
    // scheduled during the request above, yet run without its principal
    expect(runs[0]!.output).toBe('principal=none')
    const [row] = await ds.query(
      'SELECT last_fire_at, updated_at, created_at FROM job_task WHERE id = ?',
      [id],
    )
    expect(row.last_fire_at).not.toBeNull()
    await call('admin', 'put', `/${id}/enabled`, { enabled: false }).expect(200)
    await scheduler.idle()
    const stopped = (await runsOf(id)).length
    await sleep(1500)
    expect((await runsOf(id)).length).toBe(stopped)
  })

  it('runs once on request with the stored params; `run` perm; unknown id 404', async () => {
    const { id } = await add({ enabled: false, params: '{"message":"once"}' })
    const res = await call('admin', 'post', `/${id}/run`).expect(200)
    expect(Date.parse(res.body.data.scheduledAt)).toBeLessThanOrEqual(Date.now())
    await scheduler.idle()
    const [run] = await runsOf(id)
    expect(run).toMatchObject({ attempt: 1, outcome: 'ok', output: 'once', handler: 'demo.echo' })
    expect(run!.task_name).toMatch(PREFIX)
    const who = await add({ enabled: false, handler: 'test.whoami' })
    await call('admin', 'post', `/${who.id}/run`).expect(200)
    await scheduler.idle()
    expect((await runsOf(who.id))[0]!.output).toBe('principal=none')
    await call('noRun', 'post', `/${id}/run`).expect(403)
    await call('admin', 'post', '/999999999/run').expect(404)
  })

  it('records a failed run when the stored handler or params no longer fit', async () => {
    const gone = await insertTask({ handler: 'test.removed', enabled: 0 })
    await call('admin', 'post', `/${gone}/run`).expect(200)
    const badParams = await insertTask({ handler: 'test.strict', params: { days: 0 }, enabled: 0 })
    await call('admin', 'post', `/${badParams}/run`).expect(200)
    await scheduler.idle()
    expect((await runsOf(gone))[0]).toMatchObject({
      outcome: 'failed',
      error: 'unknown handler test.removed',
    })
    expect((await runsOf(badParams))[0]).toMatchObject({
      outcome: 'failed',
      error: 'Error: params: days',
    })
  })
})

describe('lock', () => {
  it('timeout-notify: sends one localized inbox alert only to the root user', async () => {
    const [admin]: { id: number; locale: string | null; timezone: string | null }[] =
      await ds.query('SELECT id, locale, timezone FROM iam_user WHERE username = ?', ['admin'])
    const key = unique()
    // an admin-made name is shown as typed (seed keys are translated: notifier.e2e covers {i18n})
    const id = await insertTask({
      name: key,
      handler: 'test.block',
      params: { key },
      timeout_ms: 100,
    })
    const before = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
    await ds.query('UPDATE iam_user SET locale = ?, timezone = ? WHERE id = ?', [
      'en-US',
      'UTC',
      admin!.id,
    ])
    // a root link removed (soft) no longer makes its user a recipient
    await ds.query(
      "INSERT INTO iam_user_roles (user_id, role_id, deleted_at) SELECT ?, id, NOW(3) FROM iam_role WHERE code = 'root' AND deleted_at IS NULL",
      [userIds[1]],
    )
    const fire = scheduler.fire(id, nextAt(), 'manual')
    try {
      await fire
      const [run] = await ds.query<{ outcome: string; started_at: Date }[]>(
        'SELECT outcome, started_at FROM job_run WHERE task_id = ?',
        [id],
      )
      expect(run?.outcome).toBe('timeout')
      const rows = await ds.query<
        {
          user_id: number
          template_code: string
          locale: string
          title: string
          body: string
          params: Record<string, unknown>
        }[]
      >(
        'SELECT user_id, template_code, locale, title, body, params FROM msg_inbox WHERE id > ? AND template_code = ? ORDER BY id',
        [before, 'scheduler.job.timeout'],
      )
      expect(rows).toHaveLength(1)
      expect(Number(rows[0]!.user_id)).toBe(Number(admin!.id))
      expect(rows[0]).toMatchObject({
        template_code: 'scheduler.job.timeout',
        locale: 'en-US',
        title: `Job timed out: ${key}`,
        body: `Handler: test.block\nTimeout: 100 ms\nStarted: ${run!.started_at.toISOString().slice(0, 16).replace('T', ' ')}\nAttempt: 1`,
        params: {
          task: { i18n: key },
          handler: 'test.block',
          timeoutMs: 100,
          startedAt: { datetime: run!.started_at.toISOString() },
          attempt: 1,
        },
      })
      expect(rows.some((row) => Number(row.user_id) === userIds[1])).toBe(false)
    } finally {
      jobs.open(key)
      await fire
      await ds.query('DELETE FROM msg_inbox WHERE id > ? AND template_code = ?', [
        before,
        'scheduler.job.timeout',
      ])
      await ds.query('DELETE FROM job_run WHERE task_id = ?', [id])
      await ds.query('DELETE FROM job_task WHERE id = ?', [id])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [userIds[1]])
      await ds.query('UPDATE iam_user SET locale = ?, timezone = ? WHERE id = ?', [
        admin!.locale,
        admin!.timezone,
        admin!.id,
      ])
    }
  })

  it('allow_overlap=0: a fire while the previous runs is skipped; the same fire time runs once', async () => {
    const key = unique()
    const id = await insertTask({ handler: 'test.block', params: { key } })
    const t1 = nextAt()
    const first = scheduler.fire(id, t1, 'cron')
    await until(() => startedOf(key) === 1)
    // the same fire time again (a duplicate tick, another instance): nothing at all
    await scheduler.fire(id, t1, 'cron')
    // a later fire time while t1 still runs: recorded as skipped, not run
    await scheduler.fire(id, nextAt(), 'cron')
    // a manual run is a fire too
    await call('admin', 'post', `/${id}/run`).expect(200)
    await until(async () => (await runsOf(id)).length === 2)
    expect(startedOf(key)).toBe(1)
    expect(await redis.exists(redisKey('jobLock', id))).toBe(1)
    jobs.open(key)
    await first
    await scheduler.idle()
    expect((await runsOf(id)).map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'ok'])
    expect((await runsOf(id))[0]!.output).toMatch(/task lock/)
    // released: the next fire runs again
    expect(await redis.exists(redisKey('jobLock', id))).toBe(0)
    const again = scheduler.fire(id, nextAt(), 'cron')
    await until(() => startedOf(key) === 2)
    jobs.open(key)
    await again
    expect((await runsOf(id)).map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'ok', 'ok'])
    // the fire-time key outlives duplicate ticks for a few minutes only
    const ttl = await redis.pTTL(redisKey('jobFire', id, t1))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(5 * 60_000)
  })

  it('timeout: the handler is aborted, the run recorded as timeout; no overlap until it really returned', async () => {
    const key = unique()
    const id = await insertTask({
      handler: 'test.stubborn',
      params: { key, graceMs: 700 },
      timeout_ms: 200,
    })
    const first = scheduler.fire(id, nextAt(), 'cron')
    await until(async () => (await runsOf(id)).length === 1)
    const [timedOut] = await runsOf(id)
    expect(timedOut).toMatchObject({ outcome: 'timeout', error: 'timed out after 200 ms' })
    expect(jobs.aborted).toContain(`${key}:JobTimeoutError`)
    // aborted but still busy: the lock is held, the next fire does not overlap it
    await scheduler.fire(id, nextAt(), 'cron')
    expect(startedOf(key)).toBe(1)
    expect((await runsOf(id)).map((r) => r.outcome)).toEqual(['timeout', 'skipped'])
    await first
    expect(await redis.exists(redisKey('jobLock', id))).toBe(0)
    // returned: the next fire runs (and times out again)
    await scheduler.fire(id, nextAt(), 'cron')
    expect(startedOf(key)).toBe(2)
    expect((await runsOf(id)).map((r) => r.outcome)).toEqual(['timeout', 'skipped', 'timeout'])
    const [row] = await ds.query('SELECT cost_ms FROM job_run WHERE id = ?', [timedOut!.id])
    expect(row.cost_ms).toBeGreaterThanOrEqual(190)
    expect(row.cost_ms).toBeLessThan(700)
  })

  it('allow_overlap=1: the next fire runs while the previous still runs; one fire time runs once', async () => {
    const key = unique()
    const id = await insertTask({
      handler: 'test.block',
      params: { key },
      allow_overlap: 1,
    })
    const t1 = nextAt()
    const fires = [scheduler.fire(id, t1, 'cron'), scheduler.fire(id, nextAt(), 'cron')]
    await until(() => startedOf(key) === 2)
    // the same fire time again: nothing
    await scheduler.fire(id, t1, 'cron')
    expect(await redis.exists(redisKey('jobLock', id))).toBe(0)
    jobs.open(key)
    await Promise.all(fires)
    await scheduler.idle()
    expect(startedOf(key)).toBe(2)
    expect((await runsOf(id)).map((r) => r.outcome)).toEqual(['ok', 'ok'])
  })

  it('a lost task lock (renewal not confirmed) aborts the handler, records it failed, no retry', async () => {
    const key = unique()
    const id = await insertTask({
      handler: 'test.block',
      params: { key },
      retry_max: 2,
      retry_delay_ms: 0,
    })
    // a short lock ttl (renewed every 100 ms) instead of 30 s
    const locks = (scheduler as unknown as { locks: RedisLock }).locks
    const acquire = locks.acquire.bind(locks)
    const short = vi.spyOn(locks, 'acquire').mockImplementation((k) => acquire(k, 300))
    const evalOf = redis.eval.bind(redis)
    const renew = vi.spyOn(redis, 'eval')
    try {
      const fire = scheduler.fire(id, nextAt(), 'cron')
      await until(() => startedOf(key) === 1)
      // Redis stops confirming the renewals of this lock
      renew.mockImplementation(((script: string, opts: never) =>
        script.includes('PEXPIRE')
          ? Promise.reject(new Error('connection lost'))
          : evalOf(script, opts)) as never)
      await fire
    } finally {
      renew.mockRestore()
      short.mockRestore()
    }
    const runs = await runsOf(id)
    expect(runs.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'failed']])
    expect(runs[0]!.error).toMatch(/^LockLostError: lock .*job:lock:.* lost: renewal failed$/)
    // aborted, not left running; not retried
    expect(startedOf(key)).toBe(1)

    // a handler slow to stop, past its timeout: still recorded as the lost lock, when it was lost
    const slow = unique()
    const stubborn = await insertTask({
      handler: 'test.stubborn',
      params: { key: slow, graceMs: 600 },
      timeout_ms: 400,
      retry_max: 1,
      retry_delay_ms: 0,
    })
    const short2 = vi.spyOn(locks, 'acquire').mockImplementation((k) => acquire(k, 300))
    const renew2 = vi
      .spyOn(redis, 'eval')
      .mockImplementation(((script: string, opts: never) =>
        script.includes('PEXPIRE')
          ? Promise.reject(new Error('connection lost'))
          : evalOf(script, opts)) as never)
    try {
      await scheduler.fire(stubborn, nextAt(), 'cron')
    } finally {
      renew2.mockRestore()
      short2.mockRestore()
    }
    const lostRuns = await runsOf(stubborn)
    expect(lostRuns.map((r) => [r.attempt, r.outcome])).toEqual([[1, 'failed']])
    expect(lostRuns[0]!.error).toMatch(/^LockLostError: /)
    expect(jobs.aborted).toContain(`${slow}:LockLostError`)
    const [cost] = await ds.query('SELECT cost_ms FROM job_run WHERE id = ?', [lostRuns[0]!.id])
    expect(cost.cost_ms).toBeLessThan(400)
  })

  it('shutdown aborts a running handler and records it', async () => {
    const key = unique()
    const id = await insertTask({ handler: 'test.block', params: { key } })
    const other = await boot()
    const s = other.get(JobScheduler)
    const otherJobs = other.get(TestJobs)
    void s.fire(id, nextAt(), 'cron')
    await until(() => otherJobs.started.includes(key))
    await other.close()
    const [run] = await runsOf(id)
    expect(run).toMatchObject({ outcome: 'failed', error: 'Error: shutdown' })
  })
})

describe('retry', () => {
  it('a failing handler is retried retry_max times: 2 retries → 3 runs, retry_delay_ms apart', async () => {
    const key = unique()
    const id = await insertTask({
      handler: 'test.flaky',
      params: { key, fail: 99 },
      retry_max: 2,
      retry_delay_ms: 150,
    })
    await scheduler.fire(id, nextAt(), 'cron')
    const runs = await runsOf(id)
    expect(runs.map((r) => [r.attempt, r.outcome, r.error])).toEqual([
      [1, 'failed', 'Error: boom 1'],
      [2, 'failed', 'Error: boom 2'],
      [3, 'failed', 'Error: boom 3'],
    ])
    expect(runs[2]!.output).toBe('try 3')
    const times: { started_at: Date }[] = await ds.query(
      'SELECT started_at FROM job_run WHERE task_id = ? ORDER BY id',
      [id],
    )
    for (let i = 1; i < times.length; i++)
      expect(
        times[i]!.started_at.getTime() - times[i - 1]!.started_at.getTime(),
      ).toBeGreaterThanOrEqual(145)
  })

  it('stops retrying at the first success; a timeout is retried too', async () => {
    const key = unique()
    const flaky = await insertTask({
      handler: 'test.flaky',
      params: { key, fail: 1 },
      retry_max: 3,
      retry_delay_ms: 0,
    })
    await scheduler.fire(flaky, nextAt(), 'cron')
    expect((await runsOf(flaky)).map((r) => [r.attempt, r.outcome, r.output])).toEqual([
      [1, 'failed', 'try 1'],
      [2, 'ok', 'try 2\nrecovered'],
    ])
    const slow = await insertTask({
      handler: 'test.stubborn',
      params: { key: unique(), graceMs: 0 },
      timeout_ms: 100,
      retry_max: 1,
      retry_delay_ms: 0,
    })
    await scheduler.fire(slow, nextAt(), 'cron')
    expect((await runsOf(slow)).map((r) => [r.attempt, r.outcome])).toEqual([
      [1, 'timeout'],
      [2, 'timeout'],
    ])
    // a handler that cannot run (params no longer fit) is not retried
    const broken = await insertTask({ handler: 'test.strict', params: { days: 0 }, retry_max: 3 })
    await scheduler.fire(broken, nextAt(), 'cron')
    expect((await runsOf(broken)).map((r) => r.outcome)).toEqual(['failed'])
  })

  it('misfire run_once: a fire missed while down runs once at the next start, not again after', async () => {
    const yearsAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 3, 5, 1))
    const id = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: yearsAgo,
      created_at: yearsAgo,
      updated_at: yearsAgo,
    })
    const skip = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'skip',
      last_fire_at: yearsAgo,
      updated_at: yearsAgo,
    })
    // disabled or edited since the last miss: nothing to make up
    const off = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: yearsAgo,
      updated_at: yearsAgo,
      enabled: 0,
    })
    const edited = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: yearsAgo,
    })
    await startOnce()
    // three yearly fires missed: one catch-up run, with the missed time as its fire time
    expect((await runsOf(id)).map((r) => [r.attempt, r.outcome, r.output])).toEqual([
      [1, 'ok', 'principal=none'],
    ])
    const firstMissed = Date.parse(`${yearsAgo.getUTCFullYear() + 1}-01-01T00:00:00`)
    expect(await redis.get(redisKey('jobFire', id, firstMissed))).toBe('misfire')
    const [row] = await ds.query(
      'SELECT last_fire_at, misfire_pending_at FROM job_task WHERE id = ?',
      [id],
    )
    expect(Date.now() - row.last_fire_at.getTime()).toBeLessThan(60_000)
    expect(row.misfire_pending_at).toBeNull()
    const skipped = await runsOf(skip)
    expect(skipped.map((r) => r.outcome)).toEqual(['skipped'])
    expect(skipped[0]!.output).toMatch(/missed the fire at .* \(misfire: skip\)/)
    expect(await runsOf(off)).toEqual([])
    expect(await runsOf(edited)).toEqual([])
    // the gap is made up once: the next start finds nothing missed
    await startOnce()
    expect(await runsOf(id)).toHaveLength(1)
    expect(await runsOf(skip)).toHaveLength(1)
  })

  it('misfire run_once: a catch-up claimed but not run before a crash runs at the next start, once', async () => {
    const yearsAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 5, 1))
    const id = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: yearsAgo,
      created_at: yearsAgo,
      updated_at: yearsAgo,
    })
    // the first start claims the catch-up and dies before running it
    const crash = vi.spyOn(JobScheduler.prototype, 'fire').mockResolvedValue(undefined)
    try {
      await (await boot()).close()
    } finally {
      crash.mockRestore()
    }
    expect(await runsOf(id)).toEqual([])
    const pendingOf = async () =>
      (
        await ds.query('SELECT last_fire_at, misfire_pending_at FROM job_task WHERE id = ?', [id])
      )[0] as { last_fire_at: Date; misfire_pending_at: Date | null }
    const claimed = await pendingOf()
    // persisted with the claim: the missed fire time; last_fire_at already moved on
    expect(claimed.misfire_pending_at?.getTime()).toBe(
      Date.parse(`${yearsAgo.getUTCFullYear() + 1}-01-01T00:00:00`),
    )
    expect(Date.now() - claimed.last_fire_at.getTime()).toBeLessThan(60_000)
    await startOnce()
    expect((await runsOf(id)).map((r) => [r.attempt, r.outcome, r.output])).toEqual([
      [1, 'ok', 'principal=none'],
    ])
    expect((await pendingOf()).misfire_pending_at).toBeNull()
    await startOnce()
    expect(await runsOf(id)).toHaveLength(1)
  })

  it('misfire run_once: a pending catch-up waits while the task lock is busy (allow_overlap=0)', async () => {
    const missed = Date.UTC(new Date().getUTCFullYear() - 1, 0, 1)
    const id = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: new Date(),
      misfire_pending_at: new Date(missed),
      updated_at: new Date(missed - 1000),
    })
    // another instance runs the task right now
    await redis.set(redisKey('jobLock', id), 'another-instance', {
      expiration: { type: 'PX', value: 60_000 },
    })
    try {
      await startOnce()
      expect(await runsOf(id)).toEqual([])
      const [kept] = await ds.query('SELECT misfire_pending_at FROM job_task WHERE id = ?', [id])
      expect(kept.misfire_pending_at?.getTime()).toBe(missed)
    } finally {
      await redis.del(redisKey('jobLock', id))
    }
    await startOnce()
    expect((await runsOf(id)).map((r) => r.outcome)).toEqual(['ok'])
    const [row] = await ds.query('SELECT misfire_pending_at FROM job_task WHERE id = ?', [id])
    expect(row.misfire_pending_at).toBeNull()
  })

  it('misfire run_once: a fire time that ran as a regular fire meanwhile (another instance) is not made up', async () => {
    const missed = Date.UTC(new Date().getUTCFullYear() - 1, 0, 1)
    const id = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      allow_overlap: 1,
      last_fire_at: new Date(),
      misfire_pending_at: new Date(missed),
      updated_at: new Date(missed - 1000),
    })
    await redis.set(redisKey('jobFire', id, missed), 'cron', {
      expiration: { type: 'PX', value: 60_000 },
    })
    await startOnce()
    expect(await runsOf(id)).toEqual([])
    const [row] = await ds.query('SELECT misfire_pending_at FROM job_task WHERE id = ?', [id])
    expect(row.misfire_pending_at).toBeNull()
  })

  it('misfire run_once: an edit racing the start of the catch-up wins (nothing runs)', async () => {
    const missed = Date.UTC(new Date().getUTCFullYear() - 1, 0, 1)
    const id = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: new Date(),
      misfire_pending_at: new Date(missed),
      updated_at: new Date(missed - 1000),
    })
    // the task is edited while the catch-up takes the task lock, after it read the task
    const acquire = RedisLock.prototype.acquire
    const racing = vi.spyOn(RedisLock.prototype, 'acquire').mockImplementation(async function (
      this: RedisLock,
      key: string,
      ttl: number,
    ) {
      if (key === redisKey('jobLock', id))
        await ds.query('UPDATE job_task SET note = ? WHERE id = ?', ['edited meanwhile', id])
      return acquire.call(this, key, ttl)
    })
    try {
      await startOnce()
    } finally {
      racing.mockRestore()
    }
    expect(await runsOf(id)).toEqual([])
  })

  it('misfire run_once: an edit of the task after the claim drops the pending catch-up', async () => {
    const yearsAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 2, 5, 1))
    const id = await insertTask({
      handler: 'test.whoami',
      cron: '0 0 0 1 1 *',
      misfire: 'run_once',
      last_fire_at: new Date(),
      misfire_pending_at: yearsAgo,
      updated_at: new Date(yearsAgo.getTime() + 1000),
    })
    await startOnce()
    expect(await runsOf(id)).toEqual([])
    const [row] = await ds.query('SELECT misfire_pending_at FROM job_task WHERE id = ?', [id])
    expect(row.misfire_pending_at).toBeNull()
  })

  it('built-in tasks are seeded by name key, with test-only dispatch disabled', async () => {
    const rows: { name: string; handler: string; enabled: number; group_code: string }[] =
      await ds.query(
        "SELECT name, handler, enabled, group_code FROM job_task WHERE name LIKE 'seed.task.%' ORDER BY id",
      )
    expect(rows.map((r) => [r.name, r.handler, r.enabled])).toEqual([
      ['seed.task.auditPurge', 'audit.purge', 1],
      ['seed.task.sessionSweep', 'session.sweep', 1],
      ['seed.task.notifyDispatch', 'notify.dispatch', 0],
      ['seed.task.demoEcho', 'demo.echo', 0],
      // the workflow seed's (超时提醒), off in test runs like dispatch
      ['seed.task.wfTaskRemind', 'wf.task.remind', 0],
    ])
    const echo = await findId(ds.manager, 'job_task', { name: 'seed.task.demoEcho' })
    await call('admin', 'post', `/${echo}/run`).expect(200)
    const dispatch = await findId(ds.manager, 'job_task', { name: 'seed.task.notifyDispatch' })
    await call('admin', 'post', `/${dispatch}/run`).expect(200)
    await scheduler.idle()
    expect((await runsOf(echo!)).at(-1)).toMatchObject({ outcome: 'ok', output: 'hello' })
    expect((await runsOf(dispatch!)).at(-1)).toMatchObject({ outcome: 'ok' })
  })

  it('session.sweep drops ended sessions from the online indexes', async () => {
    const now = Date.now()
    await redis.zAdd(redisKey('authOnline'), [
      { score: now - 1000, value: `${PREFIX}ended` },
      { score: now + 3_600_000, value: `${PREFIX}live` },
    ])
    await redis.zAdd(redisKey('authSeen'), [
      { score: now - 31 * 86_400_000, value: `${PREFIX}ancient` },
      { score: now - 8 * 86_400_000, value: `${PREFIX}third-party` },
      { score: now, value: `${PREFIX}live` },
    ])
    const id = await findId(ds.manager, 'job_task', { name: 'seed.task.sessionSweep' })
    await call('admin', 'post', `/${id}/run`).expect(200)
    await scheduler.idle()
    expect((await runsOf(id!)).at(-1)).toMatchObject({ outcome: 'ok', output: 'removed 2' })
    expect(await redis.zRange(redisKey('authOnline'), 0, -1)).not.toContain(`${PREFIX}ended`)
    expect(await redis.zScore(redisKey('authOnline'), `${PREFIX}live`)).not.toBeNull()
    expect(await redis.zScore(redisKey('authSeen'), `${PREFIX}ancient`)).toBeNull()
    expect(await redis.zScore(redisKey('authSeen'), `${PREFIX}third-party`)).not.toBeNull()
    expect(await redis.zScore(redisKey('authSeen'), `${PREFIX}live`)).not.toBeNull()
  })

  it('audit.purge deletes for good what is older than audit.retention_days, soft-deleted or not, and the files deleted before then', async () => {
    const params = app.get(ParamService)
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      '30',
      AUDIT_RETENTION_PARAM,
    ])
    await params.invalidate(AUDIT_RETENTION_PARAM)
    const old = new Date(Date.now() - 31 * 86_400_000)
    const fresh = new Date(Date.now() - 29 * 86_400_000)
    const now = new Date()
    const tag = unique()
    const ids: Record<string, number[]> = {}
    const add = async (table: string, row: Row) =>
      (ids[table] = [...(ids[table] ?? []), await insertRow(ds.manager, table, row)])
    // a row of each table at a time: the old ones go whether deleted (soft) already or not
    const rows: Record<string, (at: Date) => Row> = {
      aud_action_log: (at) => ({
        domain: tag,
        verb: 'modify',
        http_method: 'PUT',
        url: '/x',
        ok: 1,
        cost_ms: 1,
        created_at: at,
      }),
      aud_signin_log: (at) => ({
        kind: 'password',
        username: tag,
        client_id: 'console',
        ok: 1,
        msg_key: 'signin.ok',
        created_at: at,
      }),
      aud_http_trace: (at) => ({
        method: 'GET',
        url: '/x',
        status_code: 200,
        biz_code: '0',
        cost_ms: 1,
        started_at: at,
      }),
      job_run: (at) => ({
        task_id: 0,
        task_name: tag,
        handler: 'demo.echo',
        outcome: 'ok',
        started_at: at,
      }),
      msg_inbox: (at) => ({
        user_id: userIds[1],
        template_code: tag,
        locale: 'en-US',
        category: 'system',
        title: tag,
        body: 'x',
        status: 'delivered',
        created_at: at,
      }),
      msg_mail_record: (at) => ({
        to_list: ['x@example.com'],
        template_code: tag,
        locale: 'en-US',
        subject: tag,
        body: 'x',
        status: 'sent',
        created_at: at,
      }),
      msg_sms_record: (at) => ({ template_code: tag, body: 'x', status: 'sent', created_at: at }),
      msg_sms_otp: (at) => ({
        mobile: '13800000000',
        scene: 'signin',
        code: '123456',
        daily_seq: 1,
        request_ip: '127.0.0.1',
        created_at: at,
      }),
    }
    for (const [table, row] of Object.entries(rows))
      for (const [at, deleted] of [
        [old, null],
        [old, now],
        [fresh, null],
        [fresh, now],
      ] as const)
        await add(table, { ...row(at), deleted_at: deleted })
    for (const at of [old, fresh]) {
      for (const state of ['open', 'resolved', 'ignored'])
        await add('aud_http_fault', {
          method: 'GET',
          url: '/x',
          error_name: tag,
          state,
          created_at: at,
        })
      // a deleted open one: handled for this purpose
      await add('aud_http_fault', {
        method: 'GET',
        url: '/x',
        error_name: tag,
        state: 'open',
        created_at: at,
        deleted_at: now,
      })
    }
    // files: by when they were deleted, never while live (no body here: a missing one counts as gone)
    const [{ id: storageId }] = await ds.query(
      'SELECT id FROM fs_storage WHERE is_primary = 1 AND deleted_at IS NULL',
    )
    for (const [key, times] of Object.entries({
      live: { created_at: old },
      gone: { deleted_at: old },
      recent: { created_at: old, deleted_at: fresh },
    }))
      await add('fs_object', {
        storage_id: storageId,
        object_key: `${tag}/${key}.txt`,
        original_name: 'x.txt',
        mime: 'text/plain',
        size: 1,
        biz_tag: 'attachment',
        uploader_id: userIds[1],
        ...times,
      })
    try {
      const id = await findId(ds.manager, 'job_task', { name: 'seed.task.auditPurge' })
      await call('admin', 'post', `/${id}/run`).expect(200)
      await scheduler.idle()
      const run = (await runsOf(id!)).at(-1)!
      expect(run.outcome).toBe('ok')
      expect(run.output).toMatch(
        /^aud_action_log: \d+\naud_signin_log: \d+\naud_http_trace: \d+\naud_http_fault: \d+\njob_run: \d+\nmsg_inbox: \d+\nmsg_mail_record: \d+\nmsg_sms_record: \d+\nmsg_sms_otp: \d+\nfs_object: [1-9]\d*\nkept 30 days/,
      )
      const left = async (table: string) =>
        (await ds.query(`SELECT id FROM ${table} WHERE id IN (?) ORDER BY id`, [ids[table]])) // arch-allow: sql-concat table names of this spec qw:include-deleted
          .map((r: { id: number }) => Number(r.id))
      for (const table of Object.keys(rows)) expect(await left(table)).toEqual(ids[table]!.slice(2))
      // faults: the old open one stays (only handled or deleted ones go), the fresh four stay
      const [oldOpen, , , , ...freshFaults] = ids.aud_http_fault!
      expect(await left('aud_http_fault')).toEqual([oldOpen, ...freshFaults])
      // files: the live one and the one deleted since stay
      const [live, , recent] = ids.fs_object!
      expect(await left('fs_object')).toEqual([live, recent])
    } finally {
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
        '180',
        AUDIT_RETENTION_PARAM,
      ])
      await params.invalidate(AUDIT_RETENTION_PARAM)
      for (const [table, list] of Object.entries(ids))
        await ds.query(`DELETE FROM ${table} WHERE id IN (?)`, [list]) // arch-allow: sql-concat table names of this spec
    }
  })
})

describe('pages', () => {
  it('task detail: the task, its next 5 fire times, its latest 10 runs newest first', async () => {
    const { id } = await add({ cron: '0 15 3 * * *', enabled: false })
    const other = await add()
    const runIds: number[] = []
    for (let i = 0; i < 12; i++)
      runIds.push(
        await insertRow(ds.manager, 'job_run', {
          task_id: id,
          task_name: 'x',
          handler: 'demo.echo',
          outcome: i % 2 ? 'ok' : 'failed',
        }),
      )
    await insertRow(ds.manager, 'job_run', {
      task_id: other.id,
      task_name: 'y',
      handler: 'demo.echo',
      outcome: 'ok',
    })
    const got = (await call('admin', 'get', `/${id}`).expect(200)).body.data
    expect(got.recentRuns.map((r: { id: number }) => r.id)).toEqual(runIds.slice(2).reverse())
    expect(got.recentRuns[0]).toMatchObject({ taskId: id, outcome: 'ok', handler: 'demo.echo' })
    // disabled: still when it would fire; daily at 03:15:00 (server time)
    const times = got.nextFireTimes.map((t: string) => new Date(t))
    expect(times).toHaveLength(5)
    expect(times[0].getTime()).toBeGreaterThan(Date.now())
    for (const [i, t] of times.entries()) {
      expect([t.getHours(), t.getMinutes(), t.getSeconds()]).toEqual([3, 15, 0])
      if (i) expect(t.getTime() - times[i - 1].getTime()).toBeGreaterThanOrEqual(23 * 3_600_000)
    }
    await call('plain', 'get', `/${id}`).expect(403)
    await call('admin', 'get', '/999999999').expect(404)
  })

  it('next fire times of a cron: 5 in order; 400 on a bad cron; none for one that never fires', async () => {
    const res = await call('noRun', 'get', '/next-fire-times')
      .query({ cron: '*/15 * * * * *' })
      .expect(200)
    const times: number[] = res.body.data.times.map((t: string) => Date.parse(t))
    expect(times).toHaveLength(5)
    for (let i = 1; i < 5; i++) expect(times[i]! - times[i - 1]!).toBe(15_000)
    for (const cron of ['0 0 25 * * *', '0 0 12 ? * MON', '', '* * *']) {
      const bad = await call('admin', 'get', '/next-fire-times').query({ cron }).expect(400)
      expect(new Set(bad.body.errors.map((e: { path: string }) => e.path))).toEqual(
        new Set(['cron']),
      )
    }
    const never = await call('admin', 'get', '/next-fire-times')
      .query({ cron: '0 0 0 30 2 *' })
      .expect(200)
    expect(never.body.data.times).toEqual([])
    // a task never fires on it: refused
    await call('admin', 'post', '', task({ cron: '0 0 0 30 2 *' })).expect(400)
    await call('plain', 'get', '/next-fire-times').query({ cron: '* * * * *' }).expect(403)
  })

  it('run log: delete one, a batch (all or none), clean everything; 403 without remove; logged', async () => {
    const { id } = await add({ enabled: false })
    const row = () =>
      insertRow(ds.manager, 'job_run', {
        task_id: id,
        task_name: 'x',
        handler: 'demo.echo',
        outcome: 'ok',
      })
    const ids = [await row(), await row(), await row()]
    for (const res of [
      await runsCall('noRun', 'delete', `/${ids[0]}`),
      await runsCall('noRun', 'post', '/batch-delete', { ids }),
      await runsCall('noRun', 'post', '/clean'),
    ])
      expect(res.status).toBe(403)
    expect(await runsOf(id)).toHaveLength(3)
    const one = await runsCall('admin', 'delete', `/${ids[0]}`).expect(200)
    expect(await logOf(ds, one.headers['x-request-id']!)).toMatchObject({
      domain: 'scheduler.run',
      verb: 'remove',
      biz_id: String(ids[0]),
    })
    await runsCall('admin', 'post', '/batch-delete', { ids: [ids[1], 999_999_999] }).expect(404)
    expect((await runsOf(id)).map((r) => r.id)).toEqual([ids[1], ids[2]])
    await runsCall('admin', 'post', '/batch-delete', { ids: [ids[1]] }).expect(200)
    await row()
    const clean = await runsCall('admin', 'post', '/clean').expect(200)
    // soft: nothing live left, the rows stay marked deleted until audit.purge
    expect(
      Number((await ds.query('SELECT COUNT(*) AS n FROM job_run WHERE deleted_at IS NULL'))[0].n),
    ).toBe(0)
    expect(
      await ds.query('SELECT id FROM job_run WHERE task_id = ? AND deleted_at IS NOT NULL', [id]),
    ).toHaveLength(4)
    expect((await runsCall('admin', 'get').expect(200)).body.data.total).toBe(0)
    expect(await logOf(ds, clean.headers['x-request-id']!)).toMatchObject({ verb: 'clean' })
  })
})
