import type { WfCondition, WfFields, WfInitiatorCtx, WfOp } from '@qiwu/shared'
import { matchWhen } from './condition.js'

const fields: WfFields = {
  amount: 'number',
  title: 'string',
  startAt: 'date',
  owner: 'user',
  dept: 'dept',
}
const values = {
  amount: 100,
  title: 'Trip to Hangzhou',
  // 01:00 UTC
  startAt: '2026-03-01T09:00:00+08:00',
  owner: 12,
  dept: 4,
}
const ctx: WfInitiatorCtx = { deptTreePath: '/1/4/7/', roleIds: [3, 5] }

const c = (field: string, op: WfOp, value: unknown) => ({ field, op, value }) as WfCondition
const match = (
  when: WfCondition | WfCondition[][],
  formValues: Record<string, unknown> = values,
  initiatorCtx: WfInitiatorCtx = ctx,
) => matchWhen(Array.isArray(when) ? when : [[when]], fields, { formValues, initiatorCtx })

describe('wf condition evaluator', () => {
  it.each([
    ['eq', 100, true],
    ['eq', 99, false],
    ['ne', 99, true],
    ['ne', 100, false],
    ['gt', 99, true],
    ['gt', 100, false],
    ['gte', 100, true],
    ['gte', 101, false],
    ['lt', 101, true],
    ['lt', 100, false],
    ['lte', 100, true],
    ['lte', 99, false],
    ['in', [1, 100], true],
    ['in', [1, 2], false],
  ] as const)('number %s %j → %s', (op, value, want) => {
    expect(match(c('amount', op, value))).toBe(want)
  })

  it.each([
    ['eq', 'Trip to Hangzhou', true],
    ['eq', 'trip to hangzhou', false],
    ['ne', 'Other', true],
    ['ne', 'Trip to Hangzhou', false],
    ['in', ['A', 'Trip to Hangzhou'], true],
    ['in', ['A', 'B'], false],
    ['contains', 'Hang', true],
    ['contains', 'hang', false],
    ['contains', '', false],
  ] as const)('string %s %j → %s', (op, value, want) => {
    expect(match(c('title', op, value))).toBe(want)
  })

  it.each([
    // instants, not strings: the value is 01:00 UTC although its text reads 09:00
    ['eq', '2026-03-01T01:00:00Z', true],
    ['ne', '2026-03-01T01:00:00Z', false],
    ['gt', '2026-03-01T02:00:00Z', false],
    ['lt', '2026-03-01T02:00:00Z', true],
    ['gte', '2026-03-01', true],
    ['lte', '2026-03-01', false],
    ['gt', '2026-02-28T23:59:59-02:00', false],
    ['lt', '2026-03-02', true],
  ] as const)('date %s %j → %s', (op, value, want) => {
    expect(match(c('startAt', op, value))).toBe(want)
  })

  it('a bare date form value compares as 00:00 UTC', () => {
    const v = { ...values, startAt: '2026-03-01' }
    expect(match(c('startAt', 'eq', '2026-03-01T00:00:00Z'), v)).toBe(true)
    expect(match(c('startAt', 'lt', '2026-03-01T08:00:00+08:00'), v)).toBe(false)
  })

  it.each([
    ['owner', 'eq', 12, true],
    ['owner', 'ne', 12, false],
    ['owner', 'in', [3, 12], true],
    ['owner', 'in', [3], false],
    ['dept', 'eq', 4, true],
    ['dept', 'ne', 5, true],
    ['dept', 'in', [5, 6], false],
  ] as const)('%s %s %j → %s', (field, op, value, want) => {
    expect(match(c(field, op, value))).toBe(want)
  })

  it('a missing or mistyped form value matches no op, ne included', () => {
    for (const formValues of [
      {},
      { amount: null },
      { amount: '100' },
      { amount: Number.NaN },
      Object.create({ amount: 100 }) as Record<string, unknown>,
    ]) {
      for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const)
        expect(match(c('amount', op, 5), formValues)).toBe(false)
      expect(match(c('amount', 'in', [100]), formValues)).toBe(false)
    }
    expect(match(c('owner', 'ne', 3), { owner: 1.5 })).toBe(false)
    expect(match(c('owner', 'ne', 3), { owner: '12' })).toBe(false)
    expect(match(c('title', 'contains', 'a'), { title: ['a'] })).toBe(false)
    // not a calendar date (Date.parse would roll it over to 2 March)
    expect(match(c('startAt', 'gt', '2026-03-01'), { startAt: '2026-02-30' })).toBe(false)
    expect(match(c('startAt', 'ne', '2026-03-01'), { startAt: 'March 2' })).toBe(false)
  })

  it('a condition value not of the field type never matches', () => {
    expect(match(c('amount', 'ne', '5'))).toBe(false)
    expect(match(c('amount', 'in', ['100']))).toBe(false)
    expect(match(c('amount', 'in', 100))).toBe(false)
    expect(match(c('owner', 'ne', 0))).toBe(false)
    expect(match(c('startAt', 'ne', 'yesterday'))).toBe(false)
    expect(match(c('title', 'contains', 5))).toBe(false)
  })

  it('an op the field type does not take, or an unknown field, never matches', () => {
    // lexically 'Trip…' > 'A', yet strings have no order
    expect(match(c('title', 'gt', 'A'))).toBe(false)
    expect(match(c('amount', 'contains', 1))).toBe(false)
    expect(match(c('startAt', 'in', ['2026-03-01T01:00:00Z']))).toBe(false)
    expect(match(c('dept', 'inDeptTree', [4]))).toBe(false)
    expect(match(c('owner', 'hasRole', [12]))).toBe(false)
    expect(match(c('nope', 'ne', 1), { nope: 2 })).toBe(false)
    expect(match(c('constructor', 'ne', 'x'), { constructor: 'y' })).toBe(false)
  })

  it('OR of AND groups', () => {
    const big = c('amount', 'gt', 50)
    const trip = c('title', 'contains', 'Trip')
    const mine = c('owner', 'eq', 99)
    expect(match([[big, trip]])).toBe(true)
    expect(match([[big, trip, mine]])).toBe(false)
    expect(match([[big, mine], [trip]])).toBe(true)
    expect(match([[mine], [c('amount', 'lt', 50)]])).toBe(false)
    // fallback / parallel paths have no conditions; an empty group is no wildcard
    expect(match([])).toBe(false)
    expect(match([[]])).toBe(false)
    expect(match([[], [mine]])).toBe(false)
  })

  it('发起人部门子树命中 / 不命中', () => {
    const inTree = (ids: unknown, path: string | null = '/1/4/7/') =>
      match(c('$initiator.dept', 'inDeptTree', ids), values, { ...ctx, deptTreePath: path })
    expect(inTree([4])).toBe(true) // ancestor
    expect(inTree([7])).toBe(true) // own dept
    expect(inTree([99, 1])).toBe(true) // any listed dept
    expect(inTree([8])).toBe(false)
    expect(inTree([7], '/1/4/')).toBe(false) // a sub-dept's subtree does not hold its parent
    expect(inTree([2, 3], '/1/23/')).toBe(false) // whole ids only
    expect(inTree([23], '/1/23/')).toBe(true)
    expect(inTree([1], null)).toBe(false) // no dept
    expect(inTree(['4', '1/4'])).toBe(false) // ids only
    expect(inTree(4)).toBe(false)
  })

  it('发起人角色命中', () => {
    const hasRole = (ids: unknown, roleIds = [3, 5]) =>
      match(c('$initiator.roles', 'hasRole', ids), values, { ...ctx, roleIds })
    expect(hasRole([5])).toBe(true)
    expect(hasRole([9, 3])).toBe(true) // any one held
    expect(hasRole([1, 2])).toBe(false)
    expect(hasRole([3], [])).toBe(false)
    expect(hasRole(['3'])).toBe(false)
    expect(hasRole(3)).toBe(false)
  })

  it('each initiator key takes only its own op and reads only the start-time snapshot', () => {
    // 3 is a held role, 4 an ancestor dept: each would match under the other key
    expect(match(c('$initiator.dept', 'hasRole', [3]))).toBe(false)
    expect(match(c('$initiator.roles', 'inDeptTree', [4]))).toBe(false)
    expect(match(c('$initiator.dept', 'eq', 4))).toBe(false)
    expect(match(c('$initiator.dept', 'in', [4]))).toBe(false)
    // a form value under the same key is not the initiator
    expect(match(c('$initiator.roles', 'hasRole', [9]), { '$initiator.roles': [9] })).toBe(false)
  })

  it('is pure: frozen inputs, same answer every time', () => {
    const when = Object.freeze([
      Object.freeze([
        Object.freeze(c('$initiator.dept', 'inDeptTree', Object.freeze([4]))),
        Object.freeze(c('$initiator.roles', 'hasRole', Object.freeze([5]))),
        Object.freeze(c('amount', 'in', Object.freeze([100]))),
      ]),
    ])
    const instance = Object.freeze({
      formValues: Object.freeze({ ...values }),
      initiatorCtx: Object.freeze({
        deptTreePath: '/1/4/7/',
        roleIds: Object.freeze([3, 5]) as number[],
      }),
    })
    const before = JSON.stringify(instance)
    expect(matchWhen(when, Object.freeze({ ...fields }), instance)).toBe(true)
    expect(matchWhen(when, fields, instance)).toBe(true)
    expect(JSON.stringify(instance)).toBe(before)
  })
})
