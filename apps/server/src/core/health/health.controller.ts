import { Controller, Get, Inject } from '@nestjs/common'
import {
  HealthCheckService,
  type HealthCheckResult,
  HealthIndicatorService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus'
import { z } from 'zod'
import { SkipHttpTrace } from '../audit/http-trace.js'
import { Public } from '../auth/decorators.js'
import { ApiEnvelope } from '../http/api-envelope.decorator.js'
import { REDIS, type Redis } from '../redis/redis.module.js'

const TIMEOUT_MS = 1000
const Indicators = z.record(z.string(), z.looseObject({ status: z.enum(['up', 'down']) }))
const Health = z.object({
  status: z.literal('ok'),
  info: Indicators,
  error: Indicators,
  details: Indicators,
})

/**
 * Readiness probe (`pnpm smoke:boot`, later the container healthcheck): MySQL and Redis each
 * answer a ping within 1 s → 200 with terminus' result (`details.db`, `details.redis`); otherwise 503
 * (the error envelope: nothing internal leaks to this public route; terminus logs which check failed).
 * Probes never land in the API access log, even in its `all` mode.
 */
@SkipHttpTrace()
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly indicator: HealthIndicatorService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiEnvelope(Health)
  check(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.db.pingCheck('db').withTimeout(TIMEOUT_MS),
      () =>
        this.indicator
          .check('redis')
          .attempt(async () => void (await this.redis.ping()))
          .withTimeout(TIMEOUT_MS),
    ])
  }
}
