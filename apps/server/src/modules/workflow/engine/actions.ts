import {
  applyFormCalc,
  Err,
  type WfAction,
  type WfChangeSet,
  type WfCompiled,
  type WfInstance,
  type WfInstanceState,
  type WfReviewNode,
  type WfTask,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import {
  emptyChangeSet,
  moveToken,
  onChain,
  OPEN,
  pathsOf,
  taskApproved,
  type WfEngineCtx,
} from './advance.js'
import { editableValues } from './form-values.js'

// Decisions (see docs/design-notes.md#workflow): approve, reject, send back, resubmit. Each takes the task its holder acts
// on (the services check it is theirs; the patches expect its state, else 409) and returns the change set.

type Values = Record<string, unknown>

export const actionEvent = (
  action: WfAction,
  task: WfTask,
  targetIds: number[] | string[] | null,
  comment: string | null,
) => ({
  action,
  taskId: task.id,
  nodeId: task.nodeId,
  actorId: task.assigneeId,
  targetIds,
  comment,
})

/** Cancels every open task but `exceptId`'s and ends the instance in `state`. */
export function endInstance(
  ctx: WfEngineCtx,
  tasks: readonly WfTask[],
  set: WfChangeSet,
  state: WfInstanceState,
  exceptId: number | null = null,
): void {
  for (const t of tasks)
    if (t.id !== exceptId && OPEN.includes(t.state))
      set.taskPatches.push({ id: t.id, from: t.state, set: { state: 'canceled' } })
  set.instance = { ...set.instance, state, activeNodeIds: [], endedAt: ctx.now }
}

/** The review node of `task`; `decision` = only a reviewer's own task (no add-sign / delegate child), else 422. */
export function reviewOf(ctx: WfEngineCtx, task: WfTask, decision = false): WfReviewNode {
  const { node } = ctx.flow.nodes.get(task.nodeId)!
  if (node.type !== 'review' || (decision && task.parentTaskId !== null))
    throw new BizError(Err.UNPROCESSABLE)
  return node
}

/** innermost fork path holding both nodes; null = the main line */
const scopeOf = (flow: WfCompiled, a: string, b: string) =>
  pathsOf(flow, a).find((p) => pathsOf(flow, b).includes(p)) ?? null

/** `a` comes before `b` on the way to `b` (a node on a sibling fork path never does) */
function precedes(flow: WfCompiled, a: string, b: string): boolean {
  const scope = scopeOf(flow, a, b)
  const to = onChain(flow, b, scope)
  for (let id = flow.nodes.get(onChain(flow, a, scope))!.next; id !== null;) {
    if (id === to) return true
    id = flow.nodes.get(id)!.next
  }
  return false
}

/** the review node whose send-back created `beginTask`, when it wants resubmits back at itself */
function senderOf(flow: WfCompiled, tasks: readonly WfTask[], beginTask: WfTask): string | null {
  const from = tasks.find((t) => t.id === beginTask.fromTaskId)
  const node = from && flow.nodes.get(from.nodeId)!.node
  return node?.type === 'review' && node.resubmitTo === 'sender' ? node.id : null
}

/**
 * Send-back targets of `task`: review nodes upstream of it that were actually walked (an
 * approved task since the last `restart` resubmit), newest task first (creation order), then `begin`.
 * Nodes of a fork path this pass did not take still count when they were approved earlier: an
 * approver's edit that turns an exclusive fork after a send-back, or a resubmit to a sender that re-enters an
 * inclusive fork whose new values drop a sibling path approved in the earlier round (after the join its nodes
 * are listed, and a send-back there runs that path again); track fork passes if that shows up.
 */
export function backTargets(ctx: WfEngineCtx, tasks: readonly WfTask[], task: WfTask): string[] {
  const { flow } = ctx
  const begin = flow.root.id
  const restart = Math.max(
    0,
    ...tasks
      .filter((t) => t.nodeId === begin && t.state === 'approved' && !senderOf(flow, tasks, t))
      .map((t) => t.id),
  )
  const walked = tasks
    .filter((t) => t.id > restart && t.state === 'approved' && t.nodeId !== begin)
    .sort((a, b) => b.id - a.id)
    .map((t) => t.nodeId)
  return [...new Set(walked)].filter((id) => precedes(flow, id, task.nodeId)).concat(begin)
}

/**
 * Closes `task` as `state` and moves the work back to `to` (begin = the initiator): open tasks inside the
 * innermost fork path holding both are canceled (a target on the task's own path resets only that path, one
 * before the fork re-enters the fork) and a token enters `to` again.
 */
async function backTo(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  to: string,
  how: { state: 'rejected' | 'sent_back'; action: WfAction; comment: string | null },
): Promise<WfChangeSet> {
  const { flow } = ctx
  const scope = scopeOf(flow, to, task.nodeId)
  const reset = (id: string) => scope === null || pathsOf(flow, id).includes(scope)
  const set = emptyChangeSet()
  set.taskPatches.push({
    id: task.id,
    from: 'pending',
    set: { state: how.state, comment: how.comment, handledAt: ctx.now },
  })
  for (const t of tasks)
    if (t.id !== task.id && OPEN.includes(t.state) && reset(t.nodeId))
      set.taskPatches.push({ id: t.id, from: t.state, set: { state: 'canceled' } })
  set.events.push(actionEvent(how.action, task, [to], how.comment))
  set.instance.activeNodeIds = inst.activeNodeIds.filter((id) => !reset(id))
  await moveToken(ctx, inst, set, { from: null, to, fromTaskId: task.id })
  return set
}

/**
 * 通过: `edits` keep only the node's `edit` fields and apply before the token moves (the form's calc results
 * recomputed from them, `ctx.schema`); then the node's `any`/`all`/`ordered` rule (`taskApproved`).
 */
export async function approve(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { comment: string | null; edits?: Values },
): Promise<WfChangeSet> {
  const node = reviewOf(ctx, task)
  const set = emptyChangeSet()
  if (input.edits)
    set.instance.formValues = applyFormCalc(ctx.schema, {
      ...inst.formValues,
      ...editableValues(input.edits, node.access),
    })
  set.taskPatches.push({
    id: task.id,
    from: 'pending',
    set: { state: 'approved', comment: input.comment, handledAt: ctx.now },
  })
  set.events.push(actionEvent('approve', task, null, input.comment))
  await taskApproved(ctx, inst, tasks, task, set)
  return set
}

/**
 * 驳回 (one reviewer rejects the whole node, `all` too): `onReject: finish` rejects the instance and cancels
 * every open task, other fork paths included; `sendBack` goes back to `to` (one of `backTargets`, else 422;
 * the timeout's auto-reject picks it) or by default the first of them, the event carrying the target.
 */
export async function reject(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { comment: string | null; to?: string },
): Promise<WfChangeSet> {
  const { comment } = input
  if (reviewOf(ctx, task, true).onReject === 'sendBack') {
    const back = backTargets(ctx, tasks, task)
    const to = input.to ?? back[0]!
    if (!back.includes(to)) throw new BizError(Err.UNPROCESSABLE)
    return backTo(ctx, inst, tasks, task, to, { state: 'rejected', action: 'reject', comment })
  }
  const set = emptyChangeSet()
  set.taskPatches.push({
    id: task.id,
    from: 'pending',
    set: { state: 'rejected', comment, handledAt: ctx.now },
  })
  endInstance(ctx, tasks, set, 'rejected', task.id)
  set.events.push(actionEvent('reject', task, null, comment))
  return set
}

/** 退回 to one of `backTargets` (else 422); `begin` gives the initiator a task, the instance keeps running. */
export async function sendBack(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { to: string; comment: string | null },
): Promise<WfChangeSet> {
  reviewOf(ctx, task, true)
  if (!backTargets(ctx, tasks, task).includes(input.to)) throw new BizError(Err.UNPROCESSABLE)
  return backTo(ctx, inst, tasks, task, input.to, {
    state: 'sent_back',
    action: 'send_back',
    comment: input.comment,
  })
}

/**
 * 重新提交 of the initiator's `begin` task (else 422): the form values become the stored ones (a custom form's
 * adapter passes them freshly loaded in `inst`) with the `edit` fields of `begin.access` taken from `edits`,
 * calc results recomputed (`ctx.schema`), so the forks below branch on them.
 * The node that sent it back decides where it goes (`resubmitTo`): `restart` walks from `begin.next`,
 * `sender` gets a task again directly. On a parallel / inclusive path (its send-back canceled the other paths)
 * the outermost such fork holding it is entered again: the path to the sender, with the forks nested
 * in it, is taken and entered at the sender (no condition, no earlier node of it again), the other paths run
 * as on a first entry (`parallel` all, `inclusive` the ones the new values match, no fallback).
 */
export async function resubmit(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  input: { comment: string | null; edits?: Values },
): Promise<WfChangeSet> {
  const { flow } = ctx
  const { root } = flow
  if (task.nodeId !== root.id) throw new BizError(Err.UNPROCESSABLE)
  const set = emptyChangeSet()
  set.instance.formValues = applyFormCalc(ctx.schema, {
    ...inst.formValues,
    ...editableValues(input.edits ?? {}, root.access),
  })
  set.taskPatches.push({
    id: task.id,
    from: 'pending',
    set: { state: 'approved', comment: input.comment, handledAt: ctx.now },
  })
  set.events.push(actionEvent('resubmit', task, null, input.comment))
  const sender = senderOf(flow, tasks, task) ?? undefined
  // the main-line node holding the sender: the outermost fork around it (an exclusive one takes only the path
  // toward it, as the sender itself would) or the sender
  await moveToken(ctx, inst, set, {
    from: root.id,
    to: sender === undefined ? undefined : onChain(flow, sender, null),
    toward: sender,
    fromTaskId: task.id,
  })
  return set
}
