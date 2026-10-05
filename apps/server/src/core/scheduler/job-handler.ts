import { SetMetadata } from '@nestjs/common'
import { z } from 'zod'

/** What a job handler gets besides its params. */
export interface JobContext {
  /**
   * Aborted when the attempt times out (`job_task.timeout_ms`) or the app shuts down: the handler must
   * stop soon after (check it between steps, pass it on to fetch/timers). The task lock stays held
   * until the handler has really returned.
   */
  signal: AbortSignal
  /** Appends a line to the run's output (`job_run.output`, technical text, not translated). */
  log: (line: string) => void
}

/** Registry names: lowercase dotted (`audit.purge`, `demo.echo`). */
export const JOB_HANDLER_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/

/** Params of a handler that takes none: `{}` (or no params at all), nothing else. */
export const NO_PARAMS = z.object({}).strict()

export interface JobHandlerMeta {
  name: string
  /** the task's params (JSON object) are parsed with it before every run; its defaults fill a new task */
  params: z.ZodType
}

export const JOB_HANDLER = 'qw:job-handler'

/**
 * Marks a provider method as the scheduler handler `name` (whitelist): a task may only name a
 * registered handler, its params pass `params` (zod) at every write and every run; no reflection by
 * name, no code from the database. The method is `(params, ctx: JobContext) => Promise<unknown>`; what it
 * returns (text, or JSON of anything else) ends the run's output. Defined in core so core services
 * (notify.dispatch) can register handlers too; the scheduler module builds the registry.
 */
export const JobHandler = (name: string, params: z.ZodType = NO_PARAMS): MethodDecorator => {
  if (!JOB_HANDLER_NAME.test(name)) throw new Error(`@JobHandler: invalid name '${name}'`)
  return SetMetadata<string, JobHandlerMeta>(JOB_HANDLER, { name, params })
}
