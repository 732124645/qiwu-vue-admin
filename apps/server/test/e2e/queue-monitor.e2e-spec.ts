// Queue monitor API (`/api/monitor/queues`, see docs/queue.md) over the fixture queues, with three apps on
// one database: `on` (multi-tenancy on), `off` (off) and `demo` (demo mode). A reader of the default
// tenant holds the three queue perms, a stranger none. Off: the reader lists, pages, retries and removes,
// the stranger gets 403; on: only root (the jobs are every tenant's), the reader and another tenant's user
// get 403. Unknown queues and jobs are 404, retrying a job that has not failed or removing a running one
// 409; demo mode refuses the writes.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, monitorPerms, QUEUE_DATA_PREVIEW_MAX, queueJobVo, queueVo } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { QueueService } from '../../src/core/queue/queue.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { SCHEDULER_RUN_QUEUE } from '../../src/modules/platform/scheduler/job-scheduler.js'
import {
  ECHO,
  FLAKY,
  PLATFORM,
  QueueFixtureModule,
  seen,
} from '../fixtures/queue/queue-fixture.module.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

// before AppModule is imported: only the fixture queues of this spec and the scheduler's "run once"
// queue are registered (the agent's own queues come with APP_AGENT, on in the test env)
vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
})

const PREFIX = 'qmon-'
const URL = '/api/monitor/queues'

async function boot(env: Record<string, string>) {
  const { AppModule } = await import('../../src/app.module.js')
  const { setupApp } = await import('../../src/app.setup.js')
  const mod = await Test.createTestingModule({ imports: [AppModule, QueueFixtureModule] })
    // AppModule's ConfigModule.forRoot is evaluated at import time: each app gets its own parsed env
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse({ ...process.env, ...env })))
    .compile()
  const app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  return app
}

let on: NestExpressApplication
let off: NestExpressApplication
let demo: NestExpressApplication
let ds: DataSource
let redis: Redis
let queues: QueueService
let B: PeopledTenant
let roleId: number
const userIds: number[] = []
const tokens = { root: '', reader: '', stranger: '', other: '' }

const http = (app: NestExpressApplication) => request(app.getHttpServer())
const get = (app: NestExpressApplication, who: keyof typeof tokens, path = '', query = {}) =>
  http(app).get(`${URL}${path}`).query(query).set(bearer(tokens[who]))
const queue = (name: string) => queues.queues().get(name)!

/** A job of FLAKY that ran once and failed (no retries), added in the default tenant. */
async function failedJob(payload: unknown) {
  const job = await inTenant1(() => queues.add(FLAKY, 'boom', payload, { attempts: 1 }))
  await vi.waitFor(async () => expect(await job.getState()).toBe('failed'), {
    timeout: 10_000,
    interval: 50,
  })
  return job.id!
}

beforeAll(async () => {
  on = await boot({ APP_MULTI_TENANT: 'true' })
  off = await boot({ APP_MULTI_TENANT: 'false' })
  demo = await boot({ APP_MULTI_TENANT: 'false', APP_DEMO_MODE: 'true' })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  queues = on.get(QueueService)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', 1)",
    [`${PREFIX}reader`, `${PREFIX}reader`],
  )
  roleId = Number(insertId)
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, 1 FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, [monitorPerms.queue, monitorPerms.queueRetry, monitorPerms.queueRemove]],
  )
  userIds.push(await addUser(on, 1, `${PREFIX}reader`, { roleId }))
  userIds.push(await addUser(on, 1, `${PREFIX}stranger`))
  tokens.root = (await signIn(on)).accessToken
  tokens.reader = (await signInDirect(on, userIds[0]!))!.accessToken
  tokens.stranger = (await signInDirect(on, userIds[1]!))!.accessToken
  tokens.other = (await signInDirect(on, B.users.alice))!.accessToken
})

afterAll(async () => {
  await B?.dispose()
  if (ds) {
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
  await demo?.close()
})

it('lists every registered queue with its counts and paused flag', async () => {
  const id = await failedJob({ n: 1 })
  await queue(PLATFORM).pause()
  try {
    const res = await get(off, 'reader').expect(200)
    const list = z.array(queueVo).parse(res.body.data)
    expect(list.map((q) => q.name)).toEqual([PLATFORM, ECHO, FLAKY, SCHEDULER_RUN_QUEUE].sort())
    expect(list.find((q) => q.name === FLAKY)).toMatchObject({ failed: 1, paused: false })
    expect(list.find((q) => q.name === PLATFORM)).toMatchObject({ paused: true })
    expect(Object.keys(list[0]!).sort()).toEqual(
      [
        'active',
        'completed',
        'delayed',
        'failed',
        'name',
        'paused',
        'prioritized',
        'waiting',
      ].sort(),
    )
  } finally {
    await queue(PLATFORM).resume()
    await http(off).delete(`${URL}/${FLAKY}/jobs/${id}`).set(bearer(tokens.root)).expect(200)
  }
})

it('counts and lists the jobs waiting with a priority', async () => {
  await queue(ECHO).pause()
  try {
    const job = await inTenant1(() => queues.add(ECHO, 'urgent', {}, { priority: 5 }))
    const list = (await get(off, 'reader').expect(200)).body.data as { name: string }[]
    expect(list.find((q) => q.name === ECHO)).toMatchObject({ prioritized: 1, waiting: 0 })
    const res = await get(off, 'reader', `/${ECHO}/jobs`, { state: 'prioritized' }).expect(200)
    expect(res.body.data).toMatchObject({ total: 1, items: [{ id: job.id, name: 'urgent' }] })
  } finally {
    await queue(ECHO).resume()
  }
})

it('pages one state of a queue, data masked and cut; unknown queue 404, bad query 400', async () => {
  const id = await failedJob({
    password: 'hunter2-secret',
    message: 'sign-in refused for hunter2-secret',
    note: 'x'.repeat(2000),
  })
  try {
    const res = await get(off, 'reader', `/${FLAKY}/jobs`, { state: 'failed' }).expect(200)
    expect(res.body.data.total).toBe(1)
    const [job] = z.array(queueJobVo).parse(res.body.data.items)
    expect(job).toMatchObject({
      id,
      name: 'boom',
      tenantId: 1,
      attemptsMade: 1,
      attempts: 1,
      // the error quoted the payload's password: masked like a request's error message
      failedReason: 'sign-in refused for ***',
    })
    expect(job!.data).toHaveLength(QUEUE_DATA_PREVIEW_MAX)
    expect(job!.data).toMatch(/^\{"password":"?\*\*\*"?,"message":"sign-in refused for \*\*\*"/)
    expect(job!.data).not.toContain('hunter2')
    expect(job!.finishedAt).not.toBeNull()
    // the default state is failed; other states page apart
    expect((await get(off, 'reader', `/${FLAKY}/jobs`).expect(200)).body.data.total).toBe(1)
    expect(
      (await get(off, 'reader', `/${FLAKY}/jobs`, { state: 'completed' }).expect(200)).body.data,
    ).toEqual({ items: [], total: 0 })
    const unknown = await get(off, 'reader', '/no-such-queue/jobs').expect(404)
    expect(unknown.body.code).toBe(Err.NOT_FOUND.code)
    await get(off, 'reader', `/${FLAKY}/jobs`, { state: 'stuck' }).expect(400)
  } finally {
    await http(off).delete(`${URL}/${FLAKY}/jobs/${id}`).set(bearer(tokens.root)).expect(200)
  }
})

it('retries a failed job with its attempts started over (logged), refuses one that has not failed (409); unknown ones 404', async () => {
  // three attempts, 100 ms then 200 ms apart, all failed
  const added = await inTenant1(() =>
    queues.add(FLAKY, 'thrice', { n: 2 }, { backoff: { type: 'exponential', delay: 100 } }),
  )
  const id = added.id!
  await vi.waitFor(async () => expect(await added.getState()).toBe('failed'), { timeout: 10_000 })
  expect((await queue(FLAKY).getJob(id))!.attemptsMade).toBe(3)
  seen.length = 0
  const trace = `${PREFIX}${process.pid}-retry`
  await http(off)
    .post(`${URL}/${FLAKY}/jobs/${id}/retry`)
    .set(bearer(tokens.reader))
    .set('X-Request-Id', trace)
    .expect(200)
  expect(await logOf(ds, trace)).toMatchObject({
    domain: 'monitor.queue',
    verb: 'retry',
    biz_id: `${FLAKY}:${id}`,
    ok: 1,
  })
  // it ran all three attempts again, with the backoff between them (the fixture always throws)
  await vi.waitFor(
    async () => expect(await (await queue(FLAKY).getJob(id))!.getState()).toBe('failed'),
    { timeout: 10_000 },
  )
  const runs = seen.filter((s) => s.jobId === id)
  expect(runs.map((s) => s.attempt)).toEqual([0, 1, 2])
  expect(runs[2]!.at - runs[1]!.at).toBeGreaterThanOrEqual(190)
  expect((await queue(FLAKY).getJob(id))!.attemptsMade).toBe(3)
  const done = await inTenant1(() => queues.add(ECHO, 'fine', {}))
  await vi.waitFor(async () => expect(await done.getState()).toBe('completed'))
  const conflict = await http(off)
    .post(`${URL}/${ECHO}/jobs/${done.id}/retry`)
    .set(bearer(tokens.reader))
    .expect(409)
  expect(conflict.body.code).toBe(Err.CONFLICT.code)
  for (const path of [
    `/no-such-queue/jobs/${id}/retry`,
    `/${FLAKY}/jobs/999999/retry`,
    `/${FLAKY}/jobs/meta/retry`,
    // a list key, not a hash: no job either
    `/${FLAKY}/jobs/wait/retry`,
  ])
    await http(off).post(`${URL}${path}`).set(bearer(tokens.reader)).expect(404)
  await http(off).delete(`${URL}/${FLAKY}/jobs/${id}`).set(bearer(tokens.root)).expect(200)
})

it('removes a job (logged), refuses a running one (409); a removed one is 404', async () => {
  const id = await failedJob({ n: 3 })
  const trace = `${PREFIX}${process.pid}-remove`
  await http(off)
    .delete(`${URL}/${FLAKY}/jobs/${id}`)
    .set(bearer(tokens.reader))
    .set('X-Request-Id', trace)
    .expect(200)
  expect(await logOf(ds, trace)).toMatchObject({
    domain: 'monitor.queue',
    verb: 'remove',
    biz_id: `${FLAKY}:${id}`,
    ok: 1,
  })
  expect(await queue(FLAKY).getJob(id)).toBeUndefined()
  await http(off).delete(`${URL}/${FLAKY}/jobs/${id}`).set(bearer(tokens.reader)).expect(404)
  // the queue's own keys are no jobs
  await http(off).delete(`${URL}/${FLAKY}/jobs/meta`).set(bearer(tokens.reader)).expect(404)
  expect(await queue(FLAKY).isPaused()).toBe(false)
  const slow = await inTenant1(() => queues.add(ECHO, 'slow', { sleepMs: 800 }))
  await vi.waitFor(async () => expect(await slow.getState()).toBe('active'), { interval: 20 })
  // the running jobs are listed (read-only)
  const active = await get(off, 'reader', `/${ECHO}/jobs`, { state: 'active' }).expect(200)
  expect(active.body.data.items.map((j: { id: string }) => j.id)).toContain(slow.id)
  const busy = await http(off)
    .delete(`${URL}/${ECHO}/jobs/${slow.id}`)
    .set(bearer(tokens.reader))
    .expect(409)
  expect(busy.body.code).toBe(Err.CONFLICT.code)
  await vi.waitFor(async () => expect(await slow.getState()).toBe('completed'))
})

it('403 without the perms; with multi-tenancy on, root only', async () => {
  for (const [method, path] of [
    ['get', ''],
    ['get', `/${FLAKY}/jobs`],
    ['post', `/${FLAKY}/jobs/1/retry`],
    ['delete', `/${FLAKY}/jobs/1`],
  ] as const) {
    const call = (app: NestExpressApplication, who: keyof typeof tokens) =>
      http(app)[method](`${URL}${path}`).set(bearer(tokens[who]))
    const denied = await call(off, 'stranger').expect(403)
    expect(denied.body.code).toBe(Err.FORBIDDEN.code)
    // a platform user granted the perms: the jobs are every tenant's
    expect((await call(on, 'reader')).status).toBe(403)
    // another tenant's user never reaches a platform route
    expect((await call(on, 'other')).status).toBe(403)
  }
  await get(on, 'root').expect(200)
  await get(on, 'root', `/${FLAKY}/jobs`).expect(200)
  await get(off, 'reader').expect(200)
})

it('lists, retries and removes a job under a custom id (stored with the tenant prefix)', async () => {
  const added = await inTenant1(() =>
    queues.add(FLAKY, 'custom', { n: 5 }, { jobId: 'nightly:report:7', attempts: 1 }),
  )
  expect(added.id).toBe('t1-nightly:report:7')
  await vi.waitFor(async () => expect(await added.getState()).toBe('failed'), { timeout: 10_000 })
  const listed = await get(off, 'reader', `/${FLAKY}/jobs`).expect(200)
  expect(listed.body.data.items.map((j: { id: string }) => j.id)).toContain(added.id)
  const path = `${URL}/${FLAKY}/jobs/${encodeURIComponent(added.id!)}`
  seen.length = 0
  await http(off).post(`${path}/retry`).set(bearer(tokens.reader)).expect(200)
  await vi.waitFor(() => expect(seen.some((x) => x.jobId === added.id)).toBe(true), {
    timeout: 10_000,
  })
  await vi.waitFor(async () =>
    expect(await (await queue(FLAKY).getJob(added.id!))!.getState()).toBe('failed'),
  )
  await http(off).delete(path).set(bearer(tokens.reader)).expect(200)
  expect(await queue(FLAKY).getJob(added.id!)).toBeUndefined()
  await http(off).delete(path).set(bearer(tokens.reader)).expect(404)
})

it('demo mode refuses the writes, keeps the reads', async () => {
  const id = await failedJob({ n: 4 })
  const root = (await signIn(demo)).accessToken
  await http(demo).get(URL).set(bearer(root)).expect(200)
  for (const res of [
    await http(demo).post(`${URL}/${FLAKY}/jobs/${id}/retry`).set(bearer(root)),
    await http(demo).delete(`${URL}/${FLAKY}/jobs/${id}`).set(bearer(root)),
  ]) {
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(Err.DEMO_READ_ONLY.code)
  }
  expect(await (await queue(FLAKY).getJob(id))!.getState()).toBe('failed')
})
