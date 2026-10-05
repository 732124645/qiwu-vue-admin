import {
  compile,
  type WfFields,
  type WfForkNode,
  type WfInstance,
  type WfNotifyNode,
  type WfReviewNode,
  type WfStep,
  type WfTask,
} from '@qiwu/shared'
import {
  emptyChangeSet,
  start,
  taskApproved,
  type WfEngineCtx,
} from '../../../src/modules/workflow/engine/advance.js'
import { memoryOrg } from './memory-org.js'
import { memoryRun } from './memory-run.js'

// Process-building and run helpers shared by the engine specs.

// depts 1 ← 2 ← 3 (heads 1, 2, 3) and 4 (no head); user 4 (the default initiator) works in dept 3
export const org = memoryOrg(
  [
    { id: 1, dept: 1 },
    { id: 2, dept: 2 },
    { id: 3, dept: 3 },
    { id: 4, dept: 3 },
    { id: 5, dept: 3 },
    { id: 6, enabled: false },
    { id: 7 },
    { id: 8 },
    { id: 9, dept: 4 },
  ],
  [{ id: 1, head: 1 }, { id: 2, parent: 1, head: 2 }, { id: 3, parent: 2, head: 3 }, { id: 4 }],
)
export const fields: WfFields = { amount: 'number' }
export const T0 = new Date('2026-03-01T08:00:00Z')
export const HOUR = 3_600_000

/** a review node, by default user 2, `any`, autoPass, onReject finish */
export const review = (id: string, extra: Partial<WfReviewNode> = {}): WfReviewNode => ({
  id,
  type: 'review',
  name: id.toUpperCase(),
  assignee: { kind: 'users', ids: [2] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
  ...extra,
})
export const users = (...ids: number[]) => ({ assignee: { kind: 'users' as const, ids } })
export const notify = (id: string, ...ids: number[]): WfNotifyNode => ({
  id,
  type: 'notify',
  name: id,
  ...users(...ids),
})
/** parallel fork: a path per child (undefined = an empty path) */
export const parallel = (
  id: string,
  children: (WfStep | undefined)[],
  next?: WfStep,
): WfForkNode => ({
  id,
  type: 'fork',
  name: id,
  mode: 'parallel',
  paths: children.map((child, i) => ({ id: `${id}-${i}`, name: `${i}`, when: [], child })),
  next,
})
/** exclusive / inclusive fork: a path per `[amount above, child]`, then the fallback */
export const byAmount = (
  id: string,
  mode: 'exclusive' | 'inclusive',
  hits: [number, WfStep | undefined][],
  fallback?: WfStep,
  next?: WfStep,
): WfForkNode => ({
  id,
  type: 'fork',
  name: id,
  mode,
  paths: [
    ...hits.map(([above, child], i) => ({
      id: `${id}-${i}`,
      name: `${i}`,
      when: [[{ field: 'amount', op: 'gt' as const, value: above }]],
      child,
    })),
    { id: `${id}-else`, name: 'else', fallback: true, when: [], child: fallback },
  ],
  next,
})
/** links steps through `next` (the last one keeps its own) */
export const chain = (...steps: WfStep[]): WfStep | undefined =>
  steps.reduceRight<WfStep | undefined>((next, s) => ({ ...s, ...(next && { next }) }), undefined)

export const ctxOf = (steps: WfStep[], extra: Partial<WfEngineCtx> = {}): WfEngineCtx => {
  const r = compile({ id: 'begin', type: 'begin', name: 'Begin', next: chain(...steps) }, fields)
  if (!r.ok) throw new Error(JSON.stringify(r.errors))
  return { flow: r.flow, fields, org, managerIds: [7], now: T0, ...extra }
}
export const instance = (extra: Partial<WfInstance> = {}): WfInstance => ({
  id: 1,
  initiatorId: 4,
  state: 'running',
  formValues: {},
  initiatorPicks: {},
  initiatorCtx: { deptTreePath: '/1/2/3/', roleIds: [] },
  activeNodeIds: [],
  ...extra,
})

/**
 * starts an instance; `approve` drives `taskApproved` directly: no approve event, no edits, unlike the approve
 * action (actions.ts), so the advance specs see only the moves' events
 */
export async function run(ctx: WfEngineCtx, extra: Partial<WfInstance> = {}) {
  const r = memoryRun(instance(extra))
  r.apply(await start(ctx, r.instance), ctx.now)
  const approve = async (task: WfTask, now = ctx.now) => {
    const set = emptyChangeSet()
    set.taskPatches.push({
      id: task.id,
      from: 'pending',
      set: { state: 'approved', handledAt: now },
    })
    await taskApproved({ ...ctx, now }, r.instance, r.tasks, task, set)
    r.apply(set, now)
  }
  /** the pending task of `userId` */
  const taskOf = (userId: number) => r.open().find((t) => t.assigneeId === userId)!
  const pending = () => r.open().map((t) => [t.nodeId, t.assigneeId])
  return { ...r, approve, taskOf, pending }
}
