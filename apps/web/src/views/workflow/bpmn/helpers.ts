import type { WfCondition, WfForkMode } from '@qiwu/shared'
import { newStep } from '../designer/tree'
import { editOf, written, type Written } from './element-node'

/**
 * Editing helpers of the BPMN designer, the bpmn-js service `qwHelpers`:
 * - default naming: a new review (user task) or carbon copy (send task) gets the tree designer's default name and
 *   settings (`newStep`: nobody picked yet) as its `qw:Config`;
 * - join helper ①, "insert branch block" (`qw.block.insert`, one undo step): a fork, two empty paths and their
 *   join, all of one type, right after an element; the element's outgoing flows leave from the join instead;
 * - join helper ②: a fork changing type takes its join along (within the same undo step);
 * - the settings panel's commands, one undo step each: `qw.element.update` writes what the panel edits back
 *   (`written`), `qw.flow.reorder` swaps two of a fork's flows in `flowElements` (the path order), and join
 *   helper ③, "add path" (`qw.path.add`): a flow from a fork to its join (an end of its own when it has none).
 * diagram-js services come through injection (bpmn-js is the only package imported).
 */

/** a moddle object (business object, `bpmn:ExtensionElements`, `qw:Config`, …) as far as used here */
export interface Bo {
  $type: string
  $parent?: Bo
  name?: string
  body?: string
  values?: Bo[]
  extensionElements?: Bo
  flowElements?: Bo[]
  /** a gateway's default flow */
  default?: Bo
  /** a flow's condition (`bpmn:FormalExpression`) */
  conditionExpression?: Bo
  language?: string
}
/** a diagram-js shape or connection */
export interface El {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  businessObject: Bo
  parent?: El
  incoming: El[]
  outgoing: El[]
  source?: El
  target?: El
  waypoints?: Point[]
}
export interface Point {
  x: number
  y: number
}
/** a command's or command interceptor's event */
export interface CommandEvent<C> {
  context: C
}
export interface EventBus {
  on<C>(events: string | string[], priority: number, fn: (e: CommandEvent<C>) => void): void
}
interface Modeling {
  createShape(shape: { type: string }, at: Point, parent: El): El
  connect(from: El, to: El, attrs?: { type: string; waypoints: Point[] }): El
  appendShape(source: El, shape: { type: string }, at: Point): El
  reconnectStart(flow: El, from: El, docking: Point): void
  moveElements(shapes: El[], delta: Point): void
  updateProperties(element: El, props: Record<string, unknown>): void
}
interface Moddle {
  create(type: string, attrs: object): Bo
}

export type StepKind = 'review' | 'notify'
/** the BPMN type of a review / carbon copy */
export const TASK: Record<StepKind, string> = { review: 'bpmn:UserTask', notify: 'bpmn:SendTask' }
export const kindOf = (type: string) =>
  (Object.keys(TASK) as StepKind[]).find((kind) => TASK[kind] === type)
/** the BPMN type of a fork / join */
export const GATEWAY: Record<WfForkMode, string> = {
  exclusive: 'bpmn:ExclusiveGateway',
  parallel: 'bpmn:ParallelGateway',
  inclusive: 'bpmn:InclusiveGateway',
}
const isGateway = (el: El) => Object.values(GATEWAY).includes(el.type)

/** A new review's / carbon copy's name and `qw:Config` (the tree node without id, type and name). */
export function stepDefaults(kind: StepKind) {
  const step: Record<string, unknown> = { ...newStep(kind, new Set()) }
  const name = step.name as string
  for (const key of ['id', 'type', 'name']) delete step[key]
  return { name, config: step }
}

/**
 * The join closing `fork`: one path walked, each fork on it opening a block and each join closing one (the block
 * structure publishing requires); none when the path ends or loops first.
 */
export function joinOf(fork: El): El | undefined {
  let depth = 1
  const seen = new Set<El>()
  for (let el = fork.outgoing[0]?.target; el && !seen.has(el); el = el.outgoing[0]?.target) {
    seen.add(el)
    if (isGateway(el) && el.incoming.length > 1 && --depth === 0) return el
    if (isGateway(el) && el.outgoing.length > 1) depth++
  }
}

/** a command handler: a composite one does its modeling calls in `preExecute`, a plain one changes in `execute` */
interface Handler {
  preExecute?(ctx: object): void
  /** changes the diagram; the elements to redraw */
  execute?(ctx: object): El[]
  revert?(ctx: object): El[]
}

/** px: fork center right of the element, join center right of the fork, the second path's drop, room made */
const FORK = 80
const SPAN = 170
const DROP = 100
const ROOM = 300

const mid = (s: El): Point => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 })
const bottom = (s: El): Point => ({ x: s.x + s.width / 2, y: s.y + s.height })

function qwHelpers(
  eventBus: EventBus,
  commandStack: {
    register(command: string, handler: Handler): void
    execute(command: string, ctx: object): void
  },
  modeling: Modeling,
  elementFactory: { createShape(attrs: { type: string; businessObject: Bo }): El },
  bpmnFactory: Moddle,
  moddle: Moddle,
  elementRegistry: { filter(fn: (el: El) => boolean): El[] },
  bpmnReplace: { replaceElement(el: El, target: { type: string }): El },
) {
  /** a new `bpmn:ExtensionElements` of `owner` holding `config` as its only `qw:Config` */
  function extension(owner: Bo, config: object): Bo {
    const qw = moddle.create('qw:Config', { body: JSON.stringify(config) })
    const ext = bpmnFactory.create('bpmn:ExtensionElements', { values: [qw] })
    qw.$parent = ext
    ext.$parent = owner
    return ext
  }

  /** A new review / carbon copy shape: default name and settings. */
  function task(kind: StepKind): El {
    const { name, config } = stepDefaults(kind)
    const bo = bpmnFactory.create(TASK[kind], { name })
    bo.extensionElements = extension(bo, config)
    return elementFactory.createShape({ type: TASK[kind], businessObject: bo })
  }

  // ① every modeling call below is a step of this command: one undo takes the whole block back
  commandStack.register('qw.block.insert', {
    preExecute(ctx: { element: El; mode: WfForkMode }) {
      const { element, mode } = ctx
      const parent = element.parent!
      const right = element.x + element.width
      const y = mid(element).y
      const outs = [...element.outgoing]
      // room for the block: what lies right of the element moves right
      const later = elementRegistry.filter(
        (el) => !!el.parent && !el.waypoints && el.type !== 'label' && el.x >= right,
      )
      if (later.length) modeling.moveElements(later, { x: ROOM, y: 0 })
      const fork = modeling.createShape({ type: GATEWAY[mode] }, { x: right + FORK, y }, parent)
      const join = modeling.createShape(
        { type: GATEWAY[mode] },
        { x: right + FORK + SPAN, y },
        parent,
      )
      for (const flow of outs) modeling.reconnectStart(flow, join, mid(join))
      modeling.connect(element, fork)
      modeling.connect(fork, join)
      const low = bottom(fork).y + DROP
      const other = modeling.connect(fork, join, {
        type: 'bpmn:SequenceFlow',
        waypoints: [
          bottom(fork),
          { x: mid(fork).x, y: low },
          { x: mid(join).x, y: low },
          bottom(join),
        ],
      })
      // the tree designer's new fork: a conditional path and the fallback one
      if (mode !== 'parallel') modeling.updateProperties(fork, { default: other.businessObject })
    },
  })

  // ② a fork's new type goes to its join too (a nested replace: the same undo step); after bpmn-js's own
  // replace behaviors, so the flows are final
  eventBus.on<{ oldShape: El; newShape: El }>(
    'commandStack.shape.replace.postExecuted',
    500,
    ({ context: { oldShape, newShape } }) => {
      if (!isGateway(oldShape) || !isGateway(newShape) || oldShape.type === newShape.type) return
      if (newShape.incoming.length > 1 || newShape.outgoing.length < 2) return
      const join = joinOf(newShape)
      if (join && join.type !== newShape.type)
        bpmnReplace.replaceElement(join, { type: newShape.type })
    },
  )

  /** a flow's `qw-rule` condition holding `when` */
  function condition(flow: Bo, when: WfCondition[][]): Bo {
    const expr = bpmnFactory.create('bpmn:FormalExpression', {
      language: 'qw-rule',
      body: JSON.stringify(when),
    })
    expr.$parent = flow
    return expr
  }

  // the panel's edit: what differs from the element now, in one undo step (a fallback mark is the fork's
  // `default`)
  commandStack.register('qw.element.update', {
    preExecute(ctx: { element: El; written: Written }) {
      const { element, written: next } = ctx
      const bo = element.businessObject
      const now = written(editOf(element))
      const differs = (key: keyof Written) => JSON.stringify(next[key]) !== JSON.stringify(now[key])
      const props: Record<string, unknown> = {}
      if (differs('name')) props.name = next.name
      if (next.config && differs('config'))
        props.extensionElements = Object.keys(next.config).length
          ? extension(bo, next.config)
          : undefined
      if (differs('when')) props.conditionExpression = next.when && condition(bo, next.when)
      if (Object.keys(props).length) modeling.updateProperties(element, props)
      if (differs('fallback') && element.source)
        modeling.updateProperties(element.source, { default: next.fallback ? bo : undefined })
    },
  })

  // two flows of a fork trade places in `flowElements` (the path order); swapped back on undo
  const swap = ({ a, b }: { a: El; b: El }) => {
    const all = a.businessObject.$parent!.flowElements!
    const i = all.indexOf(a.businessObject)
    const j = all.indexOf(b.businessObject)
    ;[all[i], all[j]] = [all[j]!, all[i]!]
    return [a, b]
  }
  commandStack.register('qw.flow.reorder', { execute: swap, revert: swap })

  // ③ a fork's new path, to its join below the paths drawn (none: to an end of its own)
  commandStack.register('qw.path.add', {
    preExecute(ctx: { fork: El; flow?: El }) {
      const { fork } = ctx
      const join = joinOf(fork)
      const flows = [...fork.outgoing, ...(join?.incoming ?? [])]
      const low = Math.max(...flows.flatMap((f) => (f.waypoints ?? []).map((p) => p.y))) + DROP
      ctx.flow = join
        ? modeling.connect(fork, join, {
            type: 'bpmn:SequenceFlow',
            waypoints: [
              bottom(fork),
              { x: mid(fork).x, y: low },
              { x: mid(join).x, y: low },
              bottom(join),
            ],
          })
        : modeling.appendShape(fork, { type: 'bpmn:EndEvent' }, { x: mid(fork).x + FORK, y: low })
            .incoming[0]
    },
  })

  return {
    task,
    extension,
    /** ①: a `mode` branch block right after `element` (one undo step) */
    insertBlock: (element: El, mode: WfForkMode) =>
      commandStack.execute('qw.block.insert', { element, mode }),
    /** the panel's edit of `element` written back (one undo step; none when it holds that already) */
    update(element: El, edit: Written) {
      if (JSON.stringify(edit) !== JSON.stringify(written(editOf(element))))
        commandStack.execute('qw.element.update', { element, written: edit })
    },
    /** flows `a` and `b` of a fork trade places in the path order (one undo step) */
    reorder: (a: El, b: El) => commandStack.execute('qw.flow.reorder', { a, b }),
    /** ③: a new path of `fork` (one undo step); its flow */
    addPath(fork: El): El | undefined {
      const ctx: { fork: El; flow?: El } = { fork }
      commandStack.execute('qw.path.add', ctx)
      return ctx.flow
    },
  }
}
qwHelpers.$inject = [
  'eventBus',
  'commandStack',
  'modeling',
  'elementFactory',
  'bpmnFactory',
  'moddle',
  'elementRegistry',
  'bpmnReplace',
]
export type QwHelpers = ReturnType<typeof qwHelpers>

export default { __init__: ['qwHelpers'], qwHelpers: ['factory', qwHelpers] }
