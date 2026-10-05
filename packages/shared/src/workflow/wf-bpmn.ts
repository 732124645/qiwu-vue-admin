import type { z } from 'zod'
import { WF_BPMN_XML_MAX } from './wf-model.schema.js'
import {
  WF_FORK_MODES,
  WF_ID_MAX,
  WF_NAME_MAX,
  wfBeginConfig,
  wfNotifyConfig,
  wfReviewConfig,
  type WfBeginNode,
  type WfCondition,
  type WfForkMode,
  type WfForkNode,
  type WfForkPath,
  type WfNotifyNode,
  type WfReviewNode,
  type WfStep,
} from './wf.schema.js'

/**
 * BPMN notation (–5): a BPMN model is drawn in bpmn-js and compiled to the process tree on
 * publish; the tree engine runs it as any tree. Same code in the designer (bpmn-js definitions) and on the
 * server (bpmn-moddle strict parse of the XML): it reads moddle objects field by field (`$type`, own keys,
 * `flowElements`, `sourceRef`, …) and imports nothing but shared files.
 */

/**
 * The `qw` moddle package, for bpmn-js `moddleExtensions` and `new BpmnModdle({ qw })`: one type,
 * `qw:Config`, inside the `extensionElements` of a start event, review (user task) or carbon copy (send task);
 * its body is the tree node's settings as JSON. The URI carries a version for when the structure changes.
 */
export const WF_BPMN_MODDLE = {
  name: 'Qiwu',
  prefix: 'qw',
  uri: 'urn:qiwu:bpmn:1',
  associations: [],
  types: [
    {
      name: 'Config',
      superClass: ['Element'],
      properties: [{ name: 'body', type: 'String', isBody: true }],
    },
  ],
}

/** Why a diagram is refused (texts `validation.wf.bpmn_*`, param `node` = the element id). */
export const WF_BPMN_CODES = [
  /** more than `WF_BPMN_XML_MAX` UTF-8 bytes */
  'bpmn_too_large',
  /** a DOCTYPE or ENTITY declaration */
  'bpmn_doctype',
  /** ① the root elements are not exactly one process */
  'bpmn_process',
  /** ① a pool (collaboration / participant) or lanes */
  'bpmn_pool',
  /** ② an element type outside the subset, or a key outside its type's allowlist */
  'bpmn_unsupported',
  /** ③ a foreign attribute, or an extension element other than `qw:Config` (listeners, other tools' settings) */
  'bpmn_foreign',
  /** ④ `${` in a string, or a condition that is not `qw-rule` JSON */
  'bpmn_expression',
  /** ⑤ a condition or default anywhere but on a branching gateway's flows (id = the flow, else the gateway) */
  'bpmn_condition_misplaced',
  /** ⑥ a flow end or a gateway's default that is not an element of this process (or not a node) */
  'bpmn_ref',
  /** ⑬ diagram interchange: not one plane over the process, an element without exactly one DI, colors; a node
   * smaller than 10 × 10 or overlapping another, a flow drawn as a point, not from its source to its target or
   * within 5 px of another node */
  'bpmn_di',
  /** ⑦ an id the tree and XML do not both take, or a name over `WF_NAME_MAX` */
  'bpmn_id',
  /** ⑧ not exactly one start event */
  'bpmn_start',
  /** ⑧ the wrong number of incoming / outgoing flows for the element's type */
  'bpmn_arity',
  /** ⑨ not reachable from the start event */
  'bpmn_unreachable',
  /** ⑨ a loop (id = its first element) */
  'bpmn_cycle',
  /** ⑩ a branching gateway joined by a gateway of another type (id = the branching one) */
  'bpmn_join_type',
  /** ⑩ a joining gateway that does not close exactly one block (id = the joining gateway) */
  'bpmn_unstructured',
  /** ⑪ more than one `qw:Config`, or a body that is no JSON object its node type's strict schema takes */
  'bpmn_config',
] as const
export type WfBpmnCode = (typeof WF_BPMN_CODES)[number]

export interface WfBpmnError {
  code: WfBpmnCode
  /** the element it belongs to (the designer marks it); null = no single element */
  id: string | null
}

export type WfBpmnResult =
  | {
      ok: true
      tree: WfBeginNode
      /** joining gateway id → the branching gateway (fork) it closes */
      joins: Record<string, string>
    }
  | { ok: false; errors: WfBpmnError[] }

/**
 * Cheap checks before any XML parse: at most `WF_BPMN_XML_MAX` UTF-8 bytes (counted here: shared
 * has no `Buffer` / `TextEncoder`; a lone surrogate counts 3, as its U+FFFD), no DOCTYPE / ENTITY declaration.
 */
export function bpmnPrecheck(xml: string): 'bpmn_too_large' | 'bpmn_doctype' | null {
  let bytes = 0
  for (const ch of xml) {
    const cp = ch.codePointAt(0)!
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
  }
  if (bytes > WF_BPMN_XML_MAX) return 'bpmn_too_large'
  return /<!(DOCTYPE|ENTITY)/i.test(xml) ? 'bpmn_doctype' : null
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const idOf = (v: unknown) => (isObj(v) && typeof v.id === 'string' ? v.id : null)
/** `JSON.parse`, undefined for a non-string or no JSON (JSON itself never parses to undefined). */
function json(text: unknown): unknown {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const FLOW = 'bpmn:SequenceFlow'
const START = 'bpmn:StartEvent'
const END = 'bpmn:EndEvent'
type Kind = 'begin' | 'end' | 'review' | 'notify' | WfForkMode
/** Flow node types of the subset and what each becomes. */
const KINDS = new Map<unknown, Kind>([
  [START, 'begin'],
  [END, 'end'],
  ['bpmn:UserTask', 'review'],
  ['bpmn:SendTask', 'notify'],
  ['bpmn:ExclusiveGateway', 'exclusive'],
  ['bpmn:ParallelGateway', 'parallel'],
  ['bpmn:InclusiveGateway', 'inclusive'],
])
const isGateway = (o: Obj) => (WF_FORK_MODES as readonly unknown[]).includes(KINDS.get(o.$type))
const EXPRESSION = 'bpmn:FormalExpression'
const CONFIG = 'qw:Config'
/** The strict `qw:Config` schema of each configured element type (rule ⑪). */
const CONFIGS = new Map<unknown, z.ZodType<object>>([
  [START, wfBeginConfig],
  ['bpmn:UserTask', wfReviewConfig],
  ['bpmn:SendTask', wfNotifyConfig],
])

const CONFIGURED = ['id', 'name', 'incoming', 'outgoing', 'extensionElements']
const GATEWAY = ['id', 'name', 'incoming', 'outgoing', 'default', 'gatewayDirection']
/**
 * Own keys (`$` ones aside) each type may carry (rule ②, ⑬): an allowlist, so settings no designer shows
 * (`documentation`, `resources`, `isForCompensation`, loop markers, event definitions, …) are refused instead
 * of being kept unseen. Matches what bpmn-js 18.30.1 `saveXML` writes (locked by a bpmn-js export fixture).
 */
const KEYS = new Map<unknown, readonly string[]>([
  [
    'bpmn:Definitions',
    ['id', 'targetNamespace', 'exporter', 'exporterVersion', 'rootElements', 'diagrams'],
  ],
  ['bpmn:Process', ['id', 'name', 'isExecutable', 'flowElements']],
  [START, CONFIGURED],
  ['bpmn:UserTask', CONFIGURED],
  ['bpmn:SendTask', CONFIGURED],
  [END, ['id', 'name', 'incoming', 'outgoing']],
  ['bpmn:ExclusiveGateway', GATEWAY],
  ['bpmn:ParallelGateway', GATEWAY],
  ['bpmn:InclusiveGateway', GATEWAY],
  [FLOW, ['id', 'name', 'sourceRef', 'targetRef', 'conditionExpression']],
  ['bpmn:ExtensionElements', ['values']],
  ['bpmn:FormalExpression', ['body', 'language']],
  ['bpmndi:BPMNDiagram', ['id', 'plane']],
  ['bpmndi:BPMNPlane', ['id', 'bpmnElement', 'planeElement']],
  ['bpmndi:BPMNShape', ['id', 'bpmnElement', 'bounds', 'label', 'isMarkerVisible']],
  ['bpmndi:BPMNEdge', ['id', 'bpmnElement', 'waypoint', 'label']],
  ['bpmndi:BPMNLabel', ['bounds']],
  ['dc:Bounds', ['x', 'y', 'width', 'height']],
  ['dc:Point', ['x', 'y']],
])
/**
 * A value moddle never writes: absent, null or an empty list. bpmn-js leaves such keys in memory (reading a list
 * through moddle's `get` creates `[]`, e.g. `eventDefinitions`, `lanes`; a cleared label sets `name` to null),
 * so the designer's own check has to pass them as the server's parse of the saved XML does.
 */
const blank = (v: unknown) => v == null || (Array.isArray(v) && v.length === 0)
/**
 * `o` is a moddle object of `type` with no own key outside the type's allowlist that holds anything.
 * Non-enumerable ones count: moddle sets references (`sourceRef`, `default`, `messageRef`, …) that way.
 */
function is(o: unknown, type: string): o is Obj {
  if (!isObj(o) || o.$type !== type) return false
  const keys = KEYS.get(type)!
  return Object.getOwnPropertyNames(o).every(
    (k) => k.startsWith('$') || keys.includes(k) || blank(o[k]),
  )
}
/**
 * Diagram interchange (rule ⑬) carries geometry only: the allowlist and no `$attrs`. Colors (`color:*`,
 * `bioc:*`) are known properties of bpmn-moddle, so they show up as own keys, not in `$attrs`.
 */
const isDi = (o: unknown, type: string): o is Obj =>
  is(o, type) && (!isObj(o.$attrs) || Object.keys(o.$attrs).length === 0)
/**
 * Bounds / a waypoint with every coordinate a finite number (the DC schema requires them; the strict parse does
 * not): bpmn-js skips a shape without bounds (an import warning, nothing drawn) and draws NaN nowhere.
 */
const isGeo = (o: unknown, type: 'dc:Bounds' | 'dc:Point'): o is Obj =>
  isDi(o, type) && KEYS.get(type)!.every((k) => Number.isFinite(o[k]))
type Point = { x: number; y: number }
type Box = Point & { width: number; height: number }
/** Rule ⑬ geometry: a node's least width / height, and how far off its bounds a flow end may be (rounding). */
const DI_MIN = 10
const DI_DOCK = 5
/** Bounds sharing any area (touching edges do not). */
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
/** A point on or in the bounds, give or take `DI_DOCK` (bpmn-js docks on an event's circle, a gateway's rhombus). */
const docked = (p: Point, b: Box | undefined) =>
  b !== undefined &&
  p.x >= b.x - DI_DOCK &&
  p.x <= b.x + b.width + DI_DOCK &&
  p.y >= b.y - DI_DOCK &&
  p.y <= b.y + b.height + DI_DOCK
/** The segment p–q comes within `DI_DOCK` of the bounds (slab test: the part of it inside both axes' bands). */
function nears(p: Point, q: Point, b: Box): boolean {
  let lo = 0
  let hi = 1
  for (const [from, d, min, max] of [
    [p.x, q.x - p.x, b.x - DI_DOCK, b.x + b.width + DI_DOCK],
    [p.y, q.y - p.y, b.y - DI_DOCK, b.y + b.height + DI_DOCK],
  ] as const) {
    if (d === 0) {
      if (from < min || from > max) return false
    } else {
      const [a, c] = [(min - from) / d, (max - from) / d]
      lo = Math.max(lo, Math.min(a, c))
      hi = Math.min(hi, Math.max(a, c))
    }
  }
  return lo <= hi
}

/** Tree and XML id at once (tree `^[\w-]{1,64}$`, XML NCName start); no `__` prefix or prototype name. */
const ID = new RegExp(`^[A-Za-z_][\\w-]{0,${WF_ID_MAX - 1}}$`)
const badId = (id: unknown) =>
  typeof id !== 'string' ||
  !ID.test(id) ||
  id.startsWith('__') ||
  Object.hasOwn(Object.prototype, id)
/** An id the diagram takes as it is (rule ⑦): the web renames any other before drawing a tree (import). */
export const isBpmnId = (id: string) => !badId(id)
const badName = (name: unknown) =>
  name != null && (typeof name !== 'string' || name.length > WF_NAME_MAX)

/**
 * Compiles a BPMN diagram (bpmn-js `getDefinitions()`, or bpmn-moddle's strict parse on the server) to the
 * process tree: element id = node id, branching gateway = fork, its outgoing flows = the
 * paths in document order, its `default` = the fallback path, its conditions (`qw-rule` JSON) = the paths'
 * `when`, a `qw:Config` = the node's settings. Rules ①–⑥⑬⑦–⑪ in this order; a stage reports all its errors
 * and stops the rest, which rely on it. Every walk uses an explicit stack. Rule ⑫ is the caller's: the tree
 * goes on to `compile(tree, fields)`, whose error ids are element / flow ids as well (no `qw:Config` on a
 * review or carbon copy = a node without settings, which `compile` refuses as a `shape` error on it).
 */
export function bpmnToTree(definitions: unknown): WfBpmnResult {
  const errors: WfBpmnError[] = []
  const fail = (code: WfBpmnCode, el?: unknown) => {
    const id = idOf(el)
    if (!errors.some((e) => e.code === code && e.id === id)) errors.push({ code, id })
  }

  // ① one process, no pool or lanes
  const defs = isObj(definitions) ? definitions : {}
  const roots = list(defs.rootElements)
  for (const root of roots)
    if (root.$type === 'bpmn:Collaboration') fail('bpmn_pool', list(root.participants)[0] ?? root)
  const process = roots.length === 1 && roots[0]?.$type === 'bpmn:Process' ? roots[0] : undefined
  if (!process && !errors.length) fail('bpmn_process')
  for (const set of list(process?.laneSets)) fail('bpmn_pool', list(set.lanes)[0] ?? set)
  if (errors.length || !process) return { ok: false, errors }

  // ② element types of the subset, each with its allowlisted keys only
  const els = list(process.flowElements)
  if (!is(defs, 'bpmn:Definitions')) fail('bpmn_unsupported', defs)
  if (!is(process, 'bpmn:Process')) fail('bpmn_unsupported', process)
  for (const el of els) {
    const type = el.$type
    const ok =
      (KINDS.has(type) || type === FLOW) &&
      is(el, type as string) &&
      (el.extensionElements == null || is(el.extensionElements, 'bpmn:ExtensionElements')) &&
      (el.conditionExpression == null || is(el.conditionExpression, 'bpmn:FormalExpression'))
    if (!ok) fail('bpmn_unsupported', el)
  }
  if (errors.length) return { ok: false, errors }

  // the objects ③ and ④ read, each with the element it belongs to: definitions, process, flow elements, their
  // extension elements and `qw:Config`s, conditions. Never deeper: foreign content is refused, not walked.
  const checked: [Obj, Obj][] = [
    [defs, defs],
    [process, process],
  ]
  const extOf = (el: Obj) => (isObj(el.extensionElements) ? list(el.extensionElements.values) : [])
  for (const el of els) {
    checked.push([el, el])
    if (isObj(el.extensionElements)) checked.push([el.extensionElements, el])
    for (const value of extOf(el)) checked.push([value, el])
    if (isObj(el.conditionExpression)) checked.push([el.conditionExpression, el])
  }
  const attrs = (o: Obj) => (isObj(o.$attrs) ? o.$attrs : {})

  // ③ nothing of other tools: no `$attrs` (foreign attributes such as `flowable:assignee`: the strict parse
  // keeps them without a warning) but namespace declarations and a condition's `xsi:type` (bpmn-js writes it on
  // every condition, moddle has typed the object by it); no extension element but `qw:Config` (listeners,
  // foreign extensions)
  for (const [o, el] of checked) {
    const foreign = Object.keys(attrs(o)).some(
      (k) =>
        k !== 'xmlns' && !k.startsWith('xmlns:') && !(k === 'xsi:type' && o.$type === EXPRESSION),
    )
    if (foreign) fail('bpmn_foreign', el)
  }
  for (const el of els) if (extOf(el).some((v) => v.$type !== CONFIG)) fail('bpmn_foreign', el)
  if (errors.length) return { ok: false, errors }

  // ④ nothing read as an expression: `${` in no string of those objects (names, condition and `qw:Config`
  // bodies and their parsed JSON, `$attrs` values; parsed, so `&#36;&#123;` and `\u0024{` too); a condition is
  // `qw-rule` JSON (a path's `when`, OR of AND groups), never evaluated
  const expression = (v: unknown) => typeof v === 'string' && v.includes('${')
  /** a JSON body's keys and strings once parsed: a JSON escape (`\u0024{`) hides `${` from the raw text */
  const parsedExpression = (body: unknown) => {
    const stack = [json(body)]
    while (stack.length) {
      const v = stack.pop()
      if (expression(v)) return true
      if (isObj(v)) for (const [k, x] of Object.entries(v)) stack.push(k, x)
    }
    return false
  }
  for (const [o, el] of checked) {
    const strings = [...Object.getOwnPropertyNames(o).map((k) => o[k]), ...Object.values(attrs(o))]
    if (strings.some(expression) || parsedExpression(o.body)) fail('bpmn_expression', el)
  }
  const rules = new Map<Obj, unknown>()
  for (const flow of els) {
    const cond = flow.conditionExpression
    if (!isObj(cond)) continue
    const rule = cond.language === 'qw-rule' ? json(cond.body) : undefined
    if (rule === undefined) fail('bpmn_expression', flow)
    rules.set(flow, rule)
  }
  if (errors.length) return { ok: false, errors }

  // ⑤ conditions and defaults only on a branching gateway's (≥ 2 outgoing flows) flows, the only ones the tree
  // reads: one on a task's or a join's flow would never run (bpmn-js even draws a task's). A parallel gateway's
  // go on to `compile` (`parallel_path`); an unresolved source is ⑥'s.
  const byId = new Map<unknown, Obj>(els.map((el) => [el.id, el]))
  const known = (v: unknown): v is Obj => isObj(v) && byId.get(v.id) === v
  const fanOut = new Map<unknown, number>()
  for (const flow of els)
    if (flow.$type === FLOW) fanOut.set(flow.sourceRef, (fanOut.get(flow.sourceRef) ?? 0) + 1)
  const branching = (el: Obj) => isGateway(el) && (fanOut.get(el) ?? 0) > 1
  for (const el of els) {
    if (rules.has(el) && known(el.sourceRef) && !branching(el.sourceRef))
      fail('bpmn_condition_misplaced', el)
    // id = the default flow when it is the gateway's own (where bpmn-js draws it), else the gateway
    const flow = el.default
    if (flow != null && !branching(el))
      fail('bpmn_condition_misplaced', known(flow) && flow.sourceRef === el ? flow : el)
  }
  if (errors.length) return { ok: false, errors }

  // ⑥ references: the very objects of this process (a dangling id resolves to `constructor`, `__proto__`, …
  // without a parse warning); flows join nodes, never flows. Nodes' `incoming` / `outgoing` are not read:
  // the verified flows stand for them.
  const isNode = (v: Obj) => KINDS.has(v.$type)
  const nodes = els.filter(isNode)
  const outs = new Map<Obj, Obj[]>(nodes.map((n) => [n, []]))
  const ins = new Map<Obj, Obj[]>(nodes.map((n) => [n, []]))
  for (const flow of els) {
    if (flow.$type !== FLOW) continue
    const { sourceRef: from, targetRef: to } = flow
    if (known(from) && known(to) && isNode(from) && isNode(to)) {
      outs.get(from)!.push(flow)
      ins.get(to)!.push(flow)
    } else fail('bpmn_ref', flow)
  }
  for (const node of nodes) {
    const flow = node.default
    if (flow != null && !(known(flow) && flow.sourceRef === node)) fail('bpmn_ref', node)
  }
  if (errors.length) return { ok: false, errors }

  // ⑬ one diagram whose plane draws this process; exactly one shape / edge per element, geometry only (bpmn-js
  // skips an element without DI silently, and DI colors can paint one invisible: drawn ≠ run)
  const diagrams = list(defs.diagrams)
  const plane = diagrams[0]?.plane
  if (diagrams.length !== 1) fail('bpmn_di')
  else if (!isDi(diagrams[0], 'bpmndi:BPMNDiagram')) fail('bpmn_di', diagrams[0])
  else if (!isDi(plane, 'bpmndi:BPMNPlane') || plane.bpmnElement !== process) fail('bpmn_di', plane)
  else {
    const drawn = new Set<Obj>()
    /** what the geometry checks read (DI that passed): node → its bounds, flow → its waypoints */
    const boxes = new Map<Obj, Box>()
    const lines = new Map<Obj, Point[]>()
    for (const di of list(plane.planeElement)) {
      const el = di.bpmnElement
      const edge = known(el) && el.$type === FLOW
      const ok =
        known(el) &&
        !drawn.has(el) &&
        isDi(di, edge ? 'bpmndi:BPMNEdge' : 'bpmndi:BPMNShape') &&
        (edge || isGeo(di.bounds, 'dc:Bounds')) &&
        (di.label == null ||
          (isDi(di.label, 'bpmndi:BPMNLabel') &&
            (di.label.bounds == null || isGeo(di.label.bounds, 'dc:Bounds')))) &&
        list(di.waypoint).every((point) => isGeo(point, 'dc:Point'))
      if (!ok) fail('bpmn_di', known(el) ? el : di)
      else if (edge) lines.set(el, list(di.waypoint) as Point[])
      else boxes.set(el, di.bounds as Box)
      if (known(el)) drawn.add(el)
    }
    for (const el of els) if (!drawn.has(el)) fail('bpmn_di', el)
    // geometry, so nothing hides on the diagram either (bpmn-js paints shapes in order, opaque, and draws
    // waypoints as given): a node at least `DI_MIN` wide and high that overlaps no node painted before it; a
    // flow whose waypoints are not all one point, the first on its source's bounds and the last on its
    // target's (within `DI_DOCK`), so no zero-length, detached or reversed line stands for another flow, and
    // that keeps more than `DI_DOCK` off every other node, so none runs unseen along a node's border or reads
    // as passing through it (a path around a review that skips it).
    // O(n²) overlap and clearance scans, fine for the few hundred shapes `WF_BPMN_XML_MAX` allows;
    // a flow drawn along other flows all the way still passes for them (bpmn-js itself draws a join's incoming
    // flows over one another, so overlapping flows cannot be refused) — compare flows if that matters
    if (!errors.length) {
      const painted: Box[] = []
      for (const [el, b] of boxes) {
        if (b.width < DI_MIN || b.height < DI_MIN || painted.some((c) => overlap(b, c)))
          fail('bpmn_di', el)
        painted.push(b)
      }
    }
    // (only over nodes that passed: a flow into a node stacked on another is near that other one too)
    if (!errors.length) {
      for (const [flow, points] of lines) {
        const first = points[0]
        const ok =
          first !== undefined &&
          points.some((p) => p.x !== first.x || p.y !== first.y) &&
          docked(first, boxes.get(flow.sourceRef as Obj)) &&
          docked(points.at(-1)!, boxes.get(flow.targetRef as Obj)) &&
          ![...boxes].some(
            ([node, b]) =>
              node !== flow.sourceRef &&
              node !== flow.targetRef &&
              points.slice(1).some((q, i) => nears(points[i]!, q, b)),
          )
        if (!ok) fail('bpmn_di', flow)
      }
    }
  }
  if (errors.length) return { ok: false, errors }

  // ⑦ ids both the tree and the XML take, names that fit `node_name`
  if (badId(process.id)) fail('bpmn_id', process)
  for (const el of els) if (badId(el.id) || badName(el.name)) fail('bpmn_id', el)
  if (errors.length) return { ok: false, errors }

  // ⑧ one start; flows per type (only a gateway merges: a task with two incoming flows is refused)
  const starts = nodes.filter((n) => n.$type === START)
  if (starts.length !== 1) fail('bpmn_start', starts[1])
  for (const node of nodes) {
    const i = ins.get(node)!.length
    const o = outs.get(node)!.length
    const kind = KINDS.get(node.$type)
    const ok =
      kind === 'begin'
        ? i === 0 && o === 1
        : kind === 'end'
          ? i > 0 && o === 0
          : kind === 'review' || kind === 'notify'
            ? i === 1 && o === 1
            : (i === 1 && o > 1) || (i > 1 && o === 1)
    if (!ok) fail('bpmn_arity', node)
  }
  if (errors.length) return { ok: false, errors }

  // ⑨ everything reachable from the start, no loop: iterative DFS, `post` = postorder (successors first)
  const start = starts[0]!
  const next = new Map(nodes.map((n) => [n, outs.get(n)!.map((f) => f.targetRef as Obj)]))
  /** the only successor (of a start, task or join) */
  const after = (el: Obj) => next.get(el)![0]!
  const done = new Map<Obj, boolean>([[start, false]]) // false = on the DFS stack
  const post: Obj[] = []
  const stack: [Obj, number][] = [[start, 0]]
  let loop: Obj | undefined
  while (stack.length) {
    const top = stack[stack.length - 1]!
    const to = next.get(top[0])![top[1]++]
    if (!to) {
      stack.pop()
      done.set(top[0], true)
      post.push(top[0])
    } else if (!done.has(to)) {
      done.set(to, false)
      stack.push([to, 0])
    } else if (!done.get(to)) loop ??= to
  }
  for (const node of nodes) if (!done.has(node)) fail('bpmn_unreachable', node)
  if (!errors.length && loop) fail('bpmn_cycle', loop)
  if (errors.length) return { ok: false, errors }

  // ⑩ blocks: a fork's join is its immediate postdominator, every end event folded into one virtual SINK, so
  // branches ending at one end event or at their own ones = a fork without join (no `next`). Each join closes
  // exactly one fork of its own type; one met anywhere else (a branch ending early while its siblings join,
  // nested forks sharing a join, a join across blocks) breaks the block structure the tree needs.
  // Postdominator sets intersected per node, O(n²) — fine within 80 KiB (~90 elements); switch to
  // Cooper–Harvey–Kennedy if diagrams ever reach thousands of elements
  const SINK: Obj = {}
  const pdom = new Map<Obj, Set<Obj>>([[SINK, new Set([SINK])]])
  for (const node of post) {
    if (node.$type === END) continue
    const [first, ...rest] = next.get(node)!.map((to) => pdom.get(to.$type === END ? SINK : to)!)
    pdom.set(node, new Set([node, ...[...first!].filter((d) => rest.every((r) => r.has(d)))]))
  }
  const joinOf = (fork: Obj) => {
    let join = SINK
    for (const d of pdom.get(fork)!)
      if (d !== fork && pdom.get(d)!.size > pdom.get(join)!.size) join = d
    return join
  }

  // ⑪ (reported after ⑩): at most one `qw:Config`, its body a JSON object the node type's strict schema takes —
  // no `next`, `id`, `type` or extra key, or a chain's last review, or a start straight to the end, could
  // carry a subtree the diagram never shows. Nodes are built from the parsed result (extra keys of nested
  // objects dropped), never from the raw JSON.
  const settings = new Map<Obj, object>()
  const badConfig: Obj[] = []
  for (const node of nodes) {
    const configs = extOf(node)
    const schema = CONFIGS.get(node.$type)
    if (!schema || !configs.length) continue
    const parsed = configs.length === 1 ? schema.safeParse(json(configs[0]!.body)) : undefined
    if (parsed?.success) settings.set(node, parsed.data)
    else badConfig.push(node)
  }

  const joins: Record<string, string> = {}
  const tree = {
    ...settings.get(start),
    id: start.id as string,
    type: 'begin',
    name: (start.name as string | undefined) || 'seed.wf.node.begin',
  } as WfBeginNode
  // chains to build: [first element, where the chain stops (its block's join; SINK on the main line), where
  // its first step hangs]
  type Work = [Obj, Obj, (step: WfStep) => void]
  const work: Work[] = [[after(start), SINK, (step) => (tree.next = step)]]
  while (work.length) {
    const [first, stop, hang] = work.pop()!
    let put = hang
    for (let el = first; el !== stop && el.$type !== END;) {
      const kind = KINDS.get(el.$type)!
      const id = el.id as string
      const name = el.name as string | undefined
      if (kind === 'review' || kind === 'notify') {
        const step = { ...settings.get(el), id, type: kind, name: name ?? '' } as
          WfReviewNode | WfNotifyNode
        put(step)
        put = (s) => (step.next = s)
        el = after(el)
        continue
      }
      if (ins.get(el)!.length > 1) {
        fail('bpmn_unstructured', el)
        break
      }
      const join = joinOf(el)
      if (join !== SINK) {
        if (join.$type !== el.$type) fail('bpmn_join_type', el)
        if (Object.hasOwn(joins, join.id as string)) {
          fail('bpmn_unstructured', join)
          break
        }
        joins[join.id as string] = id
      }
      const fork: WfForkNode = {
        id,
        type: 'fork',
        name: name || id,
        mode: kind as WfForkMode,
        paths: [],
      }
      const branches: Work[] = []
      for (const flow of outs.get(el)!) {
        const to = flow.targetRef as Obj
        const path: WfForkPath = {
          id: flow.id as string,
          name: (flow.name || to.name || flow.id) as string,
          // a JSON `null` condition stays null: `compile` refuses it as a shape error on the flow
          when: (rules.has(flow) ? rules.get(flow) : []) as WfCondition[][],
        }
        if (el.default === flow) path.fallback = true
        fork.paths.push(path)
        branches.push([to, join, (s) => (path.child = s)])
      }
      put(fork)
      work.push(...branches.reverse())
      if (join === SINK) break
      put = (s) => (fork.next = s)
      el = after(join)
    }
  }
  if (errors.length) return { ok: false, errors }
  for (const node of badConfig) fail('bpmn_config', node)
  return errors.length ? { ok: false, errors } : { ok: true, tree, joins }
}

/** XML text and attribute values: markup characters, and whitespace an attribute value would normalize away. */
const esc = (s: string) => s.replace(/[&<>"\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`)
const NAMESPACES = [
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"',
  'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"',
  'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"',
  'xmlns:di="http://www.omg.org/spec/DD/20100524/DI"',
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  `xmlns:qw="${WF_BPMN_MODDLE.uri}"`,
].join(' ')
const GATEWAYS: Record<WfForkMode, string> = {
  exclusive: 'exclusiveGateway',
  parallel: 'parallelGateway',
  inclusive: 'inclusiveGateway',
}
/** [width, height] by tag as bpmn-js draws them, a gateway otherwise; grid: a column per step, a row per branch */
const SIZES: Record<string, [number, number]> = {
  startEvent: [36, 36],
  endEvent: [36, 36],
  userTask: [100, 80],
  sendTask: [100, 80],
}
const COLUMN = 150
const ROW = 120
const NOT_CONFIG = ['id', 'type', 'name', 'next']

/**
 * Writes a process tree as a diagram of the subset, the inverse of `bpmnToTree`: tree id = element
 * id, path = the fork's outgoing flow (in path order, its condition the `qw-rule` JSON of `when`, the fallback
 * the gateway's `default`), node settings = its `qw:Config`; names through `nameOf` (the web passes `tx`: seed
 * keys become text, bpmn-js draws `name` as it is). Joins, end events, other flows and the DI get short ids
 * (`qwj_<n>`, `qwe_<n>`, `qwf_<n>`, …) that skip the tree's own. A fork without `next` on the main line's tail
 * (or on a tail path of such a fork, recursively) ends each path in an end event of its own; anywhere else it
 * gets its own join, linked on to the outer one, or the round trip would change the structure. Ids are written
 * as they are: one the tree takes but XML does not (`1x`) is the caller's to rename first (web import).
 * Block layout, left to right: a column per step, a row per branch.
 */
export function treeToXml(
  tree: WfBeginNode,
  { nameOf = (name: string) => name }: { nameOf?: (name: string) => string } = {},
): string {
  const taken = new Set([tree.id])
  const steps = tree.next ? [tree.next] : []
  while (steps.length) {
    const step = steps.pop()!
    taken.add(step.id)
    if (step.next) steps.push(step.next)
    if (step.type === 'fork')
      for (const path of step.paths) {
        taken.add(path.id)
        if (path.child) steps.push(path.child)
      }
  }
  let n = 0
  const fresh = (prefix: string) => {
    let id: string
    do id = `${prefix}_${++n}`
    while (taken.has(id))
    taken.add(id)
    return id
  }

  const shapes: { id: string; tag: string; col: number; row: number; xml: string }[] = []
  const flows: { id: string; from: string; to: string; row: number; xml: string }[] = []
  const named = (name: string | undefined) =>
    name === undefined ? '' : ` name="${esc(nameOf(name))}"`
  /** a node's settings (without `id`, `type`, `name`, `next`) as its `qw:Config`; none when empty */
  const config = (node: object) => {
    const body = Object.fromEntries(Object.entries(node).filter(([k]) => !NOT_CONFIG.includes(k)))
    return Object.keys(body).length
      ? `<bpmn:extensionElements><qw:Config>${esc(JSON.stringify(body))}</qw:Config></bpmn:extensionElements>`
      : ''
  }
  const shape = (id: string, tag: string, col: number, row: number, attrs = '', inner = '') =>
    shapes.push({
      id,
      tag,
      col,
      row,
      xml: `<bpmn:${tag} id="${esc(id)}"${attrs}>${inner}</bpmn:${tag}>`,
    })
  /** a flow into `to` on `row`: a fork's outgoing one carries its path (id, name, condition), any other a new id */
  type Entry = { from: string; path?: WfForkPath }
  const link = ({ from, path }: Entry, to: string, row: number) => {
    const id = path?.id ?? fresh('qwf')
    const when = path?.when?.length
      ? `<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="qw-rule">${esc(JSON.stringify(path.when))}</bpmn:conditionExpression>`
      : ''
    flows.push({
      id,
      from,
      to,
      row,
      xml: `<bpmn:sequenceFlow id="${esc(id)}"${named(path?.name)} sourceRef="${esc(from)}" targetRef="${esc(to)}">${when}</bpmn:sequenceFlow>`,
    })
  }
  /**
   * Lays out a chain from `entry` at (`col`, `row`) on to `target` (a join; null = end events of its own) →
   * [the next free column, the rows used]. Recursion depth = the tree's fork nesting.
   */
  const chain = (
    first: WfStep | undefined,
    entry: Entry,
    col: number,
    row: number,
    target: string | null,
  ): [number, number] => {
    let rows = 1
    for (let step = first; step; step = step.next) {
      if (step.type !== 'fork') {
        const tag = step.type === 'review' ? 'userTask' : 'sendTask'
        shape(step.id, tag, col++, row, named(step.name), config(step))
        link(entry, step.id, row)
        entry = { from: step.id }
        continue
      }
      const tag = GATEWAYS[step.mode ?? 'exclusive']
      const fallback = step.paths.find((p) => p.fallback)
      shape(
        step.id,
        tag,
        col,
        row,
        named(step.name) + (fallback ? ` default="${esc(fallback.id)}"` : ''),
      )
      link(entry, step.id, row)
      // no join only for a fork without `next` on the main line's tail (target null): its paths end there
      const join = step.next || target !== null ? fresh('qwj') : null
      let end = col + 1
      let below = row
      for (const path of step.paths) {
        const [c, r] = chain(path.child, { from: step.id, path }, col + 1, below, join)
        end = Math.max(end, c)
        below += r
      }
      rows = Math.max(rows, below - row)
      if (!join) return [end, rows]
      shape(join, tag, end, row)
      col = end + 1
      entry = { from: join }
    }
    if (target !== null) link(entry, target, row)
    else {
      const end = fresh('qwe')
      shape(end, 'endEvent', col++, row)
      link(entry, end, row)
    }
    return [col, rows]
  }
  shape(tree.id, 'startEvent', 0, 0, named(tree.name), config(tree))
  chain(tree.next, { from: tree.id }, 1, 0, null)

  // DI: shapes centered in their grid cells; a flow is straight within a row, else leaves a fork downwards or
  // enters a join from below; an empty path below the fork's row runs along its own row (not through the first)
  const boxes = new Map(
    shapes.map((s) => {
      const [w, h] = SIZES[s.tag] ?? [50, 50]
      return [s.id, { x: 100 + s.col * COLUMN, y: 100 + s.row * ROW, w, h }] as const
    }),
  )
  const di = [
    ...shapes.map(({ id, tag }) => {
      const { x, y, w, h } = boxes.get(id)!
      const marker = tag === 'exclusiveGateway' ? ' isMarkerVisible="true"' : ''
      return `<bpmndi:BPMNShape id="${fresh('qwd')}" bpmnElement="${esc(id)}"${marker}><dc:Bounds x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}"/></bpmndi:BPMNShape>`
    }),
    ...flows.map(({ id, from, to, row }) => {
      const a = boxes.get(from)!
      const b = boxes.get(to)!
      const y = 100 + row * ROW
      const points =
        a.y === b.y && y !== a.y
          ? [
              [a.x, a.y + a.h / 2],
              [a.x, y],
              [b.x, y],
              [b.x, b.y + b.h / 2],
            ]
          : a.y === b.y
            ? [
                [a.x + a.w / 2, a.y],
                [b.x - b.w / 2, b.y],
              ]
            : a.y < b.y
              ? [
                  [a.x, a.y + a.h / 2],
                  [a.x, b.y],
                  [b.x - b.w / 2, b.y],
                ]
              : [
                  [a.x + a.w / 2, a.y],
                  [b.x, a.y],
                  [b.x, b.y + b.h / 2],
                ]
      const waypoints = points.map(([x, y]) => `<di:waypoint x="${x}" y="${y}"/>`).join('')
      return `<bpmndi:BPMNEdge id="${fresh('qwd')}" bpmnElement="${esc(id)}">${waypoints}</bpmndi:BPMNEdge>`
    }),
  ]
  const process = fresh('qwp')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<bpmn:definitions ${NAMESPACES} id="${fresh('qwd')}" targetNamespace="${WF_BPMN_MODDLE.uri}">`,
    `<bpmn:process id="${process}">`,
    ...shapes.map((s) => s.xml),
    ...flows.map((f) => f.xml),
    '</bpmn:process>',
    `<bpmndi:BPMNDiagram id="${fresh('qwd')}"><bpmndi:BPMNPlane id="${fresh('qwd')}" bpmnElement="${process}">`,
    ...di,
    '</bpmndi:BPMNPlane></bpmndi:BPMNDiagram>',
    '</bpmn:definitions>',
    '',
  ].join('\n')
}
