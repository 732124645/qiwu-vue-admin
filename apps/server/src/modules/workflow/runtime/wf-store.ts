import { Inject, Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  compile,
  Err,
  type FormSchema,
  type OrgDirectory,
  type WfChangeSet,
  type WfFields,
  type WfInitiatorCtx,
  type WfNewCc,
} from '@qiwu/shared'
import type { EntityManager, QueryDeepPartialEntity } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import { start, type WfEngineCtx } from '../engine/advance.js'
import { WfHandlers } from './wf-handlers.js'
import { WfNotify } from './wf-notify.js'
import { WfCcRow, WfEventRow, WfInstanceRow, WfTaskRow } from './wf-runtime.entity.js'

/** Injection token of the `OrgDirectory` the engine reads (its TypeORM implementation). */
export const WF_ORG = 'WF_ORG'

/** What `start` writes besides the engine's first moves (the start service checks and resolves it all). */
export interface WfStartInput {
  versionId: number
  initiatorId: number
  initiatorDeptId: number | null
  businessKey: string | null
  formValues: Record<string, unknown>
  initiatorPicks: Record<string, number[]>
  initiatorCtx: WfInitiatorCtx
}

/** An instance locked for one action, with everything the engine reads. */
export interface WfRun {
  tx: EntityManager
  ctx: WfEngineCtx
  /** the locked row; it is the engine's `WfInstance` too */
  inst: WfInstanceRow
  /** by id (creation order) */
  tasks: WfTaskRow[]
  /** by id: withdraw reads them (`withdraw(…, { events })`) */
  events: WfEventRow[]
}

/** A written change set: notifications and realtime pushes derive from it. */
export interface WfApplied {
  /** the instance as written */
  inst: WfInstanceRow
  set: WfChangeSet
  /** ids of `set.newTasks`, same order */
  taskIds: number[]
  /** the ccs inserted: `set.ccs` without the ones that existed already */
  ccs: WfNewCc[]
}

type Action = (run: WfRun) => WfChangeSet | Promise<WfChangeSet>

/**
 * The engine ↔ TypeORM adapter (持久化适配; see docs/design-notes.md#workflow). Every call is one transaction (joining the
 * caller's): the instance row is locked `FOR UPDATE` before anything of it is read, so actions on one
 * instance run one after another and each sees the last one's rows. A task patch is a conditional UPDATE
 * (`… AND state = :from`) and any patch that changes no row rolls the action back as 409. The model's
 * `WfBusinessHandler.onStateChange` runs in the same transaction.
 * `act` may follow other reads in the caller's transaction: under REPEATABLE READ their snapshot can predate
 * the lock, so the tasks and events are current reads (FOR SHARE), and the ccs are checked against them
 * (`newCcs`).
 * Every written set goes through `WfNotify.changed` in the same transaction (notifications, `wf:task` pushes).
 */
@Injectable()
export class WfStore {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly handlers: WfHandlers,
    @Inject(WF_ORG) private readonly org: OrgDirectory,
    private readonly notify: WfNotify,
  ) {}

  /** Creates the instance (`running`), runs the engine's `start` and writes its moves. */
  start(input: WfStartInput, now = new Date()): Promise<WfApplied> {
    return this.txHost.withTransaction(async () => {
      const { tx } = this.txHost
      const ctx = await this.ctxOf(tx, input.versionId, now)
      const repo = tx.getRepository(WfInstanceRow)
      const inst = await repo.save(
        repo.create({
          ...input,
          modelKey: ctx.modelKey,
          state: 'running',
          activeNodeIds: [],
          startedAt: now,
          endedAt: null,
          urgedAt: null,
        }),
      )
      const applied = await this.apply(tx, inst, await start(ctx, inst), now, true, [])
      await this.notify.changed(applied, [], ctx.flow.root.id)
      return applied
    })
  }

  /**
   * Locks instance `instanceId` (unknown → 404), loads its tasks and events, runs `action` (an engine call;
   * it may throw, e.g. 404 for a task that is not the caller's) and writes the change set it returns.
   */
  act(instanceId: number, action: Action, now = new Date()): Promise<WfApplied> {
    return this.txHost.withTransaction(async () => {
      const { tx } = this.txHost
      const inst = await tx
        .getRepository(WfInstanceRow)
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :instanceId', { instanceId })
        .getOne()
      if (!inst) throw new BizError(Err.NOT_FOUND)
      const ctx = await this.ctxOf(tx, inst.versionId, now)
      const order = { id: 'ASC' } as const
      const lock = { mode: 'pessimistic_read' } as const
      const tasks = await tx.getRepository(WfTaskRow).find({ where: { instanceId }, order, lock })
      const events = await tx.getRepository(WfEventRow).find({ where: { instanceId }, order, lock })
      const set = await action({ tx, ctx, inst, tasks, events })
      const applied = await this.apply(tx, inst, set, now, false, events)
      await this.notify.changed(applied, tasks, ctx.flow.root.id)
      return applied
    })
  }

  /**
   * The engine context of a published version (a deleted one too: its instances still run); reads that
   * lock nothing use it directly (e.g. a task's send-back targets).
   */
  async ctxOf(
    tx: EntityManager,
    versionId: number,
    now: Date,
  ): Promise<WfEngineCtx & { modelKey: string }> {
    const [v] = (await tx.query(
      // qw:include-deleted wf_version: a snapshot keeps running the instances started on it
      `SELECT v.model_key AS modelKey, v.tree_json AS tree, v.form_snapshot AS form,
              m.manager_user_ids AS managers
         FROM wf_version v LEFT JOIN wf_model m ON m.id = v.model_id AND m.deleted_at IS NULL
        WHERE v.id = ?`,
      [versionId],
    )) as {
      modelKey: string
      tree: unknown
      form: { fields: WfFields; schema?: FormSchema }
      managers: number[] | null
    }[]
    if (!v) throw new BizError(Err.NOT_FOUND)
    const fields = v.form.fields
    const r = compile(v.tree, fields)
    // published versions passed `compile`; one that no longer does is a server bug (500)
    if (!r.ok) throw new Error(`wf_version ${versionId} does not compile: ${r.errors[0]!.code}`)
    return {
      flow: r.flow,
      fields,
      schema: v.form.schema,
      org: this.org,
      managerIds: v.managers ?? [],
      now,
      modelKey: v.modelKey,
    }
  }

  /**
   * Writes `set` for locked `inst` in the engine's order (instance, task patches, new tasks, ccs, events),
   * then tells the model's handler when the instance was created or its state changed. `events`: the
   * instance's current events (none for a new one).
   */
  private async apply(
    tx: EntityManager,
    inst: WfInstanceRow,
    set: WfChangeSet,
    now: Date,
    created: boolean,
    events: readonly WfEventRow[],
  ): Promise<WfApplied> {
    const before = inst.state
    if (Object.keys(set.instance).length) {
      // json columns are whole values here, not the deep partials the type expects
      const cols = set.instance as QueryDeepPartialEntity<WfInstanceRow>
      await tx.getRepository(WfInstanceRow).update(inst.id, cols)
      Object.assign(inst, set.instance)
    }
    for (const p of set.taskPatches) {
      // a task handed to someone else (改派) is reminded to them afresh: the old holder's reminder was not
      // theirs (transfer / delegate write a new row, reminded_at empty already).
      // due_at stays, the step's deadline (as transfer's copy keeps it): the new holder of an overdue
      // task is reminded at the next run; on a node with a `timeout.action` the engine's patch restarts it
      // (`retimed`)
      const r = await tx
        .createQueryBuilder()
        .update(WfTaskRow)
        .set('assigneeId' in p.set ? { ...p.set, remindedAt: null } : p.set)
        .where('id = :id AND instance_id = :instanceId AND state = :from AND deleted_at IS NULL', {
          id: p.id,
          instanceId: inst.id,
          from: p.from,
        })
        .execute()
      // someone else changed the task first (or it is not this instance's): nothing of the action stays
      if (r.affected !== 1) throw new BizError(Err.CONFLICT)
    }
    const taskIds: number[] = []
    for (const t of set.newTasks) {
      const row = { ...t, instanceId: inst.id, createdAt: now }
      const { identifiers } = await tx.getRepository(WfTaskRow).insert(row)
      taskIds.push(identifiers[0]!.id as number)
    }
    const ccs = await this.newCcs(tx, inst.id, set.ccs, events)
    for (const c of ccs)
      await tx.getRepository(WfCcRow).insert({ ...c, instanceId: inst.id, createdAt: now })
    for (const e of set.events)
      await tx.getRepository(WfEventRow).insert({ ...e, instanceId: inst.id, createdAt: now })
    if (created || inst.state !== before)
      await this.handlers.get(inst.modelKey)?.onStateChange(inst, tx)
    return { inst, set, taskIds, ccs }
  }

  /**
   * `ccs` without the ones whose (instance, node, user, from task) has a row already (or comes earlier in
   * the list): an approval withdrawn and approved again passes its notify nodes again.
   * The rows are a plain read: a locking one gap-locks the `instance_id` index, and two actions writing the
   * first ccs of neighbouring instances deadlock. A snapshot older than the instance lock may miss rows, so
   * it is checked against `events` (current; every set with ccs writes a `cc` event): fewer → 409.
   */
  private async newCcs(
    tx: EntityManager,
    instanceId: number,
    ccs: WfNewCc[],
    events: readonly WfEventRow[],
  ): Promise<WfNewCc[]> {
    if (!ccs.length) return []
    const snapshot = await tx.getRepository(WfEventRow).countBy({ instanceId, action: 'cc' })
    if (snapshot !== events.filter((e) => e.action === 'cc').length)
      throw new BizError(Err.CONFLICT)
    const key = (c: Pick<WfNewCc, 'nodeId' | 'userId' | 'fromTaskId'>) =>
      JSON.stringify([c.nodeId, c.userId, c.fromTaskId])
    const had = await tx.getRepository(WfCcRow).find({
      select: { nodeId: true, userId: true, fromTaskId: true },
      where: { instanceId },
    })
    const seen = new Set(had.map(key))
    return ccs.filter((c) => !seen.has(key(c)) && seen.add(key(c)))
  }
}
