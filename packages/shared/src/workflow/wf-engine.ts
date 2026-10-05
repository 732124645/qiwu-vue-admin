/**
 * Engine ↔ persistence contract (see docs/design-notes.md#workflow). The engine (server `modules/workflow/engine`) is
 * pure: it reads an instance, its tasks and the org chart (through `OrgDirectory`) and returns a
 * `WfChangeSet`; the TypeORM adapter writes that set in the action's transaction.
 */

export const WF_INSTANCE_STATES = [
  'running',
  'approved',
  'rejected',
  'canceled',
  'terminated',
] as const
export type WfInstanceState = (typeof WF_INSTANCE_STATES)[number]

/** `waiting` = not active yet (later `ordered` signers, a parent suspended by a before-sign). */
export const WF_TASK_STATES = [
  'waiting',
  'pending',
  'approved',
  'rejected',
  'transferred',
  'delegated',
  'canceled',
  'sent_back',
  'withdrawn',
] as const
export type WfTaskState = (typeof WF_TASK_STATES)[number]

/** Add-sign child tasks: `before` suspends the parent, `after` runs once the parent is done. */
export const WF_SIGN_KINDS = ['before', 'after'] as const
export type WfSignKind = (typeof WF_SIGN_KINDS)[number]

/** `wf_event.action`. */
export const WF_ACTIONS = [
  'begin',
  'resubmit',
  'approve',
  'reject',
  'send_back',
  'transfer',
  'delegate',
  'add_sign',
  'remove_sign',
  'cc',
  'cancel',
  'withdraw',
  'terminate',
  'reassign',
  'comment',
  'urge',
  /** the remind job handled an overdue task: no actor, comment = a `seed.wf.timeout.*` key */
  'timeout',
] as const
export type WfAction = (typeof WF_ACTIONS)[number]

/** `wf_instance.initiator_ctx`: resolved once at start; the condition evaluator reads only this. */
export interface WfInitiatorCtx {
  /** the initiator's dept `tree_path` (`/1/4/`, always ends in `/`); null = no dept */
  deptTreePath: string | null
  /** ids of the initiator's enabled roles */
  roleIds: number[]
}

/** The engine's view of a `wf_instance` row. */
export interface WfInstance {
  id: number
  initiatorId: number
  state: WfInstanceState
  formValues: Record<string, unknown>
  /** node id → the users the initiator picked for that `initiatorPicks` node */
  initiatorPicks: Record<string, number[]>
  initiatorCtx: WfInitiatorCtx
  /** nodes holding a token; several while fork paths run side by side */
  activeNodeIds: string[]
}

/** The engine's view of a `wf_task` row. */
export interface WfTask {
  id: number
  nodeId: string
  nodeName: string
  assigneeId: number
  /** delegation: the original assignee, who decides once the delegate has handled it */
  ownerId: number | null
  /** add-sign child → the task it was added to */
  parentTaskId: number | null
  /** the task whose completion created this one (withdraw looks only at these) */
  fromTaskId: number | null
  signKind: WfSignKind | null
  /** order within an `ordered` node */
  seq: number
  state: WfTaskState
  comment: string | null
  /** set when the node has a `timeout` */
  dueAt: Date | null
  createdAt: Date
  handledAt: Date | null
}

/** A task to insert; the adapter sets `id`, `createdAt` (the action time) and null `comment`/`handledAt`. */
export type WfNewTask = Omit<WfTask, 'id' | 'createdAt' | 'comment' | 'handledAt'>

/** `UPDATE wf_task SET … WHERE id = :id AND state = :from`; no row changed → concurrent change (409). */
export interface WfTaskPatch {
  id: number
  from: WfTaskState
  set: Partial<Pick<WfTask, 'state' | 'assigneeId' | 'ownerId' | 'comment' | 'handledAt' | 'dueAt'>>
}

export interface WfNewCc {
  nodeId: string
  userId: number
  fromTaskId: number | null
  fromUserId: number | null
  reason: string | null
}

export interface WfNewEvent {
  action: WfAction
  taskId: number | null
  nodeId: string | null
  /** null = the system (e.g. an auto-passed node) */
  actorId: number | null
  /**
   * users it went to (transfer, delegate, add_sign, cc, reassign, urge: the holders urged); `remove_sign`: the users whose add-sign was
   * removed (withdraw matches on them); `send_back` and a send-back `reject`: `[targetNodeId]`
   */
  targetIds: number[] | string[] | null
  comment: string | null
}

/** Everything one engine call changes, as data. Notifications derive from it (new / canceled tasks, end state). */
export interface WfChangeSet {
  /** instance columns to write (the row is already locked `FOR UPDATE`); `endedAt` with a final state */
  instance: Partial<Pick<WfInstance, 'state' | 'activeNodeIds' | 'formValues'>> & { endedAt?: Date }
  newTasks: WfNewTask[]
  taskPatches: WfTaskPatch[]
  /**
   * `wf_cc` rows; the adapter skips one whose (instance, nodeId, userId, fromTaskId) exists already: a withdrawn
   * approval approved again passes its notify nodes again (a later round has another `fromTaskId`)
   */
  ccs: WfNewCc[]
  events: WfNewEvent[]
}

/**
 * Org chart port (in-memory for tests, TypeORM). Every user id it returns belongs to an enabled,
 * not deleted user, ascending, no duplicates.
 */
export interface OrgDirectory {
  /** the enabled users among `userIds` (unknown ids dropped) */
  enabledUsers(userIds: readonly number[]): Promise<number[]>
  usersOfRoles(roleIds: readonly number[]): Promise<number[]>
  usersOfPositions(positionIds: readonly number[]): Promise<number[]>
  /** members of these depts (not of their sub-depts) */
  usersOfDepts(deptIds: readonly number[]): Promise<number[]>
  /** null = no dept, or no such user */
  deptOfUser(userId: number): Promise<number | null>
  /**
   * Heads from `deptId` upwards, nearest first (not sorted by id): the dept's own head, then its parent's…
   * `levels` depts at most; a dept without an enabled head adds nobody.
   */
  deptHeads(deptId: number, levels: number): Promise<number[]>
  /** the start-time snapshot stored in `wf_instance.initiator_ctx` */
  initiatorCtx(userId: number): Promise<WfInitiatorCtx>
}
