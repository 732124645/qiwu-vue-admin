import { compile, Err, type WfChangeSet, type WfFieldAccess, type WfStep } from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import {
  byAmount,
  chain,
  fields,
  org,
  parallel,
  review,
  run,
  T0,
  users,
} from '../../../../test/fixtures/wf/flow.js'
import { approve, backTargets, reject, resubmit, sendBack } from './actions.js'
import type { WfEngineCtx } from './advance.js'

const edit: WfFieldAccess = { amount: 'edit' }
const bad = { err: Err.UNPROCESSABLE }

/** starts `steps` (begin may edit `amount`) with `amount`; the helpers act on the pending task of a user */
async function setup(steps: WfStep[], amount = 50) {
  const c = compile(
    { id: 'begin', type: 'begin', name: 'Begin', access: edit, next: chain(...steps) },
    fields,
  )
  if (!c.ok) throw new Error(JSON.stringify(c.errors))
  const ctx: WfEngineCtx = { flow: c.flow, fields, org, managerIds: [7], now: T0 }
  const r = await run(ctx, { formValues: { amount } })
  const act = async (set: Promise<WfChangeSet>) => r.apply(await set, T0)
  const args = (userId: number) => [ctx, r.instance, r.tasks, r.taskOf(userId)] as const
  const h = {
    ctx,
    r,
    approve: (u: number, edits?: Record<string, unknown>) =>
      act(approve(...args(u), { comment: 'ok', edits })),
    reject: (u: number) => act(reject(...args(u), { comment: 'no' })),
    sendBack: (u: number, to: string) => act(sendBack(...args(u), { to, comment: 'redo' })),
    resubmit: (edits?: Record<string, unknown>) =>
      act(resubmit(...args(4), { comment: 'fixed', edits })),
    targets: (u: number) => backTargets(ctx, r.tasks, r.taskOf(u)),
    active: () => [...r.instance.activeNodeIds].sort(),
  }
  return h
}

describe('wf actions basic', () => {
  it('通过: the task closes with the comment; edits keep only the edit fields and decide what follows', async () => {
    const h = await setup([
      review('r1', { access: { amount: 'edit' } }),
      byAmount('f', 'exclusive', [[100, review('big', users(3))]], review('small', users(5))),
    ])
    const first = h.r.taskOf(2)
    await h.approve(2, { amount: 500, other: 1 })
    expect(h.r.tasks[0]).toMatchObject({ state: 'approved', comment: 'ok', handledAt: T0 })
    expect(h.r.instance.formValues).toEqual({ amount: 500 })
    expect(h.r.pending()).toEqual([['big', 3]])
    expect(h.r.tasks[1]!.fromTaskId).toBe(first.id)
    expect(h.r.events.at(-1)).toEqual({
      action: 'approve',
      taskId: first.id,
      nodeId: 'r1',
      actorId: 2,
      targetIds: null,
      comment: 'ok',
    })
    // read fields of the node stay as they were
    const h2 = await setup([
      review('r1'),
      byAmount('f', 'exclusive', [[100, review('big', users(3))]], review('small', users(5))),
    ])
    await h2.approve(2, { amount: 500 })
    expect(h2.r.instance.formValues).toEqual({ amount: 50 })
    expect(h2.r.pending()).toEqual([['small', 5]])
  })

  it('驳回 finish: one reviewer rejects an `all` node, the instance ends and every open task is canceled', async () => {
    const h = await setup([review('r1', { sign: 'all', ...users(2, 5) }), review('r2', users(3))])
    await h.reject(5)
    expect(h.r.tasks.map((t) => [t.assigneeId, t.state, t.comment])).toEqual([
      [2, 'canceled', null],
      [5, 'rejected', 'no'],
    ])
    expect(h.r.instance).toMatchObject({ state: 'rejected', activeNodeIds: [] })
    expect(h.r.endedAt()).toEqual(T0)
    expect(h.r.events.at(-1)).toMatchObject({ action: 'reject', actorId: 5, targetIds: null })
  })

  it('并行一路驳回（finish）取消另一路待办', async () => {
    const h = await setup([
      parallel('p', [review('a', users(2)), review('b', users(3))]),
      review('z', users(1)),
    ])
    expect(h.active()).toEqual(['a', 'b'])
    await h.reject(2)
    expect(h.r.tasks.map((t) => [t.nodeId, t.state])).toEqual([
      ['a', 'rejected'],
      ['b', 'canceled'],
    ])
    expect(h.r.instance).toMatchObject({ state: 'rejected', activeNodeIds: [] })
  })

  it('驳回 sendBack: back to the latest walked node before it, begin from the first node; `all` rejects as a whole', async () => {
    const h = await setup([
      review('r1', { onReject: 'sendBack' }),
      review('r2', { onReject: 'sendBack', sign: 'all', ...users(3, 5) }),
    ])
    await h.approve(2)
    const r2 = h.r.taskOf(5)
    await h.reject(5)
    expect(h.r.tasks.slice(1).map((t) => [t.nodeId, t.assigneeId, t.state])).toEqual([
      ['r2', 3, 'canceled'],
      ['r2', 5, 'rejected'],
      ['r1', 2, 'pending'],
    ])
    expect(h.r.tasks[3]!.fromTaskId).toBe(r2.id)
    expect(h.r.events.at(-1)).toMatchObject({ action: 'reject', taskId: r2.id, targetIds: ['r1'] })
    expect(h.r.instance).toMatchObject({ state: 'running', activeNodeIds: ['r1'] })
    await h.reject(2)
    expect(h.r.pending()).toEqual([['begin', 4]])
    expect(h.r.events.at(-1)).toMatchObject({ action: 'reject', targetIds: ['begin'] })
  })

  it('首个审批节点退回发起人 → 发起人修改后重新提交 → 重新走审批', async () => {
    const h = await setup([
      review('r1'),
      byAmount('f', 'exclusive', [[100, review('big', users(3))]], review('small', users(5))),
    ])
    expect(h.targets(2)).toEqual(['begin'])
    const r1 = h.r.taskOf(2)
    await h.sendBack(2, 'begin')
    expect(h.r.tasks).toMatchObject([
      { id: r1.id, state: 'sent_back', comment: 'redo', handledAt: T0 },
      { nodeId: 'begin', nodeName: 'Begin', assigneeId: 4, state: 'pending', fromTaskId: r1.id },
    ])
    expect(h.r.instance).toMatchObject({ state: 'running', activeNodeIds: ['begin'] })
    expect(h.r.events.at(-1)).toMatchObject({
      action: 'send_back',
      actorId: 2,
      targetIds: ['begin'],
    })
    const begin = h.r.taskOf(4)
    // begin.access: `amount` may change, anything else is dropped
    await h.resubmit({ amount: 500, other: 1 })
    expect(h.r.tasks[1]).toMatchObject({ state: 'approved', comment: 'fixed', handledAt: T0 })
    expect(h.r.instance.formValues).toEqual({ amount: 500 })
    expect(h.r.events.at(-1)).toMatchObject({ action: 'resubmit', actorId: 4, nodeId: 'begin' })
    expect(h.r.pending()).toEqual([['r1', 2]])
    expect(h.r.taskOf(2).fromTaskId).toBe(begin.id)
    await h.approve(2)
    expect(h.r.pending()).toEqual([['big', 3]])
  })

  it('resubmit: nothing outside begin.access changes', async () => {
    const c = compile({ id: 'begin', type: 'begin', name: 'Begin', next: review('r1') }, fields)
    if (!c.ok) throw new Error()
    const ctx: WfEngineCtx = { flow: c.flow, fields, org, managerIds: [], now: T0 }
    const r = await run(ctx, { formValues: { amount: 50 } })
    r.apply(
      await sendBack(ctx, r.instance, r.tasks, r.taskOf(2), { to: 'begin', comment: null }),
      T0,
    )
    r.apply(
      await resubmit(ctx, r.instance, r.tasks, r.taskOf(4), {
        comment: null,
        edits: { amount: 1 },
      }),
      T0,
    )
    expect(r.instance.formValues).toEqual({ amount: 50 })
  })

  it('`resubmitTo=sender` 重新提交直接回到退回它的节点', async () => {
    const h = await setup([review('r1'), review('r2', { ...users(3), resubmitTo: 'sender' })])
    await h.approve(2)
    await h.sendBack(3, 'begin')
    await h.resubmit({ amount: 70 })
    expect(h.r.pending()).toEqual([['r2', 3]])
    expect(h.r.instance).toMatchObject({ formValues: { amount: 70 }, activeNodeIds: ['r2'] })
    // the round before the resubmit still counts as walked
    expect(h.targets(3)).toEqual(['r1', 'begin'])
  })

  it('resubmitTo=sender on a parallel path re-enters the fork: the sender directly, the siblings from their start', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        chain(review('a0', users(1)), review('a', { ...users(2), resubmitTo: 'sender' })),
        chain(review('b0', users(3)), review('b1', users(5))),
      ]),
    ])
    for (const u of [8, 1, 3]) await h.approve(u)
    expect(h.active()).toEqual(['a', 'b1'])
    await h.sendBack(2, 'begin')
    expect(h.r.tasks.find((t) => t.nodeId === 'b1')!.state).toBe('canceled')
    await h.resubmit()
    // no r1, no a0 again; the b path runs from b0
    expect(h.r.pending()).toEqual([
      ['a', 2],
      ['b0', 3],
    ])
    expect(h.active()).toEqual(['a', 'b0'])
  })

  it('resubmitTo=sender on an inclusive path: the path to the sender is taken whatever the new values, no fallback', async () => {
    const h = await setup([
      byAmount(
        'f',
        'inclusive',
        [
          [10, review('a', { ...users(2), resubmitTo: 'sender' })],
          [20, review('b', users(3))],
        ],
        review('s', users(5)),
      ),
    ])
    expect(h.active()).toEqual(['a', 'b'])
    await h.sendBack(2, 'begin')
    await h.resubmit({ amount: 5 })
    expect(h.r.pending()).toEqual([['a', 2]])
    expect(h.active()).toEqual(['a'])
    await h.approve(2)
    expect(h.r.instance.state).toBe('approved')
  })

  it('resubmitTo=sender behind an exclusive fork nested in a parallel path: the sender, whatever the edits pick', async () => {
    const h = await setup(
      [
        parallel('p', [
          byAmount(
            'e',
            'exclusive',
            [
              [
                100,
                chain(review('x', users(3)), review('a', { ...users(2), resubmitTo: 'sender' })),
              ],
              // the new values pick this one: an exclusive fork still takes only the sender's path
              [10, review('y', users(1))],
            ],
            review('s', users(5)),
          ),
          review('b', users(7)),
        ]),
      ],
      500,
    )
    await h.approve(3)
    await h.sendBack(2, 'begin')
    await h.resubmit({ amount: 50 })
    expect(h.r.pending()).toEqual([
      ['a', 2],
      ['b', 7],
    ])
    expect(h.active()).toEqual(['a', 'b'])
  })

  it('resubmitTo=sender in nested forks re-enters the outermost parallel / inclusive one', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        parallel('q', [review('a', { ...users(2), resubmitTo: 'sender' }), review('c', users(1))]),
        review('b', users(3)),
      ]),
    ])
    await h.approve(8)
    await h.sendBack(2, 'begin')
    await h.resubmit()
    expect(h.r.pending()).toEqual([
      ['a', 2],
      ['c', 1],
      ['b', 3],
    ])
    expect(h.active()).toEqual(['a', 'b', 'c'])
  })

  it('resubmitTo=sender deeper in nested forks: each fork takes its path to the sender, entered at the node holding it', async () => {
    const toA = () =>
      chain(
        review('x', users(3)),
        parallel('q', [review('a', { ...users(2), resubmitTo: 'sender' }), review('c', users(1))]),
      )
    // an inclusive fork whose new values take no path: the sender's is taken, from q (no x, b or fallback s)
    const h = await setup([
      byAmount(
        'f',
        'inclusive',
        [
          [10, toA()],
          [20, review('b', users(5))],
        ],
        review('s', users(7)),
      ),
    ])
    await h.approve(3)
    expect(h.active()).toEqual(['a', 'b', 'c'])
    await h.sendBack(2, 'begin')
    await h.resubmit({ amount: 5 })
    expect(h.r.pending()).toEqual([
      ['a', 2],
      ['c', 1],
    ])
    // a parallel fork: the sibling path runs from its start
    const p = await setup([parallel('p', [toA(), review('b', users(5))])])
    await p.approve(3)
    await p.sendBack(2, 'begin')
    await p.resubmit()
    expect(p.r.pending()).toEqual([
      ['a', 2],
      ['c', 1],
      ['b', 5],
    ])
  })

  it('resubmitTo=sender on an inclusive path re-enters the fork: the other taken paths get tasks again', async () => {
    const h = await setup([
      byAmount('f', 'inclusive', [
        [10, review('a', { ...users(2), resubmitTo: 'sender' })],
        [20, review('b', users(3))],
      ]),
    ])
    expect(h.active()).toEqual(['a', 'b'])
    await h.sendBack(2, 'begin')
    expect(h.r.pending()).toEqual([['begin', 4]])
    await h.resubmit()
    expect(h.r.pending()).toEqual([
      ['a', 2],
      ['b', 3],
    ])
    expect(h.active()).toEqual(['a', 'b'])
  })

  it('resubmitTo=sender on an exclusive path goes to the sender itself, whatever the edits make the fork pick', async () => {
    const h = await setup(
      [
        review('r1', users(8)),
        byAmount(
          'f',
          'exclusive',
          [
            [
              100,
              chain(review('b1', users(3)), review('b2', { ...users(5), resubmitTo: 'sender' })),
            ],
          ],
          review('s1', users(1)),
        ),
        review('z', users(7)),
      ],
      500,
    )
    for (const u of [8, 3]) await h.approve(u)
    await h.sendBack(5, 'begin')
    await h.resubmit({ amount: 50 })
    expect(h.r.pending()).toEqual([['b2', 5]])
    expect(h.active()).toEqual(['b2'])
    await h.approve(5)
    expect(h.r.pending()).toEqual([['z', 7]])
  })

  it('退回到分支内已走节点', async () => {
    const h = await setup(
      [
        review('r1', users(8)),
        byAmount(
          'f',
          'exclusive',
          [[100, chain(review('b1', users(3)), review('b2', users(5)))]],
          review('s1', users(1)),
        ),
        review('r2', users(7)),
      ],
      500,
    )
    for (const u of [8, 3, 5]) await h.approve(u)
    expect(h.targets(7)).toEqual(['b2', 'b1', 'r1', 'begin'])
    await h.sendBack(7, 'b1')
    expect(h.r.pending()).toEqual([['b1', 3]])
    expect(h.active()).toEqual(['b1'])
    await h.approve(3)
    await h.approve(5)
    expect(h.r.pending()).toEqual([['r2', 7]])
  })

  it('send-back targets: walked review nodes upstream only, else 422; begin and child tasks cannot decide', async () => {
    const h = await setup([review('r1', users(8)), review('r2', users(2)), review('r3', users(3))])
    await h.approve(8)
    await h.approve(2)
    await h.sendBack(3, 'r1')
    // r2 and r3 were walked but lie ahead of r1; r1 itself, a non-review and an unknown id neither
    for (const to of ['r2', 'r3', 'r1', 'nope'])
      await expect(h.sendBack(8, to)).rejects.toMatchObject(bad)
    expect(h.targets(8)).toEqual(['begin'])
    const { ctx, r } = h
    const child = { ...r.taskOf(8), parentTaskId: 1 }
    await expect(reject(ctx, r.instance, r.tasks, child, { comment: null })).rejects.toMatchObject(
      bad,
    )
    await expect(
      sendBack(ctx, r.instance, r.tasks, child, { to: 'begin', comment: null }),
    ).rejects.toMatchObject(bad)
    await h.sendBack(8, 'begin')
    const begin = r.taskOf(4)
    for (const call of [approve, reject])
      await expect(call(ctx, r.instance, r.tasks, begin, { comment: null })).rejects.toMatchObject(
        bad,
      )
    await expect(
      resubmit(ctx, r.instance, r.tasks, r.tasks[0]!, { comment: null }),
    ).rejects.toMatchObject(bad)
  })

  it('a restart resubmit starts a new round: the old fork path is no target any more', async () => {
    const h = await setup(
      [
        review('r1', users(8)),
        byAmount('f', 'exclusive', [[100, review('b1', users(3))]], review('s1', users(5))),
        review('r2', users(7)),
      ],
      500,
    )
    for (const u of [8, 3]) await h.approve(u)
    await h.sendBack(7, 'begin')
    await h.resubmit({ amount: 50 })
    for (const u of [8, 5]) await h.approve(u)
    expect(h.targets(7)).toEqual(['s1', 'r1', 'begin'])
    await expect(h.sendBack(7, 'b1')).rejects.toMatchObject(bad)
  })

  it('send-back targets count approvals only: a node that sent back is not walked', async () => {
    const h = await setup(
      [
        review('r1', { access: { amount: 'edit' }, ...users(8) }),
        byAmount('f', 'exclusive', [[100, review('b1', users(3))]], review('s1', users(5))),
        review('r2', users(7)),
      ],
      500,
    )
    await h.approve(8)
    await h.sendBack(3, 'r1')
    await h.approve(8, { amount: 50 })
    await h.approve(5)
    expect(h.targets(7)).toEqual(['s1', 'r1', 'begin'])
  })

  it('并行路径内退回只重置本路径', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        chain(review('a1', users(2)), review('a2', users(3))),
        chain(review('b1', users(5)), review('b2', users(7))),
      ]),
      review('z', users(1)),
    ])
    for (const u of [8, 2, 5]) await h.approve(u)
    expect(h.active()).toEqual(['a2', 'b2'])
    // a sibling path's node is no target
    expect(h.targets(3)).toEqual(['a1', 'r1', 'begin'])
    await expect(h.sendBack(3, 'b1')).rejects.toMatchObject(bad)
    await h.sendBack(3, 'a1')
    expect(h.r.pending()).toEqual([
      ['b2', 7],
      ['a1', 2],
    ])
    expect(h.active()).toEqual(['a1', 'b2'])
    await h.approve(2)
    await h.approve(3)
    expect(h.r.pending()).toEqual([['b2', 7]])
    await h.approve(7)
    expect(h.r.pending()).toEqual([['z', 1]])
    // from after the join into one path: only that path runs again, then it joins at once
    await h.sendBack(1, 'b1')
    expect(h.r.pending()).toEqual([['b1', 5]])
    await h.approve(5)
    await h.approve(7)
    expect(h.r.pending()).toEqual([['z', 1]])
  })

  it('nested forks: a send-back resets only the innermost path holding both nodes', async () => {
    const h = await setup([
      review('r0', users(8)),
      parallel('p', [
        parallel('q', [
          chain(review('q1', users(2)), review('q2', users(3))),
          review('q3', users(1)),
        ]),
        review('b', users(5)),
      ]),
    ])
    await h.approve(8)
    await h.approve(2)
    expect(h.active()).toEqual(['b', 'q2', 'q3'])
    expect(h.targets(3)).toEqual(['q1', 'r0', 'begin'])
    await h.sendBack(3, 'q1')
    expect(h.active()).toEqual(['b', 'q1', 'q3'])
    expect(h.r.pending()).toEqual([
      ['q3', 1],
      ['b', 5],
      ['q1', 2],
    ])
  })

  it('退到 fork 之前重进 fork', async () => {
    const h = await setup([
      review('r1', users(8)),
      parallel('p', [
        chain(review('a1', users(2)), review('a2', users(3))),
        review('b1', users(5)),
      ]),
    ])
    await h.approve(8)
    await h.approve(2)
    await h.sendBack(3, 'r1')
    expect(h.r.tasks.filter((t) => t.nodeId === 'b1').map((t) => t.state)).toEqual(['canceled'])
    expect(h.active()).toEqual(['r1'])
    await h.approve(8)
    expect(h.r.pending()).toEqual([
      ['a1', 2],
      ['b1', 5],
    ])
    expect(h.active()).toEqual(['a1', 'b1'])
  })
})
