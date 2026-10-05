import { Err, type WfChangeSet, type WfReviewNode } from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import { ctxOf, HOUR, review, run, T0, users } from '../../../../test/fixtures/wf/flow.js'
import { addSign, delegate, removeSign, transfer } from './routing.js'

/** r1 (user 2 unless `first` says otherwise) → r2 (user 3), started; `act` applies an action's change set */
async function setup(first: Partial<WfReviewNode> = {}) {
  const ctx = ctxOf([review('r1', first), review('r2', users(3))])
  const r = await run(ctx)
  const act = async (set: Promise<WfChangeSet>, now = ctx.now) => r.apply(await set, now)
  const rows = () => r.tasks.map((t) => [t.id, t.assigneeId, t.state])
  return { ctx, r, act, rows }
}
const day = { timeout: { hours: 24 } }

describe('wf actions routing', () => {
  it('转办: the task closes as transferred, the target gets a copy that goes on like it', async () => {
    const { ctx, r, act } = await setup(day)
    await act(transfer(ctx, r.instance, r.tasks, r.taskOf(2), { to: 8, comment: 'away' }))
    expect(r.tasks).toMatchObject([
      { id: 1, assigneeId: 2, state: 'transferred', comment: 'away', handledAt: T0 },
      {
        id: 2,
        nodeId: 'r1',
        nodeName: 'R1',
        assigneeId: 8,
        ownerId: null,
        parentTaskId: null,
        fromTaskId: null,
        signKind: null,
        seq: 0,
        state: 'pending',
        dueAt: new Date(T0.getTime() + 24 * HOUR),
      },
    ])
    expect(r.events.at(-1)).toEqual({
      action: 'transfer',
      taskId: 1,
      nodeId: 'r1',
      actorId: 2,
      targetIds: [8],
      comment: 'away',
    })
    await r.approve(r.taskOf(8))
    expect(r.pending()).toEqual([['r2', 3]])
  })

  it('targets: enabled users without an open task on the step, repeats dropped, else 422', async () => {
    const { ctx, r, act } = await setup({ sign: 'ordered', ...users(2, 5, 1) })
    const t = r.taskOf(2)
    const bad = { err: Err.WF_BAD_TARGET }
    // disabled, unknown, the actor, a waiting reviewer of the step
    for (const to of [6, 99, 2, 5]) {
      await expect(
        transfer(ctx, r.instance, r.tasks, t, { to, comment: null }),
      ).rejects.toMatchObject(bad)
      await expect(
        delegate(ctx, r.instance, r.tasks, t, { to, comment: null }),
      ).rejects.toMatchObject(bad)
      await expect(
        addSign(ctx, r.instance, r.tasks, t, { kind: 'after', userIds: [8, to], comment: null }),
      ).rejects.toMatchObject(bad)
    }
    await expect(
      addSign(ctx, r.instance, r.tasks, t, { kind: 'before', userIds: [], comment: null }),
    ).rejects.toMatchObject(bad)
    // the next step's reviewer is fine
    const set = await addSign(ctx, r.instance, r.tasks, t, {
      kind: 'before',
      userIds: [8, 3, 8],
      comment: null,
    })
    expect(set.newTasks.map((x) => [x.assigneeId, x.seq])).toEqual([
      [8, 0],
      [3, 1],
    ])
    // a closed task on the step is no bar: the task can come back to its first assignee
    await act(transfer(ctx, r.instance, r.tasks, t, { to: 8, comment: null }))
    await act(transfer(ctx, r.instance, r.tasks, r.taskOf(8), { to: 2, comment: null }))
    expect(r.pending()).toEqual([['r1', 2]])
  })

  it('only a review task that is no child routes, else 422', async () => {
    const { ctx, r, act } = await setup(users(2, 5))
    await act(delegate(ctx, r.instance, r.tasks, r.taskOf(2), { to: 8, comment: null }))
    await act(
      addSign(ctx, r.instance, r.tasks, r.taskOf(5), {
        kind: 'before',
        userIds: [1],
        comment: null,
      }),
    )
    const begin = { ...r.tasks[0]!, id: 99, nodeId: 'begin', state: 'pending' as const }
    for (const t of [r.taskOf(8), r.taskOf(1), begin]) {
      const no = { err: Err.UNPROCESSABLE }
      await expect(
        transfer(ctx, r.instance, r.tasks, t, { to: 7, comment: null }),
      ).rejects.toMatchObject(no)
      await expect(
        delegate(ctx, r.instance, r.tasks, t, { to: 7, comment: null }),
      ).rejects.toMatchObject(no)
      await expect(
        addSign(ctx, r.instance, r.tasks, t, { kind: 'after', userIds: [7], comment: null }),
      ).rejects.toMatchObject(no)
    }
  })

  it('委派回归: the delegate handles the task, then it is back with its owner to decide', async () => {
    const { ctx, r, act } = await setup(day)
    const t = r.taskOf(2)
    await act(delegate(ctx, r.instance, r.tasks, t, { to: 8, comment: 'check the numbers' }))
    expect(r.tasks.map((x) => [x.id, x.assigneeId, x.ownerId, x.parentTaskId, x.state])).toEqual([
      [1, 2, null, null, 'delegated'],
      [2, 8, 2, 1, 'pending'],
    ])
    expect(r.taskOf(8)).toMatchObject({ nodeId: 'r1', signKind: null, dueAt: t.dueAt })
    expect(r.events.at(-1)).toEqual({
      action: 'delegate',
      taskId: 1,
      nodeId: 'r1',
      actorId: 2,
      targetIds: [8],
      comment: 'check the numbers',
    })
    await r.approve(r.taskOf(8))
    expect(r.pending()).toEqual([['r1', 2]])
    expect(r.instance.activeNodeIds).toEqual(['r1'])
    await r.approve(r.taskOf(2))
    expect(r.pending()).toEqual([['r2', 3]])
  })

  it('a delegated task is still open: all waits for it, any cancels it with the delegate’s task', async () => {
    const all = await setup({ sign: 'all', ...users(2, 5) })
    await all.act(
      delegate(all.ctx, all.r.instance, all.r.tasks, all.r.taskOf(2), { to: 8, comment: null }),
    )
    // and its owner still holds the step: no target for another reviewer
    await expect(
      transfer(all.ctx, all.r.instance, all.r.tasks, all.r.taskOf(5), { to: 2, comment: null }),
    ).rejects.toMatchObject({ err: Err.WF_BAD_TARGET })
    await all.r.approve(all.r.taskOf(5))
    expect(all.r.pending()).toEqual([['r1', 8]])
    expect(all.r.instance.activeNodeIds).toEqual(['r1'])

    const any = await setup(users(2, 5))
    await any.act(
      delegate(any.ctx, any.r.instance, any.r.tasks, any.r.taskOf(2), { to: 8, comment: null }),
    )
    await any.r.approve(any.r.taskOf(5))
    expect(any.rows()).toEqual([
      [1, 2, 'canceled'],
      [2, 5, 'approved'],
      [3, 8, 'canceled'],
      [4, 3, 'pending'],
    ])
  })

  it('前/后加签 - before: the task waits until every signer approved, then its reviewer decides', async () => {
    const { ctx, r, act, rows } = await setup(day)
    const later = new Date(T0.getTime() + 2 * HOUR)
    await act(
      addSign({ ...ctx, now: later }, r.instance, r.tasks, r.taskOf(2), {
        kind: 'before',
        userIds: [3, 5],
        comment: 'ask them',
      }),
      later,
    )
    expect(rows()).toEqual([
      [1, 2, 'waiting'],
      [2, 3, 'pending'],
      [3, 5, 'pending'],
    ])
    expect(r.tasks[1]).toMatchObject({
      nodeId: 'r1',
      parentTaskId: 1,
      signKind: 'before',
      ownerId: null,
      seq: 0,
      dueAt: new Date(later.getTime() + 24 * HOUR),
    })
    expect(r.events.at(-1)).toEqual({
      action: 'add_sign',
      taskId: 1,
      nodeId: 'r1',
      actorId: 2,
      targetIds: [3, 5],
      comment: 'ask them',
    })
    await r.approve(r.taskOf(3))
    expect(r.tasks[0]!.state).toBe('waiting')
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['r1', 2]])
    expect(r.instance.activeNodeIds).toEqual(['r1'])
    await r.approve(r.taskOf(2))
    expect(r.pending()).toEqual([['r2', 3]])
  })

  it('前/后加签 - after: the approval is made now and takes effect once every signer approved', async () => {
    const { ctx, r, act, rows } = await setup()
    await act(
      addSign(ctx, r.instance, r.tasks, r.taskOf(2), {
        kind: 'after',
        userIds: [5, 8],
        comment: 'fine',
      }),
    )
    expect(rows()).toEqual([
      [1, 2, 'approved'],
      [2, 5, 'pending'],
      [3, 8, 'pending'],
    ])
    expect(r.tasks[0]).toMatchObject({ comment: 'fine', handledAt: T0 })
    // created by task 1's approval, so withdrawing it finds them through `fromTaskId`
    expect(r.tasks[2]).toMatchObject({ parentTaskId: 1, fromTaskId: 1, signKind: 'after', seq: 1 })
    expect(
      r.events.slice(-2).map((e) => [e.action, e.taskId, e.actorId, e.targetIds, e.comment]),
    ).toEqual([
      ['approve', 1, 2, null, 'fine'],
      ['add_sign', 1, 2, [5, 8], null],
    ])
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['r1', 8]])
    expect(r.instance.activeNodeIds).toEqual(['r1'])
    await r.approve(r.taskOf(8))
    expect(r.pending()).toEqual([['r2', 3]])
    // the reviewer's approval moved the token
    expect(r.taskOf(3).fromTaskId).toBe(1)
  })

  it('前/后加签 - after: a parent no longer approved is not settled by its signers', async () => {
    const { ctx, r, act } = await setup()
    await act(
      addSign(ctx, r.instance, r.tasks, r.taskOf(2), {
        kind: 'after',
        userIds: [5],
        comment: null,
      }),
    )
    r.tasks[0]!.state = 'pending' // its approval undone, the signer left open
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['r1', 2]])
    expect(r.instance.activeNodeIds).toEqual(['r1'])
  })

  it('前/后加签 - after on an ordered step: the next reviewer’s turn comes after the signers', async () => {
    const { ctx, r, act } = await setup({ sign: 'ordered', ...users(2, 5) })
    await act(
      addSign(ctx, r.instance, r.tasks, r.taskOf(2), {
        kind: 'after',
        userIds: [8],
        comment: null,
      }),
    )
    expect(r.pending()).toEqual([['r1', 8]])
    await r.approve(r.taskOf(8))
    expect(r.pending()).toEqual([['r1', 5]])
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['r2', 3]])
  })

  it('前/后加签 on a shared step: all waits for the signers, any cancels the waiting task and them', async () => {
    const all = await setup({ sign: 'all', ...users(2, 5) })
    await all.act(
      addSign(all.ctx, all.r.instance, all.r.tasks, all.r.taskOf(2), {
        kind: 'before',
        userIds: [8],
        comment: null,
      }),
    )
    await all.r.approve(all.r.taskOf(5))
    expect(all.r.pending()).toEqual([['r1', 8]])
    await all.r.approve(all.r.taskOf(8))
    expect(all.r.pending()).toEqual([['r1', 2]])
    await all.r.approve(all.r.taskOf(2))
    expect(all.r.pending()).toEqual([['r2', 3]])

    const any = await setup(users(2, 5))
    await any.act(
      addSign(any.ctx, any.r.instance, any.r.tasks, any.r.taskOf(2), {
        kind: 'before',
        userIds: [8],
        comment: null,
      }),
    )
    await any.r.approve(any.r.taskOf(5))
    expect(any.rows()).toEqual([
      [1, 2, 'canceled'],
      [2, 5, 'approved'],
      [3, 8, 'canceled'],
      [4, 3, 'pending'],
    ])
  })

  it('减签 - before: cancels the signers named; the last one gone gives the task back', async () => {
    const { ctx, r, act, rows } = await setup()
    await act(
      addSign(ctx, r.instance, r.tasks, r.taskOf(2), {
        kind: 'before',
        userIds: [3, 5, 8],
        comment: null,
      }),
    )
    await r.approve(r.taskOf(3))
    await act(
      removeSign(ctx, r.instance, r.tasks, r.tasks[0]!, { taskIds: [3], comment: 'not needed' }),
    )
    expect(rows()).toEqual([
      [1, 2, 'waiting'],
      [2, 3, 'approved'],
      [3, 5, 'canceled'],
      [4, 8, 'pending'],
    ])
    expect(r.events.at(-1)).toEqual({
      action: 'remove_sign',
      taskId: 1,
      nodeId: 'r1',
      actorId: 2,
      targetIds: [5],
      comment: 'not needed',
    })
    await act(removeSign(ctx, r.instance, r.tasks, r.tasks[0]!, { taskIds: [4], comment: null }))
    expect(r.pending()).toEqual([['r1', 2]])
  })

  it('减签 - after: the last signer gone lets the approval take effect', async () => {
    const { ctx, r, act } = await setup()
    await act(
      addSign(ctx, r.instance, r.tasks, r.taskOf(2), {
        kind: 'after',
        userIds: [5],
        comment: null,
      }),
    )
    await act(removeSign(ctx, r.instance, r.tasks, r.tasks[0]!, { taskIds: [2], comment: null }))
    expect(r.pending()).toEqual([['r2', 3]])
    expect(r.taskOf(3).fromTaskId).toBe(1)
  })

  it('减签: only pending add-sign tasks of the given task, all of them or none (404)', async () => {
    const { ctx, r, act } = await setup({ sign: 'all', ...users(2, 5) })
    const sign = (userId: number, userIds: number[]) =>
      act(
        addSign(ctx, r.instance, r.tasks, r.taskOf(userId), {
          kind: 'before',
          userIds,
          comment: null,
        }),
      )
    await sign(2, [8, 3]) // tasks 3, 4 under task 1
    await sign(5, [1]) // task 5 under task 2
    await r.approve(r.taskOf(8)) // task 3 handled
    const parent = r.tasks[0]!
    for (const taskIds of [[], [3], [5], [4, 5], [2], [99]])
      await expect(
        removeSign(ctx, r.instance, r.tasks, parent, { taskIds, comment: null }),
      ).rejects.toMatchObject({ err: Err.NOT_FOUND })
    await act(removeSign(ctx, r.instance, r.tasks, parent, { taskIds: [4, 4], comment: null }))
    expect(parent.state).toBe('pending')

    // a delegate's task is no add-sign
    const d = await setup()
    await d.act(delegate(d.ctx, d.r.instance, d.r.tasks, d.r.taskOf(2), { to: 8, comment: null }))
    await expect(
      removeSign(d.ctx, d.r.instance, d.r.tasks, d.r.tasks[0]!, { taskIds: [2], comment: null }),
    ).rejects.toMatchObject({ err: Err.NOT_FOUND })
  })
})
