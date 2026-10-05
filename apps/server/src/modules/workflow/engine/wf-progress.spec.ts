import type { WfChangeSet, WfNodeProgress } from '@qiwu/shared'
import { describe, expect, it } from 'vitest'
import {
  byAmount,
  ctxOf,
  fields,
  parallel,
  review,
  run,
  T0,
  users,
} from '../../../../test/fixtures/wf/flow.js'
import { approve, reject, sendBack } from './actions.js'
import { cancel } from './lifecycle.js'
import { progressOf } from './progress.js'

// begin → r0 (5 or 6) → x: amount > 1000 → big / else (empty) → p: a ∥ b → z
const ctx = ctxOf([
  review('r0', users(5, 6)),
  byAmount('x', 'exclusive', [[1000, review('big', users(6))]], undefined),
  parallel('p', [review('a', users(1)), review('b', users(3))]),
  review('z', users(8)),
])

async function setup() {
  const r = await run(ctx, { formValues: { amount: 50 } })
  const act = async (set: Promise<WfChangeSet>) => r.apply(await set, T0)
  const args = (u: number) => [ctx, r.instance, r.tasks, r.taskOf(u)] as const
  return {
    r,
    approve: (u: number) => act(approve(...args(u), { comment: null })),
    reject: (u: number) => act(reject(...args(u), { comment: null })),
    sendBack: (u: number, to: string) => act(sendBack(...args(u), { to, comment: null })),
    cancel: () => act(Promise.resolve(cancel(ctx, r.instance, r.tasks, { comment: null }))),
    progress: () => progressOf(ctx.flow, fields, r.instance, r.tasks),
  }
}

/** every node and path id with its progress, in tree order */
const ORDER = ['begin', 'r0', 'x', 'x-0', 'big', 'x-else', 'p', 'p-0', 'a', 'p-1', 'b', 'z']
const sorted = (p: Record<string, WfNodeProgress>) =>
  Object.fromEntries(ORDER.map((id) => [id, p[id]]))

describe('wf progress', () => {
  it('running: done before the tokens, both parallel paths active at once, pending after', async () => {
    const h = await setup()
    expect(sorted(h.progress())).toEqual({
      begin: 'done',
      r0: 'active',
      x: 'pending',
      'x-0': 'pending',
      big: 'pending',
      'x-else': 'pending',
      p: 'pending',
      'p-0': 'pending',
      a: 'pending',
      'p-1': 'pending',
      b: 'pending',
      z: 'pending',
    })
    await h.approve(5)
    expect(sorted(h.progress())).toEqual({
      begin: 'done',
      r0: 'done',
      x: 'done',
      'x-0': 'skipped',
      big: 'skipped',
      'x-else': 'done',
      p: 'active',
      'p-0': 'done',
      a: 'active',
      'p-1': 'done',
      b: 'active',
      z: 'pending',
    })
    // one path finished, the join waits for the other
    await h.approve(1)
    expect(h.progress()).toMatchObject({ a: 'done', b: 'active', p: 'active', z: 'pending' })
    await h.approve(3)
    expect(h.progress()).toMatchObject({ a: 'done', b: 'done', p: 'done', z: 'active' })
    await h.approve(8)
    expect(h.r.instance.state).toBe('approved')
    expect(sorted(h.progress())).toEqual({
      begin: 'done',
      r0: 'done',
      x: 'done',
      'x-0': 'skipped',
      big: 'skipped',
      'x-else': 'done',
      p: 'done',
      'p-0': 'done',
      a: 'done',
      'p-1': 'done',
      b: 'done',
      z: 'done',
    })
  })

  it('rejected on a parallel path: both open paths stopped, the `any` node one approved done', async () => {
    const h = await setup()
    await h.approve(5)
    await h.reject(1)
    expect(h.r.instance.state).toBe('rejected')
    expect(h.progress()).toMatchObject({
      r0: 'done',
      'x-else': 'done',
      p: 'stopped',
      a: 'stopped',
      b: 'stopped',
      z: 'pending',
    })
  })

  it('sent back to the initiator: begin active, the rest pending; canceled there: begin stopped', async () => {
    const h = await setup()
    await h.sendBack(5, 'begin')
    expect(h.progress()).toMatchObject({
      begin: 'active',
      r0: 'pending',
      p: 'pending',
      a: 'pending',
    })
    await h.cancel()
    expect(h.r.instance.state).toBe('canceled')
    // r0's canceled round lies after begin: pending, never a stop of its own
    expect(h.progress()).toMatchObject({ begin: 'stopped', r0: 'pending', z: 'pending' })
  })
})
