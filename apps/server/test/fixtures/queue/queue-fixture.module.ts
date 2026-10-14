// Test-only queues and processors (see docs/queue.md): imported beside AppModule by the queue specs,
// never shipped in src. Every handler records what it saw in `seen`.
import { setTimeout as sleep } from 'node:timers/promises'
import { Processor } from '@nestjs/bullmq'
import { Body, Controller, HttpCode, Module, Post } from '@nestjs/common'
import { ApiExcludeController } from '@nestjs/swagger'
import type { Job } from 'bullmq'
import { SkipActionLog } from '../../../src/core/audit/action-log.js'
import { tenantIdIfAny } from '../../../src/core/context/tenant.js'
import { registerQueue } from '../../../src/core/queue/queue-registry.js'
import { QueueService } from '../../../src/core/queue/queue.service.js'
import { type QueuedJob, TenantJobProcessor } from '../../../src/core/queue/tenant-job.processor.js'

/** echoes its payload; `{ sleepMs }` makes it take that long */
export const ECHO = 'test-echo'
/** always throws: `{ message }` of the payload, else 'flaky failure' */
export const FLAKY = 'test-flaky'
/** platform-wide: its jobs name no tenant */
export const PLATFORM = 'test-platform'

export interface Seen {
  queue: string
  jobId: string
  /** the context's tenant inside the handler (undefined: none) */
  tenant: number | undefined
  payload: unknown
  /** attempts made before this one */
  attempt: number
  at: number
  /** the handler returned (slow jobs record their start and their end) */
  done?: boolean
}
export const seen: Seen[] = []

const record = (queue: string, job: Job<QueuedJob>, extra: Partial<Seen> = {}) =>
  seen.push({
    queue,
    jobId: String(job.id),
    tenant: tenantIdIfAny(),
    payload: job.data.payload,
    attempt: job.attemptsMade,
    at: Date.now(),
    ...extra,
  })

@Processor(ECHO)
class EchoProcessor extends TenantJobProcessor<{ sleepMs?: number } | undefined, unknown> {
  protected async handle(payload: { sleepMs?: number } | undefined, job: Job<QueuedJob>) {
    record(ECHO, job)
    if (payload?.sleepMs) {
      await sleep(payload.sleepMs)
      record(ECHO, job, { done: true })
    }
    return payload
  }
}

@Processor(FLAKY)
class FlakyProcessor extends TenantJobProcessor {
  protected async handle(payload: unknown, job: Job<QueuedJob>): Promise<never> {
    record(FLAKY, job)
    throw new Error((payload as { message?: string } | undefined)?.message ?? 'flaky failure')
  }
}

@Processor(PLATFORM)
class PlatformProcessor extends TenantJobProcessor {
  protected async handle(_: unknown, job: Job<QueuedJob>) {
    record(PLATFORM, job)
  }
}

/** Adds an echo job in the caller's session tenant (a signed-in request). */
@Controller('queue-fixture')
@ApiExcludeController()
class QueueFixtureController {
  constructor(private readonly queues: QueueService) {}

  @Post('echo')
  @HttpCode(200)
  @SkipActionLog()
  async echo(@Body() body: unknown) {
    const job = await this.queues.add(ECHO, 'echo', body)
    return { id: job.id, tenantId: job.data.tenantId }
  }
}

@Module({
  imports: [registerQueue({ name: ECHO }, { name: FLAKY }, { name: PLATFORM, platform: true })],
  controllers: [QueueFixtureController],
  providers: [EchoProcessor, FlakyProcessor, PlatformProcessor],
})
export class QueueFixtureModule {}
