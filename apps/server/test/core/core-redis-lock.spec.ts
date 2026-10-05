// core/guard RedisLock: SET NX PX, renewed every ttl/3 while held, released only by
// its own token (Lua compare-and-delete), a lease that lost its key never deletes the next holder's; a
// renewal not confirmed (taken over, failed, unanswered) ends the lease and aborts its `lost` signal.
import { setTimeout as sleep } from 'node:timers/promises'
import { Test, type TestingModule } from '@nestjs/testing'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { LockLostError, RedisLock } from '../../src/core/guard/redis-lock.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { CoreRedisModule, REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'

let moduleRef: TestingModule
let locks: RedisLock
let redis: Redis
let seq = 0
const key = () => redisKey('lock', 'core-redis-lock', ++seq)
/**
 * Polls until `check` passes: a renewal answers on its own schedule, late on a loaded machine. Fixed
 * sleeps remain only where time must pass (outliving the ttl, a Redis-side expiry, nothing afterwards).
 */
const until = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 3000 })

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreConfigModule.forRoot(), CoreRedisModule],
    providers: [RedisLock],
  }).compile()
  locks = moduleRef.get(RedisLock)
  redis = moduleRef.get(REDIS)
  await cleanRedis(redis)
})

afterAll(async () => {
  if (redis) await cleanRedis(redis)
  await moduleRef?.close()
})

describe('RedisLock', () => {
  it('one holder at a time; free again after release', async () => {
    const k = key()
    const a = await locks.acquire(k, 5000)
    expect(a?.held).toBe(true)
    expect(await locks.acquire(k, 5000)).toBeNull()
    expect(await a!.release()).toBe(true)
    expect(a!.held).toBe(false)
    expect(await redis.exists(k)).toBe(0)
    const b = await locks.acquire(k, 5000)
    expect(b).not.toBeNull()
    await b!.release()
  })

  it('sets the ttl with the token as value', async () => {
    const k = key()
    const lease = await locks.acquire(k, 5000)
    const ttl = await redis.pTTL(k)
    expect(ttl).toBeGreaterThan(4000)
    expect(ttl).toBeLessThanOrEqual(5000)
    expect(await redis.get(k)).toMatch(/^[0-9a-f-]{36}$/)
    await lease!.release()
  })

  it('renews every ttl/3 while held: outlives its ttl, then released', async () => {
    const k = key()
    const lease = await locks.acquire(k, 300)
    await sleep(900)
    expect(lease!.held).toBe(true)
    expect(await redis.pTTL(k)).toBeGreaterThan(0)
    expect(await locks.acquire(k, 300)).toBeNull()
    await lease!.release()
    expect(await redis.exists(k)).toBe(0)
    // renewal stopped: nothing recreates or extends the key
    await sleep(250)
    expect(await redis.exists(k)).toBe(0)
  })

  it('expires without renewal: a key left by a crashed holder frees itself', async () => {
    const k = key()
    await redis.set(k, 'crashed-holder', { expiration: { type: 'PX', value: 150 } })
    expect(await locks.acquire(k, 5000)).toBeNull()
    await sleep(250)
    const lease = await locks.acquire(k, 5000)
    expect(lease).not.toBeNull()
    await lease!.release()
  })

  it('a lease that lost its key never deletes the next holder', async () => {
    const k = key()
    const lease = await locks.acquire(k, 300)
    // the key expired meanwhile and another holder took it
    await redis.set(k, 'next-holder', { expiration: { type: 'PX', value: 5000 } })
    // the renewal saw another token: lost
    await until(() => expect(lease!.held).toBe(false))
    expect(await lease!.release()).toBe(false)
    expect(await redis.get(k)).toBe('next-holder')
    expect(await redis.pTTL(k)).toBeGreaterThan(4000)
  })

  it('a takeover aborts `lost` (LockLostError); release never does', async () => {
    const k = key()
    const lease = await locks.acquire(k, 300)
    const released = await locks.acquire(key(), 300)
    await redis.set(k, 'next-holder', { expiration: { type: 'PX', value: 5000 } })
    await until(() => expect(lease!.lost.aborted).toBe(true))
    expect(lease!.lost.reason).toBeInstanceOf(LockLostError)
    await released!.release()
    await sleep(200)
    expect(released!.lost.aborted).toBe(false)
  })

  it('a failed renewal ends the lease at once: not held, `lost` aborted, no more renewals', async () => {
    const k = key()
    const lease = await locks.acquire(k, 300)
    const renew = vi.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('connection lost'))
    try {
      await until(() => expect(lease!.held).toBe(false))
    } finally {
      renew.mockRestore()
    }
    expect(lease!.held).toBe(false)
    expect(lease!.lost.aborted).toBe(true)
    expect(lease!.lost.reason).toBeInstanceOf(LockLostError)
    expect((lease!.lost.reason as Error).message).toMatch(/renewal failed/)
    // nobody extends the key: it expires by its ttl and another holder may take it
    await until(async () => expect(await redis.exists(k)).toBe(0))
    const next = await locks.acquire(k, 300)
    expect(next).not.toBeNull()
    await next!.release()
  })

  it('a renewal still unanswered at the next tick counts as lost too', async () => {
    const k = key()
    const lease = await locks.acquire(k, 300)
    const renew = vi.spyOn(redis, 'eval').mockImplementationOnce(() => new Promise(() => {}))
    try {
      await until(() => expect(lease!.held).toBe(false))
    } finally {
      renew.mockRestore()
    }
    expect(lease!.held).toBe(false)
    expect((lease!.lost.reason as Error).message).toMatch(/not answered/)
    await lease!.release()
  })

  it('release is idempotent', async () => {
    const k = key()
    const lease = await locks.acquire(k, 5000)
    expect(await lease!.release()).toBe(true)
    expect(await lease!.release()).toBe(false)
  })
})
