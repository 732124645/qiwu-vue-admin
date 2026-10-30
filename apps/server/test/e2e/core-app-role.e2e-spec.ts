// Process roles (APP_ROLE, see docs/scale-out.md): an api process started over enabled tasks, a missed fire
// and a scheduled automation installs no cron job, makes up no missed fire, starts no queue worker and
// registers no agent schedules; its "run once" and the jobs it adds wait
// in their queues. A worker process started afterwards takes those jobs, runs the queued "run once" and the
// catch-up, schedules the enabled task and registers the agent schedules.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { Queue } from 'bullmq'
import { createClient } from 'redis'
import type { DataSource } from 'typeorm'
import { AGENT_AUTOMATION_QUEUE } from '../../src/core/agent/automation/automation-runner.js'
import { AGENT_MEMORY_QUEUE } from '../../src/core/agent/memory/memory-extract.js'
import { AGENT_CLEANUP_QUEUE } from '../../src/core/agent/runtime/turn-queue.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { QueueService } from '../../src/core/queue/queue.service.js'
import type { Redis } from '../../src/core/redis/redis.module.js'
import {
  JobScheduler,
  SCHEDULER_RUN_QUEUE,
} from '../../src/modules/platform/scheduler/job-scheduler.js'
import { Task } from '../../src/modules/platform/scheduler/task/task.entity.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { ECHO, QueueFixtureModule, seen } from '../fixtures/queue/queue-fixture.module.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'

const PREFIX = 'e2e-app-role-'
let api: NestExpressApplication | undefined
/** A second api process started after the rows below exist: what an api process does at its start. */
let apiStarted: NestExpressApplication | undefined
let worker: NestExpressApplication | undefined
let ds: DataSource
const taskIds: number[] = []
let automationId: number | undefined

async function boot(role: 'api' | 'worker'): Promise<NestExpressApplication> {
  const { AppModule } = await import('../../src/app.module.js')
  const { setupApp } = await import('../../src/app.setup.js')
  const mod = await Test.createTestingModule({ imports: [AppModule, QueueFixtureModule] })
    // AppModule's ConfigModule.forRoot is evaluated at import time: each app gets its own parsed env
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse({ ...process.env, APP_ROLE: role })))
    .compile()
  const app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  return app
}

/** Deletes this app's Redis keys before any app starts (left-over agent schedules included). */
async function cleanBefore() {
  const redis: Redis = createClient({
    socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) },
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    database: Number(process.env.REDIS_DB),
  })
  redis.on('error', () => {})
  await redis.connect()
  try {
    await cleanRedis(redis)
  } finally {
    await redis.close()
  }
}

const queueOf = (app: NestExpressApplication, name: string): Queue => {
  const q = app.get(QueueService).queues().get(name)
  if (!q) throw new Error(`queue ${name} is not registered`)
  return q
}
const runsOf = (taskId: number): Promise<{ outcome: string; output: string }[]> =>
  ds.query('SELECT outcome, output FROM job_run WHERE task_id = ? ORDER BY id', [taskId])

const yearsAgo = new Date(Date.UTC(new Date().getUTCFullYear() - 3, 5, 1))
let cronTask: number
let missedTask: number
let manualTask: number

beforeAll(async () => {
  await cleanBefore()
  seen.length = 0
  api = await boot('api')
  ds = api.get<DataSource>(getDataSourceToken())
  // rows straight into job_task while only the api process runs: a worker sees them at its start
  const task = (name: string, row: Record<string, unknown>) =>
    insertRow(ds.manager, 'job_task', {
      name: `${PREFIX}${name}`,
      handler: 'demo.echo',
      cron: '0 0 3 * * *',
      ...row,
    }).then((id) => (taskIds.push(id), id))
  cronTask = await task('cron', {})
  missedTask = await task('missed', {
    cron: '0 0 0 1 1 *',
    misfire: 'run_once',
    params: JSON.stringify({ message: 'caught-up' }),
    last_fire_at: yearsAgo,
    created_at: yearsAgo,
    updated_at: yearsAgo,
  })
  manualTask = await task('manual', {
    enabled: 0,
    params: JSON.stringify({ message: 'run-once' }),
  })
  automationId = await inTenant1(() =>
    insertRow(ds.manager, 'agent_automation', {
      user_id: 1,
      name: `${PREFIX}schedule`,
      trigger_kind: 'schedule',
      cron: '0 3 1 1 *',
      timezone: 'UTC',
      prompt: 'noop',
      write_mode: 'read_only',
      enabled: 1,
    }),
  )
  apiStarted = await boot('api')
}, 60_000)

afterAll(async () => {
  await worker?.close()
  await apiStarted?.close()
  if (api) {
    if (automationId) await ds.query('DELETE FROM agent_automation WHERE id = ?', [automationId])
    if (taskIds.length) {
      await ds.query('DELETE FROM job_run WHERE task_id IN (?)', [taskIds])
      await ds.query('DELETE FROM job_task WHERE id IN (?)', [taskIds])
    }
    await api.close()
  }
  await cleanBefore()
}, 30_000)

describe('api role', () => {
  it('starts no queue worker: a job added there stays waiting', async () => {
    expect(api!.get(QueueService).workers()).toEqual([])
    const job = await inTenant1(() => api!.get(QueueService).add(ECHO, 'api', { from: 'api' }))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(await job.getState()).toBe('waiting')
    expect(seen).toEqual([])
  })

  it('installs no cron job and makes up no missed fire at its start, nor after a task write', async () => {
    const scheduler = apiStarted!.get(JobScheduler)
    await scheduler.idle()
    expect(scheduler.isScheduled(cronTask)).toBe(false)
    expect(scheduler.isScheduled(missedTask)).toBe(false)
    expect(await runsOf(missedTask)).toEqual([])
    await scheduler.changed([cronTask, missedTask])
    await scheduler.idle()
    expect(scheduler.isScheduled(cronTask)).toBe(false)
    expect(scheduler.isScheduled(missedTask)).toBe(false)
    expect(await runsOf(missedTask)).toEqual([])
    const [row] = await ds.query(
      'SELECT last_fire_at, misfire_pending_at FROM job_task WHERE id = ?',
      [missedTask],
    )
    expect([row.last_fire_at.getTime(), row.misfire_pending_at]).toEqual([yearsAgo.getTime(), null])
  })

  it('"run once" is queued for a worker, with the fire time it answers', async () => {
    const scheduler = api!.get(JobScheduler)
    const task = await ds.getRepository(Task).findOneByOrFail({ id: manualTask })
    const { scheduledAt } = await scheduler.runOnce(task)
    await scheduler.idle()
    expect(await runsOf(manualTask)).toEqual([])
    const waiting = await queueOf(api!, SCHEDULER_RUN_QUEUE).getJobs(['waiting'])
    expect(waiting.map((j) => j.data)).toEqual([
      { tenantId: null, payload: { taskId: manualTask, scheduledAt: Date.parse(scheduledAt) } },
    ])
  })

  it('registers no agent schedule (they belong to the processes running the workers)', async () => {
    for (const name of [AGENT_CLEANUP_QUEUE, AGENT_MEMORY_QUEUE, AGENT_AUTOMATION_QUEUE])
      expect(await queueOf(apiStarted!, name).getJobSchedulers()).toEqual([])
  })
})

describe('worker role started next', () => {
  beforeAll(async () => {
    worker = await boot('worker')
  }, 60_000)

  it('takes the waiting jobs: the queued "run once" runs here', async () => {
    expect(worker!.get(QueueService).workers().length).toBeGreaterThan(0)
    await vi.waitFor(() => expect(seen.map((s) => s.payload)).toEqual([{ from: 'api' }]), {
      timeout: 10_000,
    })
    await vi.waitFor(
      async () => expect(await runsOf(manualTask)).toEqual([{ outcome: 'ok', output: 'run-once' }]),
      { timeout: 10_000 },
    )
  })

  it('schedules the enabled tasks and makes up the missed fire', async () => {
    const scheduler = worker!.get(JobScheduler)
    expect(scheduler.isScheduled(cronTask)).toBe(true)
    await scheduler.idle()
    expect(await runsOf(missedTask)).toEqual([{ outcome: 'ok', output: 'caught-up' }])
  })

  it('registers the agent schedules', async () => {
    expect(
      (await queueOf(worker!, AGENT_CLEANUP_QUEUE).getJobSchedulers()).map((s) => s.key).sort(),
    ).toEqual(['agent-orphan-turns', 'agent-temp-threads'])
    expect(
      (await queueOf(worker!, AGENT_MEMORY_QUEUE).getJobSchedulers()).map((s) => s.key),
    ).toEqual(['agent-memory-extract'])
    expect(
      (await queueOf(worker!, AGENT_AUTOMATION_QUEUE).getJobSchedulers()).map((s) => s.key),
    ).toContain(`agent-automation-${automationId}`)
  })
})
