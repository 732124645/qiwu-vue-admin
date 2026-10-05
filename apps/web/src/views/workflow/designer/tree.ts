import type { InjectionKey } from 'vue'
import type {
  WfBeginNode,
  WfCompileError,
  WfCondition,
  WfFields,
  WfForkMode,
  WfForkNode,
  WfForkPath,
  WfNode,
  WfNodeProgress,
  WfStep,
} from '@qiwu/shared'
import { i18n } from '@/core/i18n'

// In-place edits of a process tree (see docs/design-notes.md#workflow) for WfDesigner: the tree is the parent's reactive draft.

const t = (key: string, params: Record<string, unknown> = {}) => i18n.global.t(key, params)

/**
 * A `compile` error as the server words it (`validation.wf.<code>`), `node` naming the node / path it is on
 * (none found: a code's message names the id, a schema message goes without). Both designers list them.
 */
export function checkMessage(e: WfCompileError, node: string | undefined): string {
  if (e.code !== 'shape') return t(`validation.wf.${e.code}`, { node: node ?? e.id ?? '' })
  const prop = [...e.path].reverse().find((p) => typeof p === 'string')
  const label = `wf.designer.check.field.${prop}`
  const text = t(e.message!.key, {
    ...e.message!.params,
    field: t(i18n.global.te(label) ? label : 'wf.designer.check.field.other'),
  })
  return node ? t('wf.designer.check.at', { node, message: text }) : text
}

/** What a step hangs from: a node (`next`) or a fork path (`child`). */
export type Holder = WfNode | WfForkPath
export type StepType = WfStep['type']
/** What the drawer edits: a node, or one path of a fork. */
export type Target = { node: WfNode } | { fork: WfForkNode; path: WfForkPath }

export interface DesignerCtx {
  tree: () => WfBeginNode
  fields: () => WfFields
  open: (target: Target) => void
  /** id of the node / path the drawer shows */
  active: () => string | undefined
  /** the node / path has a `compile` error (shown once the designer was validated) */
  invalid: (id: string) => boolean
  /** read-only (an instance's progress tree): the node's / path's progress there; undefined = edit mode */
  progress?: (id: string) => WfNodeProgress | undefined
}

/** a progress's icon on the read-only cards */
export const PROGRESS_ICON: Record<WfNodeProgress, string> = {
  done: 'lucide:circle-check',
  active: 'lucide:circle-dot',
  pending: 'lucide:circle-dashed',
  skipped: 'lucide:circle-minus',
  stopped: 'lucide:circle-x',
}
export const DESIGNER: InjectionKey<DesignerCtx> = Symbol('wf-designer')

export const stepAfter = (h: Holder): WfStep | undefined => ('type' in h ? h.next : h.child)

function link(h: Holder, step: WfStep | undefined) {
  const key = 'type' in h ? 'next' : 'child'
  if (step) (h as { next?: WfStep; child?: WfStep })[key] = step
  else delete (h as { next?: WfStep; child?: WfStep })[key]
}

/** Every node of the chain that starts below `h` (not into fork paths). */
export function chain(h: Holder): WfStep[] {
  const out: WfStep[] = []
  for (let s = stepAfter(h); s; s = s.next) out.push(s)
  return out
}

/** Node and fork-path ids of the whole tree (one namespace, `compile` rule). */
export function idsOf(tree: WfNode): Set<string> {
  const ids = new Set<string>()
  const walk = (n: WfNode | undefined) => {
    for (; n; n = n.next) {
      ids.add(n.id)
      if (n.type === 'fork')
        for (const p of n.paths) {
          ids.add(p.id)
          walk(p.child)
        }
    }
  }
  walk(tree)
  return ids
}

/** The node or fork path with this id (the first one when an id is used twice). */
export function targetOf(tree: WfNode, id: string): Target | undefined {
  for (let n: WfNode | undefined = tree; n; n = n.next) {
    if (n.id === id) return { node: n }
    if (n.type === 'fork')
      for (const path of n.paths) {
        if (path.id === id) return { fork: n, path }
        const inner = path.child && targetOf(path.child, id)
        if (inner) return inner
      }
  }
}

/** `<prefix>_<8 hex>`, not in `taken` (added to it). */
export function newId(prefix: string, taken: Set<string>): string {
  let id: string
  do id = `${prefix}_${crypto.randomUUID().slice(0, 8)}`
  while (taken.has(id))
  taken.add(id)
  return id
}

export function newPath(taken: Set<string>, n: number, fallback = false): WfForkPath {
  return fallback
    ? { id: newId('path', taken), name: t('wf.designer.path.fallback'), fallback: true, when: [] }
    : { id: newId('path', taken), name: t('wf.designer.path.name', { n }), when: [] }
}

/**
 * A new step with safe defaults: nobody to review → the process managers (never a silent auto-pass);
 * assignees still to pick (`compile` reports them until then).
 */
export function newStep(type: StepType, taken: Set<string>): WfStep {
  const name = t(`wf.designer.type.${type}`)
  if (type === 'review')
    return {
      id: newId('review', taken),
      type,
      name,
      assignee: { kind: 'users', ids: [] },
      sign: 'any',
      whenNobody: 'toManager',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    }
  if (type === 'notify')
    return { id: newId('notify', taken), type, name, assignee: { kind: 'users', ids: [] } }
  const id = newId('fork', taken)
  return {
    id,
    type,
    name,
    mode: 'exclusive',
    paths: [newPath(taken, 1), newPath(taken, 2, true)],
  }
}

/** Puts `step` right below `h`; what was there follows it. */
export function insertStep(h: Holder, step: WfStep) {
  step.next = stepAfter(h)
  link(h, step)
}

/** Drops the step below `h` (a fork with all its paths); its `next` moves up. */
export function removeStep(h: Holder) {
  link(h, stepAfter(h)?.next)
}

/** A copy of the step below `h` (its paths and their nodes too, all with new ids) right after it. */
export function copyStep(h: Holder, tree: WfNode) {
  const step = stepAfter(h)
  if (!step) return
  const taken = idsOf(tree)
  // the tree is JSON (a reactive proxy is no structuredClone input)
  const copy = JSON.parse(JSON.stringify({ ...step, next: undefined })) as WfStep
  const renew = (n: WfStep | undefined) => {
    for (; n; n = n.next) {
      n.id = newId(n.type, taken)
      if (n.type === 'fork')
        for (const p of n.paths) {
          p.id = newId('path', taken)
          renew(p.child)
        }
    }
  }
  renew(copy)
  insertStep(step, copy)
}

const modeOf = (fork: WfForkNode): WfForkMode => fork.mode ?? 'exclusive'

/** n of a default path name (`wf.designer.path.name`, current locale); none for any other name */
function pathNo(name: string): number | undefined {
  const [pre = '', post = ''] = t('wf.designer.path.name', { n: '\0' }).split('\0')
  const n = name.slice(pre.length, name.length - post.length)
  return name.startsWith(pre) && name.endsWith(post) && /^\d+$/.test(n) ? Number(n) : undefined
}
/** the number of a new default-named path: after the conditional paths and every default-named one */
const nextNo = (fork: WfForkNode) =>
  Math.max(
    fork.paths.filter((p) => !p.fallback).length,
    ...fork.paths.map((p) => pathNo(p.name) ?? 0),
  ) + 1

/** A new path: last when parallel, else just before the fallback (kept last). */
export function addPath(fork: WfForkNode, tree: WfNode) {
  const fallback = fork.paths.findIndex((p) => p.fallback)
  const at = modeOf(fork) === 'parallel' || fallback < 0 ? fork.paths.length : fallback
  fork.paths.splice(at, 0, newPath(idsOf(tree), nextNo(fork)))
}

/** A fork keeps two paths at least and its fallback path. */
export const canRemovePath = (fork: WfForkNode, path: WfForkPath) =>
  fork.paths.length > 2 && !path.fallback

export function removePath(fork: WfForkNode, path: WfForkPath) {
  if (canRemovePath(fork, path)) fork.paths.splice(fork.paths.indexOf(path), 1)
}

/** Paths swap with their neighbour (the evaluation order of an exclusive fork); the fallback stays last. */
export function canMovePath(fork: WfForkNode, path: WfForkPath, delta: -1 | 1) {
  const other = fork.paths[fork.paths.indexOf(path) + delta]
  return !!other && !other.fallback && !path.fallback
}

export function movePath(fork: WfForkNode, path: WfForkPath, delta: -1 | 1) {
  if (!canMovePath(fork, path, delta)) return
  const i = fork.paths.indexOf(path)
  ;[fork.paths[i], fork.paths[i + delta]] = [fork.paths[i + delta]!, path]
}

/** Conditions a switch to `mode` would drop (parallel paths have none). */
export const dropsConditions = (fork: WfForkNode, mode: WfForkMode) =>
  mode === 'parallel' && fork.paths.some((p) => p.when.length > 0)

/**
 * Switches the fork mode keeping the tree publishable: parallel paths lose their conditions and the
 * fallback mark; exclusive / inclusive need one fallback path, the last one when there is none. A default
 * name follows the path's new role (an admin's own name stays).
 */
export function setForkMode(fork: WfForkNode, mode: WfForkMode) {
  fork.mode = mode
  const otherwise = t('wf.designer.path.fallback')
  if (mode === 'parallel')
    for (const p of fork.paths) {
      if (p.fallback && p.name === otherwise)
        p.name = t('wf.designer.path.name', { n: nextNo(fork) })
      p.when = []
      delete p.fallback
    }
  else if (!fork.paths.some((p) => p.fallback)) {
    const last = fork.paths.at(-1)!
    last.fallback = true
    last.when = []
    if (pathNo(last.name) !== undefined) last.name = otherwise
  }
}

/** Condition ops that take a list of values. */
export const LIST_OPS: readonly WfCondition['op'][] = ['in', 'inDeptTree', 'hasRole']

/** i18n keys of the initiator conditions, by condition field */
export const INITIATOR_LABEL: Record<string, string> = {
  '$initiator.dept': 'wf.designer.cond.initiatorDept',
  '$initiator.roles': 'wf.designer.cond.initiatorRoles',
}
