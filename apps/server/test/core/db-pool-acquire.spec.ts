// MySQL pool settings: size / wait queue from env, the bounded wait for a free connection, and the
// 503 a request gets when none frees up in time (see docs/deploy.md).
import { type ArgumentsHost, Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Err } from '@qiwu/shared'
import type { Pool, PoolConnection } from 'mysql2'
import { DataSource, type QueryRunner } from 'typeorm'
import { AuditWriter } from '../../src/core/audit/audit-writer.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { DB_POOL_TIMEOUT, withAcquireTimeout } from '../../src/core/db/pool-acquire.js'
import { classify, HttpErrorFilter } from '../../src/core/http/http-error.filter.js'
import { CoreI18nModule } from '../../src/core/i18n/i18n.module.js'
import { dataSourceOptions } from '../../src/db/data-source.js'

type Cb = (err: NodeJS.ErrnoException | null, conn?: PoolConnection) => void

/** A pool whose getConnection only queues the callback; the test hands connections out. */
function fakePool() {
  // the two methods of mysql2's own wait queue the wrapper uses
  const queue = Object.assign([] as Cb[], {
    toArray: () => [...queue],
    removeOne: (i: number) => queue.splice(i, 1)[0],
  })
  const pool = {
    config: { connectionLimit: 2 },
    _allConnections: [1, 2],
    _freeConnections: [],
    _connectionQueue: queue,
    getConnection: (cb: Cb) => void queue.push(cb),
  }
  return { pool: pool as unknown as Pool, queue, raw: pool }
}
const conn = () =>
  ({ release: vi.fn<() => void>() }) as unknown as PoolConnection & { release: () => void }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('withAcquireTimeout', () => {
  it('0 leaves the pool untouched (no timer, no wrapper)', () => {
    const { pool, raw } = fakePool()
    const original = raw.getConnection
    expect(withAcquireTimeout(pool, 0).getConnection).toBe(original)
  })

  it('times out once with QW_DB_POOL_TIMEOUT, leaves the wait queue; a late connection is released', () => {
    vi.useFakeTimers()
    const { pool, queue } = fakePool()
    withAcquireTimeout(pool, 100)
    const cb = vi.fn<Cb>()
    pool.getConnection(cb)
    const waiter = queue[0]!
    vi.advanceTimersByTime(99)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
    const err = cb.mock.calls[0]![0] as NodeJS.ErrnoException
    expect(err.code).toBe(DB_POOL_TIMEOUT)
    expect(err.message).toContain('limit=2 total=2 idle=0 queued=0')
    // the abandoned waiter no longer holds a queue slot
    expect(queue).toHaveLength(0)
    // a connection handed to it anyway (the driver wrapped the callback) goes straight back
    const late = conn()
    waiter(null, late)
    expect(late.release).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a waiter the driver dispatches again keeps its one timer (no second wrap, one warn)', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { pool, queue } = fakePool()
    withAcquireTimeout(pool, 100)
    const cb = vi.fn<Cb>()
    pool.getConnection(cb)
    // mysql2 releasing a connection that left the pool: shift the waiter, getConnection(waiter) again
    const waiter = queue.shift()!
    pool.getConnection(waiter)
    expect([...queue]).toEqual([waiter])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(100)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(queue).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a connection in time goes to the caller and clears the timer', () => {
    vi.useFakeTimers()
    const { pool, queue } = fakePool()
    withAcquireTimeout(pool, 100)
    const cb = vi.fn<Cb>()
    pool.getConnection(cb)
    const c = conn()
    queue[0]!(null, c)
    vi.advanceTimersByTime(1000)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(null, c)
    expect(c.release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('pool env', () => {
  const base = {
    DB_USER: 'u',
    DB_NAME: 'n',
    APP_SECRET: 'local-app-secret-not-for-production-0123456789-abcdefghij',
  }

  it('defaults keep mysql2 behaviour (10 / no timeout / no queue limit) and pass to the driver', () => {
    expect(EnvSchema.parse(base)).toMatchObject({
      DB_POOL_SIZE: 10,
      DB_POOL_ACQUIRE_TIMEOUT_MS: 0,
      DB_POOL_QUEUE_LIMIT: 0,
    })
    const env = { DB_POOL_SIZE: '', DB_POOL_QUEUE_LIMIT: undefined }
    expect(dataSourceOptions(env)).toMatchObject({ poolSize: 10, extra: { queueLimit: 0 } })
    expect(dataSourceOptions({ DB_POOL_SIZE: '25', DB_POOL_QUEUE_LIMIT: '50' })).toMatchObject({
      poolSize: 25,
      extra: { queueLimit: 50 },
    })
  })

  it.each([
    ['DB_POOL_SIZE', '0'],
    ['DB_POOL_SIZE', 'ten'],
    ['DB_POOL_ACQUIRE_TIMEOUT_MS', '-1'],
    ['DB_POOL_QUEUE_LIMIT', '1.5'],
  ])('rejects %s=%s', (key, value) => {
    expect(EnvSchema.safeParse({ ...base, [key]: value }).success).toBe(false)
    expect(() => dataSourceOptions({ [key]: value })).toThrow(new RegExp(key))
  })
})

describe('against the test database', () => {
  let ds: DataSource
  const held: QueryRunner[] = []
  const hold = async () => {
    const qr = ds.createQueryRunner()
    await qr.connect()
    held.push(qr)
  }
  const open = async (extra: Record<string, string>) => {
    ds = new DataSource(dataSourceOptions({ ...process.env, DB_POOL_SIZE: '1', ...extra }))
    await ds.initialize()
  }
  afterEach(async () => {
    for (const qr of held.splice(0)) await qr.release()
    if (ds?.isInitialized) await ds.destroy()
  })

  it('a full pool fails the waiting query with QW_DB_POOL_TIMEOUT (a 503), then recovers', async () => {
    await open({ DB_POOL_ACQUIRE_TIMEOUT_MS: '150' })
    await hold()
    const failure = await ds.query('SELECT 1').catch((e: unknown) => e)
    expect((failure as NodeJS.ErrnoException).code).toBe(DB_POOL_TIMEOUT)
    expect(classify(failure)).toEqual({ err: Err.SERVICE_BUSY, status: 503 })
    await held.pop()!.release()
    expect(await ds.query('SELECT 1 AS one')).toEqual([{ one: 1 }])
  })

  it('a timed-out waiter frees its DB_POOL_QUEUE_LIMIT slot', async () => {
    await open({ DB_POOL_QUEUE_LIMIT: '1', DB_POOL_ACQUIRE_TIMEOUT_MS: '100' })
    await hold()
    const first = await ds.query('SELECT 1').catch((e: unknown) => e)
    expect((first as NodeJS.ErrnoException).code).toBe(DB_POOL_TIMEOUT)
    // the next request waits in the freed slot (not 'Queue limit reached.') and gets its connection
    const next = ds.query('SELECT 1 AS one')
    await held.pop()!.release()
    expect(await next).toEqual([{ one: 1 }])
  })

  it('a full wait queue (DB_POOL_QUEUE_LIMIT) fails at once with a 503', async () => {
    await open({ DB_POOL_QUEUE_LIMIT: '1' })
    await hold()
    const waiting = ds.query('SELECT 1 AS one')
    const failure = await ds.query('SELECT 1').catch((e: unknown) => e)
    expect(classify(failure)).toEqual({ err: Err.SERVICE_BUSY, status: 503 })
    await held.pop()!.release()
    expect(await waiting).toEqual([{ one: 1 }])
  })
})

describe('HttpErrorFilter', () => {
  it.each([
    ['zh-CN', '服务繁忙，请稍后重试'],
    ['en-US', 'The service is busy, please try again later.'],
  ])(
    'answers a pool timeout with 503 and the %s message, without a fault log',
    async (lang, msg) => {
      const fault = vi.fn<() => void>()
      const ref = await Test.createTestingModule({
        imports: [CoreContextModule, CoreI18nModule],
        providers: [HttpErrorFilter, { provide: AuditWriter, useValue: { fault } }],
      }).compile()
      const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      try {
        const filter = ref.get(HttpErrorFilter)
        const json = vi.fn<(body: unknown) => void>()
        const status = vi.fn<(code: number) => unknown>()
        const res = { setHeader: () => res, status: (code: number) => (status(code), res), json }
        const req = {
          method: 'GET',
          originalUrl: '/api/probe',
          url: '/api/probe',
          get: () => undefined,
          headers: { 'accept-language': lang },
          query: {},
          body: {},
        }
        const host = {
          switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
        } as unknown as ArgumentsHost
        const error = Object.assign(new Error('pool timed out'), { code: DB_POOL_TIMEOUT })
        filter.catch(error, host)
        expect(status).toHaveBeenCalledWith(503)
        expect(json).toHaveBeenCalledWith(
          expect.objectContaining({ code: Err.SERVICE_BUSY.code, msg }),
        )
        // expected overload, not a fault: no error log, no fault row queued on the exhausted pool
        expect(logError).not.toHaveBeenCalled()
        expect(fault).not.toHaveBeenCalled()
      } finally {
        await ref.close()
      }
    },
  )
})
