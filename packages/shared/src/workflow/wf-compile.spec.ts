import { describe, expect, it } from 'vitest'
import { compile, type WfCompileError } from './wf-compile.js'
import {
  WF_JSON_DEPTH_MAX,
  WF_JSON_VALUES_MAX,
  WF_NODES_MAX,
  WF_TIMEOUT_ACTIONS,
  wfBeginConfig,
  wfFields,
  wfNotifyConfig,
  wfPerms,
  wfReviewConfig,
  type WfBeginNode,
  type WfCondition,
  type WfForkNode,
  type WfForkPath,
  type WfNotifyNode,
  type WfReviewNode,
  type WfStep,
} from './wf.schema.js'

const fields = {
  days: 'number',
  kind: 'string',
  startAt: 'date',
  approver: 'user',
  ownerDept: 'dept',
} as const

const review = (id: string, extra: Partial<WfReviewNode> = {}): WfReviewNode => ({
  id,
  type: 'review',
  name: id,
  assignee: { kind: 'users', ids: [1] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
  ...extra,
})
const notify = (id: string, extra: Partial<WfNotifyNode> = {}): WfNotifyNode => ({
  id,
  type: 'notify',
  name: id,
  assignee: { kind: 'initiator' },
  ...extra,
})
const path = (id: string, when: WfCondition[][] = [], extra: Partial<WfForkPath> = {}) => ({
  id,
  name: id,
  when,
  ...extra,
})
const fork = (id: string, paths: WfForkPath[], extra: Partial<WfForkNode> = {}): WfForkNode => ({
  id,
  type: 'fork',
  name: id,
  paths,
  ...extra,
})
const tree = (next?: WfStep): WfBeginNode => ({ id: 'begin', type: 'begin', name: 'Begin', next })
const cond = (field: string, op: WfCondition['op'], value: unknown) =>
  ({ field, op, value }) as WfCondition
/** exclusive fork: `[cond] → child` plus an empty fallback */
const branch = (c: WfCondition, child?: WfStep) =>
  tree(fork('f', [path('p1', [[c]], { child }), path('p2', [], { fallback: true })]))

/** a node as its BPMN `qw:Config` body: without id, type and name */
const configOf = ({ id: _i, type: _t, name: _n, ...rest }: WfStep | WfBeginNode) => rest
const errorsOf = (t: unknown, f: Record<string, string> = fields) => {
  const r = compile(t, f as typeof fields)
  return r.ok ? [] : r.errors.map(({ code, id, path: at }: WfCompileError) => ({ code, id, at }))
}
const codes = (t: unknown, f?: Record<string, string>) => errorsOf(t, f).map((e) => e.code)
/** each condition with the codes compiling it in a branch gives (or, with `want`, the expected ones) */
const outcomes = (cs: WfCondition[], want?: string | null) =>
  cs.map((c) => [c, want === undefined ? codes(branch(c)) : want ? [want] : []])

describe('compile', () => {
  it('indexes nodes and fork paths of a valid tree', () => {
    const t = tree(review('lead', { timeout: { hours: 24, remindEvery: 4 }, resubmitTo: 'sender' }))
    t.next!.next = fork('f', [
      path('long', [[cond('days', 'gt', 5)], [cond('$initiator.roles', 'hasRole', [3])]], {
        child: fork(
          'both',
          [path('a', [], { child: review('hr') }), path('b', [], { child: review('boss') })],
          { mode: 'parallel' },
        ),
      }),
      path('dept', [[cond('$initiator.dept', 'inDeptTree', [2, 7])]], { child: review('head') }),
      path('rest', [], { fallback: true }),
    ])
    t.next!.next.next = notify('cc')
    const r = compile({ ...t, extra: 'dropped' }, fields)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    const { nodes, paths, root } = r.flow
    expect([...nodes.keys()]).toEqual(['begin', 'lead', 'f', 'both', 'hr', 'boss', 'head', 'cc'])
    expect(root).not.toHaveProperty('extra')
    expect(nodes.get('begin')).toMatchObject({ parentPathId: null, next: 'lead' })
    expect(nodes.get('f')).toMatchObject({ parentPathId: null, next: 'cc' })
    expect(nodes.get('both')).toMatchObject({ parentPathId: 'long', next: null })
    expect(nodes.get('hr')).toMatchObject({ parentPathId: 'a', next: null })
    expect(nodes.get('cc')).toMatchObject({ parentPathId: null, next: null })
    expect(nodes.get('lead')!.node).toMatchObject({ timeout: { hours: 24, remindEvery: 4 } })
    expect(paths.get('b')).toMatchObject({ forkId: 'both' })
    expect(paths.get('rest')).toMatchObject({ forkId: 'f', path: { fallback: true } })
    expect(paths.get('rest')!.path.child).toBeUndefined()
  })

  it('compile 拒绝不存在/类型不符的条件字段', () => {
    expect(errorsOf(branch(cond('missing', 'eq', 1)))).toEqual([
      { code: 'unknown_field', id: 'p1', at: ['next', 'paths', 0, 'when', 0, 0, 'field'] },
    ])
    for (const field of ['constructor', '__proto__', '$initiator.user'])
      expect(codes(branch(cond(field, 'eq', 1)))).toEqual(['unknown_field'])
    // a field whose declared type is not a known one counts as missing
    expect(codes(branch(cond('odd', 'eq', 1)), { odd: 'json' })).toEqual(['unknown_field'])
    // `$` names are initiator keys: never taken from `fields`
    expect(codes(branch(cond('$x', 'eq', 1)), { ...fields, $x: 'number' })).toEqual([
      'unknown_field',
    ])
    expect(wfFields.safeParse({ $x: 'number' }).success).toBe(false)
    expect(wfFields.safeParse(fields).success).toBe(true)

    const opMismatch = [
      cond('kind', 'gt', 'a'),
      cond('days', 'contains', '1'),
      cond('startAt', 'in', ['2026-01-01']),
      cond('approver', 'gt', 3),
      // the initiator ops never go with a form field, whatever its type
      ...Object.keys(fields).flatMap((f) =>
        (['inDeptTree', 'hasRole'] as const).map((op) => cond(f, op, [1])),
      ),
      cond('$initiator.dept', 'eq', [1]),
      cond('$initiator.dept', 'hasRole', [1]),
      cond('$initiator.roles', 'inDeptTree', [1]),
    ]
    expect(outcomes(opMismatch)).toEqual(outcomes(opMismatch, 'op_mismatch'))

    const valueMismatch = [
      cond('days', 'eq', 'five'),
      cond('days', 'in', []),
      cond('days', 'in', ['1', '2']),
      cond('kind', 'eq', 3),
      cond('kind', 'contains', ''),
      // a string condition not filled in (the builder starts one blank)
      cond('kind', 'eq', ''),
      cond('kind', 'ne', ''),
      cond('kind', 'in', ['annual', '']),
      cond('startAt', 'gt', 'yesterday'),
      cond('startAt', 'lt', '2026-02-30'),
      cond('approver', 'eq', 0),
      cond('ownerDept', 'in', [1.5]),
      cond('$initiator.dept', 'inDeptTree', []),
      cond('$initiator.dept', 'inDeptTree', 2),
      cond('$initiator.roles', 'hasRole', ['admin']),
    ]
    expect(outcomes(valueMismatch)).toEqual(outcomes(valueMismatch, 'value_mismatch'))

    const fine = [
      cond('days', 'lte', 2.5),
      cond('days', 'in', [1, 2]),
      cond('kind', 'in', ['annual', 'sick']),
      cond('kind', 'contains', 'ann'),
      cond('startAt', 'gte', '2026-01-01'),
      cond('startAt', 'lt', '2026-01-01T08:00:00+08:00'),
      cond('approver', 'eq', 9),
      cond('ownerDept', 'in', [1, 2]),
    ]
    expect(outcomes(fine)).toEqual(outcomes(fine, null))
  })

  it('needs exactly one fallback on exclusive and inclusive forks', () => {
    const c = [[cond('days', 'gt', 1)]]
    for (const mode of [undefined, 'exclusive', 'inclusive'] as const) {
      const noFallback = tree(fork('f', [path('a', c), path('b', c)], { mode }))
      expect(errorsOf(noFallback)).toEqual([
        { code: 'fallback_count', id: 'f', at: ['next', 'paths'] },
      ])
      const two = tree(
        fork('f', [path('a', [], { fallback: true }), path('b', [], { fallback: true })], { mode }),
      )
      expect(codes(two)).toEqual(['fallback_count'])
    }
    const conditionalFallback = tree(fork('f', [path('a', c), path('b', c, { fallback: true })]))
    expect(errorsOf(conditionalFallback)).toEqual([
      { code: 'fallback_when', id: 'b', at: ['next', 'paths', 1, 'when'] },
    ])
    const bare = tree(
      fork('f', [path('a'), path('b', [], { fallback: true })], { mode: 'inclusive' }),
    )
    expect(errorsOf(bare)).toEqual([
      { code: 'path_when_required', id: 'a', at: ['next', 'paths', 0, 'when'] },
    ])
  })

  it('takes parallel paths without conditions or fallback, at least two', () => {
    const ok = tree(fork('f', [path('a'), path('b')], { mode: 'parallel' }))
    expect(codes(ok)).toEqual([])
    const guarded = tree(
      fork('f', [path('a', [[cond('days', 'gt', 1)]]), path('b')], { mode: 'parallel' }),
    )
    expect(errorsOf(guarded)).toEqual([
      { code: 'parallel_path', id: 'a', at: ['next', 'paths', 0] },
    ])
    const fallback = tree(
      fork('f', [path('a'), path('b', [], { fallback: true })], { mode: 'parallel' }),
    )
    expect(errorsOf(fallback)).toEqual([
      { code: 'parallel_path', id: 'b', at: ['next', 'paths', 1] },
    ])
    for (const mode of ['parallel', 'exclusive'] as const) {
      const lone = errorsOf(tree(fork('f', [path('a', [], { fallback: true })], { mode })))
      expect(lone).toEqual([{ code: 'shape', id: 'f', at: ['next', 'paths'] }])
    }
  })

  it('rejects ids used twice across nodes and fork paths', () => {
    const t = tree(review('x'))
    t.next!.next = fork('f', [
      path('x', [[cond('days', 'gt', 1)]]),
      path('p', [], { fallback: true, child: review('f') }),
    ])
    expect(errorsOf(t)).toEqual([
      { code: 'duplicate_id', id: 'x', at: ['next', 'next', 'paths', 0, 'id'] },
      { code: 'duplicate_id', id: 'f', at: ['next', 'next', 'paths', 1, 'child', 'id'] },
    ])
    expect(codes(tree(review('begin')))).toEqual(['duplicate_id'])
  })

  it('checks assignee ids and form fields', () => {
    for (const kind of ['users', 'roles', 'positions', 'deptMembers', 'deptHead'] as const) {
      expect(codes(tree(review('r', { assignee: { kind } })))).toEqual(['assignee_ids'])
      expect(codes(tree(notify('n', { assignee: { kind, ids: [] } })))).toEqual(['assignee_ids'])
      expect(codes(tree(review('r', { assignee: { kind, ids: [4] } })))).toEqual([])
    }
    for (const kind of [
      'initiator',
      'initiatorPicks',
      'initiatorDeptHead',
      'deptHeadChain',
    ] as const)
      expect(codes(tree(review('r', { assignee: { kind, levels: 2 } })))).toEqual([])

    const byField = (kind: 'formFieldUser' | 'formFieldDeptHead', field?: string) =>
      codes(tree(review('r', { assignee: { kind, field } })))
    expect(byField('formFieldUser', 'approver')).toEqual([])
    expect(byField('formFieldDeptHead', 'ownerDept')).toEqual([])
    expect(byField('formFieldUser', 'ownerDept')).toEqual(['assignee_field'])
    expect(byField('formFieldDeptHead', 'approver')).toEqual(['assignee_field'])
    expect(byField('formFieldUser', 'nope')).toEqual(['assignee_field'])
    expect(byField('formFieldUser')).toEqual(['assignee_field'])
    expect(
      codes(
        tree(review('r', { assignee: { kind: 'formFieldDeptHead', field: '$initiator.dept' } })),
        {
          ...fields,
          '$initiator.dept': 'dept',
        },
      ),
    ).toEqual(['assignee_field'])
    expect(
      errorsOf(tree(notify('n', { assignee: { kind: 'formFieldUser', field: 'days' } }))),
    ).toEqual([{ code: 'assignee_field', id: 'n', at: ['next', 'assignee', 'field'] }])
  })

  it('needs a fallback user for whenNobody toUser', () => {
    expect(errorsOf(tree(review('r', { whenNobody: 'toUser' })))).toEqual([
      { code: 'fallback_user', id: 'r', at: ['next', 'fallbackUserId'] },
    ])
    expect(codes(tree(review('r', { whenNobody: 'toUser', fallbackUserId: 5 })))).toEqual([])
    expect(codes(tree(review('r', { whenNobody: 'toManager' })))).toEqual([])
  })

  it('takes whole positive hours as timeout', () => {
    const bad = [{ hours: 0 }, { hours: 1.5 }, { hours: 8761 }, { hours: 2, remindEvery: -1 }, {}]
    for (const timeout of bad) {
      const [e, ...rest] = errorsOf(tree(review('r', { timeout } as Partial<WfReviewNode>)))
      expect(rest).toEqual([])
      expect(e).toMatchObject({ code: 'shape', id: 'r' })
      expect(e.at.slice(0, 2)).toEqual(['next', 'timeout'])
    }
    const r = compile(tree(review('r', { timeout: { hours: 0 } })), fields)
    expect(r.ok ? null : r.errors[0].message).toEqual({
      key: 'validation.too_small.number_exclusive',
      params: { minimum: 0 },
    })
  })

  it('takes a timeout action of the three codes only; without one a tree compiles as before', () => {
    for (const action of WF_TIMEOUT_ACTIONS) {
      const r = compile(tree(review('r', { timeout: { hours: 4, action } })), fields)
      expect(r.ok && r.flow.nodes.get('r')!.node).toMatchObject({ timeout: { hours: 4, action } })
      const config = { ...configOf(review('r')), timeout: { hours: 4, action } }
      expect(wfReviewConfig.parse(config)).toEqual(config)
    }
    // `toManager` is whenNobody's code, `remind` the default spelled out: neither is a timeout action
    for (const action of ['remind', 'toUser', 'AUTOPASS', '', null, 1]) {
      const timeout = { hours: 4, action } as unknown as WfReviewNode['timeout']
      expect(errorsOf(tree(review('r', { timeout })))).toEqual([
        { code: 'shape', id: 'r', at: ['next', 'timeout', 'action'] },
      ])
      expect(wfReviewConfig.safeParse({ ...configOf(review('r')), timeout }).success).toBe(false)
    }
    const t = tree(review('r', { timeout: { hours: 24, remindEvery: 4 } }))
    const r = compile(structuredClone(t), fields)
    expect(r.ok && r.flow.nodes.get('r')!.node).toStrictEqual(t.next)
  })

  it('reports shape errors at the innermost node or path', () => {
    expect(errorsOf('nope')).toMatchObject([{ code: 'shape', id: null, at: [] }])
    expect(errorsOf({ ...review('r') })).toMatchObject([{ code: 'shape', id: 'r', at: ['type'] }])
    expect(errorsOf(tree({ ...tree(), id: 'b2' } as unknown as WfStep))).toMatchObject([
      { code: 'shape', id: 'b2', at: ['next', 'type'] },
    ])
    expect(errorsOf(tree(review('has space')))).toMatchObject([
      { code: 'shape', id: 'has space', at: ['next', 'id'] },
    ])
    const deep = branch(cond('days', 'gt', 1), review('deep', { sign: 'most' as 'any' }))
    expect(errorsOf(deep)).toMatchObject([
      { code: 'shape', id: 'deep', at: ['next', 'paths', 0, 'child', 'sign'] },
    ])
    const access = tree(
      review('r', { access: { id: 'write' } as unknown as WfReviewNode['access'] }),
    )
    expect(errorsOf(access)).toMatchObject([
      { code: 'shape', id: 'r', at: ['next', 'access', 'id'] },
    ])
    const emptyGroup = tree(fork('f', [path('p1', [[]]), path('p2', [], { fallback: true })]))
    expect(errorsOf(emptyGroup)).toMatchObject([
      { code: 'shape', id: 'p1', at: ['next', 'paths', 0, 'when', 0] },
    ])
    for (const ids of [[0], [-1], [1.5]])
      expect(errorsOf(tree(review('r', { assignee: { kind: 'users', ids } })))).toMatchObject([
        { code: 'shape', id: 'r', at: ['next', 'assignee', 'ids', 0] },
      ])
    const badValue = branch(cond('days', 'gt', { n: 1 }))
    expect(errorsOf(badValue)).toMatchObject([
      { code: 'shape', id: 'p1', at: ['next', 'paths', 0, 'when', 0, 0, 'value'] },
    ])
  })

  it('refuses trees too big or too deep to store, without overflowing the stack', () => {
    const chain = (n: number) => {
      const t = tree()
      let last: { next?: WfStep } = t
      for (let i = 0; i < n; i++) last = last.next = review(`r${i}`)
      return t
    }
    /** `n` parallel forks, each nested in the last one's first path, around one review */
    const nested = (n: number) => {
      let step: WfStep = review('leaf')
      for (let i = 0; i < n; i++)
        step = fork(`f${i}`, [path(`a${i}`, [], { child: step }), path(`b${i}`)], {
          mode: 'parallel',
        })
      return tree(step)
    }
    /** begin + a parallel fork of 18 paths with 11 reviews each (200 nodes) + `tail` notifies */
    const wide = (tail: number) => {
      const paths = Array.from({ length: 18 }, (_, p) => {
        const reviews = Array.from({ length: 11 }, (_, r) => review(`r${p}_${r}`))
        reviews.reduce((a, b) => (a.next = b))
        return path(`p${p}`, [], { child: reviews[0] })
      })
      const t = tree(fork('f', paths, { mode: 'parallel' }))
      for (let i = 0; i < tail; i++) t.next = { ...notify(`n${i}`), next: t.next }
      return t
    }
    /** `n` nested arrays */
    const deepArray = (n: number) => {
      let a: unknown = []
      for (let i = 1; i < n; i++) a = [a]
      return a
    }
    /** 2^n leaves through shared references */
    let dag: unknown = 0
    for (let i = 0; i < 20; i++) dag = [dag, dag]
    const cyclic = tree()
    cyclic.next = cyclic as unknown as WfStep

    // container depth: a review in a chain of n sits at n + 1, its assignee ids at n + 3;
    // the leaf of n nested forks at 3n + 2 (fork, paths, path per level), its ids at 3n + 4
    const fine = [chain(WF_JSON_DEPTH_MAX - 3), nested(32), wide(0)]
    fine.push({ ...tree(), x: deepArray(WF_JSON_DEPTH_MAX - 1) })
    // values: the root's id, type, name, next and x, then x's items
    const flat = (n: number) => ({ ...tree(), x: Array.from({ length: n - 5 }, () => 0) })
    fine.push(flat(WF_JSON_VALUES_MAX))
    for (const t of fine) expect(errorsOf(t)).toEqual([])
    const tooLarge = [{ code: 'too_large', id: null, at: [] }]
    for (const t of [
      chain(WF_JSON_DEPTH_MAX - 2),
      nested(33),
      wide(1),
      { ...tree(review('r')), x: deepArray(WF_JSON_DEPTH_MAX) },
      { ...tree(), x: deepArray(100_000) },
      { ...tree(), x: dag },
      flat(WF_JSON_VALUES_MAX + 1),
      chain(1000),
      nested(500),
      cyclic,
    ])
      expect(errorsOf(t)).toEqual(tooLarge)
    // wide() is sized for it
    expect(WF_NODES_MAX).toBe(2 + 18 * 11)
  })

  it('reports every rule broken, not only the first', () => {
    const t = tree(review('r', { whenNobody: 'toUser', assignee: { kind: 'roles' } }))
    t.next!.next = fork('f', [path('a', [[cond('x', 'eq', 1)]]), path('r')])
    expect(codes(t).sort()).toEqual(
      [
        'assignee_ids',
        'duplicate_id',
        'fallback_count',
        'fallback_user',
        'path_when_required',
        'unknown_field',
      ].sort(),
    )
  })

  it('names admin perms <domain>.<resource>.<verb> in the wf domain', () => {
    const all = Object.values(wfPerms).flatMap((r) => Object.values(r))
    expect(new Set(all).size).toBe(all.length)
    for (const p of all) expect(p).toMatch(/^wf\.[a-z]+\.[a-z-]+$/)
    expect(wfPerms.task.manage).toBe('wf.task.manage')
  })
})

describe('BPMN node configs', () => {
  it('take a node without id, type, name and next; nested extra keys are dropped', () => {
    const r = review('r', { timeout: { hours: 2, junk: 1 } as WfReviewNode['timeout'] })
    expect(wfReviewConfig.parse(configOf(r))).toEqual({ ...configOf(r), timeout: { hours: 2 } })
    expect(wfNotifyConfig.parse(configOf(notify('n')))).toEqual(configOf(notify('n')))
    expect(wfBeginConfig.parse({ access: { days: 'read' } })).toEqual({ access: { days: 'read' } })
    expect(wfBeginConfig.parse({})).toEqual({})
  })

  it('refuse next (a subtree the diagram does not show), id, type, name or any other key', () => {
    const hidden = { next: notify('cc42', { assignee: { kind: 'users', ids: [42] } }) }
    for (const extra of [hidden, { id: 'x' }, { type: 'review' }, { name: 'x' }, { junk: 1 }]) {
      expect(wfReviewConfig.safeParse({ ...configOf(review('r')), ...extra }).success).toBe(false)
      expect(wfNotifyConfig.safeParse({ ...configOf(notify('n')), ...extra }).success).toBe(false)
      expect(wfBeginConfig.safeParse(extra).success).toBe(false)
    }
  })
})
