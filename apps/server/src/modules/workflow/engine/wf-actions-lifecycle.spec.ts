import {
  Err,
  type WfChangeSet,
  type WfNewEvent,
  type WfSignKind,
  type WfStep,
  type WfTask,
} from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import {
  chain,
  ctxOf,
  HOUR,
  parallel,
  review,
  run,
  T0,
  users,
} from '../../../../test/fixtures/wf/flow.js'
import { memoryOrg } from '../../../../test/fixtures/wf/memory-org.js'
import { approve, reject, sendBack } from './actions.js'
import { cancel, cc, comment, reassign, terminate, withdraw } from './lifecycle.js'
import { addSign, delegate, removeSign, transfer } from './routing.js'

const conflict = { err: Err.CONFLICT }
const bad = { err: Err.UNPROCESSABLE }
const badTarget = { err: Err.WF_BAD_TARGET }
type Setup = Awaited<ReturnType<typeof setup>>
type WfEvents = Pick<WfNewEvent, 'action' | 'taskId' | 'targetIds'>[]

async function setup(steps: WfStep[]) {
  const ctx = ctxOf(steps)
  const r = await run(ctx)
  const act = async (set: WfChangeSet | Promise<WfChangeSet>) => r.apply(await set, T0)
  /** the latest task of a user */
  const last = (u: number) => r.tasks.findLast((t) => t.assigneeId === u)!
  const h = {
    ctx,
    r,
    act,
    last,
    approve: (u: number) => act(approve(ctx, r.instance, r.tasks, r.taskOf(u), { comment: null })),
    sendBack: (u: number, to: string) =>
      act(sendBack(ctx, r.instance, r.tasks, r.taskOf(u), { to, comment: null })),
    /** withdraw of the latest task of `u` */
    withdraw: (u: number) =>
      withdraw(ctx, r.instance, r.tasks, last(u), { comment: 'oops', events: r.events }),
    states: () => r.tasks.map((t) => [t.nodeId, t.assigneeId, t.state]),
    active: () => [...r.instance.activeNodeIds].sort(),
  }
  return h
}

describe('wf actions lifecycle', () => {
  it('抄送: a cc row per user from the pending task, repeats dropped; bad users 422, a decided task 409', async () => {
    const { ctx, r, act, approve: ok } = await setup([review('r1'), review('r2', users(3))])
    const t = r.taskOf(2)
    await act(cc(ctx, r.instance, r.tasks, t, { userIds: [8, 7, 8], reason: 'fyi' }))
    expect(r.ccs).toEqual([
      { nodeId: 'r1', userId: 8, fromTaskId: t.id, fromUserId: 2, reason: 'fyi' },
      { nodeId: 'r1', userId: 7, fromTaskId: t.id, fromUserId: 2, reason: 'fyi' },
    ])
    expect(r.events.at(-1)).toEqual({
      action: 'cc',
      taskId: t.id,
      nodeId: 'r1',
      actorId: 2,
      targetIds: [8, 7],
      comment: 'fyi',
    })
    for (const userIds of [[], [6], [99], [8, 6]])
      await expect(
        cc(ctx, r.instance, r.tasks, t, { userIds, reason: null }),
      ).rejects.toMatchObject(bad)
    await ok(2)
    await expect(
      cc(ctx, r.instance, r.tasks, t, { userIds: [8], reason: null }),
    ).rejects.toMatchObject(conflict)
  })

  it('撤销实例: every open task (waiting ones and other fork paths too) is canceled, the instance canceled', async () => {
    const { ctx, r, act } = await setup([
      parallel('p', [review('a', { sign: 'ordered', ...users(2, 5) }), review('b', users(3))]),
    ])
    await act(cancel(ctx, r.instance, r.tasks, { comment: 'not needed' }))
    expect(r.tasks.map((t) => t.state)).toEqual(['canceled', 'canceled', 'canceled'])
    expect(r.instance).toMatchObject({ state: 'canceled', activeNodeIds: [] })
    expect(r.endedAt()).toEqual(T0)
    expect(r.events.at(-1)).toEqual({
      action: 'cancel',
      taskId: null,
      nodeId: null,
      actorId: 4,
      targetIds: null,
      comment: 'not needed',
    })
    for (const call of [
      () => cancel(ctx, r.instance, r.tasks, { comment: null }),
      () => terminate(ctx, r.instance, r.tasks, { actorId: 1, comment: null }),
    ])
      expect(call).toThrow(expect.objectContaining(conflict))
  })

  it('a send-back, a terminate and a finish-reject cancel waiting and delegated tasks and delegate children', async () => {
    const to7 = { to: 7, comment: null }
    const fork = parallel('p', [
      review('a', { sign: 'ordered', ...users(3, 5) }),
      review('b', users(2)),
    ])
    const h = await setup([review('r1', users(8)), fork])
    await h.approve(8)
    await h.act(delegate(h.ctx, h.r.instance, h.r.tasks, h.r.taskOf(2), to7))
    await h.sendBack(3, 'r1')
    expect(h.states()).toEqual([
      ['r1', 8, 'approved'],
      ['a', 3, 'sent_back'],
      ['a', 5, 'canceled'],
      ['b', 2, 'canceled'],
      ['b', 7, 'canceled'],
      ['r1', 8, 'pending'],
    ])
    for (const end of [
      (x: Setup) => terminate(x.ctx, x.r.instance, x.r.tasks, { actorId: 1, comment: null }),
      (x: Setup) => reject(x.ctx, x.r.instance, x.r.tasks, x.r.taskOf(3), { comment: null }),
    ]) {
      const x = await setup([fork])
      await x.act(delegate(x.ctx, x.r.instance, x.r.tasks, x.r.taskOf(2), to7))
      await x.act(end(x))
      expect(x.states().slice(2)).toEqual([
        ['b', 2, 'canceled'],
        ['b', 7, 'canceled'],
      ])
    }
  })

  it('终止: an admin ends the instance as terminated', async () => {
    const { ctx, r, act } = await setup([review('r1', users(2, 5))])
    await act(terminate(ctx, r.instance, r.tasks, { actorId: 1, comment: 'left' }))
    expect(r.tasks.map((t) => t.state)).toEqual(['canceled', 'canceled'])
    expect(r.instance).toMatchObject({ state: 'terminated', activeNodeIds: [] })
    expect(r.events.at(-1)).toMatchObject({ action: 'terminate', actorId: 1, comment: 'left' })
  })

  it('改派: the open task goes to another enabled user; bad targets as transfer, the begin task 422, a closed task 409', async () => {
    const { ctx, r, act } = await setup([
      review('r1', { sign: 'ordered', timeout: { hours: 8 }, ...users(2, 5) }),
    ])
    const [first, second] = r.tasks
    await act(
      reassign(ctx, r.instance, r.tasks, second!, { actorId: 1, to: 8, comment: 'hand over' }),
    )
    expect(r.tasks[1]).toMatchObject({ assigneeId: 8, state: 'waiting', seq: 1, dueAt: null })
    expect(r.events.at(-1)).toEqual({
      action: 'reassign',
      taskId: second!.id,
      nodeId: 'r1',
      actorId: 1,
      targetIds: [8],
      comment: 'hand over',
    })
    // holding a task on the node (waiting or its own), disabled, unknown
    for (const to of [8, 2, 6, 99])
      await expect(
        reassign(ctx, r.instance, r.tasks, first!, { actorId: 1, to, comment: null }),
      ).rejects.toMatchObject(badTarget)
    await act(reassign(ctx, r.instance, r.tasks, first!, { actorId: 1, to: 3, comment: null }))
    expect(r.tasks[0]).toMatchObject({ assigneeId: 3, dueAt: new Date(T0.getTime() + 8 * HOUR) })
    await act(approve(ctx, r.instance, r.tasks, r.tasks[0]!, { comment: null }))
    await expect(
      reassign(ctx, r.instance, r.tasks, r.tasks[0]!, { actorId: 1, to: 7, comment: null }),
    ).rejects.toMatchObject(conflict)
    // the initiator's begin task: resubmitting it is theirs alone
    await act(sendBack(ctx, r.instance, r.tasks, r.taskOf(8), { to: 'begin', comment: null }))
    await expect(
      reassign(ctx, r.instance, r.tasks, r.taskOf(4), { actorId: 1, to: 8, comment: null }),
    ).rejects.toMatchObject(bad)
    // a delegated task: the delegate's task answers to the new assignee, who then decides
    const d = await setup([review('r1'), review('r2', users(5))])
    await d.act(delegate(d.ctx, d.r.instance, d.r.tasks, d.r.taskOf(2), { to: 8, comment: null }))
    await d.act(
      reassign(d.ctx, d.r.instance, d.r.tasks, d.r.tasks[0]!, { actorId: 1, to: 3, comment: null }),
    )
    expect(d.r.taskOf(8)).toMatchObject({ ownerId: 3, parentTaskId: d.r.tasks[0]!.id })
    await d.approve(8)
    expect(d.r.pending()).toEqual([['r1', 3]])
  })

  it('评论: only an event on the pending task', async () => {
    const { ctx, r, act, approve: ok } = await setup([review('r1'), review('r2', users(3))])
    const t = r.taskOf(2)
    await act(comment(ctx, r.instance, r.tasks, t, { comment: 'looks fine' }))
    expect(r.events.at(-1)).toEqual({
      action: 'comment',
      taskId: t.id,
      nodeId: 'r1',
      actorId: 2,
      targetIds: null,
      comment: 'looks fine',
    })
    expect(r.tasks).toHaveLength(1)
    await ok(2)
    expect(() => comment(ctx, r.instance, r.tasks, t, { comment: 'x' })).toThrow(
      expect.objectContaining(conflict),
    )
  })

  it('审批人撤回（下一节点未处理可撤；已处理不可撤）', async () => {
    const h = await setup([review('r1'), review('r2', users(3, 5)), review('r3', users(8))])
    await h.approve(2)
    await h.act(h.withdraw(2))
    expect(h.states()).toEqual([
      ['r1', 2, 'pending'],
      ['r2', 3, 'withdrawn'],
      ['r2', 5, 'withdrawn'],
    ])
    expect(h.r.tasks[0]).toMatchObject({ comment: null, handledAt: null })
    expect(h.active()).toEqual(['r1'])
    expect(h.r.events.at(-1)).toMatchObject({
      action: 'withdraw',
      taskId: 1,
      actorId: 2,
      comment: 'oops',
    })
    // approved again: the old withdrawn tasks do not block
    await h.approve(2)
    expect(h.withdraw(2).taskPatches).toHaveLength(3)
    expect(h.r.pending()).toEqual([
      ['r2', 3],
      ['r2', 5],
    ])
    await h.approve(3)
    expect(() => h.withdraw(2)).toThrow(expect.objectContaining(conflict))
    // r3's task untouched: r2's approval can be withdrawn, the `any` co-reviewer it canceled is back; not twice
    await h.act(h.withdraw(3))
    expect(h.r.pending()).toEqual([
      ['r2', 3],
      ['r2', 5],
    ])
    expect(h.active()).toEqual(['r2'])
    expect(() => h.withdraw(3)).toThrow(expect.objectContaining(conflict))
    await h.approve(5)
    expect(h.states().slice(-4)).toEqual([
      ['r2', 3, 'canceled'],
      ['r2', 5, 'approved'],
      ['r3', 8, 'withdrawn'],
      ['r3', 8, 'pending'],
    ])
  })

  it('withdraw: a next task with a comment, delegation, add-sign, transfer or a child counts as handled', async () => {
    const steps = [review('r1'), review('r2', users(3))]
    const h = await setup(steps)
    await h.approve(2)
    const next = h.r.taskOf(3)
    const { ctx, r } = h
    const w = (events: WfEvents) =>
      withdraw(ctx, r.instance, r.tasks, r.tasks[0]!, { comment: null, events })
    for (const action of ['comment', 'delegate', 'add_sign', 'transfer'] as const)
      expect(() => w([{ action, taskId: next.id, targetIds: null }])).toThrow(
        expect.objectContaining(conflict),
      )
    // an admin's reassign and a comment on another task do not count
    const events: WfEvents = [
      { action: 'reassign', taskId: next.id, targetIds: [8] },
      { action: 'comment', taskId: 1, targetIds: null },
    ]
    expect(w(events).taskPatches).toHaveLength(2)
    // the rows alone (no events): delegated, back with its owner, before-signed (a child), transferred
    const routed = async (route: (x: Setup, t: WfTask) => Promise<WfChangeSet>) => {
      const x = await setup(steps)
      await x.approve(2)
      await x.act(route(x, x.r.taskOf(3)))
      return x
    }
    const blocked = (x: Setup) =>
      expect(() =>
        withdraw(x.ctx, x.r.instance, x.r.tasks, x.r.tasks[0]!, { comment: null, events: [] }),
      ).toThrow(expect.objectContaining(conflict))
    const to8 = { to: 8, comment: null }
    const d = await routed((x, t) => delegate(x.ctx, x.r.instance, x.r.tasks, t, to8))
    blocked(d)
    await d.approve(8)
    expect(d.r.pending()).toEqual([['r2', 3]])
    blocked(d)
    const before = { kind: 'before' as const, userIds: [8], comment: null }
    blocked(await routed((x, t) => addSign(x.ctx, x.r.instance, x.r.tasks, t, before)))
    blocked(await routed((x, t) => transfer(x.ctx, x.r.instance, x.r.tasks, t, to8)))
  })

  it('withdraw after a remove-sign: after-signers it canceled are not handled, the approval can be withdrawn', async () => {
    const h = await setup([review('r1'), review('r2', users(3))])
    const { ctx, r } = h
    const after = { kind: 'after' as const, userIds: [8], comment: null }
    await h.act(addSign(ctx, r.instance, r.tasks, r.taskOf(2), after))
    await h.act(removeSign(ctx, r.instance, r.tasks, r.tasks[0]!, { taskIds: [2], comment: null }))
    expect(h.r.pending()).toEqual([['r2', 3]])
    await h.act(h.withdraw(2))
    expect(h.states()).toEqual([
      ['r1', 2, 'pending'],
      ['r1', 8, 'canceled'],
      ['r2', 3, 'withdrawn'],
    ])
    expect(h.active()).toEqual(['r1'])
    await h.approve(2)
    await h.act(h.withdraw(2))
    expect(h.r.pending()).toEqual([['r1', 2]])
    // the same user's after-signer of a later round is not the removed one
    await h.act(addSign(ctx, r.instance, r.tasks, r.taskOf(2), after))
    await h.act(h.withdraw(2))
    expect(h.r.tasks.at(-1)).toMatchObject({ assigneeId: 8, state: 'withdrawn' })
    expect(h.r.pending()).toEqual([['r1', 2]])
  })

  it('withdraw after a remove-sign: it only matches the signer it removed (its parent, its user, its round)', async () => {
    const sign = (x: Setup, u: number, kind: WfSignKind, userIds: number[]) =>
      x.act(
        addSign(x.ctx, x.r.instance, x.r.tasks, x.r.taskOf(u), { kind, userIds, comment: null }),
      )
    /** removes the pending signers of the latest task of `u` */
    const unsign = (x: Setup, u: number) => {
      const { ctx, r } = x
      const taskIds = r.open().filter((t) => t.parentTaskId === x.last(u).id)
      const input = { taskIds: taskIds.map((t) => t.id), comment: null }
      return x.act(removeSign(ctx, r.instance, r.tasks, x.last(u), input))
    }
    const blocked = (x: Setup) =>
      expect(() => x.withdraw(2)).toThrow(expect.objectContaining(conflict))
    // the `any` co-reviewer's approval cancels 2's after-signer 8 (the path waits at the join), after a
    // remove-sign of 8 by: 2 earlier (before-signer); 2 in an earlier round; 5 (another parent); r0's task
    const fork = parallel('p', [review('n', users(2, 5)), review('b', users(3))])
    const earlier = await setup([fork])
    await sign(earlier, 2, 'before', [8])
    await unsign(earlier, 2)
    await sign(earlier, 2, 'after', [8])
    await earlier.approve(5)
    expect(earlier.active()).toEqual(['b'])
    blocked(earlier)
    const round = await setup([fork])
    await sign(round, 2, 'after', [8])
    await unsign(round, 2)
    await round.act(round.withdraw(2))
    await sign(round, 2, 'after', [8])
    await round.approve(5)
    blocked(round)
    const other = await setup([fork])
    await sign(other, 5, 'before', [8])
    await unsign(other, 5)
    await sign(other, 2, 'after', [8])
    await other.approve(5)
    blocked(other)
    const node = await setup([review('r0', users(7)), fork])
    await sign(node, 7, 'after', [8])
    await unsign(node, 7)
    await sign(node, 2, 'after', [8])
    await node.approve(5)
    blocked(node)
    // an `all` node: 5 removed its before-signer 8, 8 approved 2's before-sign, 2 removed both after-signers
    const all = await setup([review('r1', { sign: 'all', ...users(2, 5) }), review('r2', users(3))])
    await sign(all, 5, 'before', [8])
    await unsign(all, 5)
    await sign(all, 2, 'before', [8])
    await all.approve(8)
    await sign(all, 2, 'after', [8, 7])
    await unsign(all, 2)
    await all.act(all.withdraw(2))
    expect(all.r.pending()).toEqual([
      ['r1', 2],
      ['r1', 5],
    ])
  })

  it('withdraw: after-signers canceled otherwise (an `any` co-reviewer, a send-back, a finish) still count', async () => {
    const signed = async (steps: WfStep[], pre: number[], userIds = [8]) => {
      const x = await setup(steps)
      for (const u of pre) await x.approve(u)
      const after = { kind: 'after' as const, userIds, comment: null }
      await x.act(addSign(x.ctx, x.r.instance, x.r.tasks, x.r.taskOf(2), after))
      return x
    }
    // one signer removed, the other canceled by the co-reviewer's approval, which ends the path (it waits at
    // the join): only that signer tells
    const co = await signed(
      [parallel('p', [review('n', users(2, 5)), review('b', users(3))])],
      [],
      [8, 7],
    )
    const removed = { taskIds: [4], comment: null }
    await co.act(removeSign(co.ctx, co.r.instance, co.r.tasks, co.r.tasks[0]!, removed))
    await co.approve(5)
    expect(co.active()).toEqual(['b'])
    expect(() => co.withdraw(2)).toThrow(expect.objectContaining(conflict))
    const fork = [review('r0', users(7)), parallel('p', [review('n'), review('b', users(3))])]
    const back = await signed(fork, [7])
    await back.sendBack(3, 'r0')
    expect(() => back.withdraw(2)).toThrow(expect.objectContaining(conflict))
    const fin = await signed(fork, [7])
    const { ctx, r } = fin
    await fin.act(reject(ctx, r.instance, r.tasks, r.taskOf(3), { comment: null }))
    expect(() => fin.withdraw(2)).toThrow(expect.objectContaining(conflict))
  })

  it('withdraw guards: pending task 409, ended instance 409, a child or begin task 422', async () => {
    const h = await setup([review('r1'), review('r2', users(3))])
    const { ctx, r } = h
    const w =
      (task = r.tasks[0]!) =>
      () =>
        withdraw(ctx, r.instance, r.tasks, task, { comment: null, events: [] })
    expect(w()).toThrow(expect.objectContaining(conflict))
    await h.approve(2)
    expect(w({ ...r.tasks[0]!, parentTaskId: 5 })).toThrow(expect.objectContaining(bad))
    await h.sendBack(3, 'begin')
    // a send-back is no approval, though the begin task it created is untouched
    expect(w(r.tasks[1])).toThrow(expect.objectContaining(conflict))
    expect(w({ ...r.taskOf(4), state: 'approved' })).toThrow(expect.objectContaining(bad))
    await h.act(cancel(ctx, r.instance, r.tasks, { comment: null }))
    expect(w()).toThrow(expect.objectContaining(conflict))
    // the approval that ended the instance
    const one = await setup([review('r1')])
    await one.approve(2)
    expect(one.r.instance).toMatchObject({ state: 'approved', activeNodeIds: [] })
    expect(() => one.withdraw(2)).toThrow(expect.objectContaining(conflict))
  })

  it('ordered: withdrawing puts the next reviewer back to waiting; not once they approved', async () => {
    const h = await setup([
      review('r1', { sign: 'ordered', timeout: { hours: 2 }, ...users(2, 5, 3) }),
    ])
    await h.approve(2)
    expect(h.r.tasks[1]).toMatchObject({
      state: 'pending',
      dueAt: new Date(T0.getTime() + 2 * HOUR),
    })
    await h.act(h.withdraw(2))
    expect(h.states()).toEqual([
      ['r1', 2, 'pending'],
      ['r1', 5, 'waiting'],
      ['r1', 3, 'waiting'],
    ])
    expect(h.r.tasks[1]!.dueAt).toBeNull()
    expect(h.active()).toEqual(['r1'])
    await h.approve(2)
    await h.approve(5)
    expect(() => h.withdraw(2)).toThrow(expect.objectContaining(conflict))
  })

  it('ordered: a withdrawn earlier round of the node does not block a withdraw', async () => {
    const h = await setup([
      review('r0', users(8)),
      review('r1', { sign: 'ordered', ...users(2, 5) }),
    ])
    await h.approve(8)
    await h.act(h.withdraw(8))
    await h.approve(8)
    await h.approve(2)
    await h.act(h.withdraw(2))
    expect(h.states()).toEqual([
      ['r0', 8, 'approved'],
      ['r1', 2, 'withdrawn'],
      ['r1', 5, 'withdrawn'],
      ['r1', 2, 'pending'],
      ['r1', 5, 'waiting'],
    ])
  })

  it('all: withdrawing while the others decide; not once another approval moved the node on', async () => {
    const h = await setup([review('r1', { sign: 'all', ...users(2, 5) }), review('r2', users(3))])
    await h.approve(2)
    await h.act(h.withdraw(2))
    expect(h.r.pending()).toEqual([
      ['r1', 2],
      ['r1', 5],
    ])
    await h.approve(2)
    await h.approve(5)
    expect(h.r.pending()).toEqual([['r2', 3]])
    expect(() => h.withdraw(2)).toThrow(expect.objectContaining(conflict))
    await h.act(h.withdraw(5))
    expect(h.r.pending()).toEqual([['r1', 5]])
  })

  it('all: withdrawing while another reviewer after-signed and the signer has not decided', async () => {
    const h = await setup([review('r1', { sign: 'all', ...users(2, 5) }), review('r2', users(3))])
    const { ctx, r } = h
    const after = { kind: 'after' as const, userIds: [8], comment: null }
    await h.act(addSign(ctx, r.instance, r.tasks, r.taskOf(5), after))
    await h.approve(2)
    await h.act(h.withdraw(2))
    expect(h.r.pending()).toEqual([
      ['r1', 2],
      ['r1', 8],
    ])
    expect(h.active()).toEqual(['r1'])
  })

  it('并行下撤回只看本任务生成的任务', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        chain(review('a1', users(2)), review('a2', users(3))),
        chain(review('b1', users(5)), review('b2', users(7))),
      ]),
    ])
    for (const u of [8, 2, 5, 7]) await h.approve(u)
    // b2 is handled (the b path is done) and a2 is not: a1's approval can be withdrawn
    await h.act(h.withdraw(2))
    expect(h.states().slice(1)).toEqual([
      ['a1', 2, 'pending'],
      ['b1', 5, 'approved'],
      ['a2', 3, 'withdrawn'],
      ['b2', 7, 'approved'],
    ])
    expect(h.active()).toEqual(['a1'])
    // r1's approval created a1 and b1, and b1 is handled
    expect(() => h.withdraw(8)).toThrow(expect.objectContaining(conflict))
    await h.approve(2)
    await h.approve(3)
    expect(h.r.instance.state).toBe('approved')
  })

  it('parallel: a path end waiting at the join can be withdrawn, not after a send-back reset the fork', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        chain(review('a0', users(1)), review('a1', users(2))),
        review('b1', users(5)),
      ]),
      review('z', users(3)),
    ])
    for (const u of [8, 1, 2]) await h.approve(u)
    expect(h.active()).toEqual(['b1'])
    await h.act(h.withdraw(2))
    expect(h.active()).toEqual(['a1', 'b1'])
    await h.approve(2)
    // b1 sends back before the fork: a1's approval no longer waits at a join
    await h.sendBack(5, 'r1')
    expect(() => h.withdraw(2)).toThrow(expect.objectContaining(conflict))
    // the fork runs again: the a path holds a token of its own
    await h.approve(8)
    expect(h.active()).toEqual(['a0', 'b1'])
    expect(() => h.withdraw(2)).toThrow(expect.objectContaining(conflict))
    await h.approve(1)
    // a1 holds a new round: the old approval is not it
    expect(() =>
      withdraw(h.ctx, h.r.instance, h.r.tasks, h.r.tasks[3]!, { comment: null, events: [] }),
    ).toThrow(expect.objectContaining(conflict))
  })

  it('parallel: a path end withdrawn after its join fired 409, once the join is withdrawn it waits again', async () => {
    const h = await setup([
      parallel('p', [review('a1', users(2)), review('b1', users(3))]),
      review('z', users(5)),
    ])
    await h.approve(3)
    await h.approve(2)
    expect(h.active()).toEqual(['z'])
    expect(() => h.withdraw(3)).toThrow(expect.objectContaining(conflict))
    // a1's approval fired the join: withdrawn, b1 waits at the join again
    await h.act(h.withdraw(2))
    await h.act(h.withdraw(3))
    expect(h.active()).toEqual(['a1', 'b1'])
    await h.approve(3)
    await h.approve(2)
    // z acted on the joined result: sending back into a1's path does not make b1's approval a wait again
    await h.sendBack(5, 'a1')
    expect(h.active()).toEqual(['a1'])
    expect(() => h.withdraw(3)).toThrow(expect.objectContaining(conflict))
  })

  it('parallel: a sibling path of an outer fork moving on does not block a withdraw at an inner join', async () => {
    const h = await setup([
      parallel('p', [
        parallel('q', [review('a', users(2)), review('b', users(3))]),
        chain(review('d1', users(5)), review('d2', users(7))),
      ]),
    ])
    await h.approve(2)
    await h.approve(5)
    await h.act(h.withdraw(2))
    expect(h.active()).toEqual(['a', 'b', 'd2'])
  })

  it('parallel: an approval that fired an inner join ending its outer path waits at the outer join, withdrawable', async () => {
    const h = await setup([
      parallel('o', [
        parallel('p', [review('a', users(2)), review('b', users(3))]),
        review('d', users(5)),
      ]),
    ])
    await h.approve(2)
    await h.approve(3)
    expect(h.active()).toEqual(['d'])
    await h.act(h.withdraw(3))
    expect(h.active()).toEqual(['b', 'd'])
  })

  it('parallel: an old approval stays when a send-back target passed by itself and the fork runs again', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [review('a1', users(2)), review('b1', users(5))]),
    ])
    await h.approve(8)
    await h.approve(2)
    // user 8 left: r1 passes by itself and creates no task
    const left = { ...h.ctx, org: memoryOrg([{ id: 2 }, { id: 5 }]) }
    const { r } = h
    await h.act(sendBack(left, r.instance, r.tasks, r.taskOf(5), { to: 'r1', comment: null }))
    expect(h.active()).toEqual(['a1', 'b1'])
    expect(() =>
      withdraw(h.ctx, r.instance, r.tasks, r.tasks[1]!, { comment: null, events: [] }),
    ).toThrow(expect.objectContaining(conflict))
  })

  it('parallel: an old path end stays approved when a self-passing target re-ran a nested fork on its path', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        chain(
          parallel('q', [review('q1', users(2)), review('q2', users(1))]),
          review('t', users(7)),
        ),
        review('b', users(5)),
      ]),
    ])
    for (const u of [8, 2, 1, 7]) await h.approve(u)
    expect(h.active()).toEqual(['b'])
    // user 8 left: r1 passes by itself, the fork runs again, the t path holds tokens inside q
    const left = { ...h.ctx, org: memoryOrg([{ id: 1 }, { id: 2 }, { id: 5 }, { id: 7 }]) }
    const { r } = h
    await h.act(sendBack(left, r.instance, r.tasks, r.taskOf(5), { to: 'r1', comment: null }))
    expect(h.active()).toEqual(['b', 'q1', 'q2'])
    expect(() => h.withdraw(7)).toThrow(expect.objectContaining(conflict))
  })

  it('withdraw on an ordered node: before- and after-signs, a before-signed approval, a transferred copy', async () => {
    const steps = [review('r1', { sign: 'ordered', ...users(2, 5) }), review('r2', users(3))]
    const patches = (x: Setup, task: WfTask) =>
      withdraw(x.ctx, x.r.instance, x.r.tasks, task, { comment: null, events: [] }).taskPatches.map(
        (p) => [p.id, p.from, p.set.state],
      )
    const sign = (x: Setup, u: number, kind: WfSignKind, userIds: number[]) =>
      x.act(
        addSign(x.ctx, x.r.instance, x.r.tasks, x.r.taskOf(u), { kind, userIds, comment: null }),
      )
    // the next reviewer before-signed: waiting again, with a child
    const nb = await setup(steps)
    await nb.approve(2)
    await sign(nb, 5, 'before', [8])
    expect(() => patches(nb, nb.r.tasks[0]!)).toThrow(expect.objectContaining(conflict))
    // an after-sign approval: its signer is withdrawn, the next reviewer still waits and is left as it is
    const af = await setup(steps)
    await sign(af, 2, 'after', [8])
    expect(patches(af, af.r.tasks[0]!)).toEqual([
      [3, 'pending', 'withdrawn'],
      [1, 'approved', 'pending'],
    ])
    // approved after a before-sign: the signers (seq 0 and 1 of their own) are no reviewers of the node
    const bf = await setup(steps)
    await sign(bf, 2, 'before', [8, 9])
    for (const u of [8, 9, 2]) await bf.approve(u)
    expect(patches(bf, bf.r.tasks[0]!)).toEqual([
      [2, 'pending', 'waiting'],
      [1, 'approved', 'pending'],
    ])
    // a transferred first reviewer: the copy's approval is withdrawn like its own
    const tr = await setup(steps)
    await tr.act(
      transfer(tr.ctx, tr.r.instance, tr.r.tasks, tr.r.taskOf(2), { to: 8, comment: null }),
    )
    await tr.approve(8)
    expect(patches(tr, tr.r.tasks[2]!)).toEqual([
      [2, 'pending', 'waiting'],
      [3, 'approved', 'pending'],
    ])
  })

  it('withdraw on an `any` node: a canceled co-reviewer that had delegated or before-signed 409', async () => {
    const steps = [review('r1', users(2, 5)), review('r2', users(3))]
    const h = await setup(steps)
    await h.approve(2)
    const co = h.r.tasks[1]!
    expect(co.state).toBe('canceled')
    expect(h.withdraw(2).taskPatches).toContainEqual({
      id: co.id,
      from: 'canceled',
      set: { state: 'pending' },
    })
    for (const route of [
      (x: Setup, t: WfTask) =>
        delegate(x.ctx, x.r.instance, x.r.tasks, t, { to: 8, comment: null }),
      (x: Setup, t: WfTask) =>
        addSign(x.ctx, x.r.instance, x.r.tasks, t, { kind: 'before', userIds: [8], comment: null }),
    ]) {
      const x = await setup(steps)
      await x.act(route(x, x.r.taskOf(5)))
      await x.approve(2)
      expect(x.r.tasks[1]!.state).toBe('canceled')
      expect(() => x.withdraw(2)).toThrow(expect.objectContaining(conflict))
    }
  })

  it('parallel: an inner path end is not withdrawn once its inner join fired, the outer path waiting at its join', async () => {
    const h = await setup([
      parallel('p', [
        chain(parallel('q', [review('a', users(2)), review('b', users(3))]), review('n', users(5))),
        review('d', users(7)),
      ]),
    ])
    for (const u of [2, 3, 5]) await h.approve(u)
    expect(h.active()).toEqual(['d'])
    expect(() => h.withdraw(2)).toThrow(expect.objectContaining(conflict))
  })
})
