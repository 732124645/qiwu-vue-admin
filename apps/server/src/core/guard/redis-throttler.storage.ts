import { randomUUID } from 'node:crypto'
import { Logger } from '@nestjs/common'
import type { ThrottlerStorage } from '@nestjs/throttler'
import { Err } from '@qiwu/shared'
import { BizError } from '../http/biz-error.js'
import { redisKey } from '../redis/cache-namespaces.js'
import type { Redis } from '../redis/redis.module.js'

// Redis TIME is shared by all instances. Hits expire individually, as in throttler 6.7.1.
const INCREMENT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl, limit, duration = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local reset = tonumber(redis.call('HGET', KEYS[2], 'resetAt')) or 0
local blockEnd = tonumber(redis.call('HGET', KEYS[2], 'blockEnd')) or 0
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - ttl)
if reset <= now then reset = now + ttl end
if blockEnd > 0 and blockEnd <= now then
  redis.call('DEL', KEYS[1])
  blockEnd = 0
end
local hits = redis.call('ZCARD', KEYS[1])
local blocked = blockEnd > now
local retry = math.max(0, blockEnd - now)
if not blocked then
  local refused = hits >= limit
  -- incrementWithoutBlock: rejected hits are not stored when no timed block is configured.
  if not refused or duration > 0 then
    redis.call('ZADD', KEYS[1], now, ARGV[4])
  end
  hits = hits + 1
  if refused then
    local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
    retry = duration > 0 and duration or (#first > 0 and tonumber(first[2]) + ttl - now or reset - now)
    blockEnd = duration > 0 and now + duration or 0
    blocked = true
  end
end
redis.call('HSET', KEYS[2], 'resetAt', reset, 'blockEnd', blockEnd)
local retention = math.max(ttl, reset - now, blockEnd - now)
redis.call('PEXPIRE', KEYS[1], retention)
redis.call('PEXPIRE', KEYS[2], retention)
return {hits, math.ceil((reset - now) / 1000), blocked and 1 or 0, math.ceil(math.max(0, retry) / 1000)}
`

/**
 * Shared atomic rolling buckets, no memory fallback. The guard still owns tracker/key generation.
 * ZSET size is bounded by limit + 1 per active handler/IP; consider approximate counters
 * only if measured traffic makes this too costly. Single Redis node, no Cluster promise.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name)

  constructor(private readonly redis: Redis) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, name: string) {
    let timer: NodeJS.Timeout | undefined
    try {
      // Abort queued work too: a timed-out request must not execute after Redis reconnects.
      const signal = AbortSignal.timeout(5_000)
      const result = (await Promise.race([
        this.redis.withCommandOptions({ abortSignal: signal }).eval(INCREMENT, {
          keys: [redisKey('throttle', name, key, 'hits'), redisKey('throttle', name, key, 'state')],
          arguments: [String(ttl), String(limit), String(blockDuration), randomUUID()],
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new BizError(Err.INTERNAL)), 5_000)
        }),
      ])) as number[]
      return {
        totalHits: result[0]!,
        timeToExpire: result[1]!,
        isBlocked: result[2] === 1,
        timeToBlockExpire: result[3]!,
      }
    } catch (error) {
      this.logger.error(error)
      throw new BizError(Err.INTERNAL)
    } finally {
      clearTimeout(timer)
    }
  }
}
