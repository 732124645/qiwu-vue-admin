import { compile, type FormRule, type WfCompiled, type WfStep } from '@qiwu/shared'
import {
  checkInitiatorPicks,
  dictValuesOf,
  editableValues,
  pickNodes,
  readerAccess,
  visibleValues,
} from './form-values.js'

describe('field access', () => {
  const values = { a: 1, b: 2, c: 3, d: 4 }
  const access = { a: 'hide', b: 'read', c: 'edit' } as const

  it('visibleValues drops hide fields only', () => {
    expect(visibleValues(values, access)).toEqual({ b: 2, c: 3, d: 4 })
    expect(visibleValues(values)).toEqual(values)
  })

  it('readerAccess: hide from any step held, edit from the current step only, hide wins', () => {
    const begin = { a: 'edit', b: 'hide' } as const
    const done = { c: 'hide', d: 'edit' } as const
    const current = { a: 'edit', c: 'edit', e: 'edit', f: 'read' } as const
    expect(readerAccess([begin, done, undefined], current)).toEqual({
      a: 'edit',
      b: 'hide',
      c: 'hide',
      e: 'edit',
    })
    // no task (cc, admin): all read; a past step's edit gives nothing
    expect(readerAccess([])).toEqual({})
    expect(readerAccess([done])).toEqual({ c: 'hide' })
  })

  it('editableValues keeps edit fields only (unlisted, read, hide and inherited names dropped)', () => {
    expect(editableValues(values, access)).toEqual({ c: 3 })
    expect(editableValues(values)).toEqual({})
    expect(editableValues({ constructor: 1, toString: 2 }, {})).toEqual({})
  })

  it('dictValuesOf reads each dict a qw-dict-select names once, unknown dicts as none', async () => {
    const asked: string[] = []
    const entries = async (code: string) => {
      asked.push(code)
      return code === 'gone' ? null : { entries: [{ value: `${code}-1` }, { value: `${code}-2` }] }
    }
    const rule = (type: string, code?: string) =>
      ({ type, field: `f${asked.length}`, props: { code } }) as FormRule
    const dicts = await dictValuesOf(
      [
        rule('qw-dict-select', 'a'),
        rule('input'),
        rule('qw-dict-select', 'a'),
        rule('qw-dict-select', 'gone'),
        rule('qw-dict-select'),
      ],
      entries,
    )
    expect(dicts).toEqual(
      new Map([
        ['a', ['a-1', 'a-2']],
        ['gone', []],
      ]),
    )
    expect(asked).toEqual(['a', 'gone'])
  })
})

describe('initiatorPicks', () => {
  const review = (id: string, kind: 'users' | 'initiatorPicks', next?: WfStep): WfStep => ({
    id,
    type: 'review',
    name: id,
    assignee: kind === 'users' ? { kind, ids: [1] } : { kind },
    sign: 'any',
    whenNobody: 'autoPass',
    whenInitiatorIsReviewer: 'self',
    onReject: 'finish',
    next,
  })
  const flowOf = (next: WfStep): WfCompiled => {
    const r = compile({ id: 'begin', type: 'begin', name: 'begin', next }, {})
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return r.flow
  }
  // pick nodes inside fork paths, a notify node, and one called `constructor` (an inherited prop name)
  const flow = flowOf(
    review('r1', 'users', {
      id: 'f',
      type: 'fork',
      name: 'f',
      mode: 'parallel',
      paths: [
        { id: 'p1', name: 'p1', when: [], child: review('pickA', 'initiatorPicks') },
        {
          id: 'p2',
          name: 'p2',
          when: [],
          child: { id: 'ccPick', type: 'notify', name: 'cc', assignee: { kind: 'initiatorPicks' } },
        },
      ],
      next: review('constructor', 'initiatorPicks'),
    }),
  )
  // users 1–5 enabled; 9 disabled; others unknown
  const calls: number[][] = []
  const org = {
    enabledUsers: async (ids: readonly number[]) => {
      calls.push([...ids])
      return ids.filter((i) => i >= 1 && i <= 5).sort((a, b) => a - b)
    },
  }
  beforeEach(() => (calls.length = 0))

  it('pickNodes lists every initiatorPicks node, fork paths included', () => {
    expect(pickNodes(flow).map((n) => n.id)).toEqual(['pickA', 'ccPick', 'constructor'])
  })

  it('发起人自选缺失/未知用户被拒', async () => {
    expect(
      await checkInitiatorPicks(flow, { pickA: [], ccPick: [2, 9, 42], r1: [1] }, org),
    ).toEqual({
      ok: false,
      errors: [
        { nodeId: 'pickA', code: 'missing', userIds: [] },
        { nodeId: 'ccPick', code: 'unknown_user', userIds: [9, 42] },
        { nodeId: 'constructor', code: 'missing', userIds: [] },
      ],
    })
    expect(await checkInitiatorPicks(flow, undefined, org)).toMatchObject({
      ok: false,
      errors: [{ nodeId: 'pickA' }, { nodeId: 'ccPick' }, { nodeId: 'constructor' }],
    })
  })

  it('only positive integer ids reach the directory', async () => {
    const picks = { pickA: ['3', 2], ccPick: [1.5], constructor: [0] }
    expect(await checkInitiatorPicks(flow, picks, org)).toEqual({
      ok: false,
      errors: [
        { nodeId: 'pickA', code: 'unknown_user', userIds: ['3'] },
        { nodeId: 'ccPick', code: 'unknown_user', userIds: [1.5] },
        { nodeId: 'constructor', code: 'unknown_user', userIds: [0] },
      ],
    })
    expect(calls).toEqual([[2]])
  })

  it('valid picks pass, kept for the pick nodes only, in order without duplicates', async () => {
    const picks = { pickA: [3, 2, 3], ccPick: [4], constructor: [5], r1: [1], gone: [7] }
    expect(await checkInitiatorPicks(flow, picks, org)).toEqual({
      ok: true,
      picks: { pickA: [3, 2], ccPick: [4], constructor: [5] },
    })
    expect(calls).toEqual([[3, 2, 4, 5]])
  })

  it('a flow without pick nodes needs no picks and asks no directory', async () => {
    expect(await checkInitiatorPicks(flowOf(review('r1', 'users')), { r1: [9] }, org)).toEqual({
      ok: true,
      picks: {},
    })
    expect(calls).toEqual([])
  })
})
