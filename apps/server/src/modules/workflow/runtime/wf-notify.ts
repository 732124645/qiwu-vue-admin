import { Injectable, type OnModuleInit } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { RT, type WfTask } from '@qiwu/shared'
import {
  EventSubscriber,
  type DataSource,
  type EntityManager,
  type EntitySubscriberInterface,
  type QueryRunner,
  type TransactionCommitEvent,
} from 'typeorm'
import { Notifier, type NotifyParams } from '../../../core/notify/notify.js'
import { RealtimeService } from '../../../core/realtime/realtime.service.js'
import { timeoutKey, type WfTimeoutOutcome } from '../engine/timeout.js'
import { WfInstanceRow, type WfTaskRow } from './wf-runtime.entity.js'
import type { WfApplied } from './wf-store.js'

/** The approval templates (inbox + mail rows in both languages, `db/seeds/workflow`; see docs/design-notes.md#workflow). */
export type WfTemplate =
  | 'wf.task.assigned'
  | 'wf.task.canceled'
  | 'wf.task.urged'
  | 'wf.task.overdue'
  | 'wf.task.timeout'
  | 'wf.instance.approved'
  | 'wf.instance.rejected'
  | 'wf.instance.sent_back'
  | 'wf.cc'

const PUSHES = 'wfTaskPushes'
/**
 * instance id → users whose to-dos changed, waiting for the outermost commit of this runner (a rolled back
 * transaction's runner is released with them: every transaction gets a new runner)
 */
const pushesOf = (runner: QueryRunner) =>
  (runner.data[PUSHES] ??= new Map()) as Map<number, Set<number>>

/**
 * Notifications and `wf:task` pushes of the change sets WfStore writes (通知; see docs/design-notes.md#workflow). `changed`
 * runs in the action's transaction: its Notifier sends are outbox rows that go out once the outermost
 * transaction commits and roll back with it; the `wf:task` pushes wait for that commit too (this
 * subscriber, the NotifyTransactionSubscriber pattern). Nobody is told about their own action.
 * Params are typed: model and node names `{i18n}` (seed keys or an admin's text), times `{datetime}`, so each
 * recipient reads them in their language and zone.
 */
@EventSubscriber()
@Injectable()
export class WfNotify implements EntitySubscriberInterface, OnModuleInit {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly notifier: Notifier,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.ds.subscribers.push(this)
  }

  afterTransactionCommit({ queryRunner }: TransactionCommitEvent): void {
    if (queryRunner.isTransactionActive) return
    const pushes = pushesOf(queryRunner)
    for (const [instanceId, users] of pushes)
      this.realtime.toUsers([...users], { type: RT.wfTask, payload: { instanceId } })
    pushes.clear()
  }

  /**
   * After WfStore wrote `applied` (`before`: the instance's tasks it read; `beginId`: the flow's begin node).
   * A task that becomes someone's pending to-do → `wf.task.assigned` (a begin task: `wf.instance.sent_back`),
   * one that stops being it (canceled, withdrawn, reassigned, back to waiting…) → `wf.task.canceled`; an end
   * as approved / rejected → the initiator; new ccs → `wf.cc`; an `urge` event → `wf.task.urged` to every
   * pending assignee. `waiting` tasks are no to-do yet: they are told once they turn pending.
   * A set led by the remind job's `timeout` event: the task it handled for its assignee is not
   * "canceled" to them (`timedOut` tells them what the system did).
   */
  async changed(
    { inst, set, ccs }: WfApplied,
    before: readonly WfTask[],
    beginId: string,
  ): Promise<void> {
    const actor = set.events[0]?.actorId ?? null
    const timedOut = set.events[0]?.action === 'timeout' ? set.events[0].taskId : null
    const out = new Map<string, { code: WfTemplate; node: string | null; to: Set<number> }>()
    const add = (code: WfTemplate, userId: number, node: string | null = null) => {
      if (userId === actor) return
      const key = `${code}\n${node}`
      if (!out.has(key)) out.set(key, { code, node, to: new Set() })
      out.get(key)!.to.add(userId)
    }
    const touched = new Set<number>()
    for (const t of set.newTasks) {
      touched.add(t.assigneeId)
      if (t.state !== 'pending') continue
      if (t.nodeId === beginId) add('wf.instance.sent_back', t.assigneeId)
      else add('wf.task.assigned', t.assigneeId, t.nodeName)
    }
    const byId = new Map(before.map((t) => [t.id, t]))
    for (const p of set.taskPatches) {
      const was = byId.get(p.id)!
      const now = { ...was, ...p.set }
      touched.add(was.assigneeId).add(now.assigneeId)
      const moved = now.assigneeId !== was.assigneeId
      if (p.from === 'pending' && (now.state !== 'pending' || moved) && p.id !== timedOut)
        add('wf.task.canceled', was.assigneeId, was.nodeName)
      if (now.state === 'pending' && (p.from !== 'pending' || moved))
        add('wf.task.assigned', now.assigneeId, now.nodeName)
    }
    const end = set.instance.state
    if (end === 'approved' || end === 'rejected') add(`wf.instance.${end}`, inst.initiatorId)
    for (const c of ccs) add('wf.cc', c.userId)
    if (set.events.some((e) => e.action === 'urge'))
      for (const t of before)
        if (t.state === 'pending') add('wf.task.urged', t.assigneeId, t.nodeName)

    if (out.size) {
      const base = await this.params(inst)
      for (const { code, node, to } of out.values())
        await this.notifier.send({
          template: code,
          to: [...to],
          params: node === null ? base : { ...base, node: { i18n: node } },
        })
    }
    if (touched.size) {
      const runner = (this.txHost.tx as EntityManager).queryRunner
      if (!runner?.isTransactionActive) throw new Error('WfNotify.changed: no transaction')
      const pushes = pushesOf(runner)
      pushes.set(inst.id, new Set([...(pushes.get(inst.id) ?? []), ...touched]))
    }
  }

  /** `wf.task.overdue` to the assignee of `task`, in the caller's transaction (the remind job). */
  async overdue(task: WfTaskRow): Promise<void> {
    await this.notifier.send({
      template: 'wf.task.overdue',
      to: [task.assigneeId],
      params: await this.taskParams(task),
    })
  }

  /**
   * `wf.task.timeout`: what the remind job did with overdue `task` (its row before),
   * to `to` (the initiator, the enabled process managers, the assignee of a task it handled), in the
   * caller's transaction. `outcome` is a `seed.wf.timeout.*` key, translated per recipient.
   */
  async timedOut(
    task: WfTaskRow,
    outcome: WfTimeoutOutcome | 'failed',
    to: number[],
  ): Promise<void> {
    const [row] = await this.txHost.tx.query<{ name: string }[]>(
      // qw:include-deleted a deleted assignee keeps their name on the notice
      'SELECT display_name AS name FROM iam_user WHERE id = ?',
      [task.assigneeId],
    )
    await this.notifier.send({
      template: 'wf.task.timeout',
      to: [...new Set(to)],
      params: {
        ...(await this.taskParams(task)),
        assignee: row?.name ?? '',
        outcome: { i18n: timeoutKey(outcome) },
      },
    })
  }

  /** the instance's params with the task's node and due time */
  private async taskParams(task: WfTaskRow): Promise<NotifyParams> {
    const inst = await this.txHost.tx
      .getRepository(WfInstanceRow)
      .findOneByOrFail({ id: task.instanceId })
    return {
      ...(await this.params(inst)),
      node: { i18n: task.nodeName },
      dueAt: { datetime: task.dueAt!.toISOString() },
    }
  }

  /** what every template names: the model, the initiator, the instance and when it started */
  private async params(inst: WfInstanceRow): Promise<NotifyParams> {
    const [row] = await this.txHost.tx.query<{ model: string | null; initiator: string | null }[]>(
      // qw:include-deleted a model or initiator deleted since still names its running instances
      `SELECT (SELECT m.name FROM wf_version v JOIN wf_model m ON m.id = v.model_id WHERE v.id = ?) AS model,
              (SELECT u.display_name FROM iam_user u WHERE u.id = ?) AS initiator`,
      [inst.versionId, inst.initiatorId],
    )
    return {
      model: { i18n: row?.model ?? inst.modelKey },
      initiator: row?.initiator ?? '',
      instanceId: inst.id,
      startedAt: { datetime: inst.startedAt.toISOString() },
    }
  }
}
