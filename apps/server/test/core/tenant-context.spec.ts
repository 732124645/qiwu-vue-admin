// Tenant context (core/context/tenant.ts, see docs/design-notes.md#tenancy): withTenant / allTenants /
// tenantId across nesting and async hops; the HTTP entry (a request never takes the tenant keys of the
// context `listen()` ran in; with multi-tenancy on it has no tenant at all); the scheduler entry (a fire
// has no tenant: the handler picks one); the production fallback to the default tenant (multi-tenancy
// off only).
import { setImmediate as nextTick, setTimeout as sleep } from 'node:timers/promises'
import { Controller, Get, Injectable, Logger, type INestApplication } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ClsServiceManager } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { type AppClsStore, clsGet, clsSet } from '../../src/core/context/cls.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import {
  allTenants,
  TenantContextMissing,
  tenantEntry,
  tenantId,
  withTenant,
} from '../../src/core/context/tenant.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  type NotifyChannel,
  NotifyChannels,
  NotifyDispatcher,
} from '../../src/core/notify/notify.js'
import { JobHandler, type JobContext } from '../../src/core/scheduler/job-handler.js'
import { JobScheduler } from '../../src/modules/platform/scheduler/job-scheduler.js'

const cls = () => ClsServiceManager.getClsService<AppClsStore>()

describe('primitives', () => {
  it('withTenant sets the tenant for its function only: nested calls give the outer one back', async () => {
    await withTenant(2, async () => {
      expect(tenantId()).toBe(2)
      await withTenant(3, async () => {
        await sleep(1)
        expect(tenantId()).toBe(3)
      })
      expect(tenantId()).toBe(2)
      expect(withTenant(4, () => tenantId())).toBe(4)
      expect(tenantId()).toBe(2)
    })
    expect(() => tenantId()).toThrow(TenantContextMissing)
  })

  it('allTenants has no single tenant; a withTenant inside it wins and sees no allTenants', async () => {
    await withTenant(2, async () => {
      await allTenants(async () => {
        expect(clsGet('allTenants')).toBe(true)
        expect(() => tenantId()).toThrow(TenantContextMissing)
        await withTenant(5, async () => {
          await sleep(1)
          expect(tenantId()).toBe(5)
          expect(clsGet('allTenants')).toBeUndefined()
        })
        expect(clsGet('allTenants')).toBe(true)
      })
      // allTenants ends with its function: the caller's context is as it was
      expect(clsGet('allTenants')).toBeUndefined()
      expect(tenantId()).toBe(2)
    })
  })

  it('keeps the tenant across await, Promise.all and setImmediate, and apart in concurrent flows', async () => {
    const seen = await Promise.all(
      [2, 3, 4].map((tid) =>
        withTenant(tid, async () => {
          await sleep(5 - tid)
          const inner = await Promise.all([
            (async () => {
              await nextTick()
              return tenantId()
            })(),
            new Promise<number>((resolve) => setImmediate(() => resolve(tenantId()))),
          ])
          return [tenantId(), ...inner]
        }),
      ),
    )
    expect(seen).toEqual([
      [2, 2, 2],
      [3, 3, 3],
      [4, 4, 4],
    ])
  })

  it('throws TenantContextMissing without a tenant: outside any context and in one without it', () => {
    expect(() => tenantId()).toThrow(TenantContextMissing)
    expect(() => cls().run(() => tenantId())).toThrow(TenantContextMissing)
    // an entry clears whatever its context inherited
    expect(() => withTenant(2, () => tenantEntry(() => tenantId()))).toThrow(TenantContextMissing)
    expect(() => withTenant(0, () => 0)).toThrow(TypeError)
  })

  it('production: no tenant falls back to the default one with an error log; allTenants still throws', () => {
    const env = process.env.NODE_ENV
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      process.env.NODE_ENV = 'production'
      expect(tenantId()).toBe(1)
      expect(cls().run(() => tenantId())).toBe(1)
      expect(logged).toHaveBeenCalledTimes(2)
      expect(String(logged.mock.calls[0]![0])).toContain('no tenant in context')
      expect(withTenant(3, () => tenantId())).toBe(3)
      expect(() => allTenants(() => tenantId())).toThrow(TenantContextMissing)
      expect(logged).toHaveBeenCalledTimes(2)
      process.env.NODE_ENV = 'development'
      expect(() => tenantId()).toThrow(TenantContextMissing)
      expect(logged).toHaveBeenCalledTimes(2)
    } finally {
      process.env.NODE_ENV = env
      logged.mockRestore()
    }
  })

  it('production with multi-tenancy on: no tenant still throws, nothing falls back', () => {
    const env = { NODE_ENV: process.env.NODE_ENV, APP_MULTI_TENANT: process.env.APP_MULTI_TENANT }
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    try {
      process.env.NODE_ENV = 'production'
      process.env.APP_MULTI_TENANT = 'true'
      expect(() => tenantId()).toThrow(TenantContextMissing)
      expect(() => cls().run(() => tenantId())).toThrow(TenantContextMissing)
      expect(logged).not.toHaveBeenCalled()
      process.env.APP_MULTI_TENANT = 'false'
      expect(tenantId()).toBe(1)
    } finally {
      for (const [key, value] of Object.entries(env))
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      logged.mockRestore()
    }
  })
})

describe('entries that work in the tenant of a row', () => {
  it('tenantEntry drops the caller tenant, actor and allTenants; a withTenant inside names the row tenant', async () => {
    const keys = () => [clsGet('tenantId'), clsGet('allTenants'), clsGet('actorTenantId')]
    const entry = () =>
      tenantEntry(async () => [
        keys(),
        await withTenant(3, async () => {
          await sleep(1)
          return [tenantId(), clsGet('allTenants'), clsGet('actorTenantId')]
        }),
      ])
    const none = [undefined, undefined, undefined]
    const fromTenant = await withTenant(7, () => {
      clsSet('actorTenantId', 8)
      return entry()
    })
    const fromAll = await allTenants(() => {
      clsSet('actorTenantId', 8)
      return entry()
    })
    expect(fromTenant).toEqual([none, [3, undefined, undefined]])
    expect(fromAll).toEqual([none, [3, undefined, undefined]])
  })

  it('notify.dispatch scans in allTenants and delivers each record in its own tenant', async () => {
    const calls: unknown[] = []
    const channel = {
      code: 'inbox',
      expire: async () => void calls.push(['expire', clsGet('allTenants')]),
      dueRows: async () => {
        calls.push(['due', clsGet('allTenants')])
        return [
          { id: 11, tenantId: 3 },
          { id: 12, tenantId: 4 },
        ]
      },
      deliver: async (id: number) =>
        void calls.push(['deliver', id, tenantId(), clsGet('allTenants')]),
    } as unknown as NotifyChannel
    const channels = new NotifyChannels()
    channels.register(channel)
    const ctx = { signal: new AbortController().signal, log: () => {} } satisfies JobContext
    const out = await withTenant(7, () => new NotifyDispatcher(channels).dispatch({}, ctx))
    expect(calls).toEqual([
      ['expire', true],
      ['due', true],
      ['deliver', 11, 3, undefined],
      ['deliver', 12, 4, undefined],
    ])
    expect(out).toBe('processed 2')
  })
})

@Controller('tenant')
class TenantController {
  @Get()
  read() {
    return {
      tenantId: tenantId(),
      allTenants: clsGet('allTenants') ?? null,
      actorTenantId: clsGet('actorTenantId') ?? null,
    }
  }

  /** the keys as they are, without tenantId()'s checks */
  @Get('raw')
  raw() {
    return {
      tenantId: clsGet('tenantId') ?? null,
      allTenants: clsGet('allTenants') ?? null,
      actorTenantId: clsGet('actorTenantId') ?? null,
    }
  }

  /** writes the keys of its own request's context */
  @Get('dirty')
  dirty() {
    clsSet('tenantId', 9)
    clsSet('allTenants', true)
    clsSet('actorTenantId', 9)
    return 'dirty'
  }
}

describe('HTTP entry', () => {
  const apps: INestApplication[] = []
  /** An app with the context middleware (multi-tenancy as asked, off by default), listening inside `around`. */
  async function listen(around: (fn: () => Promise<void>) => Promise<void>, multiTenant = false) {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreConfigModule.forRoot(), CoreContextModule],
      controllers: [TenantController],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService(
          EnvSchema.parse({ ...process.env, APP_MULTI_TENANT: String(multiTenant) }),
        ),
      )
      .compile()
    const app = moduleRef.createNestApplication({ logger: false })
    apps.push(app)
    await around(async () => {
      await app.listen(0, '127.0.0.1')
    })
    return request(app.getHttpServer())
  }
  const clean = { tenantId: 1, allTenants: null, actorTenantId: null }

  afterAll(() => Promise.all(apps.map((a) => a.close())))

  it('a request gets the default tenant, not the tenant listen() ran in, nor its actor', async () => {
    const http = await listen((fn) =>
      withTenant(7, () => {
        clsSet('actorTenantId', 8)
        return fn()
      }),
    )
    expect((await http.get('/tenant').expect(200)).body).toEqual(clean)
  })

  it('a request never runs in an allTenants that listen() ran in', async () => {
    const http = await listen((fn) => allTenants(fn))
    expect((await http.get('/tenant').expect(200)).body).toEqual(clean)
  })

  it('multi-tenancy on: a request has no tenant, not even the one listen() ran in', async () => {
    const http = await listen(
      (fn) =>
        withTenant(7, () => {
          clsSet('actorTenantId', 8)
          return fn()
        }),
      true,
    )
    expect((await http.get('/tenant/raw').expect(200)).body).toEqual({
      tenantId: null,
      allTenants: null,
      actorTenantId: null,
    })
    await http.get('/tenant').expect(500)
    const all = await listen((fn) => allTenants(fn), true)
    expect((await all.get('/tenant/raw').expect(200)).body).toEqual({
      tenantId: null,
      allTenants: null,
      actorTenantId: null,
    })
  })

  it('what one request writes stays in it', async () => {
    const http = await listen((fn) => fn())
    await http.get('/tenant/dirty').expect(200)
    expect((await http.get('/tenant').expect(200)).body).toEqual(clean)
  })
})

/** Handlers of this spec: one reads the tenant without picking one, one picks the default tenant. */
@Injectable()
class TenantJobs {
  @JobHandler('test.tenant.read')
  read() {
    return `tenant=${tenantId()}`
  }

  @JobHandler('test.tenant.picked')
  picked() {
    return withTenant(1, () => `tenant=${tenantId()}`)
  }
}

describe('scheduler entry', () => {
  let app: NestExpressApplication
  let ds: DataSource
  let scheduler: JobScheduler
  let lastTaskId = 0
  let seq = 0

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      providers: [TenantJobs],
    }).compile()
    app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
    await app.init()
    ds = app.get<DataSource>(getDataSourceToken())
    scheduler = app.get(JobScheduler)
    lastTaskId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM job_task'))[0].n)
  })

  afterAll(async () => {
    if (!ds) return
    await scheduler.idle()
    await ds.query('DELETE FROM job_run WHERE task_id > ?', [lastTaskId])
    await ds.query('DELETE FROM job_task WHERE id > ?', [lastTaskId])
    await app.close()
  })

  const task = (handler: string, cron = '0 0 3 * * *') =>
    insertRow(ds.manager, 'job_task', { name: `e2e-tenant-${++seq}`, handler, cron })
  const runs = (taskId: number) =>
    ds.query<{ outcome: string; output: string | null; error: string | null }[]>(
      'SELECT outcome, output, error FROM job_run WHERE task_id = ? ORDER BY id',
      [taskId],
    )

  it('a cron scheduled inside withTenant fires with no tenant: a handler that picks none throws', async () => {
    const id = await task('test.tenant.read', '* * * * * *')
    // the cron timer is created in this context
    await withTenant(7, () => scheduler.sync(id))
    await vi.waitFor(async () => expect(await runs(id)).not.toEqual([]), { timeout: 4000 })
    await ds.query('UPDATE job_task SET enabled = 0 WHERE id = ?', [id])
    await scheduler.sync(id)
    await scheduler.idle()
    const [first] = await runs(id)
    expect(first).toMatchObject({ outcome: 'failed', output: null })
    expect(first!.error).toMatch(/^TenantContextMissing/)
  })

  it('a run requested inside a tenant or allTenants has no tenant either; a handler picks its own', async () => {
    const read = await task('test.tenant.read')
    const picked = await task('test.tenant.picked')
    const at = Date.now()
    await withTenant(7, () => scheduler.fire(read, at, 'manual'))
    await allTenants(() => scheduler.fire(read, at + 1, 'manual'))
    await withTenant(7, () => scheduler.fire(picked, at, 'manual'))
    expect((await runs(read)).map((r) => r.outcome)).toEqual(['failed', 'failed'])
    expect(await runs(picked)).toEqual([{ outcome: 'ok', output: 'tenant=1', error: null }])
  })
})
