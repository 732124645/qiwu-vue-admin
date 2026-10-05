import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common'
import { SchedulerRegistry } from '@nestjs/schedule'
import { InjectDataSource } from '@nestjs/typeorm'
import type { JobOutcome } from '@qiwu/shared'
import { CronJob, CronTime } from 'cron'
import { ClsService } from 'nestjs-cls'
import type { DataSource } from 'typeorm'
import type { AppClsStore } from '../../../core/context/cls.js'
import { RedisLock } from '../../../core/guard/redis-lock.js'
import { Notifier } from '../../../core/notify/notify.js'
import { redisChannel, redisKey } from '../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../core/redis/redis.module.js'
import { JobRegistry, type RegisteredJob } from './job-registry.js'
import { Run } from './run/run.entity.js'
import { Task } from './task/task.entity.js'

/** What started a fire: its cron, `POST /tasks/:id/run`, the misfire catch-up at start (`run_once`). */
export type JobTrigger = 'cron' | 'manual' | 'misfire'

/** `job_run.output` / `.error` are text columns: keep them readable, never near the 64 KB limit. */
const OUTPUT_MAX = 16_000
const ERROR_MAX = 4000
/** How long shutdown waits for aborted runs to return. */
const SHUTDOWN_WAIT_MS = 10_000
/**
 * `job:lock:{id}` (allow_overlap = 0): renewed every ttl/3 while the handler runs, so ttl only bounds a
 * crash; a catch-up that finds it held is tried again after it.
 */
const LOCK_TTL_MS = 30_000
/** `job:fire:{id}:{scheduledAt}`: long enough to outlast any duplicate tick of the same fire time. */
const FIRE_KEY_TTL_MS = 5 * 60_000
/** How often an instance compares its cron jobs with the stored tasks (a missed `job:sync` heals here). */
const RECONCILE_MS = 60_000
/** setTimeout's limit (2^31 - 1 ms); the schema caps timeouts at a day anyway. */
const TIMER_MAX_MS = 2_147_483_647

const cronName = (taskId: number) => `job_task:${taskId}`
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const errorText = (err: unknown) =>
  clip(err instanceof Error ? `${err.name}: ${err.message}` : String(err), ERROR_MAX)
const outputText = (lines: string[], value: unknown) => {
  if (value !== undefined && value !== null)
    lines.push(typeof value === 'string' ? value : JSON.stringify(value))
  return lines.length ? clip(lines.join('\n'), OUTPUT_MAX) : null
}

/** The handler did not return within the task's `timeout_ms`: its signal is aborted with this. */
export class JobTimeoutError extends Error {
  override name = 'JobTimeoutError'
}

/**
 * The scheduler engine: every enabled task is a cron job in @nestjs/schedule's
 * SchedulerRegistry, loaded at start and re-synced after each task write (`changed`: this instance at
 * once, every other one through the Redis channel `job:sync`, and every minute each instance reconciles
 * its cron jobs with the stored tasks, so a missed message heals), fired by its cron or once on request
 * (`runOnce`). Syncs of one task run one after another, each reading the task fresh. A fire runs the task's registered handler with its params in a fresh CLS context (a cron
 * timer created during a request would otherwise inherit that request's principal) and writes one
 * `job_run` row per attempt. A cron tick first checks the stored task still has that cron and is
 * enabled: a stale schedule (a write whose broadcast this instance missed) runs nothing and re-syncs.
 * On shutdown running handlers are aborted and awaited.
 *
 * Single execution: each fire time runs once (`job:fire:{id}:{scheduledAt}`, SET NX, 5 min: a
 * duplicate tick or another instance's tick of the same time does nothing); `allow_overlap = 0` also takes
 * the task lock `job:lock:{id}` for the whole fire, so a fire that finds the previous one still running is
 * recorded `skipped`; `allow_overlap = 1` lets different fire times run side by side. A handler past its
 * `timeout_ms` has its signal aborted and the attempt is recorded `timeout` (+ a warn log); the lock stays
 * renewed until the handler has really returned, so the next fire never overlaps it. A lock whose renewal
 * is not confirmed is lost (another instance may take it once it expires): the handler is aborted, the
 * attempt recorded `failed` with the LockLostError, and no retry follows.
 *
 * Retries: a failed or timed-out attempt is retried `retry_max` times, `retry_delay_ms` apart, each
 * attempt one `job_run` row (`attempt` 1, 2, …), all under the same lock. Misfire (at start): a fire time
 * that passed while the app was down is either recorded as one `skipped` run (`skip`) or run once
 * (`run_once`), however many were missed; a catch-up stays pending in `misfire_pending_at` until it
 * starts, so a crash before that leaves it for the next start (see `catchUp`).
 */
@Injectable()
export class JobScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(JobScheduler.name)
  /** fires in progress (shutdown waits for them) */
  private readonly inflight = new Set<Promise<void>>()
  /** abort controllers of the running handlers */
  private readonly running = new Set<AbortController>()
  /** aborted at shutdown: no new schedules, no more retries */
  private readonly stopping = new AbortController()
  /** this instance in `job:sync` messages (it skips its own) */
  private readonly instance = randomUUID()
  /** the `job:sync` subscriber (a connection of its own: a subscribed client runs no commands) */
  private sub: Redis | null = null
  /** catch-ups waiting for the task lock to try again */
  private readonly retries = new Set<NodeJS.Timeout>()
  /** the last sync of each task being synced: the next one waits for it (no older read wins) */
  private readonly syncing = new Map<number, Promise<void>>()
  private reconciler: NodeJS.Timeout | undefined

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly crons: SchedulerRegistry,
    private readonly jobs: JobRegistry,
    private readonly cls: ClsService<AppClsStore>,
    private readonly locks: RedisLock,
    private readonly notifier: Notifier,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private get tasks() {
    return this.ds.getRepository(Task)
  }

  async onApplicationBootstrap(): Promise<void> {
    // subscribed before loading: a write racing the start reaches this instance either way
    this.sub = this.redis.duplicate()
    this.sub.on('error', (err: unknown) => this.logger.error({ err }, 'job:sync subscriber'))
    await this.sub.connect()
    await this.sub.subscribe(redisChannel('jobSync'), (message) => this.onSync(message))
    for (const task of await this.tasks.findBy({ enabled: true })) {
      // through sync: a message handled meanwhile is never overwritten by this older read
      await this.sync(task.id)
      await this.catchUp(task).catch((err: unknown) =>
        this.logger.error({ taskId: task.id, err }, 'misfire check failed'),
      )
    }
    this.reconciler = setInterval(
      () =>
        void this.reconcile().catch((err: unknown) =>
          this.logger.error({ err }, 'job reconcile failed'),
        ),
      RECONCILE_MS,
    )
    this.reconciler.unref()
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping.abort()
    clearInterval(this.reconciler)
    if (this.sub?.isOpen) this.sub.destroy()
    for (const timer of this.retries) clearTimeout(timer)
    for (const id of this.crons.getCronJobs().keys())
      if (id.startsWith('job_task:')) this.crons.deleteCronJob(id)
    for (const c of this.running) c.abort(new Error('shutdown'))
    await Promise.race([
      Promise.allSettled(this.inflight),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS).unref()),
    ])
  }

  /**
   * After task writes have committed: re-synced here at once and on every other instance through
   * `job:sync`. A message lost on the way is healed by the next tick of the stale schedule (`fire`).
   */
  async changed(ids: readonly number[]): Promise<void> {
    for (const id of ids) await this.sync(id)
    await this.redis
      .publish(redisChannel('jobSync'), JSON.stringify({ from: this.instance, ids }))
      .catch((err: unknown) => this.logger.warn({ ids, err }, 'job:sync not published'))
  }

  /**
   * Schedules the task as stored (enabled), or drops its cron job (disabled, deleted). Syncs of one task
   * are chained: each reads the task after the previous one has installed its schedule.
   */
  sync(taskId: number): Promise<void> {
    const next = (this.syncing.get(taskId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const task = await this.tasks.findOneBy({ id: taskId })
        if (task?.enabled) this.schedule(task)
        else this.unschedule(taskId)
      })
    this.syncing.set(taskId, next)
    void next
      .finally(() => {
        if (this.syncing.get(taskId) === next) this.syncing.delete(taskId)
      })
      .catch(() => undefined)
    return next
  }

  /** The enabled tasks as stored against this instance's cron jobs: each difference is re-synced. */
  private async reconcile(): Promise<void> {
    const stored = await this.tasks.find({
      select: { id: true, cron: true },
      where: { enabled: true },
    })
    const want = new Map(stored.map((t) => [t.id, t.cron]))
    const have = new Map<number, string>()
    for (const [name, job] of this.crons.getCronJobs())
      if (name.startsWith('job_task:'))
        have.set(Number(name.slice('job_task:'.length)), String(job.cronTime.source))
    for (const id of new Set([...want.keys(), ...have.keys()]))
      if (want.get(id) !== have.get(id)) await this.sync(id)
  }

  private unschedule(taskId: number): void {
    if (this.crons.doesExist('cron', cronName(taskId))) this.crons.deleteCronJob(cronName(taskId))
  }

  /** Whether the task has a live cron job (tests, the task detail). */
  isScheduled(taskId: number): boolean {
    return this.crons.doesExist('cron', cronName(taskId))
  }

  /** `POST /tasks/:id/run`: fires once now, in the background; `scheduledAt` = the request time. */
  runOnce(task: Task): { scheduledAt: string } {
    const at = Date.now()
    this.track(this.fire(task.id, at, 'manual'))
    return { scheduledAt: new Date(at).toISOString() }
  }

  /** Waits until every fire started so far has ended (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled(this.inflight)
  }

  /** A `job:sync` message of another instance: `{from, ids}`; anything else is ignored. */
  private onSync(message: string): void {
    let msg: { from?: unknown; ids?: unknown }
    try {
      msg = JSON.parse(message) as typeof msg
    } catch {
      return
    }
    if (msg.from === this.instance || !Array.isArray(msg.ids)) return
    for (const id of msg.ids as unknown[])
      if (Number.isSafeInteger(id))
        this.sync(id as number).catch((err: unknown) =>
          this.logger.error({ taskId: id, err }, 'job sync failed'),
        )
  }

  private schedule(task: Task): void {
    if (this.stopping.signal.aborted) return
    this.unschedule(task.id)
    try {
      // the fire time the timer is set for: a tick fires it, then points at the next one
      let next = 0
      const job = CronJob.from({
        cronTime: task.cron,
        start: false,
        unrefTimeout: true,
        onTick: () => {
          const at = next
          next = job.nextDate().toMillis()
          this.track(this.fire(task.id, at, 'cron', task.cron))
        },
      })
      this.crons.addCronJob(cronName(task.id), job)
      job.start()
      next = job.nextDate().toMillis()
    } catch (err) {
      // a cron edited into the table by hand: the task stays unscheduled, the others run
      this.logger.error({ taskId: task.id, cron: task.cron, err }, 'task not scheduled')
    }
  }

  private track(fire: Promise<void>): void {
    this.inflight.add(fire)
    void fire.finally(() => this.inflight.delete(fire))
  }

  /**
   * One fire of a task at `scheduledAt` (epoch ms): reads it fresh, runs it once per fire time and, with
   * `allow_overlap = 0`, only while no earlier fire still runs; records the runs. A cron tick passes the
   * cron it was scheduled with: when the stored task no longer is enabled with that cron (deleted,
   * disabled or re-timed on another instance, its broadcast missed) nothing runs and the schedule is
   * re-synced. A catch-up (`misfire`) runs through `catchUpRun`. Never throws. Public for tests, which
   * fire chosen times.
   */
  fire(taskId: number, scheduledAt: number, trigger: JobTrigger, cron?: string): Promise<void> {
    return this.cls
      .run({ ifNested: 'override' }, async () => {
        this.cls.set('traceId', randomUUID())
        if (trigger === 'misfire') return this.catchUpRun(taskId, scheduledAt)
        const task = await this.tasks.findOneBy({ id: taskId })
        const stale = !task?.enabled || (cron !== undefined && task.cron !== cron)
        if (trigger === 'cron' && stale) return this.sync(taskId)
        if (!task) return
        const first = await this.redis.set(redisKey('jobFire', task.id, scheduledAt), trigger, {
          condition: 'NX',
          expiration: { type: 'PX', value: FIRE_KEY_TTL_MS },
        })
        if (first === null) return
        await this.markFired(task.id, scheduledAt)
        await this.run(task)
      })
      .catch((err: unknown) =>
        this.logger.error({ taskId, scheduledAt, trigger, err }, 'job fire failed'),
      )
  }

  /**
   * The attempts of one fire: with `allow_overlap = 0` under the task lock (held elsewhere: recorded
   * `skipped`; a catch-up, which passes `start`, gets 'busy' and waits); retried as the task says. A
   * catch-up runs only when `start()` (right before the first attempt) claims it. A shutdown or a lost
   * task lock ends the retries.
   */
  private async run(task: Task, start?: () => Promise<boolean>): Promise<'done' | 'busy'> {
    const lease = task.allowOverlap
      ? null
      : await this.locks.acquire(redisKey('jobLock', task.id), LOCK_TTL_MS)
    if (!task.allowOverlap && !lease) {
      if (start) return 'busy'
      await this.record(task, {
        outcome: 'skipped',
        output: 'the previous run still holds the task lock',
        started: new Date(),
      })
      return 'done'
    }
    const stop = lease ? AbortSignal.any([this.stopping.signal, lease.lost]) : this.stopping.signal
    try {
      if (start && !(await start())) return 'done'
      for (let attempt = 1; ; attempt++) {
        const outcome = await this.execute(task, attempt, lease?.lost)
        if (outcome === 'ok' || outcome === null || attempt > task.retryMax || stop.aborted) break
        const paused = await sleep(task.retryDelayMs, true, { signal: stop }).catch(() => false)
        if (!paused) break
      }
    } finally {
      await lease?.release()
    }
    return 'done'
  }

  /**
   * Misfire at start: the first fire time after the task's last fire (or its last edit: a
   * disabled spell or a new cron is no miss) that is already past was missed while the app was down.
   * Claimed by moving `last_fire_at` to now only if nobody moved it meanwhile (several instances start:
   * one handles it), so a restart never reports the same gap twice. `skip` records one `skipped` run.
   * `run_once` persists the catch-up as `misfire_pending_at` (the missed time) in that same statement
   * and clears it only when it starts running: a crash in between leaves it pending and the next start
   * (of any instance) runs it. An edit of the task after the claim drops a pending catch-up, as it would
   * the miss.
   */
  private async catchUp(task: Task): Promise<void> {
    const pending = await this.pendingOf(task.id)
    if (pending !== null && task.updatedAt.getTime() <= pending) {
      const missed = new Date(pending).toISOString()
      this.logger.log({ taskId: task.id, missed }, 'pending catch-up: running it now')
      this.track(this.fire(task.id, pending, 'misfire'))
      return
    }
    if (pending !== null) await this.clearPending(task.id, pending)
    const now = Date.now()
    const since = Math.max(task.lastFireAt?.getTime() ?? 0, task.updatedAt.getTime())
    const missed = new CronTime(task.cron).getNextDateFrom(new Date(since)).toMillis()
    if (missed > now) return
    const runOnce = task.misfire === 'run_once'
    const claimed: { affectedRows: number } = await this.ds.query(
      'UPDATE job_task SET last_fire_at = ?, misfire_pending_at = ?, updated_at = updated_at WHERE id = ? AND last_fire_at <=> ? AND deleted_at IS NULL',
      [new Date(now), runOnce ? new Date(missed) : null, task.id, task.lastFireAt],
    )
    if (claimed.affectedRows !== 1) return
    const at = new Date(missed).toISOString()
    if (runOnce) {
      this.logger.log({ taskId: task.id, missed: at }, 'missed fire: running it once now')
      this.track(this.fire(task.id, missed, 'misfire'))
    } else
      await this.record(task, {
        outcome: 'skipped',
        output: `missed the fire at ${at} while the app was down (misfire: skip)`,
        started: new Date(now),
      })
  }

  /**
   * A pending catch-up (`misfire_pending_at` = `scheduledAt`). Dropped when the task was edited after the
   * claim, or when that fire time ran as a regular fire meanwhile (its `job:fire:{id}:{at}` key set by
   * another instance's tick: catch-ups take the same key, value `misfire`). Else it runs once: whoever
   * clears the pending mark (`startCatchUp`, right before the first attempt, under the task lock when
   * allow_overlap = 0) runs it, so two instances never both do and a crash before that point leaves it
   * for the next start. Once started it is a fire like any other: a crash or a shutdown mid-run does
   * not replay it. The task lock busy → tried again after the lock ttl.
   */
  private async catchUpRun(taskId: number, scheduledAt: number): Promise<void> {
    const task = await this.tasks.findOneBy({ id: taskId })
    // run meanwhile, dropped, or the task gone
    if (!task || (await this.pendingOf(taskId)) !== scheduledAt) return
    const fireKey = redisKey('jobFire', taskId, scheduledAt)
    const first = await this.redis.set(fireKey, 'misfire', {
      condition: 'NX',
      expiration: { type: 'PX', value: FIRE_KEY_TTL_MS },
    })
    const firedAlready = first === null && (await this.redis.get(fireKey)) !== 'misfire'
    if (firedAlready || task.updatedAt.getTime() > scheduledAt) {
      await this.clearPending(taskId, scheduledAt)
      return
    }
    const started = await this.run(task, () => this.startCatchUp(taskId, scheduledAt))
    if (started === 'busy') this.retryCatchUp(taskId, scheduledAt)
  }

  private retryCatchUp(taskId: number, scheduledAt: number): void {
    if (this.stopping.signal.aborted) return
    const timer = setTimeout(() => {
      this.retries.delete(timer)
      this.track(this.fire(taskId, scheduledAt, 'misfire'))
    }, LOCK_TTL_MS)
    timer.unref()
    this.retries.add(timer)
  }

  /**
   * `job_task.misfire_pending_at` (epoch ms): the catch-up claimed at start and not yet run. Read by SQL,
   * not mapped: it is scheduler state, not part of the task API.
   */
  private async pendingOf(taskId: number): Promise<number | null> {
    const [row] = await this.ds.query<{ at: Date | null }[]>(
      'SELECT misfire_pending_at AS at FROM job_task WHERE id = ? AND deleted_at IS NULL',
      [taskId],
    )
    return row?.at ? row.at.getTime() : null
  }

  /** Clears the task's pending catch-up if it still is `scheduledAt` (`updated_at` stays). */
  private async clearPending(taskId: number, scheduledAt: number): Promise<void> {
    await this.ds.query(
      'UPDATE job_task SET misfire_pending_at = NULL, updated_at = updated_at WHERE id = ? AND misfire_pending_at = ? AND deleted_at IS NULL',
      [taskId, new Date(scheduledAt)],
    )
  }

  /**
   * Claims a pending catch-up right before its first attempt: clears the mark only while it still is
   * `scheduledAt` and the task has not been edited since (a disable or an edit racing the start wins; the
   * next start drops the mark). true = this call did, the caller runs it.
   */
  private async startCatchUp(taskId: number, scheduledAt: number): Promise<boolean> {
    const r: { affectedRows: number } = await this.ds.query(
      'UPDATE job_task SET misfire_pending_at = NULL, updated_at = updated_at WHERE id = ? AND misfire_pending_at = ? AND updated_at <= misfire_pending_at AND deleted_at IS NULL',
      [taskId, new Date(scheduledAt)],
    )
    return r.affectedRows === 1
  }

  /** `last_fire_at` moves forward only; `updated_at` stays (a fire is no edit of the task). */
  private async markFired(taskId: number, scheduledAt: number): Promise<void> {
    const at = new Date(scheduledAt)
    await this.ds.query(
      'UPDATE job_task SET last_fire_at = ?, updated_at = updated_at WHERE id = ? AND (last_fire_at IS NULL OR last_fire_at < ?) AND deleted_at IS NULL',
      [at, taskId, at],
    )
  }

  /**
   * Runs the task's handler once and records it as attempt `attempt`: ok, failed, or timeout (the handler
   * aborted); null when it cannot run at all (handler or params no longer fit) or its task lock was
   * `lost` meanwhile (the handler aborted, the attempt recorded failed): no retry either.
   */
  private async execute(
    task: Task,
    attempt: number,
    lost?: AbortSignal,
  ): Promise<JobOutcome | null> {
    const started = new Date()
    const job = this.jobs.get(task.handler)
    const params = job && this.paramsOf(task, job)
    if (!job || params instanceof Error) {
      // the registry or the handler's schema changed since the task was saved
      const error = job ? errorText(params) : `unknown handler ${task.handler}`
      await this.record(task, { outcome: 'failed', error, started, attempt })
      return null
    }
    const controller = new AbortController()
    this.running.add(controller)
    const lines: string[] = []
    // a handler that throws before its first await still ends as a rejected promise
    const settled = (async () =>
      job.run(params, {
        // timeout and shutdown abort the controller; a lost task lock aborts the handler too
        signal: lost ? AbortSignal.any([controller.signal, lost]) : controller.signal,
        log: (line) => void lines.push(String(line)),
      }))()
      .then(
        (value) => ({ value }),
        (err: unknown) => ({ err }),
      )
      .finally(() => this.running.delete(controller))
    let timer: NodeJS.Timeout | undefined
    const ends: Promise<'timeout' | 'lost'>[] = []
    if (task.timeoutMs > 0)
      ends.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('timeout'), Math.min(task.timeoutMs, TIMER_MAX_MS))
        }),
      )
    if (lost)
      ends.push(
        new Promise((resolve) => {
          if (lost.aborted) resolve('lost')
          else lost.addEventListener('abort', () => resolve('lost'), { once: true })
        }),
      )
    const first = await Promise.race([settled, ...ends])
    clearTimeout(timer)
    if (first === 'lost') {
      // once the lock is gone another instance may run the task: recorded at once, whatever the
      // handler (aborted through its signal) does next; awaited like a timed-out one
      this.logger.warn(
        { taskId: task.id, handler: task.handler },
        'task lock lost; handler aborted',
      )
      await this.record(task, {
        outcome: 'failed',
        output: outputText(lines, undefined),
        error: errorText(lost!.reason),
        started,
        attempt,
      })
      await settled
      return null
    }
    if (first === 'timeout') {
      controller.abort(new JobTimeoutError(`timed out after ${task.timeoutMs} ms`))
      this.logger.warn(
        { taskId: task.id, handler: task.handler, timeoutMs: task.timeoutMs },
        'job timed out; handler aborted',
      )
      await this.record(task, {
        outcome: 'timeout',
        output: outputText(lines, undefined),
        error: `timed out after ${task.timeoutMs} ms`,
        started,
        attempt,
      })
      try {
        const roots = await this.ds.query<{ id: number }[]>(
          `SELECT DISTINCT u.id FROM iam_user u
             JOIN iam_user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
             JOIN iam_role r ON r.id = ur.role_id
            WHERE u.enabled = 1 AND u.deleted_at IS NULL
              AND r.code = ? AND r.is_builtin = 1 AND r.enabled = 1 AND r.deleted_at IS NULL`,
          ['root'],
        )
        await this.notifier.send({
          template: 'scheduler.job.timeout',
          to: roots.map(({ id }) => Number(id)),
          channels: ['inbox'],
          params: {
            task: { i18n: task.name },
            handler: task.handler,
            timeoutMs: task.timeoutMs,
            startedAt: { datetime: started.toISOString() },
            attempt,
          },
        })
      } catch (err) {
        this.logger.warn({ taskId: task.id, err }, 'job timeout notification failed')
      }
      // the task lock (allow_overlap = 0) stays renewed until the handler has really returned
      await settled
      return 'timeout'
    }
    if ('err' in first) {
      await this.record(task, {
        outcome: 'failed',
        output: outputText(lines, undefined),
        error: errorText(first.err),
        started,
        attempt,
      })
      return 'failed'
    }
    await this.record(task, {
      outcome: 'ok',
      output: outputText(lines, first.value),
      started,
      attempt,
    })
    return 'ok'
  }

  /** The task's params through the handler's schema (its defaults filled in), or the reason they fail. */
  private paramsOf(task: Task, job: RegisteredJob): unknown {
    try {
      const r = job.params.safeParse(task.params == null ? {} : JSON.parse(task.params))
      return r.success
        ? r.data
        : new Error(`params: ${r.error.issues.map((i) => i.path.join('.') || '-').join(', ')}`)
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err))
    }
  }

  private async record(
    task: Task,
    run: {
      outcome: JobOutcome
      started: Date
      attempt?: number
      output?: string | null
      error?: string | null
    },
  ): Promise<void> {
    const ended = new Date()
    await this.ds.getRepository(Run).insert({
      taskId: task.id,
      taskName: task.name,
      handler: task.handler,
      params: task.params == null ? undefined : JSON.parse(task.params),
      attempt: run.attempt ?? 1,
      outcome: run.outcome,
      output: run.output ?? null,
      error: run.error ?? null,
      startedAt: run.started,
      endedAt: ended,
      costMs: Math.max(0, ended.getTime() - run.started.getTime()),
    })
  }
}
