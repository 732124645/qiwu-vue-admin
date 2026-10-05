import {
  Err,
  type FormSchema,
  type OrgDirectory,
  type WfAction,
  type WfBeginNode,
  type WfChangeSet,
  type WfCompiled,
  type WfFields,
  type WfForkNode,
  type WfForkPath,
  type WfInstance,
  type WfReviewNode,
  type WfTask,
  type WfTaskState,
} from '@qiwu/shared'
import { BizError } from '../../../core/http/biz-error.js'
import { matchWhen } from './condition.js'
import { resolveAssignees } from './wf-assignee.js'

// Token moves (see docs/design-notes.md#workflow): where a token goes after the start or a finished node, and the tasks, ccs and
// events that produces. Pure: reads its arguments and the org chart, appends to the caller's change set.

/** What engine calls read besides the instance and its tasks. */
export interface WfEngineCtx {
  flow: WfCompiled
  fields: WfFields
  /** a dynamic form's sanitized schema: its calc components' results are recomputed on every edit */
  schema?: FormSchema
  org: OrgDirectory
  /** `wf_model.manager_user_ids`: where `whenNobody: 'toManager'` goes */
  managerIds: readonly number[]
  /** the action time (the adapter writes it as the new tasks' `createdAt`) */
  now: Date
}

const HOUR = 3_600_000
/**
 * Tasks still to be decided: a `delegated` one waits for its delegate. Send-back and cancel
 * cancel `waiting` and `delegated` ones too, or a re-entered node sees them.
 */
export const OPEN: readonly WfTaskState[] = ['waiting', 'pending', 'delegated']

export const emptyChangeSet = (): WfChangeSet => ({
  instance: {},
  newTasks: [],
  taskPatches: [],
  ccs: [],
  events: [],
})

/** an event of no task (a system move, or an instance-wide action: `nodeId` null) */
export const event = (
  action: WfAction,
  nodeId: string | null,
  actorId: number | null,
  targetIds: number[] | null = null,
  comment: string | null = null,
) => ({
  action,
  taskId: null,
  nodeId,
  actorId,
  targetIds,
  comment,
})

/** `dueAt` of a task that becomes pending now: `timeout.hours` from now, none without a timeout. */
export const dueAt = (ctx: WfEngineCtx, node: WfReviewNode) =>
  node.timeout ? new Date(ctx.now.getTime() + node.timeout.hours * HOUR) : null

/**
 * A handed-over (transfer, reassign) or withdrawn task's patch on a node with a `timeout.action`: its time starts again, else the remind job would act on the old `dueAt` within minutes. Without
 * an action nothing (the old `dueAt` stays).
 */
export const retimed = (ctx: WfEngineCtx, node: WfReviewNode) =>
  node.timeout?.action ? { dueAt: dueAt(ctx, node) } : {}

/** `nodeId` lies inside a path of fork `forkId`, at any depth (unknown ids never do). */
export const within = (flow: WfCompiled, nodeId: string, forkId: string) =>
  pathsOf(flow, nodeId).some((p) => flow.paths.get(p)!.forkId === forkId)

/** fork paths holding node `id`, innermost first (none for an unknown id) */
export function pathsOf(flow: WfCompiled, id: string): string[] {
  const out: string[] = []
  for (let p = flow.nodes.get(id)?.parentPathId ?? null; p !== null;) {
    out.push(p)
    p = flow.nodes.get(flow.paths.get(p)!.forkId)!.parentPathId
  }
  return out
}

/** `id` itself or the fork on chain `scope` (a path id, null = the main line) that holds it */
export function onChain(flow: WfCompiled, id: string, scope: string | null): string {
  for (let p = flow.nodes.get(id)!.parentPathId; p !== scope; p = flow.nodes.get(id)!.parentPathId)
    id = flow.paths.get(p!)!.forkId
  return id
}

/**
 * The paths a token takes into `fork`: `parallel` all of them; `exclusive` the first matching path in
 * path order, `inclusive` every matching one, both else the fallback (picked by its flag, not its place).
 * `via` (a resubmit back to its sender) is taken whatever the values say and counts as the match:
 * `exclusive` takes it alone, `inclusive` adds the other matching paths, neither the fallback.
 */
export function pathsTaken(
  fields: WfFields,
  inst: WfInstance,
  fork: WfForkNode,
  via?: string,
): WfForkPath[] {
  if (fork.mode === 'parallel') return fork.paths
  const matches = (p: WfForkPath) => !p.fallback && matchWhen(p.when, fields, inst)
  if (via !== undefined)
    return fork.paths.filter((p) => p.id === via || (fork.mode === 'inclusive' && matches(p)))
  const hit = fork.paths.filter(matches)
  const taken = fork.mode === 'inclusive' ? hit : hit.slice(0, 1)
  return taken.length ? taken : fork.paths.filter((p) => p.fallback)
}

/**
 * Who reviews `node`: the resolved assignees after `whenInitiatorIsReviewer` (`skip` drops the initiator, and
 * a node the initiator alone had passes; `deptHead` puts the initiator's nearest dept head that is not the
 * initiator in their place), then `whenNobody` if none is left. Empty = the node passes by itself.
 * Decision: the `whenNobody` targets are taken as they are, not run through
 * `whenInitiatorIsReviewer`, so an initiator who is a process manager / the fallback user reviews it.
 */
async function reviewersOf(
  ctx: WfEngineCtx,
  inst: WfInstance,
  node: WfReviewNode,
): Promise<number[]> {
  const { org } = ctx
  const me = inst.initiatorId
  let ids = await resolveAssignees(node, inst, org)
  if (ids.includes(me) && node.whenInitiatorIsReviewer === 'skip') {
    ids = ids.filter((id) => id !== me)
    if (!ids.length) return []
  } else if (ids.includes(me) && node.whenInitiatorIsReviewer === 'deptHead') {
    const dept = await org.deptOfUser(me)
    const head =
      dept === null ? undefined : (await org.deptHeads(dept, Infinity)).find((id) => id !== me)
    ids = [...new Set(ids.flatMap((id) => (id !== me ? [id] : head === undefined ? [] : [head])))]
  }
  if (ids.length || node.whenNobody === 'autoPass') return ids
  const other =
    node.whenNobody === 'toManager'
      ? await org.enabledUsers(ctx.managerIds)
      : node.fallbackUserId === undefined
        ? []
        : await org.enabledUsers([node.fallbackUserId])
  // never a silent pass: the action fails until an admin fixes the process or the org chart
  if (!other.length) throw new BizError(Err.WF_NO_ASSIGNEE, { node: node.name })
  return other
}

/** One token move: the instance with this action's form values, the change set, the active node ids so far. */
interface Walk {
  ctx: WfEngineCtx
  inst: WfInstance
  set: WfChangeSet
  active: Set<string>
  fromTaskId: number | null
  /** a resubmit's sender: a fork holding it takes the path to it and enters that path at it */
  toward: string | null
}

/**
 * Enters node `id` (null = nothing to enter) and walks down its chain through notify nodes, forks and nodes
 * that pass by themselves. A fork sends a token down every path it takes and goes on to `fork.next` only if
 * none of them rests. True = a token rests (on this chain or inside one of its forks), false = the chain ended.
 */
async function enter(w: Walk, id: string | null): Promise<boolean> {
  const { ctx, inst, set, active, fromTaskId } = w
  for (; id !== null; id = ctx.flow.nodes.get(id)!.next) {
    const { node } = ctx.flow.nodes.get(id)!
    if (node.type === 'fork') {
      const via =
        w.toward === null
          ? undefined
          : pathsOf(ctx.flow, w.toward).find((p) => ctx.flow.paths.get(p)!.forkId === id)
      let rests = false
      // every path, also after one has rested; the one toward the sender starts at the node on it holding it
      for (const p of pathsTaken(ctx.fields, inst, node, via))
        rests =
          (await enter(
            w,
            p.id === via ? onChain(ctx.flow, w.toward!, via) : (p.child?.id ?? null),
          )) || rests
      if (rests) return true
      continue
    }
    if (node.type === 'notify') {
      const users = await resolveAssignees(node, inst, ctx.org)
      for (const userId of users)
        set.ccs.push({ nodeId: id, userId, fromTaskId, fromUserId: null, reason: null })
      if (users.length) set.events.push(event('cc', id, null, users))
      continue
    }
    const users = node.type === 'begin' ? [inst.initiatorId] : await reviewersOf(ctx, inst, node)
    if (!users.length) {
      set.events.push(event('approve', id, null))
      continue
    }
    const review = node.type === 'review' ? node : null
    users.forEach((assigneeId, seq) => {
      const waiting = review?.sign === 'ordered' && seq > 0
      set.newTasks.push({
        nodeId: node.id,
        nodeName: node.name,
        assigneeId,
        ownerId: null,
        parentTaskId: null,
        fromTaskId,
        signKind: null,
        seq,
        state: waiting ? 'waiting' : 'pending',
        dueAt: review && !waiting ? dueAt(ctx, review) : null,
      })
    })
    active.add(id)
    return true
  }
  return false
}

/**
 * Moves the token on `from` (null = a new token) into `to`, or, without `to`, on to what follows `from`, and
 * walks it (see `enter`) until it rests on nodes with tasks. A fork path's end waits while a token is left
 * inside that fork; the last one out goes on from `fork.next` (join). The main chain's end approves
 * the instance. New tasks and ccs carry `fromTaskId`, the task whose completion moved the token. `toward`: see
 * `Walk`.
 */
export async function moveToken(
  ctx: WfEngineCtx,
  inst: WfInstance,
  set: WfChangeSet,
  move: { from: string | null; to?: string; toward?: string; fromTaskId: number | null },
): Promise<void> {
  const { flow } = ctx
  // form values this action already changed (an approver's edit fields, a resubmit) decide forks and reviewers
  inst = { ...inst, formValues: set.instance.formValues ?? inst.formValues }
  const active = new Set(set.instance.activeNodeIds ?? inst.activeNodeIds)
  if (move.from !== null) active.delete(move.from)
  const w: Walk = {
    ctx,
    inst,
    set,
    active,
    fromTaskId: move.fromTaskId,
    toward: move.toward ?? null,
  }
  // any node of the chain being walked; `from` and `to` null together is a caller bug
  let at = move.to ?? move.from!
  let rests = await enter(w, move.to ?? flow.nodes.get(at)!.next)
  while (!rests) {
    const pathId = flow.nodes.get(at)!.parentPathId
    if (pathId === null) {
      set.instance.state = 'approved'
      set.instance.endedAt = ctx.now
      break
    }
    at = flow.paths.get(pathId)!.forkId
    if ([...active].some((id) => within(flow, id, at))) break
    rests = await enter(w, flow.nodes.get(at)!.next)
  }
  set.instance.activeNodeIds = [...active]
}

/** Start (see docs/design-notes.md#workflow): the `begin` event, then a token from `begin.next`. */
export async function start(ctx: WfEngineCtx, inst: WfInstance): Promise<WfChangeSet> {
  const set = emptyChangeSet()
  const root: WfBeginNode = ctx.flow.root
  set.events.push(event('begin', root.id, inst.initiatorId))
  await moveToken(ctx, inst, set, { from: root.id, fromTaskId: null })
  return set
}

/**
 * After `task` was approved. A child task (delegate or add-sign) answers to its parent: a delegate's hands the parent back to
 * its owner, an add-sign's settles the parent once it was the last open one (`signsDone`). A review task:
 * `any` cancels the node's other open tasks and finishes it; `all` finishes once no other task is open;
 * `ordered` hands the node to the next waiting reviewer (their `dueAt` starts now) and finishes after the last.
 * A finished node moves its token on. `all` never activates a waiting task, and an `ordered` node has no
 * suspended before-sign parent when this runs (its one pending reviewer is that parent), so neither picks one.
 * An activated ordered task keeps its `fromTaskId` (the previous node's task), so withdrawing an ordered
 * approval looks at the same node's next seq, not at `fromTaskId`.
 */
export async function taskApproved(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  set: WfChangeSet,
): Promise<void> {
  if (task.parentTaskId !== null) {
    const parent = tasks.find((t) => t.id === task.parentTaskId)!
    if (task.signKind === null)
      set.taskPatches.push({ id: parent.id, from: 'delegated', set: { state: 'pending' } })
    else {
      const done = tasks.map((t) => (t.id === task.id ? { ...t, state: 'approved' as const } : t))
      await signsDone(ctx, inst, done, parent, set)
    }
    return
  }
  const node = ctx.flow.nodes.get(task.nodeId)!.node as WfReviewNode
  const open = tasks.filter(
    (t) => t.nodeId === node.id && t.id !== task.id && OPEN.includes(t.state),
  )
  if (node.sign === 'any') {
    for (const t of open)
      set.taskPatches.push({ id: t.id, from: t.state, set: { state: 'canceled' } })
  } else {
    const next =
      node.sign === 'ordered' &&
      open.filter((t) => t.state === 'waiting').sort((a, b) => a.seq - b.seq)[0]
    if (next)
      set.taskPatches.push({
        id: next.id,
        from: 'waiting',
        set: { state: 'pending', dueAt: dueAt(ctx, node) },
      })
    if (open.length) return
  }
  await moveToken(ctx, inst, set, { from: node.id, fromTaskId: task.id })
}

/**
 * `parent`'s add-sign children as `tasks` now stand: once none is open, a before-sign parent (waiting)
 * is pending again, and an after-sign parent's approval (approved already) takes effect through `taskApproved`;
 * a parent in any other state (e.g. pending again after a withdraw) never moves the token.
 */
export async function signsDone(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  parent: WfTask,
  set: WfChangeSet,
): Promise<void> {
  if (tasks.some((t) => t.parentTaskId === parent.id && OPEN.includes(t.state))) return
  if (parent.state === 'waiting')
    set.taskPatches.push({ id: parent.id, from: 'waiting', set: { state: 'pending' } })
  else if (parent.state === 'approved') await taskApproved(ctx, inst, tasks, parent, set)
}
