import { applyDecorators, UseGuards } from '@nestjs/common'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { clsGet } from '../context/cls.js'
import { tenantId } from '../context/tenant.js'

/**
 * At most `limit` calls per `ttlMs` per client IP (`req.ip`, so `trust proxy` decides which address
 * counts; see docs/design-notes.md#security); the next one gets 429 `too_many_requests`. Route guard: runs after the global
 * AuthGuard/PermGuard.
 */
export const RateLimit = (limit: number, ttlMs: number, tracker: 'ip' | 'user' = 'ip') =>
  applyDecorators(
    UseGuards(ThrottlerGuard),
    Throttle({
      default: {
        limit,
        ttl: ttlMs,
        // 身份由已完成认证的 CLS 提供；同一办公网络中的员工各有自己的额度，不能伪造头切换。
        ...(tracker === 'user'
          ? { getTracker: () => `${tenantId()}:${clsGet('principal')!.userId}` }
          : {}),
      },
    }),
  )
