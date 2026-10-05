import type { CronNextVo, JobMisfire, JobOutcome, Page } from '@qiwu/shared'
import { api } from '@/core/request/http'

const TASKS = '/scheduler/tasks'

/** A task as `GET /scheduler/tasks/:id` answers it (the generated task VO): what the detail shows. */
export interface JobTaskView {
  id: number
  /** i18n key (seeded tasks, `seed.*`) or text */
  name: string
  groupCode: string | null
  handler: string
  /** JSON object (or its text); null = none */
  params: unknown
  cron: string
  enabled: boolean
  retryMax: number
  retryDelayMs: number
  timeoutMs: number
  allowOverlap: boolean
  misfire: JobMisfire
  lastFireAt: string | null
  note: string | null
}

/** A row of `GET /scheduler/runs` (the generated run VO): what the detail shows. */
export interface JobRunView {
  id: number
  attempt: number
  outcome: JobOutcome
  startedAt: string
  endedAt: string | null
  costMs: number | null
  error: string | null
}

/** How many runs the task detail lists. */
export const RECENT_RUNS = 10

/**
 * The scheduler calls beside the generated task / run CRUD (contracts in
 * `@qiwu/shared` platform/scheduler/scheduler.schema.ts), and the task detail's reads.
 */
export const jobApi = {
  /** the next fire times of a cron (the server's cron); silent: the caller shows a rejected cron itself */
  nextFireTimes: (cron: string) =>
    api.get<CronNextVo>(`${TASKS}/next-fire-times`, { params: { cron }, silent: true }),
  task: (id: number) => api.get<JobTaskView>(`${TASKS}/${id}`),
  /** the task's latest runs, newest first (the run list's default order) */
  recentRuns: (taskId: number) =>
    api.get<Page<JobRunView>>('/scheduler/runs', {
      params: { taskId, page: 1, pageSize: RECENT_RUNS },
    }),
}
