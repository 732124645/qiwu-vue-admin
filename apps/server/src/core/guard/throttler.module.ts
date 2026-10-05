import { ThrottlerModule } from '@nestjs/throttler'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { RedisThrottlerStorage } from './redis-throttler.storage.js'

// Routes opt in with ThrottlerGuard + @Throttle (@RateLimit wraps both); tracker = req.ip,
// so `trust proxy` (main.ts, env TRUST_PROXY) decides which client IP counts.
export const CoreThrottlerModule = ThrottlerModule.forRootAsync({
  inject: [REDIS],
  useFactory: (redis: Redis) => ({
    throttlers: [{ ttl: 60_000, limit: 100 }],
    storage: new RedisThrottlerStorage(redis),
  }),
})
