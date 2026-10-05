import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Scheduler contracts besides the generated task / run CRUD: the handler registry, run
 * once and the next fire times of a cron. They sit on the task resource (`/api/scheduler/tasks`, field
 * labels `field.scheduler.task.<prop>` from its generated fragment; perms its generated `taskPerms`):
 * - `GET /tasks/handlers` → {@link JobHandlerVo}[]: the `@JobHandler` registry, the only values a task's
 *   `handler` may take (anything else → 422).
 * - `POST /tasks/:id/run` (no body) → {@link JobRunOnceVo}: fires the task once now with its stored params,
 *   `scheduledAt` = the request time (the `job:fire:` key with `allow_overlap=1`); the runs land in
 *   `job_run` as usual. No params override: `run` must not do what only `modify` may (e.g. purge with 0 days).
 * - `GET /tasks/next-fire-times?cron=` → {@link CronNextVo}: the next {@link CRON_NEXT_COUNT} fire times
 *   (the server's `validateCronExpression` + `CronTime.sendAt`; an expression it rejects → 400 on `cron`).
 */

/** A cron with 5 (minute …) or 6 (second …) fields of digits and `* , - /` only (`job_task.cron` ≤ 64). */
export const CRON_PATTERN = /^[\d*,/-]+(?:\s+[\d*,/-]+){4,5}$/

/** A task's cron: structural check here (no names, `?`, `L`, `W`, `#`, `@daily`); ranges on the server. */
export const cronExpr = z.string().trim().min(1).max(64).regex(CRON_PATTERN)

/** How many fire times the next-fire-times endpoint answers with (CronEditor, task detail drawer). */
export const CRON_NEXT_COUNT = 5

/** `job_task.misfire`: a fire missed while down is skipped (logged) or run once at start. */
export const JOB_MISFIRES = ['skip', 'run_once'] as const
export type JobMisfire = (typeof JOB_MISFIRES)[number]

/** `job_run.outcome`: `skipped` = the previous run still held the task lock (`allow_overlap=0`). */
export const JOB_OUTCOMES = ['ok', 'failed', 'skipped', 'timeout'] as const
export type JobOutcome = (typeof JOB_OUTCOMES)[number]

const isJsonObject = (text: string) => {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v)
  } catch {
    return false
  }
}

/**
 * A task's `params` as edited: JSON object text (blank = none → null); the handler's own zod schema checks
 * the content on the server.
 */
export const jobParamsText = blankAsNull(
  z.string().trim().max(4000).refine(isJsonObject, { error: 'validation.json_object' }),
)

export const jobHandlerVo = z.object({
  /** registry name (`audit.purge`); label on the page: `scheduler.handler.<name>` */
  name: z.string(),
  /** params a new task with this handler starts with (JSON of its schema's defaults); null = none */
  defaultParams: z.string().nullable(),
})
export type JobHandlerVo = z.infer<typeof jobHandlerVo>

export const jobRunOnceVo = z.object({ scheduledAt: z.iso.datetime() })
export type JobRunOnceVo = z.infer<typeof jobRunOnceVo>

export const cronNextQuery = z
  .object({ cron: cronExpr })
  .register(fieldDomains, { domain: 'scheduler.task' })
export type CronNextQuery = z.output<typeof cronNextQuery>

export const cronNextVo = z.object({ times: z.array(z.iso.datetime()) })
export type CronNextVo = z.infer<typeof cronNextVo>
