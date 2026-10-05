import type {
  WfAction,
  WfInitiatorCtx,
  WfInstanceState,
  WfSignKind,
  WfTaskState,
} from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity, CreatedEntity } from '../../../core/db/base.entity.js'

// The runtime tables of a process: an instance, its tasks, ccs and timeline. The rows are the
// engine's own views (`WfInstance`, `WfTask`, the events withdraw reads), so the engine takes them as they
// are. Change sets are written only through WfStore (wf-store.ts); other writers only mark rows
// (`wf_cc.read_at`, `wf_task.reminded_at`). `wf_model` / `wf_version` belong to the model API.

/** `wf_instance`: a started process (its title is built when read, in the reader's language). */
@Entity('wf_instance')
export class WfInstanceRow extends BaseEntity {
  @Column({ name: 'version_id', type: 'bigint', unsigned: true })
  versionId: number

  @Column({ name: 'model_key', length: 64 })
  modelKey: string

  /** the business row of a `custom` form (its `WfBusinessHandler` reads it) */
  @Column({ name: 'business_key', type: 'varchar', length: 128, nullable: true })
  businessKey: string | null

  @Column({ name: 'initiator_id', type: 'bigint', unsigned: true })
  initiatorId: number

  /** the admin pages' data scope */
  @Column({ name: 'initiator_dept_id', type: 'bigint', unsigned: true, nullable: true })
  initiatorDeptId: number | null

  @Column({ type: 'varchar', length: 12 })
  state: WfInstanceState

  @Column({ name: 'form_values', type: 'json' })
  formValues: Record<string, unknown>

  @Column({ name: 'initiator_picks', type: 'json' })
  initiatorPicks: Record<string, number[]>

  @Column({ name: 'initiator_ctx', type: 'json' })
  initiatorCtx: WfInitiatorCtx

  /** nodes holding a token, several while fork paths run side by side */
  @Column({ name: 'active_node_ids', type: 'json' })
  activeNodeIds: string[]

  @Column({ name: 'urged_at', type: 'datetime', precision: 3, nullable: true })
  urgedAt: Date | null

  @Column({ name: 'started_at', type: 'datetime', precision: 3 })
  startedAt: Date

  @Column({ name: 'ended_at', type: 'datetime', precision: 3, nullable: true })
  endedAt: Date | null
}

/** `wf_task`: one person's work on a node; `created_at` is the action time that made it. */
@Entity('wf_task')
export class WfTaskRow extends BaseEntity {
  @Column({ name: 'instance_id', type: 'bigint', unsigned: true })
  instanceId: number

  @Column({ name: 'node_id', length: 64 })
  nodeId: string

  @Column({ name: 'node_name', length: 64 })
  nodeName: string

  @Column({ name: 'assignee_id', type: 'bigint', unsigned: true })
  assigneeId: number

  @Column({ name: 'owner_id', type: 'bigint', unsigned: true, nullable: true })
  ownerId: number | null

  @Column({ name: 'parent_task_id', type: 'bigint', unsigned: true, nullable: true })
  parentTaskId: number | null

  @Column({ name: 'from_task_id', type: 'bigint', unsigned: true, nullable: true })
  fromTaskId: number | null

  @Column({ name: 'sign_kind', type: 'varchar', length: 8, nullable: true })
  signKind: WfSignKind | null

  @Column({ type: 'int', unsigned: true, default: 0 })
  seq: number

  @Column({ type: 'varchar', length: 12 })
  state: WfTaskState

  @Column({ type: 'varchar', length: 1000, nullable: true })
  comment: string | null

  @Column({ name: 'due_at', type: 'datetime', precision: 3, nullable: true })
  dueAt: Date | null

  @Column({ name: 'reminded_at', type: 'datetime', precision: 3, nullable: true })
  remindedAt: Date | null

  @Column({ name: 'handled_at', type: 'datetime', precision: 3, nullable: true })
  handledAt: Date | null
}

/** `wf_cc`: a copy sent to a user by a notify node (`fromUserId` null) or a reviewer. */
@Entity('wf_cc')
export class WfCcRow extends CreatedEntity {
  @Column({ name: 'instance_id', type: 'bigint', unsigned: true })
  instanceId: number

  @Column({ name: 'node_id', length: 64 })
  nodeId: string

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'from_task_id', type: 'bigint', unsigned: true, nullable: true })
  fromTaskId: number | null

  @Column({ name: 'from_user_id', type: 'bigint', unsigned: true, nullable: true })
  fromUserId: number | null

  @Column({ type: 'varchar', length: 1000, nullable: true })
  reason: string | null

  @Column({ name: 'read_at', type: 'datetime', precision: 3, nullable: true })
  readAt: Date | null
}

/** `wf_event`: the timeline and audit of an instance. */
@Entity('wf_event')
export class WfEventRow extends CreatedEntity {
  @Column({ name: 'instance_id', type: 'bigint', unsigned: true })
  instanceId: number

  @Column({ name: 'task_id', type: 'bigint', unsigned: true, nullable: true })
  taskId: number | null

  @Column({ name: 'node_id', type: 'varchar', length: 64, nullable: true })
  nodeId: string | null

  /** null = the system */
  @Column({ name: 'actor_id', type: 'bigint', unsigned: true, nullable: true })
  actorId: number | null

  @Column({ type: 'varchar', length: 16 })
  action: WfAction

  /** users it went to; send-back: `[targetNodeId]` (`WfNewEvent.targetIds`) */
  @Column({ name: 'target_ids', type: 'json', nullable: true })
  targetIds: number[] | string[] | null

  @Column({ type: 'varchar', length: 1000, nullable: true })
  comment: string | null
}

/** `TypeOrmModule.forFeature` list of the module that provides WfStore. */
export const WF_RUNTIME_ENTITIES = [WfInstanceRow, WfTaskRow, WfCcRow, WfEventRow]
