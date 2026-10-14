import { WorkerHost } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { DiscoveryService } from '@nestjs/core'
import { type Job, type JobsOptions, Queue, type Worker } from 'bullmq'
import { tenantId } from '../context/tenant.js'
import { isPlatformQueue } from './queue-registry.js'
import type { QueuedJob } from './tenant-job.processor.js'

/**
 * Adds jobs (see docs/queue.md) and finds the queues and workers registered in this app
 * (`registerQueue`, `@Processor` subclasses of `TenantJobProcessor`).
 */
@Injectable()
export class QueueService {
  private registry?: ReadonlyMap<string, Queue>

  constructor(private readonly discovery: DiscoveryService) {}

  /** Every queue registered in this app, by name (read once, after the modules were initialized). */
  queues(): ReadonlyMap<string, Queue> {
    this.registry ??= new Map(
      this.discovery
        .getProviders()
        .map((w) => w.instance as unknown)
        .filter((i): i is Queue => i instanceof Queue)
        .map((q) => [q.name, q]),
    )
    return this.registry
  }

  /** The workers of the processors in this app (each `@Processor` provider runs one). */
  workers(): Worker[] {
    return this.discovery
      .getProviders()
      .map((w) => w.instance as unknown)
      .filter((i): i is WorkerHost => i instanceof WorkerHost)
      .map((h) => (h as unknown as { _worker?: Worker })._worker)
      .filter((w): w is Worker => w !== undefined)
  }

  /**
   * Adds job `name` with `payload` to queue `queue`, recording the context's tenant with it (the
   * processor runs it there). Throws without a tenant in the context (`TenantContextMissing`), unless
   * the queue is platform-wide. `opts` override `QUEUE_JOB_DEFAULTS` per job. One queue holds every
   * tenant's jobs: in a tenant queue a custom `jobId` and a `deduplication.id` are stored as
   * `t{tenantId}-{id}` (the returned job's `id`), so equal ids of two tenants never collide.
   */
  async add<T>(
    queue: string,
    name: string,
    payload: T,
    opts?: JobsOptions,
  ): Promise<Job<QueuedJob<T>>> {
    const q = this.queues().get(queue)
    if (!q) throw new Error(`QueueService.add: no queue '${queue}' is registered`)
    const tid = isPlatformQueue(queue) ? null : tenantId()
    // an empty id is no custom id (BullMQ numbers the job), as in a platform queue
    const own = (id: string) => (tid === null || id === '' ? id : `t${tid}-${id}`)
    const data: QueuedJob<T> = { tenantId: tid, payload }
    return (await q.add(name, data, {
      ...opts,
      ...(opts?.jobId !== undefined && { jobId: own(opts.jobId) }),
      ...(opts?.deduplication && {
        deduplication: { ...opts.deduplication, id: own(opts.deduplication.id) },
      }),
    })) as Job<QueuedJob<T>>
  }
}
