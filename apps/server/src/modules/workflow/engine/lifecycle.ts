import {
  Err,
  type WfAction,
  type WfChangeSet,
  type WfInstance,
  type WfNewEvent,
  type WfTask,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import { actionEvent, endInstance, reviewOf } from './actions.js'
import {
  emptyChangeSet,
  event,
  OPEN,
  pathsOf,
  retimed,
  within,
  type WfEngineCtx,
} from './advance.js'
import { targets } from './routing.js'
import { AUTO_PASSED } from './timeout.js'

// Lifecycle actions (see docs/design-notes.md#workflow): cc, cancel, withdraw, terminate, reassign, comment. The services check who
// may act (reviewer / initiator / `wf.task.manage`, `allow_cancel`, `allow_withdraw`); the engine checks the
// instance and task states it reads (409; an ended instance has no open task left) and the targets (422).

const conflict = () => new BizError(Err.CONFLICT)

/** 抄送 by the reviewer of pending `task`: a `wf_cc` row per user (repeats dropped; none or not enabled → 422). */
export async function cc(
  ctx: WfEngineCtx,
  _inst: WfInstance,
  _tasks: readonly WfTask[],
  task: WfTask,
  input: { userIds: readonly number[]; reason: string | null },
): Promise<WfChangeSet> {
  if (task.state !== 'pending') throw conflict()
  const ids = [...new Set(input.userIds)]
  if (!ids.length || (await ctx.org.enabledUsers(ids)).length !== ids.length)
    throw new BizError(Err.UNPROCESSABLE)
  const set = emptyChangeSet()
  for (const userId of ids)
    set.ccs.push({
      nodeId: task.nodeId,
      userId,
      fromTaskId: task.id,
      fromUserId: task.assigneeId,
      reason: input.reason,
    })
  set.events.push(actionEvent('cc', task, ids, input.reason))
  return set
}

/** Ends a running instance as `canceled` (撤销, the initiator) or `terminated` (终止, an admin). */
function stop(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  how: { action: 'cancel' | 'terminate'; actorId: number; comment: string | null },
): WfChangeSet {
  if (inst.state !== 'running') throw conflict()
  const set = emptyChangeSet()
  endInstance(ctx, tasks, set, how.action === 'cancel' ? 'canceled' : 'terminated')
  set.events.push(event(how.action, null, how.actorId, null, how.comment))
  return set
}

/** 撤销实例 by the initiator: every open task is canceled, the instance `canceled`. */
export const cancel = (
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  input: { comment: string | null },
) => stop(ctx, inst, tasks, { action: 'cancel', actorId: inst.initiatorId, ...input })

/** 终止 by an admin: every open task is canceled, the instance `terminated`. */
export const terminate = (
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  input: { actorId: number; comment: string | null },
) => stop(ctx, inst, tasks, { action: 'terminate', ...input })

/**
 * 改派 by an admin (e.g. the assignee left): open review `task` goes to `to`, an enabled user without an open
 * task on the node (else 422 `WF_BAD_TARGET`, as transfer); a delegated task's open delegate task gets
 * `to` as its owner. The initiator's `begin` task is theirs alone (resubmit or cancel), 422. A pending task on a
 * node with a `timeout.action` is timed anew (a `waiting` one keeps its null or suspended `dueAt`).
 */
export async function reassign(
  ctx: WfEngineCtx,
  _inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { actorId: number; to: number; comment: string | null },
): Promise<WfChangeSet> {
  const node = reviewOf(ctx, task)
  if (!OPEN.includes(task.state)) throw conflict()
  const [to] = await targets(ctx, tasks, task, [input.to])
  const set = emptyChangeSet()
  set.taskPatches.push({
    id: task.id,
    from: task.state,
    set: { assigneeId: to!, ...(task.state === 'pending' && retimed(ctx, node)) },
  })
  // a delegated task: its delegate's open task answers to the new assignee (`ownerId`, who decides after it)
  for (const c of tasks)
    if (c.parentTaskId === task.id && c.signKind === null && OPEN.includes(c.state))
      set.taskPatches.push({ id: c.id, from: c.state, set: { ownerId: to! } })
  set.events.push({
    ...actionEvent('reassign', task, [to!], input.comment),
    actorId: input.actorId,
  })
  return set
}

/** 评论 by the holder of pending `task`: an event, nothing else. */
export function comment(
  _ctx: WfEngineCtx,
  _inst: WfInstance,
  _tasks: readonly WfTask[],
  task: WfTask,
  input: { comment: string },
): WfChangeSet {
  if (task.state !== 'pending') throw conflict()
  const set = emptyChangeSet()
  set.events.push(actionEvent('comment', task, null, input.comment))
  return set
}

/** a task someone worked on without deciding it (add-sign, delegation, comment; transfer too; see docs/design-notes.md#workflow) */
const HANDLED: readonly WfAction[] = ['comment', 'delegate', 'add_sign', 'transfer']

/**
 * 撤回 of approved review `task` (no add-sign / delegate child, else 422). What it created — tasks whose
 * `fromTaskId` is `task` (on a fork path only this path's; after-signers too, but not those a
 * remove-sign canceled, matched to its `remove_sign` event below), and on an `ordered` node the next
 * reviewer it activated — must all be untouched: pending or waiting, no child and no `HANDLED` action in
 * `events` (the instance's `wf_event` rows). They are withdrawn (the next ordered reviewer
 * waits again; one still waiting behind an after-sign stays), `task` is pending again and on an `any` node so
 * are the co-reviewers its approval canceled. Created nothing: its node must still hold the token for this
 * round (an `all` node with others or their add-sign children open), or its fork path's join must still
 * wait (`joinWaits`). Else → 409. An approval the remind job made (`timeout` event with `AUTO_PASSED`) is
 * never withdrawn (409). On a node with a `timeout.action` the tasks pending again are timed anew.
 * Ccs of notify nodes it passed stay (the adapter skips a repeat when it is approved again, `WfChangeSet.ccs`).
 * A canceled co-reviewer with a child (it had delegated or before-signed) → 409, as its state before
 * the cancel cannot be rebuilt (children a remove-sign canceled look the same); an after-signed co-reviewer
 * whose signers the approval canceled stays approved without effect. Rebuild them if that shows up.
 */
export function withdraw(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: {
    comment: string | null
    events: readonly (Pick<WfNewEvent, 'action' | 'taskId' | 'targetIds'> & {
      comment?: string | null
    })[]
  },
): WfChangeSet {
  const node = reviewOf(ctx, task, true)
  if (task.state !== 'approved') throw conflict()
  if (
    input.events.some(
      (e) => e.action === 'timeout' && e.taskId === task.id && e.comment === AUTO_PASSED,
    )
  )
    throw conflict()
  // this round of the node: created together (transfer copies included; a withdrawn earlier round is not;
  // add-sign children number `seq` on their own)
  const round = tasks.filter(
    (t) =>
      t.nodeId === task.nodeId &&
      t.parentTaskId === null &&
      t.fromTaskId === task.fromTaskId &&
      t.state !== 'withdrawn' &&
      t.id !== task.id,
  )
  const next = node.sign === 'ordered' ? round.filter((t) => t.seq === task.seq + 1) : []
  // A `remove_sign` event names users, not tasks: a canceled child counts as removed when every canceled child
  // of the parent for that user was removed by a remove_sign naming them (a user holds one open child of a
  // parent at a time; a child canceled otherwise ends its parent's children, so it is never matched).
  const mine = (t: WfTask, c: WfTask) =>
    c.parentTaskId === t.parentTaskId && c.assigneeId === t.assigneeId && c.state === 'canceled'
  const removed = (t: WfTask) =>
    mine(t, t) &&
    tasks.filter((c) => mine(t, c)).length <=
      input.events.filter(
        (e) =>
          e.action === 'remove_sign' &&
          e.taskId === t.parentTaskId &&
          e.targetIds?.some((id) => id === t.assigneeId),
      ).length
  const made = tasks.filter(
    (t) => t.fromTaskId === task.id && t.state !== 'withdrawn' && !removed(t),
  )
  // only an `any` approval cancels its round (the others end the instance or reset the node: 409 below)
  const back = round.filter((t) => t.state === 'canceled')
  const hasChild = (t: WfTask) => tasks.some((c) => c.parentTaskId === t.id)
  const untouched = (t: WfTask) =>
    (t.state === 'pending' || t.state === 'waiting') &&
    !hasChild(t) &&
    !input.events.some((e) => e.taskId === t.id && HANDLED.includes(e.action))
  if (![...made, ...next].every(untouched) || back.some(hasChild)) throw conflict()
  const active = inst.activeNodeIds
  if (!made.length && !next.length) {
    // a co-reviewer or its add-sign child (an after-signer leaves its parent approved) still open
    const holds = tasks.some(
      (t) =>
        OPEN.includes(t.state) && (round.includes(t) || round.some((p) => p.id === t.parentTaskId)),
    )
    if (!holds && !joinWaits(ctx, active, tasks, task)) throw conflict()
  }
  const set = emptyChangeSet()
  for (const t of made)
    set.taskPatches.push({ id: t.id, from: t.state, set: { state: 'withdrawn' } })
  for (const t of next)
    if (t.state === 'pending')
      set.taskPatches.push({ id: t.id, from: 'pending', set: { state: 'waiting', dueAt: null } })
  for (const t of back)
    set.taskPatches.push({
      id: t.id,
      from: 'canceled',
      set: { state: 'pending', ...retimed(ctx, node) },
    })
  set.taskPatches.push({
    id: task.id,
    from: 'approved',
    set: { state: 'pending', comment: null, handledAt: null, ...retimed(ctx, node) },
  })
  const moved = new Set(made.map((t) => t.nodeId))
  set.instance.activeNodeIds = [...new Set([...active.filter((id) => !moved.has(id)), task.nodeId])]
  set.events.push(actionEvent('withdraw', task, null, input.comment))
  return set
}

/**
 * `task` ended its fork path and its approval still only waits at the join: no task (not withdrawn since) was
 * created after it in line with the innermost fork holding it (after that fork's join, before the fork or at
 * `begin`: the join fired or the fork was left), and the innermost fork around it holding a token has none on
 * its own path (one there means the path was entered again, e.g. through a send-back target that passed by
 * itself).
 */
function joinWaits(
  ctx: WfEngineCtx,
  active: readonly string[],
  tasks: readonly WfTask[],
  task: WfTask,
): boolean {
  const { flow } = ctx
  const paths = pathsOf(flow, task.nodeId)
  const around = paths.slice(1)
  const inLine = (id: string) => pathsOf(flow, id).every((p) => around.includes(p))
  if (tasks.some((t) => t.id > task.id && t.state !== 'withdrawn' && inLine(t.nodeId))) return false
  for (const p of paths) {
    const inFork = active.filter((a) => within(flow, a, flow.paths.get(p)!.forkId))
    if (inFork.length) return !inFork.some((a) => pathsOf(flow, a).includes(p))
  }
  return false
}
