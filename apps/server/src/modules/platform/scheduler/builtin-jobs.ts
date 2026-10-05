import { setTimeout as sleep } from 'node:timers/promises'
import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { AUDIT_RETENTION_PARAM, DEFAULT_AUDIT_RETENTION_DAYS } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { sweepOnline } from '../../../core/auth/online-sweep.js'
import { REDIS, type Redis } from '../../../core/redis/redis.module.js'
import { JobHandler, type JobContext } from '../../../core/scheduler/job-handler.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { StorageService } from '../storage/storage.service.js'

const echoParams = z.object({
  message: z.string().max(200).default('hello'),
  /** waits this long first (abortable): shows timeouts and overlap on the pages */
  delayMs: z.number().int().min(0).max(600_000).default(0),
})

/** Rows per purge statement: short locks on busy log tables, a signal check in between. */
const PURGE_BATCH = 5000
/**
 * What `audit.purge` clears (the log and record tables, the notification
 * outbox and the SMS codes; see docs/design-notes.md#audit): table, time column, extra condition. Constants only (the statement
 * concatenates them); API error logs only once handled (or deleted).
 * The msg_* tables have no index on created_at, so each run ends with one scan of each; add
 * one in a migration if they grow large.
 */
const PURGE: [table: string, time: string, extra: string][] = [
  ['aud_action_log', 'created_at', ''],
  ['aud_signin_log', 'created_at', ''],
  ['aud_http_trace', 'started_at', ''],
  [
    'aud_http_fault',
    'created_at',
    " AND (state IN ('resolved', 'ignored') OR deleted_at IS NOT NULL)",
  ],
  ['job_run', 'started_at', ''],
  ['msg_inbox', 'created_at', ''],
  ['msg_mail_record', 'created_at', ''],
  ['msg_sms_record', 'created_at', ''],
  ['msg_sms_otp', 'created_at', ''],
]

/** The built-in handlers; each responds to its signal. */
@Injectable()
export class BuiltinJobs {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly params: ParamService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Deletes for good what is older than `audit.retention_days` (default 180), in batches:
   * the PURGE rows by their time, soft-deleted or not, then the stored files deleted (soft) before then,
   * body and row (StorageService.purgeDeleted).
   */
  @JobHandler('audit.purge')
  async purge(_params: object, { signal, log }: JobContext) {
    const days = await this.params.int(
      AUDIT_RETENTION_PARAM,
      1,
      36_500,
      DEFAULT_AUDIT_RETENTION_DAYS,
    )
    const before = new Date(Date.now() - days * 86_400_000)
    for (const [table, time, extra] of PURGE) {
      let deleted = 0
      for (;;) {
        signal.throwIfAborted()
        // qw:include-deleted expired rows go whether an administrator deleted them already or not
        const res: { affectedRows: number } = await this.ds.query(
          // arch-allow: sql-concat table, column and condition are the PURGE constants; the time is bound
          `DELETE FROM ${table} WHERE ${time} < ?${extra} LIMIT ${PURGE_BATCH}`,
          [before],
        )
        deleted += res.affectedRows
        if (res.affectedRows < PURGE_BATCH) break
      }
      log(`${table}: ${deleted}`)
    }
    log(`fs_object: ${await this.storage.purgeDeleted(before, signal)}`)
    return `kept ${days} days (before ${before.toISOString()} deleted)`
  }

  /** Drops ended sessions from the online list's indexes (core/auth). */
  @JobHandler('session.sweep')
  async sweep() {
    return `removed ${await sweepOnline(this.redis)}`
  }

  /** Echoes its message after `delayMs`: a harmless task to try the pages with. */
  @JobHandler('demo.echo', echoParams)
  async echo({ message, delayMs }: z.output<typeof echoParams>, { signal }: JobContext) {
    if (delayMs) await sleep(delayMs, undefined, { signal })
    return message
  }
}
