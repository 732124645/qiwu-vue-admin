import {
  Err,
  type WfChangeSet,
  type WfInstance,
  type WfNewTask,
  type WfSignKind,
  type WfTask,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import { actionEvent, reviewOf } from './actions.js'
import { dueAt, emptyChangeSet, OPEN, retimed, signsDone, type WfEngineCtx } from './advance.js'

// Routing actions (see docs/design-notes.md#workflow): transfer, delegate, add-sign before / after, remove-sign. Each takes
// the task its assignee acts on (the services check it is theirs; the patches expect its state, else 409) and returns
// the change set. Children hang on their parent through `parentTaskId`: a delegate's task has `ownerId` and no
// `signKind`, an add-sign's has a `signKind`. Approving a child goes through `taskApproved` (advance.ts).

/** a pending copy of `task` for `assigneeId`, same node, lineage and due time */
const copy = (task: WfTask, assigneeId: number): WfNewTask => ({
  nodeId: task.nodeId,
  nodeName: task.nodeName,
  assigneeId,
  ownerId: task.ownerId,
  parentTaskId: task.parentTaskId,
  fromTaskId: task.fromTaskId,
  signKind: task.signKind,
  seq: task.seq,
  state: 'pending',
  dueAt: task.dueAt,
})

/**
 * `ids` without repeats, each an enabled user holding no open task on the node (the task's holder holds one), else
 * 422 `WF_BAD_TARGET` (改派 too).
 */
export async function targets(
  ctx: WfEngineCtx,
  tasks: readonly WfTask[],
  task: WfTask,
  ids: readonly number[],
): Promise<number[]> {
  const want = [...new Set(ids)]
  const busy = tasks.filter((t) => t.nodeId === task.nodeId && OPEN.includes(t.state))
  if (
    !want.length ||
    (await ctx.org.enabledUsers(want)).length !== want.length ||
    busy.some((t) => want.includes(t.assigneeId))
  )
    throw new BizError(Err.WF_BAD_TARGET)
  return want
}

/** 转办: the task is closed as `transferred` and `to` gets a copy (timed anew on a node with a `timeout.action`). */
export async function transfer(
  ctx: WfEngineCtx,
  _inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { to: number; comment: string | null },
): Promise<WfChangeSet> {
  const node = reviewOf(ctx, task, true)
  const [to] = await targets(ctx, tasks, task, [input.to])
  const set = emptyChangeSet()
  set.taskPatches.push({
    id: task.id,
    from: 'pending',
    set: { state: 'transferred', comment: input.comment, handledAt: ctx.now },
  })
  set.newTasks.push({ ...copy(task, to!), ...retimed(ctx, node) })
  set.events.push(actionEvent('transfer', task, [to!], input.comment))
  return set
}

/**
 * 委派: the task waits as `delegated` while `to` handles a child (`ownerId` = the owner); the delegate's
 * approval puts the task back to pending for the owner to decide.
 */
export async function delegate(
  ctx: WfEngineCtx,
  _inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { to: number; comment: string | null },
): Promise<WfChangeSet> {
  reviewOf(ctx, task, true)
  const [to] = await targets(ctx, tasks, task, [input.to])
  const set = emptyChangeSet()
  set.taskPatches.push({ id: task.id, from: 'pending', set: { state: 'delegated' } })
  set.newTasks.push({ ...copy(task, to!), ownerId: task.assigneeId, parentTaskId: task.id })
  set.events.push(actionEvent('delegate', task, [to!], input.comment))
  return set
}

/**
 * 加签: a child task per user, all at once, each with the node's `timeout` from now. `before` suspends the task
 * (`waiting`) until they all approved; `after` approves it now, and the approval takes effect (the node's
 * `any`/`all`/`ordered` rule) once they all approved.
 */
export async function addSign(
  ctx: WfEngineCtx,
  _inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { kind: WfSignKind; userIds: readonly number[]; comment: string | null },
): Promise<WfChangeSet> {
  const node = reviewOf(ctx, task, true)
  const ids = await targets(ctx, tasks, task, input.userIds)
  const { kind, comment } = input
  const set = emptyChangeSet()
  set.taskPatches.push({
    id: task.id,
    from: 'pending',
    set:
      kind === 'before' ? { state: 'waiting' } : { state: 'approved', comment, handledAt: ctx.now },
  })
  ids.forEach((assigneeId, seq) =>
    set.newTasks.push({
      ...copy(task, assigneeId),
      parentTaskId: task.id,
      // an after-sign is created by the approval of `task`: withdrawing it finds them by this
      fromTaskId: kind === 'after' ? task.id : task.fromTaskId,
      signKind: kind,
      seq,
      dueAt: dueAt(ctx, node),
    }),
  )
  if (kind === 'after') set.events.push(actionEvent('approve', task, null, comment))
  set.events.push(actionEvent('add_sign', task, ids, kind === 'after' ? null : comment))
  return set
}

/**
 * 减签: cancels add-sign children of `task` (the actor's own, suspended or approved) still pending; a handled,
 * foreign or unknown id → 404. The last open one gone settles `task` as its last approval would.
 */
export async function removeSign(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { taskIds: readonly number[]; comment: string | null },
): Promise<WfChangeSet> {
  const ids = new Set(input.taskIds)
  const gone = tasks.filter(
    (t) =>
      ids.has(t.id) && t.parentTaskId === task.id && t.signKind !== null && t.state === 'pending',
  )
  if (!gone.length || gone.length !== ids.size) throw new BizError(Err.NOT_FOUND)
  const set = emptyChangeSet()
  for (const t of gone)
    set.taskPatches.push({ id: t.id, from: 'pending', set: { state: 'canceled' } })
  set.events.push(
    actionEvent(
      'remove_sign',
      task,
      gone.map((t) => t.assigneeId),
      input.comment,
    ),
  )
  const now = tasks.map((t) => (ids.has(t.id) ? { ...t, state: 'canceled' as const } : t))
  await signsDone(ctx, inst, now, task, set)
  return set
}
