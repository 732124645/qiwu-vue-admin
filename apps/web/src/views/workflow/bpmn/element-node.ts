import type { WfCondition, WfForkMode, WfForkNode, WfForkPath, WfNode } from '@qiwu/shared'
import { newStep, type Target } from '../designer/tree'
import type { Bo } from './helpers'

/**
 * The BPMN settings panel ↔ diagram mapping, pure. What the panel edits for an element
 * (`editOf`): the tree designer's `Target` — a start, review or carbon copy → its node, a branching gateway → its
 * fork, a flow leaving one → that fork's path — else just a name (an end, a join, any other flow). What writing
 * an edit back sets on the element (`written`). The same reading as the server's `bpmnToTree`: `qw:Config` = the
 * node's settings, a flow's `qw-rule` condition = its path's `when`, the gateway's `default` = the fallback path,
 * the order in `flowElements` = the path order.
 */

/** The part of a diagram-js shape / connection read here (plain objects in the unit tests). */
export interface Item {
  id: string
  type: string
  businessObject: Bo
  source?: Item
  target?: Item
  outgoing: Item[]
}
/** What the panel edits: a node or a fork path (the tree designer's `Target`), else just the element's name. */
export type Edit = Target | { name: string }
export const isTarget = (edit: Edit): edit is Target => 'node' in edit || 'path' in edit
/**
 * What an element carries of an `Edit`: its name (none: undefined), a start's / review's / carbon copy's
 * settings (`qw:Config`; `{}` = none), a fork path's condition (none: undefined) and default mark. A key the
 * element has no such thing for is left out.
 */
export interface Written {
  name?: string
  config?: Record<string, unknown>
  when?: WfCondition[][]
  fallback?: boolean
}

/** element types that are tree nodes with settings */
const NODES: Record<string, 'begin' | 'review' | 'notify'> = {
  'bpmn:StartEvent': 'begin',
  'bpmn:UserTask': 'review',
  'bpmn:SendTask': 'notify',
}
const MODES: Record<string, WfForkMode> = {
  'bpmn:ExclusiveGateway': 'exclusive',
  'bpmn:ParallelGateway': 'parallel',
  'bpmn:InclusiveGateway': 'inclusive',
}
/** node keys that are no settings (as `treeToXml` writes `qw:Config`) */
const NOT_CONFIG = ['id', 'type', 'name', 'next']

/** settings of a node (no `qw:Config`, or one missing a setting: a new node's, so the form has what it edits) */
const defaults = (type: 'begin' | 'review' | 'notify') =>
  type === 'begin'
    ? {}
    : Object.fromEntries(
        Object.entries(newStep(type, new Set())).filter(([k]) => !NOT_CONFIG.includes(k)),
      )

/** A gateway with two flows out or more: a fork (`bpmnToTree`). */
export const isFork = (el: Item) => Object.hasOwn(MODES, el.type) && el.outgoing.length > 1

/** `fork`'s flows out in path order: their order in the process's `flowElements`. */
export function flowsOf(fork: Item): Item[] {
  const all = fork.businessObject.$parent?.flowElements ?? []
  const at = (flow: Item) => all.indexOf(flow.businessObject)
  return [...fork.outgoing].sort((a, b) => at(a) - at(b))
}

/** The settings in `bo`'s `qw:Config` (none, or not a JSON object: undefined). */
export function configOf(bo: Bo): Record<string, unknown> | undefined {
  const body = bo.extensionElements?.values?.find((v) => v.$type === 'qw:Config')?.body
  try {
    const parsed: unknown = JSON.parse(body ?? '')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * `fork`'s paths in order as the panel lists them: the name `bpmnToTree` gives a path (the flow's, else its
 * target's, else the flow's id) and whether it is the default one.
 */
export const branchesOf = (fork: Item) =>
  flowsOf(fork).map((flow) => ({
    id: flow.id,
    label: flow.businessObject.name || flow.target?.businessObject.name || flow.id,
    fallback: fork.businessObject.default === flow.businessObject,
  }))

/** a flow's `qw-rule` condition as a path's `when` (none or unreadable: no conditions) */
function whenOf(flow: Bo): WfCondition[][] {
  const cond = flow.conditionExpression
  if (cond?.language !== 'qw-rule') return []
  try {
    const when: unknown = JSON.parse(cond.body ?? '')
    return Array.isArray(when) ? (when as WfCondition[][]) : []
  } catch {
    return []
  }
}

/** `gateway` as the tree's fork, its paths in order; names as drawn ('' = none). */
export function forkOf(gateway: Item): WfForkNode {
  const bo = gateway.businessObject
  return {
    id: gateway.id,
    type: 'fork',
    name: bo.name ?? '',
    mode: MODES[gateway.type],
    paths: flowsOf(gateway).map((flow): WfForkPath => ({
      id: flow.id,
      name: flow.businessObject.name ?? '',
      when: whenOf(flow.businessObject),
      ...(bo.default === flow.businessObject ? { fallback: true } : {}),
    })),
  }
}

/** What the panel edits for `el` (a fresh copy). */
export function editOf(el: Item): Edit {
  const bo = el.businessObject
  const type = Object.hasOwn(NODES, el.type) ? NODES[el.type] : undefined
  if (type)
    return {
      node: { ...defaults(type), ...configOf(bo), id: el.id, type, name: bo.name ?? '' } as WfNode,
    }
  if (isFork(el)) return { node: forkOf(el) }
  if (el.source && isFork(el.source)) {
    const fork = forkOf(el.source)
    return { fork, path: fork.paths.find((p) => p.id === el.id)! }
  }
  return { name: bo.name ?? '' }
}

/** What `edit` sets on its element once written back. */
export function written(edit: Edit): Written {
  if ('path' in edit) {
    const { name, when, fallback } = edit.path
    return { name: name || undefined, when: when.length ? when : undefined, fallback: !!fallback }
  }
  if (!('node' in edit)) return { name: edit.name || undefined }
  const { node } = edit
  if (node.type === 'fork') return { name: node.name || undefined }
  const config = Object.fromEntries(Object.entries(node).filter(([k]) => !NOT_CONFIG.includes(k)))
  return { name: node.name || undefined, config }
}
