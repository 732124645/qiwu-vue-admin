import type { WfForkMode } from '@qiwu/shared'
import { configOf } from './element-node'
import helpers, {
  GATEWAY,
  kindOf,
  stepDefaults,
  type Bo,
  type El,
  type EventBus,
  type QwHelpers,
  type StepKind,
} from './helpers'

/**
 * What the BPMN designer offers: updaters registered after bpmn-js's own providers cut the
 * palette, the context pad and the change-type menu down to the element subset publishing accepts,
 * new reviews / carbon copies come with default settings (`qwHelpers`). Two command hooks keep the diagram what
 * it shows: a review ↔ carbon copy change rewrites `qw:Config` for the new type (rule ⑪ would refuse the old
 * one, and nothing on the canvas shows what is missing), and an undone delete puts the element back at its
 * index in `flowElements` (bpmn-js appends it, which would silently reorder an exclusive fork's paths).
 */

/** after bpmn-js's providers (1000) and its multi-selection align entry (500) */
const LATE = 100
/** bpmn-js palette entries kept (the separator has no action) */
const PALETTE = [
  'hand-tool',
  'lasso-tool',
  'space-tool',
  'global-connect-tool',
  'tool-separator',
  'create.start-event',
  'create.end-event',
]
/** bpmn-js context pad entries kept (`append.end-event` = where appending is allowed) */
const PAD = ['append.end-event', 'connect', 'replace', 'delete']
const GATEWAYS = [
  'replace-with-exclusive-gateway',
  'replace-with-parallel-gateway',
  'replace-with-inclusive-gateway',
]
/** change-type menu entries per element type: like for like only */
const REPLACE: Record<string, string[]> = {
  'bpmn:UserTask': ['replace-with-send-task'],
  'bpmn:SendTask': ['replace-with-user-task'],
  'bpmn:ExclusiveGateway': GATEWAYS,
  'bpmn:ParallelGateway': GATEWAYS,
  'bpmn:InclusiveGateway': GATEWAYS,
  'bpmn:SequenceFlow': ['replace-with-sequence-flow', 'replace-with-default-flow'],
}
/** a default flow only leaves these, when branching (rule ⑤) */
const WITH_DEFAULT = [GATEWAY.exclusive, GATEWAY.inclusive]
const defaultable = (flow: El) =>
  !!flow.source && WITH_DEFAULT.includes(flow.source.type) && flow.source.outgoing.length > 1
const ICON: Record<WfForkMode, string> = {
  exclusive: 'bpmn-icon-gateway-xor',
  parallel: 'bpmn-icon-gateway-parallel',
  inclusive: 'bpmn-icon-gateway-or',
}
/** deletes whose undo bpmn-js appends to `flowElements` */
const DELETES = ['commandStack.shape.delete', 'commandStack.connection.delete']

type Entries = Record<string, unknown>
type Translate = (template: string) => string
type Action = (event: Event, element: El) => void

const pick = (entries: Entries, keys: readonly string[]): Entries =>
  Object.fromEntries(keys.filter((key) => key in entries).map((key) => [key, entries[key]]))

function restrict(
  eventBus: EventBus,
  palette: { registerProvider(priority: number, provider: object): void },
  contextPad: { registerProvider(priority: number, provider: object): void },
  popupMenu: { registerProvider(id: string, priority: number, provider: object): void },
  create: { start(event: Event, shape: El, context?: { source: El }): void },
  autoPlace: { append(source: El, shape: El): void },
  elementFactory: { createShape(attrs: { type: string }): El },
  modeling: { updateProperties(element: El, props: Record<string, unknown>): void },
  translate: Translate,
  qwHelpers: QwHelpers,
) {
  const entry = (
    group: string,
    className: string,
    title: string,
    action: Record<string, Action>,
  ) => ({
    group,
    className,
    title: translate(title),
    action,
  })
  /** a palette entry creating `shape()` (click, then click on the canvas; or drag) */
  const creating = (shape: () => El, group: string, className: string, title: string) => {
    const start = (event: Event) => create.start(event, shape())
    return entry(group, className, title, { click: start, dragstart: start })
  }
  /** a context pad entry appending a new review / carbon copy */
  const appending = (kind: StepKind, className: string, title: string) =>
    entry('model', className, title, {
      click: (_, el) => autoPlace.append(el, qwHelpers.task(kind)),
      dragstart: (event, el) => create.start(event, qwHelpers.task(kind), { source: el }),
    })
  const block = (mode: WfForkMode, title: string) =>
    entry('model', ICON[mode], title, { click: (_, el) => qwHelpers.insertBlock(el, mode) })
  const gateway = (mode: WfForkMode, title: string) =>
    creating(
      () => elementFactory.createShape({ type: GATEWAY[mode] }),
      'gateway',
      ICON[mode],
      title,
    )

  palette.registerProvider(LATE, {
    getPaletteEntries: () => (entries: Entries) => ({
      ...pick(entries, PALETTE),
      'create.user-task': creating(
        () => qwHelpers.task('review'),
        'activity',
        'bpmn-icon-user-task',
        'Create review',
      ),
      'create.send-task': creating(
        () => qwHelpers.task('notify'),
        'activity',
        'bpmn-icon-send-task',
        'Create carbon copy',
      ),
      'create.exclusive-gateway': gateway('exclusive', 'Create exclusive gateway'),
      'create.parallel-gateway': gateway('parallel', 'Create parallel gateway'),
      'create.inclusive-gateway': gateway('inclusive', 'Create inclusive gateway'),
    }),
  })

  contextPad.registerProvider(LATE, {
    getContextPadEntries: () => (entries: Entries) => {
      const { 'append.end-event': end, ...rest } = pick(entries, PAD)
      if (!end) return rest
      return {
        'append.user-task': appending('review', 'bpmn-icon-user-task', 'Append review'),
        'append.send-task': appending('notify', 'bpmn-icon-send-task', 'Append carbon copy'),
        'append.end-event': end,
        'insert.exclusive-block': block('exclusive', 'Insert exclusive branch block'),
        'insert.parallel-block': block('parallel', 'Insert parallel branch block'),
        'insert.inclusive-block': block('inclusive', 'Insert inclusive branch block'),
        ...rest,
      }
    },
    getMultiElementContextPadEntries: () => (entries: Entries) => pick(entries, ['delete']),
  })

  popupMenu.registerProvider('bpmn-replace', LATE, {
    getPopupMenuEntries: (target: El) => (entries: Entries) =>
      pick(
        entries,
        (REPLACE[target.type] ?? []).filter(
          (key) => key !== 'replace-with-default-flow' || defaultable(target),
        ),
      ),
    // no multi-instance / loop / compensation toggles
    getPopupMenuHeaderEntries: () => () => ({}),
  })

  // review ↔ carbon copy: the new type's default settings, the people picked kept; a default name follows the
  // type (a nested command: the same undo step as the change)
  eventBus.on<{ oldShape: El; newShape: El }>(
    'commandStack.shape.replace.postExecuted',
    LATE,
    ({ context: { oldShape, newShape } }) => {
      const was = kindOf(oldShape.type)
      const kind = kindOf(newShape.type)
      if (!was || !kind || was === kind) return
      const { name, config } = stepDefaults(kind)
      const assignee = configOf(oldShape.businessObject)?.assignee
      const bo = newShape.businessObject
      modeling.updateProperties(newShape, {
        extensionElements: qwHelpers.extension(bo, assignee ? { ...config, assignee } : config),
        ...(bo.name === stepDefaults(was).name ? { name } : {}),
      })
    },
  )

  // an undone delete back at its index: noted before bpmn-js removes it (1000), restored after it re-appends
  type Deleted = { shape?: El; connection?: El; qwIndex?: number }
  const elementsOf = (el: El | undefined): [Bo, Bo[]] | undefined => {
    const bo = el?.type === 'label' ? undefined : el?.businessObject
    const list = bo?.$parent?.flowElements
    return bo && list ? [bo, list] : undefined
  }
  eventBus.on<Deleted>(
    DELETES.map((c) => `${c}.executed`),
    1500,
    ({ context }) => {
      const found = elementsOf(context.shape ?? context.connection)
      context.qwIndex = found ? found[1].indexOf(found[0]) : -1
    },
  )
  eventBus.on<Deleted>(
    DELETES.map((c) => `${c}.reverted`),
    500,
    ({ context }) => {
      const found = elementsOf(context.shape ?? context.connection)
      const at = context.qwIndex ?? -1
      if (!found || at < 0) return
      const [bo, list] = found
      const now = list.indexOf(bo)
      if (now < 0 || now === at) return
      list.splice(now, 1)
      list.splice(at, 0, bo)
    },
  )
}
restrict.$inject = [
  'eventBus',
  'palette',
  'contextPad',
  'popupMenu',
  'create',
  'autoPlace',
  'elementFactory',
  'modeling',
  'translate',
  'qwHelpers',
]

export default { __depends__: [helpers], __init__: [restrict] }
