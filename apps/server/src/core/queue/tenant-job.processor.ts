import { randomUUID } from 'node:crypto'
import { WorkerHost } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { ClsServiceManager } from 'nestjs-cls'
import type { AppClsStore } from '../context/cls.js'
import { clearTenantContext, withTenant } from '../context/tenant.js'
import { driverMasked } from '../redact.js'
import { isPlatformQueue } from './queue-registry.js'

/** What `QueueService.add` stores as a job's data: the caller's tenant and the payload. */
export interface QueuedJob<T = unknown> {
  /** the tenant whose context added the job; null only in a platform-wide queue */
  tenantId: number | null
  payload: T
}

/**
 * Base of every queue processor (see docs/queue.md): `@Processor('<queue>')` on a subclass that
 * implements `handle`. Each job runs in a context of its own (new trace id, no inherited tenant) inside
 * the tenant that added it; a job naming no valid tenant fails at once, without retries. A platform-wide
 * queue's jobs (tenant null) run with no tenant: tenant tables are out of reach there.
 */
export abstract class TenantJobProcessor<T = unknown, R = unknown> extends WorkerHost {
  /** The job's work, in its tenant. Throwing fails this attempt (retried as the job's options say). */
  protected abstract handle(payload: T, job: Job<QueuedJob<T>>): Promise<R>

  async process(job: Job<QueuedJob<T>>): Promise<R> {
    const cls = ClsServiceManager.getClsService<AppClsStore>()
    return cls.run({ ifNested: 'override' }, () => {
      cls.set('traceId', randomUUID())
      clearTenantContext()
      const tid = (job.data as Partial<QueuedJob<T>> | undefined)?.tenantId
      if (tid === null && isPlatformQueue(job.queueName)) return this.run(job)
      if (typeof tid !== 'number' || !Number.isSafeInteger(tid) || tid < 1)
        throw new UnrecoverableError(`job ${job.id} of queue ${job.queueName} names no tenant`)
      // qw:cross-tenant a queued job runs in the tenant that added it (QueueService.add wrote it)
      return withTenant(tid, () => this.run(job))
    })
  }

  /**
   * `handle`, with a database driver's error message masked as in the error log (it may quote row
   * values, e.g. a duplicate key): BullMQ stores the message as the job's failure reason. The error
   * itself is rethrown, so its class (`UnrecoverableError`) still decides about retries.
   */
  private async run(job: Job<QueuedJob<T>>): Promise<R> {
    try {
      return await this.handle(job.data.payload, job)
    } catch (e) {
      if (e instanceof Error) e.message = driverMasked(e.message, e)
      throw e
    }
  }
}
