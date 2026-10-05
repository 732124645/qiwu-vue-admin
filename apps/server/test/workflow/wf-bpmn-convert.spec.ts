// `bpmnPrecheck` and the structural part of `bpmnToTree` (rules
// ①②⑥⑬⑦⑧⑨⑩, the element mapping, `joins`). Every fixture goes through the server's bpmn-moddle strict parse
// with 0 warnings, as on publish, and carries full DI (rule ⑬ runs before ⑦–⑩) except the DI cases: the
// `fixture` helper (fixtures/wf/bpmn-fixture.ts) draws a shape / edge per element, nodes in a row.
// `bpmn-js-leave.bpmn` is a bpmn-js 18.30.1 `saveXML({ format: true })` export (drawn with the Modeler API:
// append, connect, update properties, a `qw:Config` per configured element, conditions, a default flow) that
// locks rule ②'s allowlist; its geometry moved where bpmn-js drew three flows through other nodes (rule ⑬, the shape `director` 110 px down, `otherwise` over the row, `over-2` and the flow out of `director` after it).
// The content rules ③④⑤⑪ and rule ⑫ — the tree goes on to `compile`, whose errors carry
// element / flow ids — at the end of the file.
import { readFileSync } from 'node:fs'
import {
  bpmnPrecheck,
  bpmnToTree,
  compile,
  WF_BPMN_MODDLE,
  WF_BPMN_XML_MAX,
  type WfBeginNode,
  type WfBpmnCode,
  type WfBpmnResult,
  type WfCompileCode,
  type WfFields,
  type WfStep,
} from '@qiwu/shared'
import { BpmnModdle } from 'bpmn-moddle'
import { cfg, fixture, type Fx, NS, text } from '../fixtures/wf/bpmn-fixture.js'

const moddle = new BpmnModdle({ qw: WF_BPMN_MODDLE })
async function parse(xml: string) {
  const { rootElement, warnings } = await moddle.fromXML(xml, 'bpmn:Definitions', { lax: false })
  expect(warnings).toEqual([])
  return rootElement
}
const convert = async (xml: string) => bpmnToTree(await parse(xml))

/** `S > R1 > X1:exclusive[X1_R2=R2 | X1_E1*=] > R3`: chains, forks with their paths (`*` = fallback). */
function chain(first: WfStep | undefined): string {
  const out: string[] = []
  for (let n = first; n; n = n.next)
    out.push(
      n.type === 'fork'
        ? `${n.id}:${n.mode}[${n.paths.map((p) => `${p.id}${p.fallback ? '*' : ''}=${chain(p.child)}`).join(' | ')}]`
        : n.id,
    )
  return out.join(' > ')
}
const shapeOf = (tree: WfBeginNode) => [tree.id, chain(tree.next)].filter(Boolean).join(' > ')
async function ok(xml: string) {
  const r = await convert(xml)
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`)
  return { shape: shapeOf(r.tree), joins: r.joins, tree: r.tree }
}
const refused = (code: WfBpmnCode, id: string | null): WfBpmnResult => ({
  ok: false,
  errors: [{ code, id }],
})

/** `qw:Config` settings that pass the strict schemas (rule ⑪). */
const REVIEW = {
  assignee: { kind: 'users', ids: [2] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'skip',
  onReject: 'finish',
}
const NOTIFY = { assignee: { kind: 'users', ids: [3] } }

describe('bpmnPrecheck', () => {
  it('counts UTF-8 bytes up to WF_BPMN_XML_MAX', () => {
    expect(bpmnPrecheck('a'.repeat(WF_BPMN_XML_MAX))).toBeNull()
    expect(bpmnPrecheck('a'.repeat(WF_BPMN_XML_MAX + 1))).toBe('bpmn_too_large')
    // 3 bytes each (a CJK character), 4 for a pair (an emoji), 3 for a lone surrogate (its U+FFFD)
    const cjk = '栖'.repeat(WF_BPMN_XML_MAX / 4)
    expect(bpmnPrecheck(cjk)).toBeNull()
    expect(bpmnPrecheck(cjk + '\u{1F600}'.repeat(WF_BPMN_XML_MAX / 16))).toBeNull()
    expect(bpmnPrecheck(cjk + '\u{1F600}'.repeat(WF_BPMN_XML_MAX / 16) + 'a')).toBe(
      'bpmn_too_large',
    )
    expect(bpmnPrecheck('\ud800'.repeat(WF_BPMN_XML_MAX / 2))).toBe('bpmn_too_large')
    expect(bpmnPrecheck('é'.repeat(WF_BPMN_XML_MAX / 2))).toBeNull()
    expect(bpmnPrecheck('é'.repeat(WF_BPMN_XML_MAX / 2) + 'a')).toBe('bpmn_too_large')
  })

  it('refuses a DOCTYPE or ENTITY declaration in any case', () => {
    const xml = fixture({ flows: 'S>E1' })
    expect(bpmnPrecheck(xml)).toBeNull()
    expect(bpmnPrecheck(`<!doctype x>${xml}`)).toBe('bpmn_doctype')
    expect(bpmnPrecheck(xml.replace('<bpmn:process', '<!EnTiTy x "y"><bpmn:process'))).toBe(
      'bpmn_doctype',
    )
  })
})

describe('bpmnToTree: structures it takes', () => {
  it('a chain: start → review → carbon copy → review → end', async () => {
    expect(await ok(fixture({ flows: 'S>R1>C1>R2>E1' }))).toMatchObject({
      shape: 'S > R1 > C1 > R2',
      joins: {},
    })
  })

  it('the leave shape: an exclusive block with a parallel block inside; names, paths, fallback', async () => {
    const r = await ok(
      fixture({
        flows: 'S>R1>X1>P1>R2>PJ>XJ>E1 P1>R3>PJ X1>R4>XJ X1>XJ',
        default: { X1: 'X1_XJ' },
        names: {
          R1: 'Supervisor',
          P1: 'Both',
          R2: 'HR',
          R3: 'Director',
          R4: 'Director',
          X1_R4: 'Short',
        },
      }),
    )
    expect(r.shape).toBe(
      'S > R1 > X1:exclusive[X1_P1=P1:parallel[P1_R2=R2 | P1_R3=R3] | X1_R4=R4 | X1_XJ*=]',
    )
    expect(r.joins).toEqual({ PJ: 'P1', XJ: 'X1' })
    // unnamed: start → the seed key, gateway → its id, path → its target's name, else its own id
    expect(r.tree).toMatchObject({
      id: 'S',
      type: 'begin',
      name: 'seed.wf.node.begin',
      next: {
        id: 'R1',
        type: 'review',
        name: 'Supervisor',
        next: {
          id: 'X1',
          type: 'fork',
          name: 'X1',
          mode: 'exclusive',
          paths: [
            {
              id: 'X1_P1',
              name: 'Both',
              child: {
                type: 'fork',
                name: 'Both',
                mode: 'parallel',
                paths: [
                  { id: 'P1_R2', name: 'HR', child: { type: 'review', name: 'HR' } },
                  { id: 'P1_R3', name: 'Director', child: { type: 'review', name: 'Director' } },
                ],
              },
            },
            { id: 'X1_R4', name: 'Short', child: { id: 'R4', type: 'review', name: 'Director' } },
            { id: 'X1_XJ', name: 'X1_XJ', fallback: true },
          ],
        },
      },
    })
    const paths = (r.tree.next!.next as Extract<WfStep, { type: 'fork' }>).paths
    expect(paths.map((p) => 'fallback' in p)).toEqual([false, false, true])
  })

  it('an inclusive block, consecutive blocks, a block nested inside a path that goes on', async () => {
    expect(
      await ok(fixture({ flows: 'S>I1>R1>IJ>R3>E1 I1>R2>IJ', default: { I1: 'I1_R2' } })),
    ).toMatchObject({ shape: 'S > I1:inclusive[I1_R1=R1 | I1_R2*=R2] > R3', joins: { IJ: 'I1' } })
    expect(
      await ok(
        fixture({ flows: 'S>X1>R1>XJ>P1>R2>PJ>E1 X1>XJ P1>R3>PJ', default: { X1: 'X1_XJ' } }),
      ),
    ).toMatchObject({
      shape: 'S > X1:exclusive[X1_R1=R1 | X1_XJ*=] > P1:parallel[P1_R2=R2 | P1_R3=R3]',
      joins: { XJ: 'X1', PJ: 'P1' },
    })
    expect(
      await ok(
        fixture({ flows: 'S>X1>P1>R1>PJ>R3>XJ>R4>E1 P1>R2>PJ X1>XJ', default: { X1: 'X1_XJ' } }),
      ),
    ).toMatchObject({
      shape: 'S > X1:exclusive[X1_P1=P1:parallel[P1_R1=R1 | P1_R2=R2] > R3 | X1_XJ*=] > R4',
      joins: { PJ: 'P1', XJ: 'X1' },
    })
  })

  it('a fork without join: branches to their own end events, or (exclusive and parallel) to one', async () => {
    expect(await ok(fixture({ flows: 'S>X1>R1>E1 X1>R2>E2' }))).toMatchObject({
      shape: 'S > X1:exclusive[X1_R1=R1 | X1_R2=R2]',
      joins: {},
    })
    expect((await ok(fixture({ flows: 'S>X1>R1>E1 X1>R2>E1' }))).shape).toBe(
      'S > X1:exclusive[X1_R1=R1 | X1_R2=R2]',
    )
    expect((await ok(fixture({ flows: 'S>P1>R1>E1 P1>R2>E1' }))).shape).toBe(
      'S > P1:parallel[P1_R1=R1 | P1_R2=R2]',
    )
  })

  it('several end events, an empty path to one, a fork without join inside one', async () => {
    const r = await ok(
      fixture({ flows: 'S>R0>X1>R1>E1 X1>P1>R2>E2 P1>R3>E3 X1>E4', names: { E4: 'Rejected' } }),
    )
    expect(r.shape).toBe(
      'S > R0 > X1:exclusive[X1_R1=R1 | X1_P1=P1:parallel[P1_R2=R2 | P1_R3=R3] | X1_E4=]',
    )
    expect(r.tree).toMatchObject({
      next: { next: { paths: [{}, {}, { id: 'X1_E4', name: 'Rejected' }] } },
    })
  })

  it('an empty path: a fork straight to its join', async () => {
    expect(await ok(fixture({ flows: 'S>P1>R1>PJ>E1 P1>PJ' }))).toMatchObject({
      shape: 'S > P1:parallel[P1_R1=R1 | P1_PJ=]',
      joins: { PJ: 'P1' },
    })
  })

  it('empty names fall back as missing ones (start, gateway, path)', async () => {
    const xml = fixture({
      flows: 'S>X1>R1>XJ>E1 X1>R2>XJ',
      names: { R1: 'A' },
      attrs: { S: ' name=""', X1: ' name=""', X1_R1: ' name=""' },
    })
    expect((await ok(xml)).tree).toMatchObject({
      name: 'seed.wf.node.begin',
      next: { name: 'X1', paths: [{ name: 'A' }, { name: 'X1_R2' }] },
    })
  })

  it('a 64-character id', async () => {
    const long = `R${'x'.repeat(63)}`
    const xml = fixture({ flows: 'S>R1>E1' }).replaceAll('"R1"', `"${long}"`)
    expect((await ok(xml)).shape).toBe(`S > ${long}`)
  })

  it('the qw namespace declared under another prefix', async () => {
    const xml = fixture({
      flows: 'S>R1>E1',
      inner: { R1: cfg(REVIEW).replaceAll('qw:Config', 'wf:Config') },
    }).replace('xmlns:qw=', 'xmlns:wf=')
    expect(xml).not.toContain('xmlns:qw')
    const defs = (await parse(xml)) as {
      rootElements: { flowElements: { extensionElements?: { values: { $type: string }[] } }[] }[]
    }
    expect(defs.rootElements[0].flowElements[1].extensionElements?.values[0].$type).toBe(
      'qw:Config',
    )
    expect((await ok(xml)).tree.next).toEqual({ ...REVIEW, id: 'R1', type: 'review', name: '' })
  })

  it('a bpmn-js 18.30.1 saveXML export (the allowlist of rule ②)', async () => {
    const xml = readFileSync(new URL('../fixtures/wf/bpmn-js-leave.bpmn', import.meta.url), 'utf8')
    expect(xml).toContain('xsi:type="bpmn:tFormalExpression"')
    const r = await ok(xml)
    expect(r.shape).toBe(
      'begin > supervisor > by-days:exclusive[over-5=hr-and-director:parallel[to-hr=hr | to-director=director-long] | over-2=director | otherwise*=] > cc-hr',
    )
    expect(r.joins).toEqual({ 'join-both': 'hr-and-director', 'join-days': 'by-days' })
    expect(r.tree).toMatchObject({
      name: 'seed.wf.node.begin',
      next: {
        name: 'Supervisor',
        next: {
          name: 'Days',
          paths: [
            {
              name: 'Over 5 days',
              child: {
                name: 'HR and director',
                paths: [{ name: 'HR' }, { name: 'Director', child: { name: 'Director' } }],
              },
            },
            { name: 'Over 2 days' },
            { name: 'Otherwise', fallback: true },
          ],
          next: { type: 'notify', name: 'Copy HR' },
        },
      },
    })
  })

  // the designer's own check runs on bpmn-js definitions in memory: reading a list through moddle's `get`
  // creates `[]` (bpmn-js does it for `eventDefinitions`, `lanes`, `categoryValueRef`), a cleared label sets
  // `name` to null; moddle writes neither, so they pass as on the server's parse of the saved XML
  it('keys holding nothing, as bpmn-js leaves them in memory', async () => {
    interface El {
      id: string
      get(key: string): unknown
      set(key: string, value: unknown): void
    }
    const xml = readFileSync(new URL('../fixtures/wf/bpmn-js-leave.bpmn', import.meta.url), 'utf8')
    const defs = (await parse(xml)) as El & {
      rootElements: (El & { flowElements: El[] })[]
      diagrams: { plane: { planeElement: (El & { label?: El })[] } }[]
    }
    const process = defs.rootElements[0]
    const all = [defs, process, ...process.flowElements]
    const lists = ['documentation', 'eventDefinitions', 'lanes', 'categoryValueRef', 'imports']
    for (const el of all) for (const key of lists) el.get(key)
    for (const el of process.flowElements) el.set('name', null)
    const el = (id: string) => all.find((e) => e.id === id)!
    el('join-days').set('default', null)
    el('Flow_0rt38bf').set('conditionExpression', null)
    el('done').set('extensionElements', null)
    const di = defs.diagrams[0].plane.planeElement
    di.find((d) => d.id === '_BPMNShape_StartEvent_2')!.set('label', null)
    di.find((d) => d.id === 'Activity_0e66vww_di')!.label!.set('bounds', null)
    expect(Object.getOwnPropertyNames(el('begin'))).toEqual(
      expect.arrayContaining(['eventDefinitions', 'documentation', 'name']),
    )
    const r = bpmnToTree(defs)
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`)
    expect(shapeOf(r.tree)).toBe(
      'begin > supervisor > by-days:exclusive[over-5=hr-and-director:parallel[to-hr=hr | to-director=director-long] | over-2=director | otherwise*=] > cc-hr',
    )
    expect(r.tree).toMatchObject({ name: 'seed.wf.node.begin', next: { name: '' } })
  })
})

const base = (more: Partial<Fx> = {}) => fixture({ flows: 'S>R1>E1', ...more })
const shapeXml = (id: string) =>
  `<bpmndi:BPMNShape id="${id}_extra" bpmnElement="${id}"><dc:Bounds x="0" y="0" width="1" height="1"/></bpmndi:BPMNShape>`
/** `xml` with element `id`'s shape at other bounds / flow `id`'s edge through other waypoints */
const bounds = (xml: string, id: string, x: number, y = 0, width = 36, height = 36) =>
  xml.replace(
    new RegExp(`(bpmnElement="${id}"><dc:Bounds )[^/]*`),
    `$1x="${x}" y="${y}" width="${width}" height="${height}"`,
  )
/** base with R1 moved to touch S (x 36), R1_E1 rerouted to fit, and S_R1 through `points` */
const touching = (xml: string, ...points: [number, number][]) =>
  route(route(bounds(xml, 'R1', 36), 'R1_E1', [72, 41], [195, -5]), 'S_R1', ...points)
const route = (xml: string, id: string, ...points: [number, number][]) =>
  xml.replace(
    new RegExp(`(bpmnElement="${id}">)(<di:waypoint [^/]*/>)+`),
    `$1${points.map(([x, y]) => `<di:waypoint x="${x}" y="${y}"/>`).join('')}`,
  )
/** an exclusive fork whose second path skips the review: S > X1 > R1 > XJ > E1, X1 > XJ (drawn over the row) */
const skip = () => fixture({ flows: 'S>X1>R1>XJ>E1 X1>XJ', default: { X1: 'X1_XJ' } })
const RULES: [string, string, WfBpmnCode, string | null][] = [
  // ① one process, no pool or lanes
  [
    'a pool',
    base({
      root: '<bpmn:collaboration id="C"><bpmn:participant id="Pool" processRef="P"/></bpmn:collaboration>',
      diExtra: shapeXml('Pool'),
    }),
    'bpmn_pool',
    'Pool',
  ],
  [
    'a lane',
    base({
      extra:
        '<bpmn:laneSet id="LS"><bpmn:lane id="L1"><bpmn:flowNodeRef>R1</bpmn:flowNodeRef></bpmn:lane></bpmn:laneSet>',
      diExtra: shapeXml('L1'),
    }),
    'bpmn_pool',
    'L1',
  ],
  ['two processes', base({ root: '<bpmn:process id="P2"/>' }), 'bpmn_process', null],
  ['a message beside the process', base({ root: '<bpmn:message id="M1"/>' }), 'bpmn_process', null],
  [
    'a message instead of a process',
    `<bpmn:definitions ${NS} id="D" targetNamespace="urn:test"><bpmn:message id="M1"/></bpmn:definitions>`,
    'bpmn_process',
    null,
  ],
  // ② types and keys outside the subset
  ['a script task', fixture({ flows: 'S>T1>E1' }), 'bpmn_unsupported', 'T1'],
  [
    'a boundary event',
    fixture({ flows: 'S>R1>E1 B1>E2', attrs: { B1: ' attachedToRef="R1"' } }),
    'bpmn_unsupported',
    'B1',
  ],
  [
    'a multi-instance marker',
    base({ inner: { R1: '<bpmn:multiInstanceLoopCharacteristics/>' } }),
    'bpmn_unsupported',
    'R1',
  ],
  [
    'documentation',
    base({ inner: { R1: '<bpmn:documentation>x</bpmn:documentation>' } }),
    'bpmn_unsupported',
    'R1',
  ],
  [
    'isForCompensation',
    base({ attrs: { R1: ' isForCompensation="true"' } }),
    'bpmn_unsupported',
    'R1',
  ],
  [
    'resources',
    base({
      inner: {
        R1: '<bpmn:potentialOwner id="PO"><bpmn:resourceAssignmentExpression id="RA"><bpmn:formalExpression id="FE">7</bpmn:formalExpression></bpmn:resourceAssignmentExpression></bpmn:potentialOwner>',
      },
    }),
    'bpmn_unsupported',
    'R1',
  ],
  [
    'a qw:Config on a gateway',
    fixture({
      flows: 'S>X1>R1>E1 X1>R2>E2',
      inner: { X1: '<bpmn:extensionElements><qw:Config>{}</qw:Config></bpmn:extensionElements>' },
    }),
    'bpmn_unsupported',
    'X1',
  ],
  // a reference is a non-enumerable own key: still outside the allowlist
  [
    'messageRef on a carbon copy',
    fixture({ flows: 'S>C1>E1', attrs: { C1: ' messageRef="E1"' } }),
    'bpmn_unsupported',
    'C1',
  ],
  [
    'a start event with an event definition',
    base({ inner: { S: '<bpmn:timerEventDefinition id="TD"/>' } }),
    'bpmn_unsupported',
    'S',
  ],
  [
    'a condition that is no FormalExpression',
    fixture({
      flows: 'S>X1>R1>E1 X1>R2>E2',
      inner: { X1_R1: '<bpmn:conditionExpression>x</bpmn:conditionExpression>' },
    }),
    'bpmn_unsupported',
    'X1_R1',
  ],
  [
    'a condition key outside the allowlist',
    fixture({
      flows: 'S>X1>R1>E1 X1>R2>E2',
      inner: {
        X1_R1:
          '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" id="CE">x</bpmn:conditionExpression>',
      },
    }),
    'bpmn_unsupported',
    'X1_R1',
  ],
  [
    'a definitions key outside the allowlist',
    base().replace(
      'targetNamespace="urn:test"',
      'targetNamespace="urn:test" expressionLanguage="urn:x"',
    ),
    'bpmn_unsupported',
    'D',
  ],
  [
    'a process key outside the allowlist',
    base({ process: ' isClosed="true"' }),
    'bpmn_unsupported',
    'P',
  ],
  // ⑥ references
  [
    'targetRef="constructor"',
    base().replace('targetRef="E1"', 'targetRef="constructor"'),
    'bpmn_ref',
    'R1_E1',
  ],
  [
    'targetRef="__proto__"',
    base().replace('targetRef="E1"', 'targetRef="__proto__"'),
    'bpmn_ref',
    'R1_E1',
  ],
  ['a flow to a flow', base().replace('targetRef="E1"', 'targetRef="S_R1"'), 'bpmn_ref', 'R1_E1'],
  ['a flow from a flow', base().replace('sourceRef="R1"', 'sourceRef="S_R1"'), 'bpmn_ref', 'R1_E1'],
  [
    "a default on another gateway's flow",
    fixture({ flows: 'S>X1>X2>R1>E1 X2>R2>E2 X1>R3>E3', default: { X1: 'X2_R1' } }),
    'bpmn_ref',
    'X1',
  ],
  [
    'default="toString"',
    fixture({ flows: 'S>X1>R1>E1 X1>R2>E2', default: { X1: 'toString' } }),
    'bpmn_ref',
    'X1',
  ],
  [
    'a default on a node, not a flow',
    fixture({ flows: 'S>X1>R1>E1 X1>R2>E2', default: { X1: 'R1' } }),
    'bpmn_ref',
    'X1',
  ],
  // ⑬ DI
  ['a carbon copy without DI', fixture({ flows: 'S>R1>C1>E1', noDi: ['C1'] }), 'bpmn_di', 'C1'],
  ['a flow without DI', fixture({ flows: 'S>R1>C1>E1', noDi: ['R1_C1'] }), 'bpmn_di', 'R1_C1'],
  [
    'color:background-color',
    base({ diAttrs: { R1: ' color:background-color="#ffffff"' } }),
    'bpmn_di',
    'R1',
  ],
  [
    'bioc:stroke on an edge',
    base({ diAttrs: { S_R1: ' bioc:stroke="#ffffff"' } }),
    'bpmn_di',
    'S_R1',
  ],
  [
    'a colored label',
    base().replace(
      'bpmnElement="R1">',
      'bpmnElement="R1"><bpmndi:BPMNLabel color:color="#ffffff"/>',
    ),
    'bpmn_di',
    'R1',
  ],
  [
    'a foreign attribute on a shape',
    base({ diAttrs: { R1: ' xmlns:x="urn:x" x:y="1"' } }),
    'bpmn_di',
    'R1',
  ],
  [
    'a foreign attribute on the plane',
    base().replace('id="PL"', 'id="PL" xmlns:x="urn:x" x:y="1"'),
    'bpmn_di',
    'PL',
  ],
  [
    'a DI key outside the allowlist',
    base({ diAttrs: { R1: ' isHorizontal="true"' } }),
    'bpmn_di',
    'R1',
  ],
  [
    'a foreign attribute on bounds',
    base().replace('<dc:Bounds ', '<dc:Bounds xmlns:x="urn:x" x:y="1" '),
    'bpmn_di',
    'S',
  ],
  [
    'a foreign attribute on a waypoint',
    base().replace('<di:waypoint ', '<di:waypoint xmlns:x="urn:x" x:y="1" '),
    'bpmn_di',
    'S_R1',
  ],
  [
    'a foreign attribute on label bounds',
    base().replace(
      'bpmnElement="R1">',
      'bpmnElement="R1"><bpmndi:BPMNLabel><dc:Bounds xmlns:x="urn:x" x:y="1" x="0" y="0" width="1" height="1"/></bpmndi:BPMNLabel>',
    ),
    'bpmn_di',
    'R1',
  ],
  // bpmn-js skips a shape without bounds (drawn ≠ run) and draws a NaN coordinate nowhere
  [
    'a shape without bounds',
    base().replace(
      'bpmnElement="R1"><dc:Bounds x="100" y="0" width="36" height="36"/>',
      'bpmnElement="R1">',
    ),
    'bpmn_di',
    'R1',
  ],
  [
    'bounds without x',
    base().replace('bpmnElement="R1"><dc:Bounds x="100" ', 'bpmnElement="R1"><dc:Bounds '),
    'bpmn_di',
    'R1',
  ],
  [
    'a waypoint that is no number',
    base().replace(
      'bpmnElement="S_R1"><di:waypoint x="0"',
      'bpmnElement="S_R1"><di:waypoint x="a"',
    ),
    'bpmn_di',
    'S_R1',
  ],
  [
    'label bounds without width',
    base().replace(
      'bpmnElement="R1">',
      'bpmnElement="R1"><bpmndi:BPMNLabel><dc:Bounds x="0" y="0" height="1"/></bpmndi:BPMNLabel>',
    ),
    'bpmn_di',
    'R1',
  ],
  ['two shapes for one element', base({ diExtra: shapeXml('R1') }), 'bpmn_di', 'R1'],
  ['a shape for a flow', base({ noDi: ['S_R1'], diExtra: shapeXml('S_R1') }), 'bpmn_di', 'S_R1'],
  [
    'DI bpmnElement="toString"',
    base({ diExtra: shapeXml('toString') }),
    'bpmn_di',
    'toString_extra',
  ],
  ['DI for the process', base({ diExtra: shapeXml('P') }), 'bpmn_di', 'P_extra'],
  [
    'a plane on another element',
    base().replace('id="PL" bpmnElement="P"', 'id="PL" bpmnElement="R1"'),
    'bpmn_di',
    'PL',
  ],
  [
    'two diagrams',
    base().replace(
      '</bpmn:definitions>',
      '<bpmndi:BPMNDiagram id="DG2"><bpmndi:BPMNPlane id="PL2" bpmnElement="P"/></bpmndi:BPMNDiagram></bpmn:definitions>',
    ),
    'bpmn_di',
    null,
  ],
  [
    'no diagram',
    base().replace(/<bpmndi:BPMNDiagram[\s\S]*<\/bpmndi:BPMNDiagram>/, ''),
    'bpmn_di',
    null,
  ],
  [
    'a diagram key outside the allowlist',
    base().replace('id="DG"', 'id="DG" name="x"'),
    'bpmn_di',
    'DG',
  ],
  // geometry: a node hidden under another, too small to see, a flow that does not run from its source
  // to its target on the diagram (base: S at x 0, R1 at 100, E1 at 200, each 36 × 36; S_R1 from (0,0) to (100,0))
  [
    'a carbon copy stacked exactly under a review, its flows docked on both',
    route(
      route(bounds(fixture({ flows: 'S>C1>R1>E1' }), 'C1', 200), 'S_C1', [0, 0], [200, 0]),
      'C1_R1',
      [200, 0],
      [236, 36],
    ),
    'bpmn_di',
    'R1',
  ],
  [
    'a node partly over another',
    route(
      route(bounds(base(), 'R1', 30, 30), 'S_R1', [0, 0], [30, 30]),
      'R1_E1',
      [66, 66],
      [200, 0],
    ),
    'bpmn_di',
    'R1',
  ],
  ['a zero-size node', bounds(base(), 'R1', 100, 0, 0, 0), 'bpmn_di', 'R1'],
  ['a node 9 px wide', bounds(base(), 'R1', 100, 0, 9, 36), 'bpmn_di', 'R1'],
  ['a node 9 px high', bounds(base(), 'R1', 100, 0, 36, 9), 'bpmn_di', 'R1'],
  ['a flow without waypoints', route(base(), 'S_R1'), 'bpmn_di', 'S_R1'],
  // R1 touching S (x 36): a point on the shared edge is on both, so only the point count / length refuses these
  ['a flow with one waypoint', touching(base(), [36, 18]), 'bpmn_di', 'S_R1'],
  ['a zero-length flow', touching(base(), [36, 18], [36, 18], [36, 18]), 'bpmn_di', 'S_R1'],
  ['a flow ending off its target', route(base(), 'S_R1', [0, 0], [150, 0]), 'bpmn_di', 'S_R1'],
  [
    'a flow ending 6 px left of its target',
    route(base(), 'S_R1', [0, 0], [94, 0]),
    'bpmn_di',
    'S_R1',
  ],
  [
    'a flow ending 6 px above its target',
    route(base(), 'S_R1', [0, 0], [100, -6]),
    'bpmn_di',
    'S_R1',
  ],
  [
    'a flow ending 6 px below its target',
    route(base(), 'S_R1', [0, 0], [100, 42]),
    'bpmn_di',
    'S_R1',
  ],
  ['a flow starting off its source', route(base(), 'S_R1', [60, 0], [100, 0]), 'bpmn_di', 'S_R1'],
  ['a flow drawn backwards', route(base(), 'S_R1', [100, 0], [0, 0]), 'bpmn_di', 'S_R1'],
  // a fork's path that skips the review drawn along the review's border / through it / near it: drawn so it
  // reads as X1 → R1 → XJ (skip: X1 at 100, R1 at 200, XJ at 300; drawn clear of R1 it passes, below)
  [
    "a path around a review drawn along the review's border",
    route(skip(), 'X1_XJ', [136, 18], [200, 18], [200, 0], [236, 0], [236, 18], [300, 18]),
    'bpmn_di',
    'X1_XJ',
  ],
  [
    'a flow straight through another node',
    route(skip(), 'X1_XJ', [136, 18], [300, 18]),
    'bpmn_di',
    'X1_XJ',
  ],
  [
    'a flow across another node, slanted',
    route(skip(), 'X1_XJ', [136, 36], [300, 0]),
    'bpmn_di',
    'X1_XJ',
  ],
  [
    'a flow 5 px over another node',
    route(skip(), 'X1_XJ', [136, 0], [136, -5], [300, -5], [300, 0]),
    'bpmn_di',
    'X1_XJ',
  ],
  // ⑦ ids and names
  ['id __x', base().replaceAll('"R1"', '"__x"'), 'bpmn_id', '__x'],
  [
    'a 65-character id',
    base().replaceAll('"R1"', `"R${'x'.repeat(64)}"`),
    'bpmn_id',
    `R${'x'.repeat(64)}`,
  ],
  ['an id with a dot', base().replaceAll('"R1"', '"R.1"'), 'bpmn_id', 'R.1'],
  [
    'a process id __P',
    base()
      .replace('process id="P"', 'process id="__P"')
      .replace('bpmnElement="P"', 'bpmnElement="__P"'),
    'bpmn_id',
    '__P',
  ],
  ['a 65-character name', base({ names: { R1: 'n'.repeat(65) } }), 'bpmn_id', 'R1'],
  // ⑧ one start, flows per type
  ['two start events', fixture({ flows: 'S>R1>E1 S2>R2>E2' }), 'bpmn_start', 'S2'],
  ['no start event', fixture({ flows: 'XJ>R1>X1>E1 X1>R2>XJ X1>R3>XJ' }), 'bpmn_start', null],
  [
    'an implicit merge (a task with two incoming flows)',
    fixture({ flows: 'S>X1>R1>R2>E1 X1>R2' }),
    'bpmn_arity',
    'R2',
  ],
  ['a start with two outgoing flows', fixture({ flows: 'S>R1>E1 S>R2>E2' }), 'bpmn_arity', 'S'],
  ['a start with an incoming flow', fixture({ flows: 'S>X1>R1>E1 X1>S' }), 'bpmn_arity', 'S'],
  ['an end event without incoming flow', fixture({ flows: 'S>R1>E1 E2' }), 'bpmn_arity', 'E2'],
  ['a task with two outgoing flows', fixture({ flows: 'S>R1>E1 R1>E2' }), 'bpmn_arity', 'R1'],
  ['an end event with an outgoing flow', fixture({ flows: 'S>E1>R1>E2' }), 'bpmn_arity', 'E1'],
  ['a gateway with one flow in and out', fixture({ flows: 'S>X1>R1>E1' }), 'bpmn_arity', 'X1'],
  [
    'a gateway that joins and branches',
    fixture({ flows: 'S>X1>R1>X2>R3>E1 X1>R2>X2>R4>E2' }),
    'bpmn_arity',
    'X2',
  ],
  // ⑨ a loop (the first element on it)
  ['a loop', fixture({ flows: 'S>XJ>R1>X1>E1 X1>XJ' }), 'bpmn_cycle', 'XJ'],
  [
    'two loops: the first one met',
    fixture({ flows: 'S>XJ>R1>X1>XK>R2>X2>E1 X1>XJ X2>XK' }),
    'bpmn_cycle',
    'XK',
  ],
  // ⑩ blocks
  [
    'a branch ending early while its siblings join',
    fixture({ flows: 'S>R0>X1>R1>XJ>E1 X1>R2>XJ X1>R3>E2' }),
    'bpmn_unstructured',
    'XJ',
  ],
  [
    'nested forks sharing one join',
    fixture({ flows: 'S>X1>R1>XJ>E1 X1>X2>R2>XJ X2>R3>XJ' }),
    'bpmn_unstructured',
    'XJ',
  ],
  // the inner fork's walk stops there: it never goes on past the shared join into the next block
  [
    'nested forks sharing one join, a block after it',
    fixture({ flows: 'S>X1>R1>XJ>X3>R5>XJ3>E1 X3>R6>XJ3 X1>X2>R2>XJ X2>R3>XJ' }),
    'bpmn_unstructured',
    'XJ',
  ],
  [
    'a join across blocks',
    fixture({ flows: 'S>X0>X1>R1>XJ>R9>E1 X1>R2>XJ X0>X2>R3>XJ X2>R4>XJ X0>E2' }),
    'bpmn_unstructured',
    'XJ',
  ],
  ['a join of another type', fixture({ flows: 'S>X1>R1>PJ>E1 X1>R2>PJ' }), 'bpmn_join_type', 'X1'],
]

describe('bpmnToTree: refused, with the element id', () => {
  it.each(RULES)('%s', async (_, xml, code, id) => {
    expect(await convert(xml)).toEqual(refused(code, id))
  })

  it('geometry: touching nodes, flow ends inside a shape or up to 5 px off its bounds', async () => {
    expect((await convert(touching(base(), [18, 18], [31, 18]))).ok).toBe(true)
    expect(await convert(touching(base(), [18, 18], [30, 18]))).toEqual(refused('bpmn_di', 'S_R1'))
  })

  it('geometry: a flow 6 px or more off every other node', async () => {
    expect((await ok(skip())).shape).toBe('S > X1:exclusive[X1_R1=R1 | X1_XJ*=]')
    const xml = route(skip(), 'X1_XJ', [136, 0], [136, -6], [300, -6], [300, 0])
    expect((await convert(xml)).ok).toBe(true)
  })

  it('geometry: nodes above, below and beside each other in any order', async () => {
    // S (0,0); R1 below it, C1 above both, E1 left of R1: each pair apart on one axis only
    let xml = fixture({ flows: 'S>R1>C1>E1' })
    for (const [id, x, y] of [
      ['R1', 0, 50],
      ['C1', 0, -50],
      ['E1', -100, 50],
    ] as const)
      xml = bounds(xml, id, x, y)
    xml = route(xml, 'S_R1', [18, 36], [18, 50])
    xml = route(xml, 'R1_C1', [36, 68], [60, 68], [60, -32], [36, -32]) // around S
    xml = route(xml, 'C1_E1', [0, -32], [-64, 68])
    expect((await convert(xml)).ok).toBe(true)
  })

  // what bpmn-js definitions in memory can carry but the strict parse refuses (illegal / duplicate ID) or drops
  // (`valueRef` on extensionElements): the rules hold for the designer's own check too
  it.each([
    ['an id on Object.prototype', '"toString"', /duplicate ID/, 'bpmn_id', 'toString'],
    ['an id starting with a digit', '"1R"', /illegal ID/, 'bpmn_id', '1R'],
  ] as const)('%s', async (_, id, parseError, code, at) => {
    const xml = base()
    await expect(
      moddle.fromXML(xml.replaceAll('"R1"', id), 'bpmn:Definitions', { lax: false }),
    ).rejects.toThrow(parseError)
    const defs = (await parse(xml)) as { rootElements: { flowElements: { id: string }[] }[] }
    defs.rootElements[0].flowElements[1].id = JSON.parse(id) as string
    expect(bpmnToTree(defs)).toEqual(refused(code, at))
  })

  // a copy is no element of this process, whatever its type and id say
  it.each([
    ['a flow to a node of no process', 'targetRef', 'R1_E1'],
    ['a flow from a node of no process', 'sourceRef', 'R1_E1'],
    ['a default flow of no process', 'default', 'X1'],
  ] as const)('%s', async (_, key, at) => {
    const defs = (await parse(
      fixture({ flows: 'S>X1>R1>E1 X1>R2>E2', default: { X1: 'X1_R2' } }),
    )) as {
      rootElements: { flowElements: Record<string, unknown>[] }[]
    }
    const els = defs.rootElements[0].flowElements
    expect(bpmnToTree(defs).ok).toBe(true)
    const el = els.find((e) => e.id === at)!
    const copy = el[key] as object
    el[key] = Object.create(Object.getPrototypeOf(copy), Object.getOwnPropertyDescriptors(copy))
    expect(bpmnToTree(defs)).toEqual(refused('bpmn_ref', at))
  })

  it('extensionElements with a key other than values', async () => {
    const xml = base({ inner: { R1: cfg(REVIEW) } })
    const defs = (await parse(xml)) as {
      rootElements: { flowElements: { extensionElements?: Record<string, unknown> }[] }[]
    }
    expect(bpmnToTree(defs).ok).toBe(true)
    defs.rootElements[0].flowElements[1].extensionElements!.valueRef = {}
    expect(bpmnToTree(defs)).toEqual(refused('bpmn_unsupported', 'R1'))
  })

  // (an unreachable part is always a loop or has a second start; a loop on the reachable part waits for it)
  it('every element not reachable from the start, before any loop', async () => {
    const xml = fixture({ flows: 'S>X9>R1>X8>E1 X8>X9 XA>R2>XJ>XB>XA XA>R3>XJ XB>E2' })
    expect(await convert(xml)).toEqual({
      ok: false,
      errors: ['XA', 'R2', 'XJ', 'XB', 'R3', 'E2'].map((id) => ({ code: 'bpmn_unreachable', id })),
    })
  })

  // each stage's errors only, never the next stage's
  it.each([
    [
      'a flow to a flow and a missing DI: only the reference',
      base({ noDi: ['R1'] }).replace('targetRef="E1"', 'targetRef="S_R1"'),
      'bpmn_ref',
      'R1_E1',
    ],
    [
      'a missing DI and an id __x: only the DI',
      fixture({ flows: 'S>R1>C1>E1', noDi: ['C1'] }).replaceAll('"R1"', '"__x"'),
      'bpmn_di',
      'C1',
    ],
    [
      'an id __x and a task with two outgoing flows: only the id',
      fixture({ flows: 'S>R1>E1 R1>E2' }).replaceAll('"E2"', '"__x"'),
      'bpmn_id',
      '__x',
    ],
    [
      'a loop and a missing DI: only the DI',
      fixture({ flows: 'S>XJ>R1>X1>E1 X1>XJ', noDi: ['R1'] }),
      'bpmn_di',
      'R1',
    ],
  ] as const)('stops at the first failing stage: %s', async (_, xml, code, id) => {
    expect(await convert(xml)).toEqual(refused(code, id))
  })

  it('an element without id, or a name that is no string (in memory)', async () => {
    const xml = base()
    for (const [key, value] of [
      ['id', undefined],
      ['name', 5],
    ] as const) {
      const defs = (await parse(xml)) as {
        rootElements: { flowElements: Record<string, unknown>[] }[]
      }
      defs.rootElements[0].flowElements[1][key] = value
      expect(bpmnToTree(defs)).toEqual(refused('bpmn_id', key === 'id' ? null : 'R1'))
    }
  })

  it('takes no definitions at all', () => {
    expect(bpmnToTree(null)).toEqual(refused('bpmn_process', null))
    expect(bpmnToTree({ $type: 'bpmn:Definitions' })).toEqual(refused('bpmn_process', null))
  })
})

// ---- content rules ③④⑤⑪ and ⑫ (`compile` on the tree) ----

const FIELDS: WfFields = { days: 'number' }
const GT5 = [[{ field: 'days', op: 'gt', value: 5 }]]
/** a condition as bpmn-js writes it, or with other attributes */
const cond = (body: unknown, attrs = 'xsi:type="bpmn:tFormalExpression" language="qw-rule"') =>
  `<bpmn:conditionExpression ${attrs}>${text(body)}</bpmn:conditionExpression>`
/** `fixture` with a name and valid settings on every review / carbon copy it does not fill itself */
function full(fx: Fx): string {
  const names = { ...fx.names }
  const inner = { ...fx.inner }
  for (const id of new Set(fx.flows.split(/[\s>]+/)))
    if (/^[RC]/.test(id)) {
      names[id] ??= `Name ${id}`
      inner[id] ??= cfg(id.startsWith('R') ? REVIEW : NOTIFY)
    }
  return fixture({ ...fx, names, inner })
}
/** an exclusive block: X1_R1 has a condition, X1_R2 is the default */
const block = (more: Partial<Fx> = {}) =>
  full({
    flows: 'S>X1>R1>XJ>E1 X1>R2>XJ',
    default: { X1: 'X1_R2' },
    ...more,
    inner: { X1_R1: cond(GT5), ...more.inner },
  })
async function compiled(xml: string) {
  const r = await convert(xml)
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`)
  return compile(r.tree, FIELDS)
}

describe('bpmnToTree: content it takes', () => {
  it('conditions as bpmn-js writes them (xsi:type), settings from qw:Config; compile passes', async () => {
    const xml = full({
      flows: 'S>R1>X1>R2>XJ>C1>E1 X1>XJ',
      default: { X1: 'X1_XJ' },
      names: { X1_R2: 'Long' },
      // namespace declarations anywhere (a default one, one on an element) are no foreign attributes
      attrs: { R1: ' xmlns:x="urn:x"' },
      inner: {
        S: cfg({ access: { days: 'edit' } }),
        R1: cfg({ ...REVIEW, timeout: { hours: 24, action: 'toManager' } }),
        X1_R2: cond(GT5),
      },
    }).replace(
      '<bpmn:definitions ',
      '<bpmn:definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" ',
    )
    expect(xml).toContain('xsi:type="bpmn:tFormalExpression"')
    const r = await convert(xml)
    expect(r).toEqual({
      ok: true,
      joins: { XJ: 'X1' },
      tree: {
        access: { days: 'edit' },
        id: 'S',
        type: 'begin',
        name: 'seed.wf.node.begin',
        next: {
          ...REVIEW,
          timeout: { hours: 24, action: 'toManager' },
          id: 'R1',
          type: 'review',
          name: 'Name R1',
          next: {
            id: 'X1',
            type: 'fork',
            name: 'X1',
            mode: 'exclusive',
            paths: [
              {
                id: 'X1_R2',
                name: 'Long',
                when: GT5,
                child: { ...REVIEW, id: 'R2', type: 'review', name: 'Name R2' },
              },
              { id: 'X1_XJ', name: 'X1_XJ', when: [], fallback: true },
            ],
            next: { ...NOTIFY, id: 'C1', type: 'notify', name: 'Name C1' },
          },
        },
      },
    })
    expect(r.ok && compile(r.tree, FIELDS).ok).toBe(true)
  })

  it('the bpmn-js export: its conditions and settings in the tree, compile passes', async () => {
    const xml = readFileSync(new URL('../fixtures/wf/bpmn-js-leave.bpmn', import.meta.url), 'utf8')
    const r = await convert(xml)
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.errors)}`)
    expect(r.tree).toMatchObject({
      access: { days: 'edit' },
      next: {
        assignee: { kind: 'users', ids: [2] },
        next: {
          paths: [
            { when: [[{ field: 'days', op: 'gt', value: 5 }]] },
            {
              when: [
                [
                  { field: 'days', op: 'gt', value: 2 },
                  { field: 'days', op: 'lte', value: 5 },
                ],
              ],
            },
            { when: [], fallback: true },
          ],
          next: { assignee: { kind: 'users', ids: [3] } },
        },
      },
    })
    expect(compile(r.tree, FIELDS)).toMatchObject({ ok: true })
  })

  it('builds nodes from the parsed settings: extra keys of nested objects are dropped', async () => {
    const xml = base({
      names: { R1: 'A' },
      inner: { R1: cfg({ ...REVIEW, assignee: { kind: 'users', ids: [2], next: { id: 'x' } } }) },
    })
    expect((await ok(xml)).tree.next).toEqual({ ...REVIEW, id: 'R1', type: 'review', name: 'A' })
  })
})

const ext = (...xml: string[]) => `<bpmn:extensionElements>${xml.join('')}</bpmn:extensionElements>`
const LISTENER =
  '<camunda:executionListener xmlns:camunda="http://camunda.org/schema/1.0/bpmn" event="start" class="x"/>'
const CONTENT: [string, string, WfBpmnCode, string][] = [
  // ③ foreign attributes and extensions
  [
    'a flowable: attribute',
    full({
      flows: 'S>R1>E1',
      attrs: { R1: ' xmlns:flowable="http://flowable.org/bpmn" flowable:assignee="x"' },
    }),
    'bpmn_foreign',
    'R1',
  ],
  ['camunda:executionListener', base({ inner: { R1: ext(LISTENER) } }), 'bpmn_foreign', 'R1'],
  [
    'a listener beside a qw:Config',
    base({ inner: { R1: ext(`<qw:Config>${text(REVIEW)}</qw:Config>`, LISTENER) } }),
    'bpmn_foreign',
    'R1',
  ],
  [
    'a foreign attribute on a condition beside xsi:type',
    block({
      inner: {
        X1_R1: cond(
          GT5,
          'xsi:type="bpmn:tFormalExpression" language="qw-rule" xmlns:x="urn:x" x:y="1"',
        ),
      },
    }),
    'bpmn_foreign',
    'X1_R1',
  ],
  [
    'xsi:type on a task',
    base({ attrs: { R1: ' xsi:type="bpmn:tUserTask"' } }),
    'bpmn_foreign',
    'R1',
  ],
  [
    'a foreign attribute on the definitions',
    base().replace('id="D"', 'id="D" xsi:schemaLocation="urn:x x.xsd"'),
    'bpmn_foreign',
    'D',
  ],
  ['a foreign attribute on the process', base({ process: ' xsi:type="x"' }), 'bpmn_foreign', 'P'],
  [
    'a foreign attribute on extensionElements',
    base({
      inner: {
        R1: cfg(REVIEW).replace(
          '<bpmn:extensionElements>',
          '<bpmn:extensionElements xmlns:x="urn:x" x:y="1">',
        ),
      },
    }),
    'bpmn_foreign',
    'R1',
  ],
  [
    'a foreign attribute on qw:Config',
    base({
      inner: { R1: cfg(REVIEW).replace('<qw:Config>', '<qw:Config xmlns:x="urn:x" x:y="1">') },
    }),
    'bpmn_foreign',
    'R1',
  ],
  // ④ expressions
  [
    '${} in a condition',
    block({ inner: { X1_R1: cond('[[{"field":"days","op":"eq","value":"${x}"}]]') } }),
    'bpmn_expression',
    'X1_R1',
  ],
  [
    '&#36;&#123; in a condition',
    block({ inner: { X1_R1: cond('[[{"field":"days","op":"eq","value":"&#36;&#123;x}"}]]') } }),
    'bpmn_expression',
    'X1_R1',
  ],
  ['&#36;&#123; in a name', base({ names: { R1: '&#36;&#123;x}' } }), 'bpmn_expression', 'R1'],
  // a JSON escape spells `${` only once the body is parsed: in a string, in a key
  [
    '\\u0024{ in a condition',
    block({ inner: { X1_R1: cond('[[{"field":"days","op":"eq","value":"\\u0024{x}"}]]') } }),
    'bpmn_expression',
    'X1_R1',
  ],
  [
    '\\u0024\\u007b in a qw:Config key',
    base({ inner: { S: cfg('{"access":{"\\u0024\\u007bk}":"edit"}}') } }),
    'bpmn_expression',
    'S',
  ],
  ['${} in the process name', base({ process: ' name="${x}"' }), 'bpmn_expression', 'P'],
  [
    '${} in a qw:Config body',
    base({ inner: { R1: cfg('{"x":"${a}"}') } }),
    'bpmn_expression',
    'R1',
  ],
  [
    '${} in a namespace declaration',
    base({ attrs: { R1: ' xmlns:x="urn:${x}"' } }),
    'bpmn_expression',
    'R1',
  ],
  [
    'a condition in another language',
    block({
      inner: { X1_R1: cond(GT5, 'xsi:type="bpmn:tFormalExpression" language="javascript"') },
    }),
    'bpmn_expression',
    'X1_R1',
  ],
  [
    'a condition without language',
    block({ inner: { X1_R1: cond(GT5, 'xsi:type="bpmn:tFormalExpression"') } }),
    'bpmn_expression',
    'X1_R1',
  ],
  [
    'a condition that is no JSON',
    block({ inner: { X1_R1: cond('days > 5') } }),
    'bpmn_expression',
    'X1_R1',
  ],
  ['an empty condition', block({ inner: { X1_R1: cond('') } }), 'bpmn_expression', 'X1_R1'],
  // ⑤ conditions and defaults only on a branching gateway's flows
  [
    "a condition on a task's flow",
    base({ inner: { R1_E1: cond(GT5) } }),
    'bpmn_condition_misplaced',
    'R1_E1',
  ],
  // before ⑧ refuses the task's second flow: a gateway's flows only, however many a task has
  [
    'a condition on a flow of a task with two outgoing flows',
    fixture({ flows: 'S>R1>E1 R1>E2', inner: { R1_E2: cond(GT5) } }),
    'bpmn_condition_misplaced',
    'R1_E2',
  ],
  [
    "a condition on the start's flow",
    base({ inner: { S_R1: cond(GT5) } }),
    'bpmn_condition_misplaced',
    'S_R1',
  ],
  [
    "a condition on a join's flow",
    block({ flows: 'S>X1>R1>XJ>R3>E1 X1>R2>XJ', inner: { XJ_R3: cond(GT5) } }),
    'bpmn_condition_misplaced',
    'XJ_R3',
  ],
  [
    'a default on a join: its own flow',
    block({ flows: 'S>X1>R1>XJ>R3>E1 X1>R2>XJ', default: { X1: 'X1_R2', XJ: 'XJ_R3' } }),
    'bpmn_condition_misplaced',
    'XJ_R3',
  ],
  [
    "a default on a join: another gateway's flow",
    block({ default: { X1: 'X1_R2', XJ: 'X1_R2' } }),
    'bpmn_condition_misplaced',
    'XJ',
  ],
  // ⑪ qw:Config: one at most, the node type's strict schema
  ['two qw:Config', base({ inner: { R1: cfg(REVIEW, REVIEW) } }), 'bpmn_config', 'R1'],
  [
    "the chain's last review with next in its settings",
    base({
      inner: {
        R1: cfg({ ...REVIEW, next: { id: 'C9', type: 'notify', name: 'Hidden', ...NOTIFY } }),
      },
    }),
    'bpmn_config',
    'R1',
  ],
  [
    'a start straight to the end with next in its settings',
    fixture({
      flows: 'S>E1',
      inner: { S: cfg({ next: { id: 'R9', type: 'review', name: 'Hidden', ...REVIEW } }) },
    }),
    'bpmn_config',
    'S',
  ],
  ['settings with id', base({ inner: { R1: cfg({ ...REVIEW, id: 'R9' }) } }), 'bpmn_config', 'R1'],
  [
    'settings with type',
    base({ inner: { R1: cfg({ ...REVIEW, type: 'notify' }) } }),
    'bpmn_config',
    'R1',
  ],
  [
    'settings with name',
    base({ inner: { R1: cfg({ ...REVIEW, name: 'x' }) } }),
    'bpmn_config',
    'R1',
  ],
  [
    'settings with an extra key',
    base({ inner: { R1: cfg({ ...REVIEW, x: 1 }) } }),
    'bpmn_config',
    'R1',
  ],
  [
    "a carbon copy with a review's setting",
    fixture({ flows: 'S>C1>E1', inner: { C1: cfg({ ...NOTIFY, sign: 'any' }) } }),
    'bpmn_config',
    'C1',
  ],
  [
    "a start with a review's setting",
    base({ inner: { S: cfg({ assignee: NOTIFY.assignee }) } }),
    'bpmn_config',
    'S',
  ],
  [
    'a value outside the schema',
    base({ inner: { R1: cfg({ ...REVIEW, sign: 'some' }) } }),
    'bpmn_config',
    'R1',
  ],
  [
    'settings missing a required key',
    base({ inner: { R1: cfg({ sign: 'any' }) } }),
    'bpmn_config',
    'R1',
  ],
  ['a body that is no JSON', base({ inner: { R1: cfg('{x') } }), 'bpmn_config', 'R1'],
  ['an empty body', base({ inner: { R1: cfg('') } }), 'bpmn_config', 'R1'],
  ['a JSON array (start)', base({ inner: { S: cfg('[]') } }), 'bpmn_config', 'S'],
  ['JSON null (start)', base({ inner: { S: cfg('null') } }), 'bpmn_config', 'S'],
]

describe('bpmnToTree: content refused, with the element id', () => {
  it.each(CONTENT)('%s', async (_, xml, code, id) => {
    expect(await convert(xml)).toEqual(refused(code, id))
  })
})

describe('bpmnToTree then compile (rule ⑫): errors at element / flow ids', () => {
  const COMPILE: [string, string, WfCompileCode, string][] = [
    [
      'no default path',
      block({ default: {}, inner: { X1_R2: cond(GT5) } }),
      'fallback_count',
      'X1',
    ],
    [
      'a condition on a field the form lacks',
      block({ inner: { X1_R1: cond([[{ field: 'amount', op: 'gt', value: 5 }]]) } }),
      'unknown_field',
      'X1_R1',
    ],
    [
      'a parallel flow with a condition',
      full({ flows: 'S>P1>R1>PJ>E1 P1>R2>PJ', inner: { P1_R1: cond(GT5) } }),
      'parallel_path',
      'P1_R1',
    ],
    [
      'a flow without condition beside the default',
      block({ inner: { X1_R1: '' } }),
      'path_when_required',
      'X1_R1',
    ],
    [
      'a condition on the default flow',
      block({ inner: { X1_R2: cond(GT5) } }),
      'fallback_when',
      'X1_R2',
    ],
  ]
  it.each(COMPILE)('%s', async (_, xml, code, id) => {
    const r = await compiled(xml)
    expect(r.ok ? [] : r.errors.map((e) => [e.code, e.id])).toEqual([[code, id]])
  })

  it('a condition that is no OR of AND groups: a shape error on its flow', async () => {
    const r = await compiled(block({ inner: { X1_R1: cond({ field: 'days' }) } }))
    expect(r.ok ? [] : r.errors.map((e) => [e.code, e.id])).toEqual([['shape', 'X1_R1']])
  })

  it('a JSON null condition, on the default flow too: a shape error on its flow', async () => {
    const r = await compiled(block({ inner: { X1_R2: cond('null') } }))
    expect(r.ok ? [] : r.errors.map((e) => [e.code, e.id])).toEqual([['shape', 'X1_R2']])
  })

  it('a review or carbon copy without qw:Config: shape errors on it', async () => {
    for (const id of ['R1', 'C1']) {
      const r = await compiled(full({ flows: 'S>R1>C1>E1', inner: { [id]: '' } }))
      expect(r.ok).toBe(false)
      expect(new Set(r.ok ? [] : r.errors.map((e) => `${e.code} ${e.id}`))).toEqual(
        new Set([`shape ${id}`]),
      )
    }
  })
})

describe('bpmnToTree: content rules in order', () => {
  it.each([
    [
      'documentation and a foreign attribute: only ②',
      base({
        attrs: { R1: ' xmlns:x="urn:x" x:y="1"' },
        inner: { R1: '<bpmn:documentation>x</bpmn:documentation>' },
      }),
      'bpmn_unsupported',
      'R1',
    ],
    [
      'a foreign attribute and ${} in a name: only ③',
      base({
        attrs: { R1: ' xmlns:x="urn:x" x:y="1"' },
        names: { C1: '${x}' },
        flows: 'S>R1>C1>E1',
      }),
      'bpmn_foreign',
      'R1',
    ],
    [
      "a condition in another language on a task's flow: only ④",
      base({ inner: { R1_E1: cond(GT5, 'xsi:type="bpmn:tFormalExpression" language="js"') } }),
      'bpmn_expression',
      'R1_E1',
    ],
    [
      "a condition on a task's flow and a flow to a flow: only ⑤",
      base({ inner: { S_R1: cond(GT5) } }).replace('targetRef="E1"', 'targetRef="S_R1"'),
      'bpmn_condition_misplaced',
      'S_R1',
    ],
    // ⑤ leaves an unresolved source to ⑥
    ...['constructor', '__proto__'].map(
      (ref) =>
        [
          `a condition on a flow from sourceRef="${ref}"`,
          base({ inner: { R1_E1: cond(GT5) } }).replace('sourceRef="R1"', `sourceRef="${ref}"`),
          'bpmn_ref',
          'R1_E1',
        ] as const,
    ),
    [
      'invalid settings and a branch ending early: only ⑩',
      fixture({
        flows: 'S>R0>X1>R1>XJ>E1 X1>R2>XJ X1>R3>E2',
        inner: { R0: cfg({ ...REVIEW, next: {} }) },
      }),
      'bpmn_unstructured',
      'XJ',
    ],
  ] as const)('%s', async (_, xml, code, id) => {
    expect(await convert(xml)).toEqual(refused(code, id))
  })

  it('reports every element with invalid settings', async () => {
    const xml = fixture({ flows: 'S>R1>C1>E1', inner: { S: cfg('[]'), C1: cfg(REVIEW) } })
    expect(await convert(xml)).toEqual({
      ok: false,
      errors: ['S', 'C1'].map((id) => ({ code: 'bpmn_config', id })),
    })
  })
})
