import { describe, expect, it } from 'vitest'
import {
  byAmount,
  chain,
  ctxOf,
  notify,
  parallel,
  review,
  run,
  users,
} from '../../../../test/fixtures/wf/flow.js'

const after = () => review('after', users(8))

describe('wf parallel', () => {
  it.each([
    ['a first', 1, 3],
    ['b first', 3, 1],
  ])('并行两路都通过才汇合 (%s)', async (_, first, last) => {
    const r = await run(
      ctxOf([parallel('p', [review('a', users(1)), review('b', users(3))], after())]),
    )
    expect(r.pending()).toEqual([
      ['a', 1],
      ['b', 3],
    ])
    expect(r.instance.activeNodeIds).toEqual(['a', 'b'])
    await r.approve(r.taskOf(first))
    expect(r.pending()).toEqual([first === 1 ? ['b', 3] : ['a', 1]])
    expect(r.instance.activeNodeIds).toEqual([first === 1 ? 'b' : 'a'])
    const joining = r.taskOf(last)
    await r.approve(joining)
    expect(r.pending()).toEqual([['after', 8]])
    expect(r.instance.activeNodeIds).toEqual(['after'])
    // the task that finished last moved the token past the join
    expect(r.taskOf(8).fromTaskId).toBe(joining.id)
    await r.approve(r.taskOf(8))
    expect(r.instance.state).toBe('approved')
  })

  it('parallel: a path of several nodes; the join waits for its last node', async () => {
    const r = await run(
      ctxOf([
        review('r0', users(5)),
        parallel(
          'p',
          [
            chain(review('a1', users(1)), notify('n', 7), review('a2', users(2))),
            review('b', users(3)),
          ],
          after(),
        ),
      ]),
    )
    const r0 = r.taskOf(5)
    await r.approve(r0)
    // every path gets its tokens from the task that entered the fork
    expect(r.open().map((t) => [t.nodeId, t.fromTaskId])).toEqual([
      ['a1', r0.id],
      ['b', r0.id],
    ])
    await r.approve(r.taskOf(3))
    await r.approve(r.taskOf(1))
    expect(r.ccs.map((c) => [c.nodeId, c.userId])).toEqual([['n', 7]])
    expect(r.pending()).toEqual([['a2', 2]])
    expect(r.instance.activeNodeIds).toEqual(['a2'])
    await r.approve(r.taskOf(2))
    expect(r.pending()).toEqual([['after', 8]])
  })

  it('parallel as the last node: approved only once every path is done', async () => {
    const r = await run(ctxOf([parallel('p', [review('a', users(1)), review('b', users(3))])]))
    await r.approve(r.taskOf(3))
    expect(r.instance).toMatchObject({ state: 'running', activeNodeIds: ['a'] })
    expect(r.endedAt()).toBeUndefined()
    await r.approve(r.taskOf(1))
    expect(r.instance).toMatchObject({ state: 'approved', activeNodeIds: [] })
    expect(r.endedAt()).toBeDefined()
  })

  it('包容命中两路 / 都不命中走 fallback', async () => {
    const ctx = ctxOf([
      byAmount(
        'i',
        'inclusive',
        [
          [100, review('x', users(1))],
          [1000, review('y', users(3))],
        ],
        review('z', users(5)),
        after(),
      ),
    ])
    const both = await run(ctx, { formValues: { amount: 5000 } })
    expect(both.pending()).toEqual([
      ['x', 1],
      ['y', 3],
    ])
    expect(both.instance.activeNodeIds).toEqual(['x', 'y'])
    await both.approve(both.taskOf(3))
    expect(both.pending()).toEqual([['x', 1]])
    await both.approve(both.taskOf(1))
    expect(both.pending()).toEqual([['after', 8]])

    expect((await run(ctx, { formValues: { amount: 500 } })).pending()).toEqual([['x', 1]])

    const none = await run(ctx, { formValues: { amount: 5 } })
    expect(none.pending()).toEqual([['z', 5]])
    await none.approve(none.taskOf(5))
    expect(none.pending()).toEqual([['after', 8]])
  })

  it('inclusive: a matching empty path joins at once; nothing matching and an empty fallback goes on', async () => {
    const ctx = ctxOf([
      byAmount(
        'i',
        'inclusive',
        [
          [100, undefined],
          [1000, review('y', users(3))],
        ],
        undefined,
        after(),
      ),
    ])
    expect((await run(ctx, { formValues: { amount: 500 } })).pending()).toEqual([['after', 8]])
    expect((await run(ctx, { formValues: { amount: 5 } })).pending()).toEqual([['after', 8]])
    const r = await run(ctx, { formValues: { amount: 5000 } })
    expect(r.pending()).toEqual([['y', 3]])
    await r.approve(r.taskOf(3))
    expect(r.pending()).toEqual([['after', 8]])
  })

  it('parallel: an empty path (or one that passes by itself) never holds the join', async () => {
    const passes = review('auto', users(6))
    for (const paths of [
      [undefined, review('b', users(3))],
      [review('b', users(3)), undefined],
      [passes, review('b', users(3))],
    ]) {
      const r = await run(ctxOf([parallel('p', paths, after())]))
      expect(r.pending()).toEqual([['b', 3]])
      expect(r.instance.activeNodeIds).toEqual(['b'])
      await r.approve(r.taskOf(3))
      expect(r.pending()).toEqual([['after', 8]])
    }
    const empty = await run(ctxOf([parallel('p', [undefined, passes], after())]))
    expect(empty.pending()).toEqual([['after', 8]])
    expect(empty.events.map((e) => [e.action, e.nodeId])).toEqual([
      ['begin', 'begin'],
      ['approve', 'auto'],
    ])
    expect((await run(ctxOf([parallel('p', [undefined, undefined])]))).instance.state).toBe(
      'approved',
    )
  })

  it.each([
    ['inner paths first', [1, 3, 2, 5]],
    ['outer path first', [2, 1, 3, 5]],
  ])(
    'nested parallel: the inner fork joins on its own paths, the outer on all of its (%s)',
    async (_, order) => {
      const r = await run(
        ctxOf([
          parallel(
            'out',
            [
              parallel(
                'in',
                [review('a1', users(1)), review('a2', users(3))],
                review('a3', users(5)),
              ),
              review('b', users(2)),
            ],
            after(),
          ),
        ]),
      )
      expect(r.instance.activeNodeIds).toEqual(['a1', 'a2', 'b'])
      const seen: string[][] = []
      for (const user of order) {
        await r.approve(r.taskOf(user))
        seen.push([...r.instance.activeNodeIds])
      }
      expect(seen).toEqual(
        order[0] === 1
          ? // a3 starts while b still runs; b then waits for a3
            [['a2', 'b'], ['b', 'a3'], ['a3'], ['after']]
          : // b waits for the inner paths, nested one level down
            [['a1', 'a2'], ['a2'], ['a3'], ['after']],
      )
    },
  )

  it('nested: an exclusive fork inside a parallel path, a parallel fork inside an exclusive path', async () => {
    const exInPar = ctxOf([
      parallel(
        'p',
        [
          byAmount('ex', 'exclusive', [[100, review('big', users(1))]], review('small', users(3))),
          review('b', users(2)),
        ],
        after(),
      ),
    ])
    const r = await run(exInPar, { formValues: { amount: 500 } })
    expect(r.pending()).toEqual([
      ['big', 1],
      ['b', 2],
    ])
    await r.approve(r.taskOf(1))
    expect(r.pending()).toEqual([['b', 2]])
    await r.approve(r.taskOf(2))
    expect(r.pending()).toEqual([['after', 8]])

    const parInEx = ctxOf([
      byAmount(
        'ex',
        'exclusive',
        [[100, parallel('p', [review('a', users(1)), review('b', users(3))])]],
        review('small', users(5)),
        after(),
      ),
    ])
    const s = await run(parInEx, { formValues: { amount: 500 } })
    expect(s.pending()).toEqual([
      ['a', 1],
      ['b', 3],
    ])
    await s.approve(s.taskOf(1))
    expect(s.pending()).toEqual([['b', 3]])
    await s.approve(s.taskOf(3))
    expect(s.pending()).toEqual([['after', 8]])
  })

  it('two forks in a row: the second joins on its own tokens only', async () => {
    const r = await run(
      ctxOf([
        parallel(
          'p1',
          [review('a', users(1)), review('b', users(3))],
          parallel('p2', [review('c', users(5)), review('d', users(2))], after()),
        ),
      ]),
    )
    await r.approve(r.taskOf(1))
    await r.approve(r.taskOf(3))
    expect(r.instance.activeNodeIds).toEqual(['c', 'd'])
    await r.approve(r.taskOf(5))
    expect(r.pending()).toEqual([['d', 2]])
    await r.approve(r.taskOf(2))
    expect(r.pending()).toEqual([['after', 8]])
  })
})
