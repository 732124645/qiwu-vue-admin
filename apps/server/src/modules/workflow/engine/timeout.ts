import type {
  WfAction,
  WfChangeSet,
  WfInstance,
  WfNewEvent,
  WfReviewNode,
  WfTask,
} from '@qiwu/shared'
import { approve, backTargets, reject } from './actions.js'
import { emptyChangeSet, OPEN, type WfEngineCtx } from './advance.js'
import { transfer } from './routing.js'

// Timeout auto-handling: what the remind job does with an overdue review task whose node
// has a `timeout.action`. Pure like the other engine calls: it reuses approve / reject / transfer and swaps
// their decision event for a system `timeout` event, put first (WfNotify reads the first event's actor).

/** `toManager` / `toAdmin` = handed to the assignee's superior / a process manager; `remindOnly` = nobody fits */
export type WfTimeoutOutcome = 'autoPass' | 'autoReject' | 'toManager' | 'toAdmin' | 'remindOnly'

/** the `timeout` event's comment: a `seed.json` key, translated for the timeline and the notice */
export const timeoutKey = (outcome: WfTimeoutOutcome | 'failed') => `seed.wf.timeout.${outcome}`
/** an auto-passed approval: withdraw refuses it, an auto-reject's send-back skips its node */
export const AUTO_PASSED = timeoutKey('autoPass')

/** the system's `timeout` event of `task` (no actor); `targetIds` as the event it replaces */
export const timeoutEvent = (
  task: WfTask,
  outcome: WfTimeoutOutcome | 'failed',
  targetIds: WfNewEvent['targetIds'] = null,
): WfNewEvent => ({
  action: 'timeout',
  taskId: task.id,
  nodeId: task.nodeId,
  actorId: null,
  targetIds,
  comment: timeoutKey(outcome),
})

type Events = readonly (Pick<WfNewEvent, 'action' | 'taskId'> & { comment?: string | null })[]

/**
 * The remind job's call for overdue `task` (`events` = the instance's `wf_event` rows). Null = not handled
 * here: not pending, a child (delegate / add-sign) task, not due, it ever had a child (delegated or
 * add-signed: only reminded), or its node has no `timeout.action`; the adapter reminds or skips it.
 * - `autoPass` = approve; `autoReject` = reject by the node's `onReject`, a send-back to the first of
 *   `backTargets` whose newest approval was not auto-passed (`begin` at the end never is): no autoPass ↔
 *   autoReject loop.
 * - `toManager` (not `whenNobody: 'toManager'`, the process managers) = transfer to the assignee's superior:
 *   the head of their dept, or when they head it the parent dept's head (`deptHeads` skips disabled ones;
 *   none further up). Not eligible: anyone who held this round of the node (same `fromTaskId`, no parent: the transfer
 *   chain, the assignee too) or holds an open task on it (`targets` would 422), and the initiator unless the
 *   node lets them review (`whenInitiatorIsReviewer: 'self'`; `reviewersOf` applies it only on entering).
 *   Then the first eligible enabled process manager in `managerIds` order (`toAdmin`), else `remindOnly`.
 *   An `any` node whose superior or a process manager already holds an open task on it: `remindOnly` (one
 *   approval does, nobody else is drawn in). Every hop goes to someone new, so the chain ends.
 */
export async function onTimeout(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  events: Events,
): Promise<{ outcome: WfTimeoutOutcome; set: WfChangeSet } | null> {
  const { node } = ctx.flow.nodes.get(task.nodeId)!
  if (
    task.state !== 'pending' ||
    task.parentTaskId !== null ||
    task.dueAt === null ||
    task.dueAt > ctx.now ||
    tasks.some((t) => t.parentTaskId === task.id) ||
    node.type !== 'review' ||
    !node.timeout?.action
  )
    return null
  const { action } = node.timeout
  if (action === 'toManager') {
    const hop = await superiorOf(ctx, inst, tasks, task, node)
    if (!hop) {
      const set = emptyChangeSet()
      set.events.push(timeoutEvent(task, 'remindOnly'))
      return { outcome: 'remindOnly', set }
    }
    const set = await transfer(ctx, inst, tasks, task, { to: hop.to, comment: null })
    return swap(task, hop.outcome, 'transfer', set)
  }
  const input = { comment: null }
  if (action === 'autoPass')
    return swap(task, 'autoPass', 'approve', await approve(ctx, inst, tasks, task, input))
  // `finish` ignores `to`
  const to = backTargets(ctx, tasks, task).find((id) => !autoPassed(tasks, events, id))
  return swap(task, 'autoReject', 'reject', await reject(ctx, inst, tasks, task, { ...input, to }))
}

/** `set` with `task`'s `decision` event replaced by the system's `timeout` event, first */
function swap(task: WfTask, outcome: WfTimeoutOutcome, decision: WfAction, set: WfChangeSet) {
  const at = set.events.findIndex((e) => e.action === decision && e.taskId === task.id)
  const [made] = set.events.splice(at, 1)
  set.events.unshift(timeoutEvent(task, outcome, made!.targetIds))
  return { outcome, set }
}

/** node `nodeId`'s newest approval (by task id, as `backTargets`) was the remind job's */
function autoPassed(tasks: readonly WfTask[], events: Events, nodeId: string): boolean {
  const last = Math.max(
    0,
    ...tasks.filter((t) => t.nodeId === nodeId && t.state === 'approved').map((t) => t.id),
  )
  return events.some(
    (e) => e.action === 'timeout' && e.taskId === last && e.comment === AUTO_PASSED,
  )
}

/** where `toManager` hands `task` (see `onTimeout`); undefined = remind only */
async function superiorOf(
  ctx: WfEngineCtx,
  inst: WfInstance,
  tasks: readonly WfTask[],
  task: WfTask,
  node: WfReviewNode,
): Promise<{ to: number; outcome: 'toManager' | 'toAdmin' } | undefined> {
  const { org, managerIds } = ctx
  const me = task.assigneeId
  const dept = await org.deptOfUser(me)
  const [head] = dept === null ? [] : await org.deptHeads(dept, 1)
  const up = head !== me ? head : (await org.deptHeads(dept!, 2)).find((id) => id !== me)
  const onNode = tasks.filter((t) => t.nodeId === task.nodeId)
  const holders = new Set<number | undefined>(
    onNode.filter((t) => t.id !== task.id && OPEN.includes(t.state)).map((t) => t.assigneeId),
  )
  if (node.sign === 'any' && [up, ...managerIds].some((id) => holders.has(id))) return undefined
  const taken = new Set(
    onNode
      .filter(
        (t) =>
          OPEN.includes(t.state) || (t.fromTaskId === task.fromTaskId && t.parentTaskId === null),
      )
      .map((t) => t.assigneeId),
  )
  const ok = (id: number) =>
    !taken.has(id) && (node.whenInitiatorIsReviewer === 'self' || id !== inst.initiatorId)
  if (up !== undefined && ok(up)) return { to: up, outcome: 'toManager' }
  // in `manager_user_ids` order: `enabledUsers` sorts by id
  const on = new Set(await org.enabledUsers(managerIds))
  const admin = managerIds.find((id) => on.has(id) && ok(id))
  return admin === undefined ? undefined : { to: admin, outcome: 'toAdmin' }
}
