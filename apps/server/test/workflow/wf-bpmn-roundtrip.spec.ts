// `treeToXml`. Tree → XML → the server's bpmn-moddle strict parse (0 warnings) →
// `bpmnToTree` gives the tree back — normalized: `mode` and an empty `when` filled in, `fallback: false` dropped —
// and `compile` takes it: the leave seed, the built-in templates, the engine fixtures and forks without
// `next` at a path's end (on the main line's tail: end events of their own; elsewhere: a join of their own).
import {
  bpmnPrecheck,
  bpmnToTree,
  compile,
  fieldsFromFormSchema,
  sanitizeFormSchema,
  treeToXml,
  WF_BPMN_MODDLE,
  type WfBeginNode,
  type WfFields,
  type WfForkPath,
  type WfStep,
} from '@qiwu/shared'
import { BpmnModdle } from 'bpmn-moddle'
import { WF_TEMPLATES } from '../../src/db/seeds/workflow/process-templates.seed.js'
import { LEAVE_FIELDS } from '../../src/modules/biz/leave/leave-wf.handler.js'
import { leaveTree } from '../../src/modules/biz/leave/leave.seed.js'
import { byAmount, chain, fields, notify, parallel, review } from '../fixtures/wf/flow.js'

const moddle = new BpmnModdle({ qw: WF_BPMN_MODDLE })
type El = {
  $type: string
  id: string
  bounds?: Box
  waypoint?: { x: number; y: number }[]
  sourceRef?: El
  targetRef?: El
}
type Box = { x: number; y: number; width: number; height: number }
type Defs = {
  rootElements: { flowElements: El[] }[]
  diagrams: { plane: { planeElement: (El & { bpmnElement: El })[] } }[]
}
async function parse(xml: string) {
  const { rootElement, warnings } = await moddle.fromXML(xml, 'bpmn:Definitions', { lax: false })
  expect(warnings).toEqual([])
  return rootElement as unknown as Defs
}

/** what `bpmnToTree` writes for what a tree may leave out */
function normalize(tree: WfBeginNode): WfBeginNode {
  const copy = structuredClone(tree)
  const steps: WfStep[] = copy.next ? [copy.next] : []
  while (steps.length) {
    const step = steps.pop()!
    if (step.next) steps.push(step.next)
    if (step.type !== 'fork') continue
    step.mode ??= 'exclusive'
    for (const path of step.paths) {
      path.when ??= []
      if (path.fallback === false) delete path.fallback
      if (path.child) steps.push(path.child)
    }
  }
  return copy
}

/** the block layout: no two shapes overlap, every edge runs horizontally / vertically, around other shapes */
function expectLayout(defs: Defs) {
  const di = defs.diagrams[0]!.plane.planeElement
  const boxes = di.filter((d) => d.bounds).map((d) => d.bounds!)
  expect(boxes).toHaveLength(
    defs.rootElements[0]!.flowElements.filter((e) => !e.$type.endsWith('Flow')).length,
  )
  boxes.forEach((a, i) =>
    boxes.slice(i + 1).forEach((b) => {
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y
      expect(apart).toBe(true)
    }),
  )
  for (const { waypoint } of di.filter((d) => d.waypoint?.length))
    waypoint!
      .slice(1)
      .forEach((p, i) => expect(p.x === waypoint![i]!.x || p.y === waypoint![i]!.y).toBe(true))
  // no edge runs through a shape other than its own two ends (an empty path keeps to its own row)
  const shapes = di.filter((d) => d.bounds)
  for (const { bpmnElement: flow, waypoint } of di.filter((d) => d.waypoint?.length)) {
    const ends = [flow.sourceRef!.id, flow.targetRef!.id]
    for (const { bpmnElement, bounds: s } of shapes.filter((d) => !ends.includes(d.bpmnElement.id)))
      waypoint!.slice(1).forEach((p, i) => {
        const q = waypoint![i]!
        const crosses =
          Math.min(p.x, q.x) < s!.x + s!.width &&
          Math.max(p.x, q.x) > s!.x &&
          Math.min(p.y, q.y) < s!.y + s!.height &&
          Math.max(p.y, q.y) > s!.y
        expect({ flow: flow.id, shape: bpmnElement.id, crosses }).toMatchObject({ crosses: false })
      })
  }
}

async function roundTrip(tree: WfBeginNode, flowFields: WfFields) {
  const xml = treeToXml(tree)
  expect(bpmnPrecheck(xml)).toBeNull()
  const defs = await parse(xml)
  const r = bpmnToTree(defs)
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`)
  expect(r.tree).toEqual(normalize(tree))
  expect(compile(r.tree, flowFields)).toMatchObject({ ok: true })
  expectLayout(defs)
  return { xml, ...r }
}

const begin = (next?: WfStep, extra: Partial<WfBeginNode> = {}): WfBeginNode => ({
  id: 'begin',
  type: 'begin',
  name: 'Begin',
  ...extra,
  ...(next && { next }),
})
/** what a tree may leave out or spell out: a `fallback: false`, the fallback path without `when` */
function loose() {
  const fork = byAmount(
    'x',
    'exclusive',
    [
      [1000, review('big')],
      [100, undefined],
    ],
    review('small'),
    review('after'),
  )
  fork.paths[0]!.fallback = false
  delete (fork.paths[2] as Partial<WfForkPath>).when
  return fork
}
const ids = (xml: string) => [...xml.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])

describe('treeToXml: the round trip', () => {
  it('the leave seed (exclusive on the main line tail, a parallel fork at a path end, an empty path)', async () => {
    const tree = leaveTree({ employee: 11, supervisor: 12, deputy: 13, director: 14, hr: 15 })
    const r = await roundTrip(tree, LEAVE_FIELDS)
    // no joins: every path of both forks ends in an end event of its own
    expect(r.joins).toEqual({})
    expect(r.xml.match(/<bpmn:endEvent /g)).toHaveLength(4)
  })

  it.each(WF_TEMPLATES.map((t) => [t.key, t] as const))(
    'the built-in template %s',
    async (_, tpl) => {
      const s = sanitizeFormSchema(tpl.schema)
      const f = s.ok ? fieldsFromFormSchema(s.schema) : undefined
      if (!f?.ok) throw new Error(`template ${tpl.key} has no fields`)
      expect((await roundTrip(tpl.tree, f.fields)).ok).toBe(true)
    },
  )

  it.each<[string, WfBeginNode]>([
    [
      'linear, every setting',
      begin(
        chain(
          review('r1'),
          notify('c1', 3, 4),
          review('r2', {
            sign: 'ordered',
            assignee: { kind: 'deptHeadChain', levels: 2 },
            whenNobody: 'toUser',
            fallbackUserId: 7,
            whenInitiatorIsReviewer: 'skip',
            onReject: 'sendBack',
            commentRequired: true,
            resubmitTo: 'sender',
            timeout: { hours: 4, remindEvery: 2, action: 'toManager' },
            access: { amount: 'read' },
          }),
        ),
        { access: { amount: 'edit' } },
      ),
    ],
    ['start straight to the end', begin()],
    [
      'exclusive with a join, an empty path, `fallback: false`, a path without `when`',
      begin(loose()),
    ],
    [
      'parallel with a join, a chain and an empty path',
      begin(
        parallel(
          'p',
          [review('a'), chain(review('b'), notify('c', 3))!, undefined],
          review('after'),
        ),
      ),
    ],
    [
      'inclusive on the main line tail',
      begin(
        byAmount(
          'i',
          'inclusive',
          [
            [10, review('i1')],
            [20, review('i2')],
          ],
          undefined,
        ),
      ),
    ],
    [
      'no mode in the tree (exclusive)',
      begin({ ...byAmount('m', 'exclusive', [[10, review('m1')]], review('m2')), mode: undefined }),
    ],
    [
      'nested: exclusive ⊃ parallel ⊃ inclusive, then a fork in a row',
      begin(
        chain(
          byAmount(
            'outer',
            'exclusive',
            [
              [
                100,
                parallel(
                  'inner',
                  [
                    review('a'),
                    byAmount('deep', 'inclusive', [[5, review('d1')]], review('d2'), review('d3')),
                  ],
                  notify('n', 3),
                ),
              ],
            ],
            review('else'),
          ),
          parallel('second', [review('s1'), review('s2')]),
        ),
      ),
    ],
  ])('Fixture: %s', async (_, tree) => {
    expect((await roundTrip(tree, fields)).ok).toBe(true)
  })

  it('a fork without next at a path end on the main line tail: end events of its own, no join', async () => {
    const tree = begin(
      parallel('p', [
        chain(review('a'), byAmount('x', 'exclusive', [[1, review('b')]], undefined))!,
        review('d'),
      ]),
    )
    const r = await roundTrip(tree, fields)
    expect(r.joins).toEqual({})
    expect(r.xml.match(/<bpmn:endEvent /g)).toHaveLength(3)
  })

  it('a fork without next at a path end anywhere else: a join of its own, linked on to the outer one', async () => {
    const tree = begin(
      byAmount(
        'o',
        'exclusive',
        [[1, parallel('p', [parallel('q', [review('a'), review('b')]), review('c')])]],
        undefined,
        review('after'),
      ),
    )
    const r = await roundTrip(tree, fields)
    expect(Object.values(r.joins).sort()).toEqual(['o', 'p', 'q'])
    expect(r.xml.match(/<bpmn:endEvent /g)).toHaveLength(1)
  })
})

describe('treeToXml: ids, names, XML', () => {
  it('generated ids skip the tree ids (qwj_1, …) and are unique', async () => {
    const fork = parallel('qwj_1', [review('qwe_2'), notify('qwf_3', 3)], review('qwd_4'))
    fork.paths[0]!.id = 'qwf_6'
    const tree = begin(fork, { id: 'qwp_5' })
    const { xml } = await roundTrip(tree, fields)
    const all = ids(xml)
    expect(new Set(all).size).toBe(all.length)
    for (const id of ['qwj_1', 'qwe_2', 'qwf_3', 'qwd_4', 'qwp_5', 'qwf_6'])
      expect(all.filter((x) => x === id)).toHaveLength(1)
  })

  it('writes ids as they are: one XML refuses (digit first) or bpmnToTree refuses (`__x`) — the web renames them on import', async () => {
    const xml = treeToXml(begin(review('1st')))
    expect(xml).toContain('id="1st"')
    await expect(moddle.fromXML(xml, 'bpmn:Definitions', { lax: false })).rejects.toThrow(
      /illegal ID <1st>/,
    )
    // the same id held in memory (bpmn-js definitions): the designer's own check refuses it
    const defs = await parse(treeToXml(begin(review('first'))))
    defs.rootElements[0]!.flowElements.find((e) => e.id === 'first')!.id = '1st'
    expect(bpmnToTree(defs)).toEqual({ ok: false, errors: [{ code: 'bpmn_id', id: '1st' }] })

    expect(bpmnToTree(await parse(treeToXml(begin(review('__x')))))).toEqual({
      ok: false,
      errors: [{ code: 'bpmn_id', id: '__x' }],
    })
  })

  it('escapes names with markup characters, quotes and line breaks; Chinese as it is', async () => {
    const odd = "审批 <&\"> 'x'\n第二行\t]]>"
    const fork = byAmount(
      'x',
      'exclusive',
      [[1, review('r2', { name: '金额 > 1 & "大"' })]],
      undefined,
    )
    fork.name = '<分支>'
    fork.paths[0]!.name = '大于 1 & <小于> 2'
    const { xml, tree } = await roundTrip(
      begin(chain(review('r1', { name: odd }), fork), { name: '发起 & 提交' }),
      fields,
    )
    expect(tree.name).toBe('发起 & 提交')
    expect(tree.next!.name).toBe(odd)
    expect(xml).toContain('name="审批 &#60;&#38;&#34;&#62; \'x\'&#10;第二行&#9;]]&#62;"')
    expect(xml).not.toMatch(/name="[^"]*[<&](?!#\d+;)/)
  })

  it('writes names through nameOf (the web passes tx: seed keys become text)', async () => {
    const tree = leaveTree({ employee: 1, supervisor: 2, deputy: 3, director: 4, hr: 5 })
    const xml = treeToXml(tree, { nameOf: (k) => k.replace('seed.wf.', 'T:') })
    expect(xml).not.toContain('seed.wf.')
    const r = bpmnToTree(await parse(xml))
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    expect(r.tree.name).toBe('T:node.begin')
    expect(r.tree.next!.name).toBe('T:node.supervisor')
    const fork = r.tree.next!.next!
    expect(fork.type === 'fork' && [fork.name, fork.paths.map((p) => p.name)]).toEqual([
      'T:node.byDays',
      ['T:path.over5', 'T:path.over2', 'T:path.otherwise'],
    ])
  })

  it('writes no DOCTYPE, conditions as qw-rule JSON, settings as qw:Config', () => {
    const xml = treeToXml(begin(byAmount('x', 'exclusive', [[1, review('r')]], undefined)))
    expect(xml).not.toMatch(/<!DOCTYPE|<!ENTITY/i)
    expect(xml).toContain(
      '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="qw-rule">[[{&#34;field&#34;:&#34;amount&#34;,&#34;op&#34;:&#34;gt&#34;,&#34;value&#34;:1}]]</bpmn:conditionExpression>',
    )
    expect(xml).toContain('<bpmn:exclusiveGateway id="x" name="x" default="x-else">')
    expect(xml).toMatch(
      /<bpmn:userTask id="r" name="R"><bpmn:extensionElements><qw:Config>\{&#34;assignee/,
    )
  })
})
