import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { compile, Err, type WfFields, type WfReviewNode } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import { JobHandler, type JobContext } from '../../../core/scheduler/job-handler.js'
import { emptyChangeSet } from '../engine/advance.js'
import { onTimeout, timeoutEvent, type WfTimeoutOutcome } from '../engine/timeout.js'
import { WfNotify } from './wf-notify.js'
import { WfTaskRow } from './wf-runtime.entity.js'
import { WfStore } from './wf-store.js'

const HOUR = 3_600_000
/** errors written to a run's output (every one goes to the log) */
const ERROR_LINES = 10

/** what one candidate came to; counted in the run's output */
type Done = 'reminded' | 'timed out' | 'timeout failed'

/**
 * Overdue reminders (超时提醒; see docs/design-notes.md#workflow): a pending task past its `due_at` gets `wf.task.overdue`
 * once; when its node's `timeout.remindEvery` is set, again every that many hours while it stays pending.
 * Timeout auto-handling (designs 14–16): a never reminded task of a node with a `timeout.action`
 * is handled instead (`timeoutOne`). The seeded task runs it every 5 minutes (the handling's precision).
 */
@Injectable()
export class WfRemind {
  private readonly logger = new Logger(WfRemind.name)

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly notify: WfNotify,
    private readonly store: WfStore,
  ) {}

  /**
   * A task reminded once (no `remindEvery`) stays a candidate while it is pending past its due
   * time, each run spends a no-op UPDATE on it; add a "done" marker column if such tasks pile up.
   */
  @JobHandler('wf.task.remind')
  async remind(_params: object, { signal, log }: JobContext): Promise<string> {
    const now = new Date()
    // candidates: not reminded within the shortest remindEvery (1 hour); `remindOne` decides
    const due = await this.ds.query<
      {
        id: string
        instanceId: string
        versionId: string
        nodeId: string
        remindedAt: Date | null
      }[]
    >(
      `SELECT t.id, t.instance_id AS instanceId, i.version_id AS versionId, t.node_id AS nodeId,
              t.reminded_at AS remindedAt
         FROM wf_task t JOIN wf_instance i ON i.id = t.instance_id AND i.deleted_at IS NULL
        WHERE t.state = 'pending' AND t.due_at <= ? AND t.deleted_at IS NULL
          AND (t.reminded_at IS NULL OR t.reminded_at <= ?)
        ORDER BY t.due_at, t.id`,
      [now, new Date(now.getTime() - HOUR)],
    )
    const timeoutOf = await this.timeouts(due)
    const n: Record<Done | 'errors', number> = {
      reminded: 0,
      'timed out': 0,
      'timeout failed': 0,
      errors: 0,
    }
    for (const t of due) {
      signal.throwIfAborted()
      const timeout = timeoutOf(t.versionId, t.nodeId)
      const every = timeout?.remindEvery ?? null
      if (!timeout?.action || t.remindedAt !== null) {
        if (await this.remindOne(Number(t.id), every, now)) n.reminded++
        continue
      }
      try {
        const done = await this.timeoutOne(Number(t.id), Number(t.instanceId), every, now)
        if (done) n[done]++
      } catch (e) {
        // not a BizError (a deadlock, a lost connection, a bug): this one rolled back, the next run retries.
        // `job_run.output` keeps its head (16 000 chars): a few short lines, so the counts (last) stay
        const why = e instanceof Error ? e.message : String(e)
        if (++n.errors <= ERROR_LINES) log(`task ${t.id}: ${why.slice(0, 300)}`)
        this.logger.error({ err: e, taskId: Number(t.id) }, 'timeout handling failed')
      }
    }
    const counts = Object.entries(n).map(([k, v]) => `${k} ${v}`)
    return `${counts.join(', ')} of ${due.length}`
  }

  /**
   * Claims the reminder of task `id` and sends it in one transaction (joining the caller's). The claim is a
   * conditional UPDATE of `reminded_at` (still pending and due; never reminded, or `every` hours ago): of
   * runs racing on one task (several app instances, a stale candidate list) one wins. A failed send rolls
   * the claim back (next run).
   */
  remindOne(id: number, every: number | null, now: Date): Promise<boolean> {
    return this.txHost.withTransaction(async () => {
      const { tx } = this.txHost
      const r = await tx
        .createQueryBuilder()
        .update(WfTaskRow)
        .set({ remindedAt: now })
        .where(
          `id = :id AND state = 'pending' AND due_at <= :now AND deleted_at IS NULL
           AND (reminded_at IS NULL OR reminded_at <= :again)`,
          // no remindEvery: `<= NULL` is never true, so only a task never reminded passes
          { id, now, again: every ? new Date(now.getTime() - every * HOUR) : null },
        )
        .execute()
      if (r.affected !== 1) return false
      await this.notify.overdue(await tx.getRepository(WfTaskRow).findOneByOrFail({ id }))
      return true
    })
  }

  /**
   * The timeout handling of task `id` (its node has a `timeout.action`, it was never reminded), one
   * transaction: `handle` (see there). A BizError (the next step has nobody to review it, a business
   * handler's 422, a 409) rolls it back, then a new transaction records it as `failed`; any other error
   * propagates (this one rolled back, the next run retries). Null = nothing to do any more.
   */
  async timeoutOne(id: number, instanceId: number, every: number | null, now: Date) {
    try {
      return await this.handle(id, instanceId, every, now, false)
    } catch (e) {
      if (!(e instanceof BizError)) throw e
      return this.handle(id, instanceId, every, now, true)
    }
  }

  /**
   * WfStore.act locks the instance; on its current rows the task must still be pending, due and never
   * reminded, else nothing is written (a user acted first, another run or app instance took it, the
   * candidate list was stale): so it is handled once. Then `onTimeout` (`failed`: just the `timeout`
   * event): its change set is written (WfNotify.changed tells the new assignees…), `wf.task.timeout` goes to
   * the initiator and the enabled process managers, plus the assignee when the task was handled for them.
   * `remindOnly` / `failed` claim `reminded_at` as a reminder does (`wf.task.overdue` to the assignee; a
   * lost claim rolls it all back); from then on the task is reminded as any other. A task that ever had a
   * child (delegated, add-signed) is only reminded.
   */
  private handle(id: number, instanceId: number, every: number | null, now: Date, failed: boolean) {
    return this.txHost.withTransaction(async (): Promise<Done | null> => {
      const got: { task?: WfTaskRow; outcome?: WfTimeoutOutcome | 'failed'; to?: number[] } = {}
      await this.store.act(
        instanceId,
        async ({ ctx, inst, tasks, events }) => {
          const task = tasks.find((t) => t.id === id)
          if (task?.state !== 'pending' || !task.dueAt || task.dueAt > now || task.remindedAt)
            return emptyChangeSet()
          got.task = task
          got.to = [inst.initiatorId, ...(await ctx.org.enabledUsers(ctx.managerIds))]
          if (failed) {
            got.outcome = 'failed'
            return { ...emptyChangeSet(), events: [timeoutEvent(task, 'failed')] }
          }
          const r = await onTimeout(ctx, inst, tasks, task, events)
          got.outcome = r?.outcome
          return r?.set ?? emptyChangeSet()
        },
        now,
      )
      const { task, outcome, to } = got
      if (!task) return null
      if (!outcome) return (await this.remindOne(id, every, now)) ? 'reminded' : null
      const handled = outcome !== 'remindOnly' && outcome !== 'failed'
      // the reminder's claim: a run that lost it rolls this one back
      if (!handled && !(await this.remindOne(id, every, now))) throw new BizError(Err.CONFLICT)
      const me = task.assigneeId
      await this.notify.timedOut(
        task,
        outcome,
        handled ? [...to!, me] : to!.filter((u) => u !== me),
      )
      return failed ? 'timeout failed' : 'timed out'
    })
  }

  /** `(versionId, nodeId) → timeout` of the candidates' published versions (review nodes only). */
  private async timeouts(due: { versionId: string }[]) {
    const ids = [...new Set(due.map((t) => Number(t.versionId)))]
    const versions = ids.length
      ? await this.ds.query<{ id: string; tree: unknown; form: { fields: WfFields } }[]>(
          // qw:include-deleted wf_version: a snapshot keeps running the instances started on it
          'SELECT id, tree_json AS tree, form_snapshot AS form FROM wf_version WHERE id IN (?)',
          [ids],
        )
      : []
    const flows = new Map(
      versions.map((v) => {
        const r = compile(v.tree, v.form.fields)
        return [Number(v.id), r.ok ? r.flow : null]
      }),
    )
    return (versionId: string, nodeId: string): WfReviewNode['timeout'] => {
      const node = flows.get(Number(versionId))?.nodes.get(nodeId)?.node
      return node?.type === 'review' ? node.timeout : undefined
    }
  }
}
