import {
  Err,
  type WfChangeSet,
  type WfInstance,
  type WfReviewNode,
  type WfStep,
  type WfTask,
  type WfTimeoutAction,
} from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import {
  ctxOf,
  HOUR,
  notify,
  parallel,
  review,
  run,
  T0,
  users,
} from '../../../../test/fixtures/wf/flow.js'
import { memoryOrg } from '../../../../test/fixtures/wf/memory-org.js'
import { approve, reject, resubmit } from './actions.js'
import type { WfEngineCtx } from './advance.js'
import { reassign, withdraw } from './lifecycle.js'
import { addSign, delegate, transfer } from './routing.js'
import { onTimeout } from './timeout.js'

// Timeout auto-handling in the engine.

const at = (h: number) => new Date(T0.getTime() + h * HOUR)
const timed = (action?: WfTimeoutAction, hours = 1) => ({ timeout: { hours, action } })
const conflict = { err: Err.CONFLICT }

/**
 * depts 1 (head R 10) ← 2 (head P 11) ← 3 (head H 12: A 20, B 21, manager M 30); 4 under 3 with a disabled
 * head (13: C 22); 5 under 3 and 6 under 5, both headed by D 14; manager N 31 has no dept, X 32 is disabled
 */
const boss = memoryOrg(
  [
    { id: 10, dept: 1 },
    { id: 11, dept: 2 },
    { id: 12, dept: 3 },
    { id: 13, dept: 4, enabled: false },
    { id: 14, dept: 6 },
    { id: 20, dept: 3 },
    { id: 21, dept: 3 },
    { id: 22, dept: 4 },
    { id: 30, dept: 3 },
    { id: 31 },
    { id: 32, enabled: false },
  ],
  [
    { id: 1, head: 10 },
    { id: 2, parent: 1, head: 11 },
    { id: 3, parent: 2, head: 12 },
    { id: 4, parent: 3, head: 13 },
    { id: 5, parent: 3, head: 14 },
    { id: 6, parent: 5, head: 14 },
  ],
)

async function setup(
  steps: WfStep[],
  extra: Partial<WfEngineCtx> = {},
  inst: Partial<WfInstance> = {},
) {
  const ctx = ctxOf(steps, extra)
  const r = await run(ctx, inst)
  const act = async (set: WfChangeSet | Promise<WfChangeSet>, now = T0) => r.apply(await set, now)
  const h = {
    ctx,
    r,
    act,
    /** the remind job's call for `task` at `now`, applied when it handled it */
    time: async (task: WfTask, now: Date) => {
      const out = await onTimeout({ ...ctx, now }, r.instance, r.tasks, task, r.events)
      if (out) r.apply(out.set, now)
      return out
    },
    /** the remind job's outcome for the pending task of `u` */
    timeOf: async (u: number, now: Date) => (await h.time(r.taskOf(u), now))?.outcome,
    /** the same at the task's due time */
    due: (u: number) => h.timeOf(u, r.taskOf(u).dueAt!),
    approve: (u: number, now = T0, comment: string | null = null) =>
      act(approve({ ...ctx, now }, r.instance, r.tasks, r.taskOf(u), { comment }), now),
    withdraw: (task: WfTask, now = T0) =>
      withdraw({ ...ctx, now }, r.instance, r.tasks, task, { comment: null, events: r.events }),
    states: () => r.tasks.map((t) => [t.nodeId, t.assigneeId, t.state]),
  }
  return h
}
type H = Awaited<ReturnType<typeof setup>>

describe('wf timeout engine', () => {
  it('autoPass approves as `any`: the co-reviewer canceled, the token moves on, a system event first', async () => {
    const h = await setup([
      review('r1', { ...users(2, 5), ...timed('autoPass') }),
      notify('n1', 8),
      review('r2'),
    ])
    expect(await h.time(h.r.taskOf(2), at(0.9))).toBeNull()
    const out = await h.time(h.r.taskOf(2), at(1))
    expect(out!.outcome).toBe('autoPass')
    expect(h.states()).toEqual([
      ['r1', 2, 'approved'],
      ['r1', 5, 'canceled'],
      ['r2', 2, 'pending'],
    ])
    expect(h.r.tasks[0]).toMatchObject({ comment: null, handledAt: at(1) })
    expect(out!.set.events).toEqual([
      {
        action: 'timeout',
        taskId: 1,
        nodeId: 'r1',
        actorId: null,
        targetIds: null,
        comment: 'seed.wf.timeout.autoPass',
      },
      { action: 'cc', taskId: null, nodeId: 'n1', actorId: null, targetIds: [8], comment: null },
    ])
    // the co-reviewer's task, canceled: not pending any more
    expect(await h.time(h.r.tasks[1]!, at(2))).toBeNull()
  })

  it('autoPass on `all` settles each task on its own; on `ordered` the next reviewer is timed from then', async () => {
    const all = await setup([
      review('r1', { sign: 'all', ...users(2, 5), ...timed('autoPass') }),
      review('r2', users(3)),
    ])
    expect(await all.timeOf(2, at(1))).toBe('autoPass')
    expect(all.r.pending()).toEqual([['r1', 5]])
    expect(await all.timeOf(5, at(1.5))).toBe('autoPass')
    expect(all.r.pending()).toEqual([['r2', 3]])
    const ord = await setup([
      review('r1', { sign: 'ordered', ...users(2, 5), ...timed('autoPass') }),
    ])
    expect(await ord.timeOf(2, at(1))).toBe('autoPass')
    expect(ord.r.taskOf(5).dueAt).toEqual(at(2))
    expect(await ord.time(ord.r.taskOf(5), at(1.5))).toBeNull()
    expect(await ord.timeOf(5, at(2))).toBe('autoPass')
    expect(ord.r.instance.state).toBe('approved')
  })

  it('autoReject by `onReject`: finish ends the instance; sendBack goes back to the walked node', async () => {
    const fin = await setup([
      review('r1', users(2)),
      review('r2', { sign: 'all', ...users(3, 5), ...timed('autoReject') }),
    ])
    await fin.approve(2)
    const out = await fin.time(fin.r.taskOf(3), at(1))
    expect(out!.outcome).toBe('autoReject')
    expect(fin.r.instance.state).toBe('rejected')
    expect(fin.states().slice(1)).toEqual([
      ['r2', 3, 'rejected'],
      ['r2', 5, 'canceled'],
    ])
    expect(out!.set.events[0]).toMatchObject({ action: 'timeout', actorId: null, targetIds: null })
    expect(out!.set.events.map((e) => e.action)).toEqual(['timeout'])
    const back = await setup([
      review('r1', users(2)),
      review('r2', { ...users(3), ...timed('autoReject'), onReject: 'sendBack' }),
    ])
    await back.approve(2)
    const sent = await back.time(back.r.taskOf(3), at(1))
    expect(sent!.set.events).toEqual([
      {
        action: 'timeout',
        taskId: 2,
        nodeId: 'r2',
        actorId: null,
        targetIds: ['r1'],
        comment: 'seed.wf.timeout.autoReject',
      },
    ])
    expect(back.r.pending()).toEqual([['r1', 2]])
  })

  it('no loop: an auto-reject sends back past auto-passed nodes, to the initiator when all were', async () => {
    const h = await setup([
      review('a', { ...users(2, 5), ...timed('autoPass') }),
      review('b', { ...users(3), ...timed('autoReject'), onReject: 'sendBack' }),
    ])
    expect(await h.timeOf(2, at(1))).toBe('autoPass')
    const out = await h.time(h.r.taskOf(3), at(2))
    expect(out!.set.events[0]!.targetIds).toEqual(['begin'])
    expect(h.r.pending()).toEqual([['begin', 4]])
    expect(h.r.taskOf(4).dueAt).toBeNull()
    // resubmitted, A approved by hand this time: B's auto-reject goes back to A
    await h.act(
      resubmit({ ...h.ctx, now: at(3) }, h.r.instance, h.r.tasks, h.r.taskOf(4), { comment: null }),
      at(3),
    )
    await h.approve(2, at(3))
    expect((await h.time(h.r.taskOf(3), at(4)))!.set.events[0]!.targetIds).toEqual(['a'])
    expect(h.r.pending()).toEqual([
      ['a', 2],
      ['a', 5],
    ])
    /** a → b (user 21) → c (user 22, auto-rejects back): `prep` until b is auto-passed; c's target */
    const abc = async (a: Partial<WfReviewNode>, prep: (h: H) => Promise<unknown>) => {
      const h = await setup(
        [
          review('a', a),
          review('b', { ...users(21), ...timed('autoPass') }),
          review('c', { ...users(22), ...timed('autoReject'), onReject: 'sendBack' }),
        ],
        { org: boss, managerIds: [] },
      )
      await prep(h)
      expect(await h.due(21)).toBe('autoPass')
      return (await h.time(h.r.taskOf(22), h.r.taskOf(22).dueAt!))!.set.events[0]!.targetIds
    }
    // a by hand: back to a past b
    expect(await abc(users(20), (h) => h.approve(20))).toEqual(['a'])
    // a by hand after a remind-only, or with a comment that reads like the system's: not skipped
    const remindA = async (h: H) => [await h.due(31), await h.approve(31, at(1))]
    expect(await abc({ ...users(31), ...timed('toManager') }, remindA)).toEqual(['a'])
    const forged = (h: H) => h.approve(20, T0, 'seed.wf.timeout.autoPass')
    expect(await abc(users(20), forged)).toEqual(['a'])
    // `all`: the newest approval decides (one auto-passed, then one by hand: not skipped)
    const mixed = async (h: H) => [await h.due(20), await h.approve(30, at(1))]
    expect(await abc({ sign: 'all', ...users(20, 30), ...timed('autoPass') }, mixed)).toEqual(['a'])
  })

  it('not handled: not due, not pending, a child task, a task that had a child, a node without an action', async () => {
    const none = await setup([review('r1', timed())])
    expect(await none.time(none.r.taskOf(2), at(5))).toBeNull()
    const h = await setup([review('r1', { ...users(2, 5), ...timed('autoPass') })])
    // no due time (never so on a node with a timeout; the job only picks due ones)
    expect(await h.time({ ...h.r.taskOf(2), dueAt: null }, at(2))).toBeNull()
    // delegated: the parent is not pending, the delegate's child is a child; back with the owner: it had one
    await h.act(delegate(h.ctx, h.r.instance, h.r.tasks, h.r.taskOf(2), { to: 8, comment: null }))
    expect(await h.time(h.r.tasks[0]!, at(2))).toBeNull()
    expect(await h.time(h.r.taskOf(8), at(2))).toBeNull()
    await h.approve(8)
    expect(await h.time(h.r.taskOf(2), at(2))).toBeNull()
    // before-signed, the signer approved: pending again, still only reminded
    await h.act(
      addSign(h.ctx, h.r.instance, h.r.tasks, h.r.taskOf(5), {
        kind: 'before',
        userIds: [9],
        comment: null,
      }),
    )
    expect(await h.time(h.r.taskOf(9), at(2))).toBeNull()
    await h.approve(9)
    expect(await h.time(h.r.taskOf(5), at(2))).toBeNull()
    expect(h.r.events.some((e) => e.action === 'timeout')).toBe(false)
    // decided already
    await h.approve(2, at(2))
    expect(await h.time(h.r.tasks[0]!, at(3))).toBeNull()
  })

  it("toManager: the dept head, a head's parent-dept head, a process manager when there is none", async () => {
    const one = (assignee: number, extra: Partial<WfEngineCtx> = {}) =>
      setup([review('r1', { ...users(assignee), ...timed('toManager') })], {
        org: boss,
        managerIds: [30],
        ...extra,
      })
    const a = await one(20)
    const out = await a.time(a.r.taskOf(20), at(1))
    expect(out!.outcome).toBe('toManager')
    expect(out!.set.events).toEqual([
      {
        action: 'timeout',
        taskId: 1,
        nodeId: 'r1',
        actorId: null,
        targetIds: [12],
        comment: 'seed.wf.timeout.toManager',
      },
    ])
    expect(a.states()).toEqual([
      ['r1', 20, 'transferred'],
      ['r1', 12, 'pending'],
    ])
    expect(a.r.taskOf(12).dueAt).toEqual(at(2))
    const h = await one(12)
    expect([await h.timeOf(12, at(1)), h.r.pending()]).toEqual(['toManager', [['r1', 11]]])
    // a head that is the parent dept's head too: no superior, a process manager
    const d = await one(14)
    expect([await d.timeOf(14, at(1)), d.r.pending()]).toEqual(['toAdmin', [['r1', 30]]])
    // a disabled head (not the parent dept's): the first enabled manager in configured order
    const c = await one(22, { managerIds: [32, 31, 30] })
    expect([await c.timeOf(22, at(1)), c.r.pending()]).toEqual(['toAdmin', [['r1', 31]]])
    // the first manager is the assignee: the next one
    const n = await one(31, { managerIds: [31, 30] })
    expect([await n.timeOf(31, at(1)), n.r.pending()]).toEqual(['toAdmin', [['r1', 30]]])
    // nobody: remind only, one event, nothing else
    const x = await one(31, { managerIds: [31] })
    const only = await x.time(x.r.taskOf(31), at(1))
    expect(only).toEqual({
      outcome: 'remindOnly',
      set: {
        instance: {},
        newTasks: [],
        taskPatches: [],
        ccs: [],
        events: [
          {
            action: 'timeout',
            taskId: 1,
            nodeId: 'r1',
            actorId: null,
            targetIds: null,
            comment: 'seed.wf.timeout.remindOnly',
          },
        ],
      },
    })
  })

  it('toManager on `all`: a superior holding a task on the node (an add-sign child too) is passed over', async () => {
    const steps = (...ids: number[]) => [
      review('r1', { sign: 'all' as const, ...users(...ids), ...timed('toManager') }),
    ]
    const co = await setup(steps(20, 12), { org: boss, managerIds: [30] })
    expect(await co.timeOf(20, at(1))).toBe('toAdmin')
    expect(co.r.pending()).toEqual([
      ['r1', 12],
      ['r1', 30],
    ])
    const sign = await setup(steps(20, 21), { org: boss, managerIds: [30] })
    await sign.act(
      addSign(sign.ctx, sign.r.instance, sign.r.tasks, sign.r.taskOf(21), {
        kind: 'before',
        userIds: [12],
        comment: null,
      }),
    )
    expect(await sign.timeOf(20, at(1))).toBe('toAdmin')
    expect(sign.r.taskOf(30).nodeId).toBe('r1')
    // a delegate who is done (a closed child) holds nothing: still the superior
    const done = await setup(steps(20, 21), { org: boss, managerIds: [30] })
    const t21 = done.r.taskOf(21)
    await done.act(
      delegate(done.ctx, done.r.instance, done.r.tasks, t21, { to: 12, comment: null }),
    )
    await done.approve(12)
    expect(await done.timeOf(20, at(1))).toBe('toManager')
  })

  it('toManager looks at the node only: a superior holding a task on a sibling path is still it', async () => {
    for (const sign of ['any', 'all'] as const) {
      const h = await setup(
        [
          parallel('f', [
            review('p1', { sign, ...users(20, 21), ...timed('toManager') }),
            review('p2', users(12)),
          ]),
        ],
        { org: boss, managerIds: [30] },
      )
      expect(await h.timeOf(20, at(1))).toBe('toManager')
      expect(h.r.pending()).toEqual([
        ['p1', 21],
        ['p2', 12],
        ['p1', 12],
      ])
    }
  })

  it('toManager: who handled an earlier round of the node may be handed it again', async () => {
    const h = await setup(
      [
        review('r1', { ...users(20), ...timed('toManager') }),
        review('r2', { ...users(21), ...timed('autoReject'), onReject: 'sendBack' }),
      ],
      { org: boss, managerIds: [30] },
    )
    expect(await h.due(20)).toBe('toManager')
    await h.approve(12, at(1))
    expect(await h.due(21)).toBe('autoReject')
    expect(await h.due(20)).toBe('toManager')
    expect(h.r.pending()).toEqual([['r1', 12]])
  })

  it('the chain ends: A → H → P → R → manager M, then nobody new (not back to H or P)', async () => {
    const h = await setup([review('r1', { ...users(20), ...timed('toManager') })], {
      org: boss,
      managerIds: [30, 10],
    })
    const outcomes = []
    for (const [u, hour] of [
      [20, 1],
      [12, 2],
      [11, 3],
      [10, 4],
      [30, 5],
    ] as const)
      outcomes.push(await h.timeOf(u, at(hour)))
    expect(outcomes).toEqual(['toManager', 'toManager', 'toManager', 'toAdmin', 'remindOnly'])
    expect(h.r.pending()).toEqual([['r1', 30]])
    expect(h.r.events.filter((e) => e.action === 'timeout')).toHaveLength(5)
  })

  it('the initiator: not handed the task unless the node lets them review (`self`)', async () => {
    const as = (when: WfReviewNode['whenInitiatorIsReviewer']) =>
      setup(
        [review('r1', { ...users(20), ...timed('toManager'), whenInitiatorIsReviewer: when })],
        { org: boss, managerIds: [12, 30] },
        { initiatorId: 12 },
      )
    for (const when of ['skip', 'deptHead'] as const) {
      const skip = await as(when)
      expect([await skip.timeOf(20, at(1)), skip.r.pending()]).toEqual(['toAdmin', [['r1', 30]]])
    }
    const self = await as('self')
    expect([await self.timeOf(20, at(1)), self.r.pending()]).toEqual(['toManager', [['r1', 12]]])
  })

  it('`any`: a superior or a process manager holding a task there already: remind only', async () => {
    const h = await setup([review('r1', { ...users(20, 21), ...timed('toManager') })], {
      org: boss,
      managerIds: [30],
    })
    expect(await h.timeOf(20, at(1))).toBe('toManager')
    const out = await h.time(h.r.taskOf(21), at(1))
    expect(out!.outcome).toBe('remindOnly')
    expect(out!.set.events).toHaveLength(1)
    expect(h.r.pending()).toEqual([
      ['r1', 21],
      ['r1', 12],
    ])
    const m = await setup([review('r1', { ...users(22, 30), ...timed('toManager') })], {
      org: boss,
      managerIds: [30, 31],
    })
    expect(await m.timeOf(22, at(1))).toBe('remindOnly')
  })

  it('a node with an action times transfers and reassigns of pending tasks anew; without one they keep it', async () => {
    for (const action of ['autoPass', undefined] as const) {
      const h = await setup([
        review('r1', { sign: 'ordered', ...users(2, 5), ...timed(action, 8) }),
      ])
      const ctx = { ...h.ctx, now: at(2) }
      await h.act(transfer(ctx, h.r.instance, h.r.tasks, h.r.taskOf(2), { to: 8, comment: null }))
      const waiting = h.r.open('waiting')[0]!
      await h.act(
        reassign(ctx, h.r.instance, h.r.tasks, waiting, { actorId: 1, to: 9, comment: null }),
      )
      await h.act(
        reassign({ ...ctx, now: at(3) }, h.r.instance, h.r.tasks, h.r.taskOf(8), {
          actorId: 1,
          to: 3,
          comment: null,
        }),
      )
      expect(h.r.tasks.map((t) => [t.assigneeId, t.state, t.dueAt])).toEqual([
        [2, 'transferred', at(8)],
        [9, 'waiting', null],
        [3, 'pending', action ? at(11) : at(8)],
      ])
      // a delegated task is not pending: reassigned, it keeps its due time
      const d = await setup([review('r1', { ...users(2), ...timed(action, 8) })])
      await d.act(delegate(d.ctx, d.r.instance, d.r.tasks, d.r.taskOf(2), { to: 8, comment: null }))
      await d.act(
        reassign({ ...d.ctx, now: at(2) }, d.r.instance, d.r.tasks, d.r.tasks[0]!, {
          actorId: 1,
          to: 9,
          comment: null,
        }),
      )
      expect(d.r.tasks.map((t) => [t.assigneeId, t.state, t.dueAt])).toEqual([
        [9, 'delegated', at(8)],
        [8, 'pending', at(8)],
      ])
    }
  })

  it('a withdraw after the due time times the task and its `any` co-reviewers anew (with an action)', async () => {
    for (const action of ['autoPass', undefined] as const) {
      const h = await setup([
        review('r1', { ...users(2, 5), ...timed(action) }),
        review('r2', users(3)),
      ])
      await h.approve(2, at(0.5))
      await h.act(h.withdraw(h.r.tasks[0]!, at(2)), at(2))
      expect(h.r.tasks.map((t) => [t.assigneeId, t.state, t.dueAt])).toEqual([
        [2, 'pending', action ? at(3) : at(1)],
        [5, 'pending', action ? at(3) : at(1)],
        [3, 'withdrawn', null],
      ])
    }
  })

  it('an auto-passed approval is never withdrawn; one by hand is, a remind-only before it too', async () => {
    const h = await setup([
      review('r1', { sign: 'all', ...users(2, 5), ...timed('autoPass') }),
      review('r2', users(3)),
    ])
    expect(await h.timeOf(2, at(1))).toBe('autoPass')
    expect(() => h.withdraw(h.r.tasks[0]!, at(1))).toThrow(expect.objectContaining(conflict))
    await h.approve(5, at(1))
    expect(h.withdraw(h.r.tasks[1]!, at(1)).events[0]).toMatchObject({ action: 'withdraw' })
    const steps = [review('r1', { ...users(31), ...timed('toManager') }), review('r2', users(20))]
    const r = await setup(steps, { org: boss, managerIds: [] })
    expect(await r.timeOf(31, at(1))).toBe('remindOnly')
    await r.approve(31, at(2))
    await r.act(r.withdraw(r.r.tasks[0]!, at(2)), at(2))
    expect(r.r.pending()).toEqual([['r1', 31]])
    // a reviewer's own comment that reads like the system's is no auto-pass
    const f = await setup(steps, { org: boss, managerIds: [] })
    await f.approve(31, T0, 'seed.wf.timeout.autoPass')
    await f.act(f.withdraw(f.r.tasks[0]!))
    expect(f.r.pending()).toEqual([['r1', 31]])
  })

  it('reject `to`: a send-back target of the task, else 422; none = the first one', async () => {
    const h = await setup([
      review('r1', users(2)),
      review('r2', users(3)),
      review('r3', { ...users(5), onReject: 'sendBack' }),
    ])
    await h.approve(2)
    await h.approve(3)
    const t = h.r.taskOf(5)
    const rej = (to?: string) => reject(h.ctx, h.r.instance, h.r.tasks, t, { comment: null, to })
    for (const to of ['r3', 'nope'])
      await expect(rej(to)).rejects.toMatchObject({ err: Err.UNPROCESSABLE })
    expect((await rej()).events[0]!.targetIds).toEqual(['r2'])
    await h.act(rej('r1'))
    expect(h.r.pending()).toEqual([['r1', 2]])
  })
})
