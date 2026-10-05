import { redisKey } from '../redis/cache-namespaces.js'
import type { Redis } from '../redis/redis.module.js'
import { MAX_SESSION_MS } from './token.service.js'

/**
 * The `session.sweep` job: drops ended sessions from the online indexes, the trims a
 * sign-in does too (TokenService ISSUE) for when nobody signs in for a while: `auth:online` members whose
 * refresh expired, `auth:seen` entries older than any session lives. Session keys expire by themselves.
 * Returns how many entries went.
 */
export async function sweepOnline(redis: Redis, now = Date.now()): Promise<number> {
  const [online, seen] = await redis
    .multi()
    .zRemRangeByScore(redisKey('authOnline'), '-inf', now)
    .zRemRangeByScore(redisKey('authSeen'), '-inf', now - MAX_SESSION_MS)
    .exec()
  return Number(online) + Number(seen)
}
