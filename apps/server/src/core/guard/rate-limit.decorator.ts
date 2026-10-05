import { applyDecorators, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'

/**
 * At most `limit` calls per `ttlMs` per client IP (`req.ip`, so `trust proxy` decides which address
 * counts; see docs/design-notes.md#security); the next one gets 429 `too_many_requests`. Route guard: runs after the global
 * AuthGuard/PermGuard.
 */
export const RateLimit = (limit: number, ttlMs: number) =>
  applyDecorators(UseGuards(ThrottlerGuard), Throttle({ default: { limit, ttl: ttlMs } }))
