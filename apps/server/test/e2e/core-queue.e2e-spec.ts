// Job queues on Redis with multi-tenancy on (see docs/queue.md): a job added by a request of tenant B runs
// in tenant B, a job naming no tenant fails at once without retries, a throwing handler is retried with
// exponential backoff and ends failed, platform-wide jobs run with no tenant, the job defaults, the key
// prefix under `qw:queue:`, and workers that finish their running job before the app closes.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import type { Queue } from 'bullmq'
import request from 'supertest'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { TenantContextMissing, withTenant } from '../../src/core/context/tenant.js'
import { QueueService } from '../../src/core/queue/queue.service.js'
import { QUEUE_JOB_DEFAULTS } from '../../src/core/queue/queue-registry.js'
import { keyPrefix } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { SCHEDULER_RUN_QUEUE } from '../../src/modules/platform/scheduler/job-scheduler.js'
import {
  ECHO,
  FLAKY,
  PLATFORM,
  QueueFixtureModule,
  seen,
} from '../fixtures/queue/queue-fixture.module.js'
import { bearer } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { createTenant, inTenant1, type PeopledTenant, signInDirect } from '../setup/tenants.js'

// before AppModule is imported: only the fixture queues of this spec and the scheduler's "run once"
// queue are registered (the agent's own queues come with APP_AGENT, on in the test env)
vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
})

let app: NestExpressApplication
let redis: Redis
let queues: QueueService
let B: PeopledTenant | undefined
let closed = false

const queue = (name: string) => queues.queues().get(name)!
/** Waits until the job reached `state` (failed / completed / …). */
const settle = (q: Queue, id: string, state: string, timeout = 10_000) =>
  vi.waitFor(
    async () => {
      expect(await (await q.getJob(id))?.getState()).toBe(state)
    },
    { timeout, interval: 50 },
  )

beforeAll(async () => {
  const { AppModule } = await import('../../src/app.module.js')
  const { setupApp } = await import('../../src/app.setup.js')
  const env = { ...process.env, APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, QueueFixtureModule] })
    // AppModule's ConfigModule.forRoot is evaluated at import time: this app gets its own parsed env
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  redis = app.get(REDIS)
  queues = app.get(QueueService)
  await cleanRedis(redis)
  B = await createTenant(app, { users: true })
})

afterAll(async () => {
  await B?.dispose()
  if (!closed) {
    await cleanRedis(redis)
    await app?.close()
  }
})

beforeEach(() => {
  seen.length = 0
})

it('registers the fixture queues under qw:queue: with the documented job defaults', async () => {
  expect([...queues.queues().keys()].sort()).toEqual(
    [ECHO, FLAKY, PLATFORM, SCHEDULER_RUN_QUEUE].sort(),
  )
  expect(queue(ECHO).opts.prefix).toBe(`${keyPrefix()}queue`)
  expect(QUEUE_JOB_DEFAULTS).toEqual({
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  })
  const job = await inTenant1(() => queues.add(ECHO, 'defaults', undefined))
  expect(job.opts).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 5000 } })
  await settle(queue(ECHO), job.id!, 'completed')
  const keys: string[] = []
  for await (const batch of redis.scanIterator({ MATCH: `${keyPrefix()}*`, COUNT: 500 }))
    keys.push(...batch)
  const own = keys.filter((k) => k.includes(ECHO))
  expect(own.length).toBeGreaterThan(0)
  expect(own.every((k) => k.startsWith(`${keyPrefix()}queue:${ECHO}:`))).toBe(true)
})

it("a job added by a request of tenant B runs in tenant B; one of the default tenant's in it", async () => {
  const b = B!
  const alice = (await signInDirect(app, b.users.alice))!.accessToken
  const res = await request(app.getHttpServer())
    .post('/api/queue-fixture/echo')
    .set(bearer(alice))
    .send({ hello: 'b' })
    .expect(200)
  expect(res.body.data.tenantId).toBe(b.id)
  const own = await inTenant1(() => queues.add(ECHO, 'one', { hello: 'a' }))
  expect(own.data.tenantId).toBe(1)
  await settle(queue(ECHO), res.body.data.id, 'completed')
  await settle(queue(ECHO), own.id!, 'completed')
  expect(
    seen
      .map(({ jobId, tenant, payload }) => ({ jobId, tenant, payload }))
      .sort((a, b) => a.jobId.localeCompare(b.jobId)),
  ).toEqual(
    [
      { jobId: res.body.data.id, tenant: b.id, payload: { hello: 'b' } },
      { jobId: own.id, tenant: 1, payload: { hello: 'a' } },
    ].sort((a, b) => a.jobId!.localeCompare(b.jobId!)),
  )
})

it('keeps equal custom job ids of two tenants apart: both jobs run, each in its tenant', async () => {
  const b = B!
  const own = await inTenant1(() => queues.add(ECHO, 'same', { from: 1 }, { jobId: 'nightly' }))
  // qw:cross-tenant spec: tenant B adds a job under the same custom id
  const theirs = await withTenant(b.id, () =>
    queues.add(ECHO, 'same', { from: b.id }, { jobId: 'nightly' }),
  )
  expect([own.id, theirs.id]).toEqual(['t1-nightly', `t${b.id}-nightly`])
  await settle(queue(ECHO), own.id!, 'completed')
  await settle(queue(ECHO), theirs.id!, 'completed')
  expect(
    seen
      .map(({ jobId, tenant, payload }) => ({ jobId, tenant, payload }))
      .sort((x, y) => x.tenant! - y.tenant!),
  ).toEqual([
    { jobId: 't1-nightly', tenant: 1, payload: { from: 1 } },
    { jobId: `t${b.id}-nightly`, tenant: b.id, payload: { from: b.id } },
  ])
})

it('keeps equal deduplication ids of two tenants apart; within a tenant the second add is dropped', async () => {
  const b = B!
  await queue(ECHO).pause()
  const ids: string[] = []
  try {
    const dedup = { deduplication: { id: 'once' } }
    ids.push((await inTenant1(() => queues.add(ECHO, 'd', { n: 1 }, dedup))).id!)
    // within the tenant: the same deduplication id adds nothing
    await inTenant1(() => queues.add(ECHO, 'd', { n: 2 }, dedup))
    // qw:cross-tenant spec: tenant B uses the same deduplication id
    ids.push((await withTenant(b.id, () => queues.add(ECHO, 'd', { n: 3 }, dedup))).id!)
    expect(await queue(ECHO).getJobCountByTypes('waiting')).toBe(2)
    const de = (tid: number) => `${keyPrefix()}queue:${ECHO}:de:t${tid}-once`
    expect(await redis.exists([de(1), de(b.id)])).toBe(2)
  } finally {
    await queue(ECHO).resume()
  }
  for (const id of ids) await settle(queue(ECHO), id, 'completed')
  expect(seen.map((x) => [x.tenant, x.payload]).sort()).toEqual(
    [
      [1, { n: 1 }],
      [b.id, { n: 3 }],
    ].sort(),
  )
})

it('refuses to add a tenant job without a tenant in the context', async () => {
  await expect(queues.add(ECHO, 'nobody', {})).rejects.toBeInstanceOf(TenantContextMissing)
  expect(await queue(ECHO).getJobCountByTypes('waiting', 'delayed', 'active')).toBe(0)
})

it('fails a job naming no tenant at once: one attempt, no retry, the handler never runs', async () => {
  // added around QueueService.add, as a forged or foreign job would be
  const raw = await queue(ECHO).add('raw', { payload: 'no tenant' } as never, { attempts: 3 })
  const forged = await queue(ECHO).add('forged', { tenantId: null, payload: 'x' } as never)
  for (const job of [raw, forged]) {
    await settle(queue(ECHO), job.id!, 'failed')
    const after = (await queue(ECHO).getJob(job.id!))!
    expect(after.attemptsMade).toBe(1)
    expect(after.failedReason).toContain('names no tenant')
  }
  expect(seen).toEqual([])
})

it('retries a throwing handler with exponential backoff, then leaves the job failed', async () => {
  const job = await inTenant1(() =>
    queues.add(FLAKY, 'boom', { n: 1 }, { backoff: { type: 'exponential', delay: 200 } }),
  )
  await settle(queue(FLAKY), job.id!, 'failed')
  const after = (await queue(FLAKY).getJob(job.id!))!
  expect(after.attemptsMade).toBe(3)
  expect(after.failedReason).toBe('flaky failure')
  const runs = seen.filter((s) => s.jobId === job.id)
  expect(runs.map((s) => [s.attempt, s.tenant])).toEqual([
    [0, 1],
    [1, 1],
    [2, 1],
  ])
  // 200 ms, then 400 ms between the attempts
  expect(runs[1]!.at - runs[0]!.at).toBeGreaterThanOrEqual(190)
  expect(runs[2]!.at - runs[1]!.at).toBeGreaterThanOrEqual(390)
})

it('adds a platform-wide job without any tenant and runs it with none', async () => {
  const job = await queues.add(PLATFORM, 'tick', { at: 1 })
  expect(job.data).toEqual({ tenantId: null, payload: { at: 1 } })
  await settle(queue(PLATFORM), job.id!, 'completed')
  expect(seen).toMatchObject([{ queue: PLATFORM, tenant: undefined, payload: { at: 1 } }])
})

it('lets a running job finish before the app closes', async () => {
  const job = await inTenant1(() => queues.add(ECHO, 'slow', { sleepMs: 600 }))
  await vi.waitFor(() => expect(seen.some((s) => s.jobId === job.id)).toBe(true), {
    timeout: 5000,
    interval: 20,
  })
  // the tenant's rows go while the app still runs; its keys after it closed (its client is gone then)
  await B!.dispose()
  B = undefined
  const spare = redis.duplicate()
  closed = true
  await app.close()
  expect(seen.filter((s) => s.jobId === job.id).map((s) => !!s.done)).toEqual([false, true])
  await spare.connect()
  // finished as completed in Redis, not cut off
  expect(await spare.zScore(`${keyPrefix()}queue:${ECHO}:completed`, job.id!)).not.toBeNull()
  await cleanRedis(spare as Redis)
  await spare.close()
})
