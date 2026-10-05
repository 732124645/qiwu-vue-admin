import { setTimeout as sleep } from 'node:timers/promises'
import { Logger } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { Err } from '@qiwu/shared'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { RedisThrottlerStorage } from '../../src/core/guard/redis-throttler.storage.js'
import { classify } from '../../src/core/http/http-error.filter.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { CoreRedisModule, REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'

let ref: TestingModule
let redis: Redis
let storage: RedisThrottlerStorage
let seq = 0
const key = () => `throttle-test-${++seq}`
const hit = (k: string, ttl = 1000, limit = 2, block = ttl, name = 'default') =>
  storage.increment(k, ttl, limit, block, name)
const keys = (k: string, name = 'default') =>
  ['hits', 'state'].map((part) => redisKey('throttle', name, k, part))

beforeAll(async () => {
  ref = await Test.createTestingModule({
    imports: [CoreConfigModule.forRoot(), CoreRedisModule],
  }).compile()
  redis = ref.get(REDIS)
  storage = new RedisThrottlerStorage(redis)
  await cleanRedis(redis)
})

afterAll(async () => {
  if (redis) await cleanRedis(redis)
  await ref?.close()
})

it('atomically counts concurrent hits once and isolates key/name buckets', async () => {
  const k = key()
  const results = await Promise.all(Array.from({ length: 20 }, () => hit(k, 5000, 20)))
  expect(results.map((r) => r.totalHits).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 20 }, (_, i) => i + 1),
  )
  expect(results.every((r) => !r.isBlocked)).toBe(true)
  expect(await redis.zCard(keys(k)[0]!)).toBe(20)
  expect(await hit(k, 5000, 20)).toMatchObject({ totalHits: 21, isBlocked: true })
  expect(await hit(k, 5000, 20, 5000, 'other')).toMatchObject({ totalHits: 1, isBlocked: false })
  expect(await hit(key())).toMatchObject({ totalHits: 1, isBlocked: false })
})

it('expires each hit independently: an older first hit does not discard the second', async () => {
  const k = key()
  await hit(k, 1000, 10)
  await sleep(650)
  await hit(k, 1000, 10)
  await sleep(500)
  expect(await hit(k, 1000, 10)).toEqual({
    totalHits: 2,
    timeToExpire: 1,
    isBlocked: false,
    timeToBlockExpire: 0,
  })
})

it.each([150, 1200])(
  'keeps a fixed %i ms block, even across hit expiry, then starts at one',
  async (block) => {
    const k = key()
    await hit(k, 400, 1, block)
    const refused = await hit(k, 400, 1, block)
    expect(refused).toMatchObject({
      totalHits: 2,
      isBlocked: true,
      timeToBlockExpire: Math.ceil(block / 1000),
    })
    const end = await redis.hGet(keys(k)[1]!, 'blockEnd')
    await sleep(block === 1200 ? 500 : 50)
    const again = await hit(k, 400, 1, block)
    expect(again.isBlocked).toBe(true)
    expect(again.timeToBlockExpire).toBeGreaterThan(0)
    expect(await redis.hGet(keys(k)[1]!, 'blockEnd')).toBe(end)
    expect(await redis.zCard(keys(k)[0]!)).toBeLessThanOrEqual(2)
    await sleep(block)
    expect(await hit(k, 400, 1, block)).toMatchObject({
      totalHits: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    })
  },
)

it('incrementWithoutBlock refuses without adding a hit and accepts after the oldest expires', async () => {
  const k = key()
  await hit(k, 200, 1, 0)
  expect(await hit(k, 200, 1, 0)).toMatchObject({
    totalHits: 2,
    isBlocked: true,
    timeToBlockExpire: 1,
  })
  expect(await redis.zCard(keys(k)[0]!)).toBe(1)
  await sleep(250)
  expect(await hit(k, 200, 1, 0)).toMatchObject({ totalHits: 1, isBlocked: false })
})

it('expires idle keys and uses Redis time even if an instance clock drifts', async () => {
  const k = key()
  const ttl = 1000
  expect(await hit(k, ttl, 1)).toMatchObject({ totalHits: 1, isBlocked: false })
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ttl + 1000)
  try {
    expect(await hit(k, ttl, 1)).toMatchObject({ totalHits: 2, isBlocked: true })
  } finally {
    clock.mockRestore()
  }
  await vi.waitFor(async () => expect(await redis.exists(keys(k))).toBe(0), { timeout: 2000 })
})

it('real Redis rejection and a destroyed connection fail closed as A0500', async () => {
  const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
  try {
    const k = key()
    await redis.set(keys(k)[0]!, 'wrong-type')
    await expect(hit(k)).rejects.toMatchObject({ err: Err.INTERNAL })
    const disconnected = redis.duplicate()
    disconnected.on('error', () => {})
    await disconnected.connect()
    disconnected.destroy()
    await expect(
      new RedisThrottlerStorage(disconnected).increment(k, 1000, 1, 1000, 'default'),
    ).rejects.toMatchObject({ err: Err.INTERNAL })
    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining('WRONGTYPE') })
    expect(log.mock.calls[1]![0]).toBeInstanceOf(Error)
  } finally {
    log.mockRestore()
  }
})

it('an unanswered Redis operation fails within its budget without leaking internals', async () => {
  vi.useFakeTimers()
  const options = vi.spyOn(redis, 'withCommandOptions').mockReturnValue({
    eval: () => new Promise(() => {}),
  } as unknown as Redis)
  try {
    const result = hit(key()).catch((error: unknown) => classify(error))
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toEqual({ err: Err.INTERNAL, status: 500, params: {} })
  } finally {
    options.mockRestore()
    vi.useRealTimers()
  }
})
