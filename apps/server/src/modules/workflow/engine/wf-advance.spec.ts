import { Err, type WfForkNode, type WfReviewNode, type WfStep } from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import { ctxOf, HOUR, notify, review, run, T0, users } from '../../../../test/fixtures/wf/flow.js'
import { BizError } from '../../../core/http/biz-error.js'
import { emptyChangeSet, moveToken, taskApproved } from './advance.js'

/** exclusive fork: `amount > 100` path, then the fallback; `next` joins them */
const fork = (id: string, big?: WfStep, small?: WfStep, next?: WfStep): WfForkNode => ({
  id,
  type: 'fork',
  name: id,
  paths: [
    {
      id: `${id}-big`,
      name: 'big',
      when: [[{ field: 'amount', op: 'gt', value: 100 }]],
      child: big,
    },
    { id: `${id}-small`, name: 'small', fallback: true, when: [], child: small },
  ],
  next,
})

describe('wf advance', () => {
  it('start: a begin event, then the first review gets its tasks and holds the token', async () => {
    const r = await run(ctxOf([review('r1', users(5, 2))]))
    expect(r.events).toEqual([
      {
        action: 'begin',
        taskId: null,
        nodeId: 'begin',
        actorId: 4,
        targetIds: null,
        comment: null,
      },
    ])
    expect(r.tasks).toMatchObject([
      {
        nodeId: 'r1',
        nodeName: 'R1',
        assigneeId: 5,
        seq: 0,
        state: 'pending',
        fromTaskId: null,
        dueAt: null,
      },
      {
        nodeId: 'r1',
        nodeName: 'R1',
        assigneeId: 2,
        seq: 1,
        state: 'pending',
        fromTaskId: null,
        dueAt: null,
      },
    ])
    expect(r.tasks[0]).toMatchObject({ ownerId: null, parentTaskId: null, signKind: null })
    expect(r.instance).toMatchObject({ state: 'running', activeNodeIds: ['r1'] })
    expect(r.endedAt()).toBeUndefined()
  })

  it('三种会签方式 - any: the first approval cancels the other tasks and moves the token on', async () => {
    const r = await run(ctxOf([review('r1', users(2, 5)), review('r2', users(3))]))
    await r.approve(r.taskOf(5))
    expect(r.tasks.map((t) => [t.assigneeId, t.state])).toEqual([
      [2, 'canceled'],
      [5, 'approved'],
      [3, 'pending'],
    ])
    expect(r.instance.activeNodeIds).toEqual(['r2'])
  })

  it('三种会签方式 - all: the node waits for every reviewer', async () => {
    const r = await run(
      ctxOf([review('r1', { sign: 'all', ...users(2, 5) }), review('r2', users(3))]),
    )
    await r.approve(r.taskOf(2))
    expect(r.pending()).toEqual([['r1', 5]])
    expect(r.instance.activeNodeIds).toEqual(['r1'])
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['r2', 3]])
    expect(r.instance.activeNodeIds).toEqual(['r2'])
  })

  it('三种会签方式 - ordered: one reviewer at a time in list order, the rest waiting', async () => {
    const r = await run(
      ctxOf([review('r1', { sign: 'ordered', ...users(5, 2, 3) }), review('r2', users(1))]),
    )
    expect(r.tasks.map((t) => [t.assigneeId, t.seq, t.state])).toEqual([
      [5, 0, 'pending'],
      [2, 1, 'waiting'],
      [3, 2, 'waiting'],
    ])
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['r1', 2]])
    expect(r.open('waiting').map((t) => t.assigneeId)).toEqual([3])
    await r.approve(r.taskOf(2))
    await r.approve(r.taskOf(3))
    expect(r.pending()).toEqual([['r2', 1]])
  })

  it('ordered: the next reviewer is the lowest waiting seq, whatever order the tasks come in', async () => {
    const ctx = ctxOf([review('r1', { sign: 'ordered', ...users(5, 2, 3) })])
    const r = await run(ctx)
    const set = emptyChangeSet()
    await taskApproved(ctx, r.instance, [...r.tasks].reverse(), r.taskOf(5), set)
    expect(set.taskPatches).toEqual([
      { id: r.tasks[1]!.id, from: 'waiting', set: { state: 'pending', dueAt: null } },
    ])
  })

  it.each(['any', 'all'] as const)(
    '%s: open tasks of other nodes neither block nor get canceled',
    async (sign) => {
      const ctx = ctxOf([review('r1', { sign }), review('r2', users(3))])
      const r = await run(ctx)
      const elsewhere = { ...r.tasks[0]!, id: 99, nodeId: 'r2' }
      const set = emptyChangeSet()
      await taskApproved(ctx, r.instance, [...r.tasks, elsewhere], r.tasks[0]!, set)
      expect(set.taskPatches).toEqual([])
      expect(set.newTasks.map((t) => [t.nodeId, t.assigneeId])).toEqual([['r2', 3]])
    },
  )

  it('the last node finishing approves the instance', async () => {
    const ctx = ctxOf([review('r1')])
    const r = await run(ctx)
    const later = new Date(T0.getTime() + HOUR)
    await r.approve(r.taskOf(2), later)
    expect(r.instance).toMatchObject({ state: 'approved', activeNodeIds: [] })
    expect(r.endedAt()).toEqual(later)
  })

  it('an empty process is approved at the start', async () => {
    const r = await run(ctxOf([]))
    expect(r.instance).toMatchObject({ state: 'approved', activeNodeIds: [] })
    expect(r.tasks).toEqual([])
  })

  it('new tasks and ccs carry the task whose approval created them (fromTaskId)', async () => {
    const r = await run(ctxOf([review('r1'), notify('n1', 5), review('r2', users(3, 1))]))
    const t = r.taskOf(2)
    await r.approve(t)
    expect(r.open().map((x) => x.fromTaskId)).toEqual([t.id, t.id])
    expect(r.ccs).toEqual([
      { nodeId: 'n1', userId: 5, fromTaskId: t.id, fromUserId: null, reason: null },
    ])
  })

  it('notify: a cc for each enabled user and a cc event, then on; none resolved = no cc', async () => {
    const r = await run(ctxOf([notify('n1', 6, 5, 1), notify('n2', 6), review('r1')]))
    expect(r.ccs.map((c) => [c.nodeId, c.userId, c.fromTaskId])).toEqual([
      ['n1', 5, null],
      ['n1', 1, null],
    ])
    expect(r.events[1]).toEqual({
      action: 'cc',
      taskId: null,
      nodeId: 'n1',
      actorId: null,
      targetIds: [5, 1],
      comment: null,
    })
    expect(r.events).toHaveLength(2)
    expect(r.pending()).toEqual([['r1', 2]])
  })

  it('fork fallback: the first matching path, else the fallback; a path end joins at fork.next', async () => {
    const steps = [
      fork('f', review('big', users(1)), review('small', users(3)), review('after', users(5))),
    ]
    const big = await run(ctxOf(steps), { formValues: { amount: 500 } })
    expect(big.pending()).toEqual([['big', 1]])
    expect(big.instance.activeNodeIds).toEqual(['big'])
    await big.approve(big.taskOf(1))
    expect(big.pending()).toEqual([['after', 5]])
    expect(big.instance.activeNodeIds).toEqual(['after'])

    expect((await run(ctxOf(steps), { formValues: { amount: 100 } })).pending()).toEqual([
      ['small', 3],
    ])
    expect((await run(ctxOf(steps), { formValues: {} })).pending()).toEqual([['small', 3]])
  })

  it('fork: path order decides between matching paths; an empty path goes straight to fork.next', async () => {
    const first = fork('f', review('a', users(1)), review('b', users(3)), review('after', users(5)))
    first.paths.splice(1, 0, {
      id: 'f-also',
      name: 'also',
      when: [[{ field: 'amount', op: 'gte', value: 0 }]],
      child: review('c', users(2)),
    })
    expect((await run(ctxOf([first]), { formValues: { amount: 500 } })).pending()).toEqual([
      ['a', 1],
    ])
    expect((await run(ctxOf([first]), { formValues: { amount: 5 } })).pending()).toEqual([['c', 2]])

    // the fallback is picked by its flag, not its place: listed first it still only catches the rest
    const lead = fork('f', review('big', users(1)), review('small', users(3)))
    lead.paths.reverse()
    expect((await run(ctxOf([lead]), { formValues: { amount: 500 } })).pending()).toEqual([
      ['big', 1],
    ])
    expect((await run(ctxOf([lead]), { formValues: { amount: 5 } })).pending()).toEqual([
      ['small', 3],
    ])

    const empty = [fork('f', undefined, review('small', users(3)), review('after', users(5)))]
    expect((await run(ctxOf(empty), { formValues: { amount: 500 } })).pending()).toEqual([
      ['after', 5],
    ])
  })

  it('fork: form values the same action changed decide the path', async () => {
    const ctx = ctxOf([review('r1'), fork('f', review('big', users(1)), review('small', users(3)))])
    const r = await run(ctx, { formValues: { amount: 5 } })
    const set = emptyChangeSet()
    set.instance.formValues = { amount: 500 }
    await taskApproved(ctx, r.instance, r.tasks, r.taskOf(2), set)
    expect(set.newTasks.map((t) => [t.nodeId, t.assigneeId])).toEqual([['big', 1]])
  })

  it('fork: the end of a nested path climbs out to the next node of an outer chain', async () => {
    const inner = fork('in', review('deep', users(1)), undefined)
    const r = await run(ctxOf([fork('out', inner, undefined), review('last', users(5))]), {
      formValues: { amount: 500 },
    })
    expect(r.pending()).toEqual([['deep', 1]])
    await r.approve(r.taskOf(1))
    expect(r.pending()).toEqual([['last', 5]])
    await r.approve(r.taskOf(5))
    expect(r.instance.state).toBe('approved')
  })

  it('whenNobody 三分支: autoPass passes as the system, toManager / toUser hand the node over', async () => {
    const nobody = { assignee: { kind: 'users' as const, ids: [6] } }
    const auto = await run(ctxOf([review('r1', nobody), review('r2', users(3))]))
    expect(auto.events[1]).toEqual({
      action: 'approve',
      taskId: null,
      nodeId: 'r1',
      actorId: null,
      targetIds: null,
      comment: null,
    })
    expect(auto.pending()).toEqual([['r2', 3]])

    const mgr = await run(
      ctxOf([review('r1', { ...nobody, whenNobody: 'toManager' })], { managerIds: [8, 6, 7] }),
    )
    expect(mgr.pending()).toEqual([
      ['r1', 7],
      ['r1', 8],
    ])
    const user = await run(
      ctxOf([review('r1', { ...nobody, whenNobody: 'toUser', fallbackUserId: 8 })]),
    )
    expect(user.pending()).toEqual([['r1', 8]])
  })

  it('whenNobody: a manager / fallback user who is nobody enabled either fails the move, never passes', async () => {
    const nobody = { assignee: { kind: 'users' as const, ids: [6] } }
    const noManager = run(
      ctxOf([review('r1', { ...nobody, whenNobody: 'toManager' })], { managerIds: [6] }),
    )
    await expect(noManager).rejects.toThrow(BizError)
    await expect(noManager).rejects.toMatchObject({
      err: Err.WF_NO_ASSIGNEE,
      params: { node: 'R1' },
    })
    const gone = run(ctxOf([review('r1', { ...nobody, whenNobody: 'toUser', fallbackUserId: 6 })]))
    await expect(gone).rejects.toMatchObject({ err: Err.WF_NO_ASSIGNEE })
  })

  it('whenInitiatorIsReviewer skip: nobody resolved (the initiator not among them) still goes to whenNobody', async () => {
    const skip = {
      assignee: { kind: 'users' as const, ids: [6] },
      whenInitiatorIsReviewer: 'skip' as const,
    }
    // decision: the whenNobody targets are taken as they are, an initiator among them included
    const mgr = await run(
      ctxOf([review('r1', { ...skip, whenNobody: 'toManager' })], { managerIds: [4, 7] }),
    )
    expect(mgr.pending()).toEqual([
      ['r1', 4],
      ['r1', 7],
    ])
    const user = await run(
      ctxOf([review('r1', { ...skip, whenNobody: 'toUser', fallbackUserId: 8 })]),
    )
    expect(user.pending()).toEqual([['r1', 8]])
    const none = run(
      ctxOf([review('r1', { ...skip, whenNobody: 'toManager' })], { managerIds: [6] }),
    )
    await expect(none).rejects.toMatchObject({ err: Err.WF_NO_ASSIGNEE })
  })

  it('whenInitiatorIsReviewer: self keeps the initiator, skip drops them', async () => {
    const both = users(4, 5)
    expect((await run(ctxOf([review('r1', both)]))).pending()).toEqual([
      ['r1', 4],
      ['r1', 5],
    ])
    const skip = { ...both, whenInitiatorIsReviewer: 'skip' as const }
    expect((await run(ctxOf([review('r1', skip)]))).pending()).toEqual([['r1', 5]])
    // the initiator alone: the node passes, even with a whenNobody target
    const alone = {
      ...users(4),
      whenInitiatorIsReviewer: 'skip' as const,
      whenNobody: 'toManager' as const,
    }
    const r = await run(ctxOf([review('r1', alone), review('r2', users(3))]))
    expect(r.events.map((e) => [e.action, e.nodeId, e.actorId])).toEqual([
      ['begin', 'begin', 4],
      ['approve', 'r1', null],
    ])
    expect(r.pending()).toEqual([['r2', 3]])
  })

  it('whenInitiatorIsReviewer: deptHead puts the nearest dept head who is not the initiator in their place', async () => {
    const dh = (ids: number[], extra: Partial<WfReviewNode> = {}) =>
      ctxOf([
        review('r1', {
          ...users(...ids),
          sign: 'ordered',
          whenInitiatorIsReviewer: 'deptHead',
          ...extra,
        }),
      ])
    const order = (r: Awaited<ReturnType<typeof run>>) => r.tasks.map((t) => t.assigneeId)
    // user 4 in dept 3 → head 3, at the initiator's place
    expect(order(await run(dh([5, 4, 1])))).toEqual([5, 3, 1])
    // the head is listed already: once
    expect(order(await run(dh([3, 4])))).toEqual([3])
    // user 3 heads dept 3 → the head above (2)
    expect(order(await run(dh([3, 5]), { initiatorId: 3 }))).toEqual([2, 5])
    // user 9's dept has no head, user 7 has no dept: nobody left → whenNobody
    expect(
      order(await run(dh([9], { whenNobody: 'toUser', fallbackUserId: 8 }), { initiatorId: 9 })),
    ).toEqual([8])
    expect(order(await run(dh([7, 5]), { initiatorId: 7 }))).toEqual([5])
  })

  it('超时节点的任务带 dueAt', async () => {
    const timeout = { hours: 24, remindEvery: 4 }
    const r = await run(
      ctxOf([
        review('r1', { timeout }),
        review('r2', { sign: 'ordered', timeout, ...users(3, 5) }),
      ]),
    )
    expect(r.taskOf(2).dueAt).toEqual(new Date(T0.getTime() + 24 * HOUR))
    const later = new Date(T0.getTime() + 2 * HOUR)
    await r.approve(r.taskOf(2), later)
    // ordered: a waiting reviewer's clock starts when their turn comes
    expect(r.tasks.slice(1).map((t) => [t.assigneeId, t.state, t.dueAt])).toEqual([
      [3, 'pending', new Date(later.getTime() + 24 * HOUR)],
      [5, 'waiting', null],
    ])
    const last = new Date(T0.getTime() + 5 * HOUR)
    await r.approve(r.taskOf(3), last)
    expect(r.taskOf(5).dueAt).toEqual(new Date(last.getTime() + 24 * HOUR))
  })

  it('moveToken into begin gives the initiator a begin task (send back to the initiator)', async () => {
    const ctx = ctxOf([review('r1', { timeout: { hours: 1 } })])
    const r = await run(ctx)
    const set = emptyChangeSet()
    await moveToken(ctx, r.instance, set, { from: 'r1', to: 'begin', fromTaskId: 1 })
    expect(set.newTasks).toEqual([
      {
        nodeId: 'begin',
        nodeName: 'Begin',
        assigneeId: 4,
        ownerId: null,
        parentTaskId: null,
        fromTaskId: 1,
        signKind: null,
        seq: 0,
        state: 'pending',
        dueAt: null,
      },
    ])
    expect(set.instance).toEqual({ activeNodeIds: ['begin'] })
  })

  it('moveToken: a second move in one change set keeps the active nodes the first move left', async () => {
    const ctx = ctxOf([review('r1'), review('r2', users(3))])
    const r = await run(ctx)
    const set = emptyChangeSet()
    set.instance.activeNodeIds = ['x', 'r1']
    await moveToken(ctx, r.instance, set, { from: 'r1', to: 'r2', fromTaskId: 1 })
    expect(set.instance.activeNodeIds).toEqual(['x', 'r2'])
  })
})
