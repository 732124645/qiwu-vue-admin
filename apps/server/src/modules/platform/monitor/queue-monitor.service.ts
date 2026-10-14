import { Injectable } from '@nestjs/common'
import {
  Err,
  type Page,
  QUEUE_DATA_PREVIEW_MAX,
  type QueueJobsQuery,
  type QueueJobVo,
  type QueueVo,
} from '@qiwu/shared'
import { ErrorCode, type Job, type Queue } from 'bullmq'
import { BizError } from '../../../core/http/biz-error.js'
import type { QueuedJob } from '../../../core/queue/tenant-job.processor.js'
import { QueueService } from '../../../core/queue/queue.service.js'
import { redactedJson, textRedactor } from '../../../core/redact.js'

/**
 * BullMQ's rule for job ids: no `:`, or exactly two (its repeat and scheduler ids `repeat:<key>:<time>`).
 * Only ids found in a state list pass `job()` anyway.
 */
const JOB_ID = /^[^:]{1,256}(?::[^:]{1,256}:[^:]{1,256})?$/

/**
 * BullMQ refusing a job that changed between the state check and the write (it started, finished or
 * went meanwhile): its finished-state errors carry a numeric `code`, a locked job's removal only a
 * message. Gone → 404, the others → 409; anything else is a real error.
 */
async function orConflict(write: () => Promise<unknown>): Promise<void> {
  try {
    await write()
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === ErrorCode.JobNotExist) throw new BizError(Err.NOT_FOUND)
    if (typeof code === 'number' || /could not be removed because it is locked/.test(String(e)))
      throw new BizError(Err.CONFLICT)
    throw e
  }
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null)

/** `value` with `mask` applied to every string in it, any depth (keys stay). */
function maskStrings(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === 'string') return mask(value)
  if (Array.isArray(value)) return value.map((v) => maskStrings(v, mask))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskStrings(v, mask)]))
  return value
}

function jobVo(job: Job): QueueJobVo {
  const data = job.data as Partial<QueuedJob> | undefined
  // free text may quote the payload's secrets (an error message, a secret copied into another field):
  // their values are masked wherever they appear, as in a request's error message; in the data before
  // it is serialized (JSON would escape a secret's `"` or `\` and hide it from the mask)
  const mask = textRedactor(data?.payload)
  const json = redactedJson(maskStrings(data?.payload, mask), Number.MAX_SAFE_INTEGER)
  return {
    id: String(job.id),
    name: job.name,
    tenantId: typeof data?.tenantId === 'number' ? data.tenantId : null,
    attemptsMade: job.attemptsMade,
    attempts: job.opts.attempts ?? 1,
    failedReason: job.failedReason ? mask(job.failedReason) : null,
    createdAt: new Date(job.timestamp).toISOString(),
    processedAt: iso(job.processedOn),
    finishedAt: iso(job.finishedOn),
    data: json?.slice(0, QUEUE_DATA_PREVIEW_MAX) ?? null,
  }
}

/**
 * The queue page: counts per registered queue, one state's jobs, retrying and removing a job. Jobs of
 * every tenant: the routes are root only while multi-tenancy is on. An unknown queue or job is 404.
 */
@Injectable()
export class QueueMonitorService {
  constructor(private readonly queues: QueueService) {}

  private queue(name: string): Queue {
    const q = this.queues.queues().get(name)
    if (!q) throw new BizError(Err.NOT_FOUND)
    return q
  }

  /**
   * The job and its state; 404 unless it is in one of the queue's state lists (a queue's own keys,
   * `meta` or `events`, read as a hash too, but are in none).
   */
  private async job(name: string, id: string): Promise<[Job, string]> {
    const q = this.queue(name)
    let job: Job | undefined
    let state = 'unknown'
    try {
      job = JOB_ID.test(id) ? await q.getJob(id) : undefined
      if (job) state = await job.getState()
    } catch (e) {
      // the id named one of the queue's own keys of another type (`wait` is a list): no job
      if (!String(e).includes('WRONGTYPE')) throw e
    }
    if (!job || state === 'unknown') throw new BizError(Err.NOT_FOUND)
    return [job, state]
  }

  list(): Promise<QueueVo[]> {
    const queues = [...this.queues.queues().values()].sort((a, b) => a.name.localeCompare(b.name))
    return Promise.all(
      queues.map(async (q) => {
        const [c, paused] = await Promise.all([
          q.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed', 'completed'),
          q.isPaused(),
        ])
        return {
          name: q.name,
          waiting: c.waiting ?? 0,
          prioritized: c.prioritized ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
          completed: c.completed ?? 0,
          paused,
        }
      }),
    )
  }

  async jobs(
    name: string,
    { state, page, pageSize, sort }: QueueJobsQuery,
  ): Promise<Page<QueueJobVo>> {
    const q = this.queue(name)
    const start = (page - 1) * pageSize
    const asc = sort?.[0]?.order === 'ASC'
    const [jobs, total] = await Promise.all([
      q.getJobs([state], start, start + pageSize - 1, asc),
      q.getJobCountByTypes(state),
    ])
    // a job removed between the two reads comes back empty
    return { items: jobs.filter(Boolean).map(jobVo), total }
  }

  /**
   * A failed job runs again with its attempts (and backoff) started over; any other state, or one it
   * left meanwhile, is 409.
   */
  async retry(name: string, id: string): Promise<void> {
    const [job, state] = await this.job(name, id)
    if (state !== 'failed') throw new BizError(Err.CONFLICT)
    await orConflict(() =>
      job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true }),
    )
  }

  /** Removes a job that is not running (409 while a worker holds it). */
  async remove(name: string, id: string): Promise<void> {
    const [job, state] = await this.job(name, id)
    if (state === 'active') throw new BizError(Err.CONFLICT)
    await orConflict(() => job.remove())
  }
}
