import { z } from 'zod'
import { validationMessage, type ValidationMessage } from '../validation/zod-i18n.js'
import {
  WF_ASSIGNEE_ID_KINDS,
  WF_FIELD_OPS,
  WF_FIELD_TYPES,
  WF_INITIATOR_OPS,
  WF_JSON_DEPTH_MAX,
  WF_JSON_VALUES_MAX,
  WF_NODES_MAX,
  wfTree,
  type WfAssigneeKind,
  type WfBeginNode,
  type WfCondition,
  type WfFields,
  type WfFieldType,
  type WfForkPath,
  type WfNode,
  type WfOp,
  type WfReviewNode,
  type WfNotifyNode,
} from './wf.schema.js'

export const WF_COMPILE_CODES = [
  /**
   * more than `WF_NODES_MAX` nodes, nesting deeper than `WF_JSON_DEPTH_MAX` or more than
   * `WF_JSON_VALUES_MAX` values; reported alone, nothing else is checked
   */
  'too_large',
  /** wrong JSON shape; `message` holds the zod key + params */
  'shape',
  /** a node or fork-path id used twice (one namespace) */
  'duplicate_id',
  /** exclusive / inclusive fork without exactly one fallback path */
  'fallback_count',
  /** a fallback path with conditions */
  'fallback_when',
  /** an exclusive / inclusive non-fallback path without conditions */
  'path_when_required',
  /** a parallel path with conditions or marked fallback */
  'parallel_path',
  /** condition on a field missing from `fields` */
  'unknown_field',
  /** op the field (type) does not take */
  'op_mismatch',
  /** value not of the field's type (or not a non-empty list / substring where needed) */
  'value_mismatch',
  /** users / roles / positions / deptMembers / deptHead without ids */
  'assignee_ids',
  /** formFieldUser / formFieldDeptHead without a `user` / `dept` field */
  'assignee_field',
  /** `whenNobody: 'toUser'` without `fallbackUserId` */
  'fallback_user',
] as const
export type WfCompileCode = (typeof WF_COMPILE_CODES)[number]

export interface WfCompileError {
  code: WfCompileCode
  /** the node or fork path it belongs to (the designer highlights it); null = the root is not a node */
  id: string | null
  /** where in the tree JSON */
  path: (string | number)[]
  message?: ValidationMessage
}

export interface WfCompiledNode {
  node: WfNode
  /** innermost fork path holding the node; null = main line */
  parentPathId: string | null
  /** next node in the same chain; null = chain end (join of the enclosing fork, or the process end) */
  next: string | null
}

export interface WfCompiled {
  root: WfBeginNode
  nodes: Map<string, WfCompiledNode>
  /** fork path id → its fork and the path */
  paths: Map<string, { forkId: string; path: WfForkPath }>
}

export type WfCompileResult =
  { ok: true; flow: WfCompiled } | { ok: false; errors: WfCompileError[] }

type Path = (string | number)[]

const isoDateOrTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })])
const isId = (v: unknown) => Number.isInteger(v) && (v as number) > 0
const SCALAR: Record<WfFieldType, (v: unknown) => boolean> = {
  number: (v) => typeof v === 'number',
  // blank = not filled in (the builder's new condition): never compared against
  string: (v) => typeof v === 'string' && v.length > 0,
  date: (v) => isoDateOrTime.safeParse(v).success,
  user: isId,
  dept: isId,
}
const nonEmptyList = (v: unknown, each: (x: unknown) => boolean) =>
  Array.isArray(v) && v.length > 0 && v.every(each)
// an inherited `constructor` etc. is no type name; `$` names are initiator keys, never form fields
const typeOf = (fields: WfFields, field: string) =>
  field.startsWith('$') ? undefined : WF_FIELD_TYPES.find((t) => t === fields[field])

/**
 * Why a condition on a form field does not type-check against `fields`, or null: a field missing from them
 * (a `$` key included), an op its type does not take (`WF_FIELD_OPS`), a value not of its type (`in` = a
 * non-empty list of them). Fork conditions (`compile`) and the data page's field filters share it.
 */
export function fieldConditionError(
  fields: WfFields,
  { field, op, value }: Pick<WfCondition, 'field' | 'op'> & { value: unknown },
): 'unknown_field' | 'op_mismatch' | 'value_mismatch' | null {
  const type = typeOf(fields, field)
  if (!type) return 'unknown_field'
  if (!(WF_FIELD_OPS[type] as readonly WfOp[]).includes(op)) return 'op_mismatch'
  const ok = op === 'in' ? nonEmptyList(value, SCALAR[type]) : SCALAR[type](value)
  return ok ? null : 'value_mismatch'
}
/** The condition key each `fieldConditionError` code points at. */
export const WF_CONDITION_KEY = {
  unknown_field: 'field',
  op_mismatch: 'op',
  value_mismatch: 'value',
} as const
const ASSIGNEE_FIELD: Partial<Record<WfAssigneeKind, WfFieldType>> = {
  formFieldUser: 'user',
  formFieldDeptHead: 'dept',
}

const NODE = 1
const PATHS = 2
const PATH = 3
/**
 * Walks every object and array of the raw input with an explicit stack (a deep tree would overflow the
 * call stack in zod's recursive parse), stopping past `WF_NODES_MAX` nodes, `WF_JSON_DEPTH_MAX` nesting
 * or `WF_JSON_VALUES_MAX` values (the last keeps shared references or cycles in an in-memory tree linear).
 */
function tooLarge(tree: unknown): boolean {
  // [value, container depth, NODE | PATHS (a node's `paths`) | PATH (one of them) | 0]
  const stack: [unknown, number, number][] = [[tree, 1, NODE]]
  let nodes = 0
  let values = 0
  while (stack.length) {
    const [value, depth, role] = stack.pop()!
    if (!value || typeof value !== 'object') continue
    if (depth > WF_JSON_DEPTH_MAX || (role === NODE && ++nodes > WF_NODES_MAX)) return true
    for (const key of Array.isArray(value) ? value.keys() : Object.keys(value)) {
      if (++values > WF_JSON_VALUES_MAX) return true
      const inner =
        role === NODE
          ? key === 'next'
            ? NODE
            : key === 'paths'
              ? PATHS
              : 0
          : role === PATHS
            ? PATH
            : role === PATH && key === 'child'
              ? NODE
              : 0
      stack.push([(value as Record<string | number, unknown>)[key], depth + 1, inner])
    }
  }
  return false
}

/** Id of the innermost node / fork path on the way to `path` in the raw input (shape errors). */
function ownerOf(tree: unknown, path: readonly PropertyKey[]): string | null {
  let owner: string | null = null
  let cur = tree
  for (let i = 0; cur && typeof cur === 'object'; i++) {
    const atNode =
      i === 0 || path[i - 1] === 'next' || path[i - 1] === 'child' || path[i - 2] === 'paths'
    const own = (cur as { id?: unknown }).id
    if (atNode && typeof own === 'string' && own) owner = own
    const key = path[i]
    if (key === undefined) break
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return owner
}

/**
 * Checks a process tree against the form's `fields` (see docs/design-notes.md#workflow) and indexes it by node id. Same code
 * in the designer and on publish. Reports every error found, located by node / path id.
 */
export function compile(tree: unknown, fields: WfFields): WfCompileResult {
  if (tooLarge(tree)) return { ok: false, errors: [{ code: 'too_large', id: null, path: [] }] }
  const parsed = wfTree.safeParse(tree)
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'shape',
        id: ownerOf(tree, issue.path),
        path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        message: validationMessage(issue),
      })),
    }

  const errors: WfCompileError[] = []
  const fail = (code: WfCompileCode, id: string, path: Path) => errors.push({ code, id, path })
  const nodes = new Map<string, WfCompiledNode>()
  const paths = new Map<string, { forkId: string; path: WfForkPath }>()
  const seen = new Set<string>()
  const claim = (id: string, at: Path) => {
    if (seen.has(id)) fail('duplicate_id', id, [...at, 'id'])
    seen.add(id)
  }
  const checkAssignee = (node: WfReviewNode | WfNotifyNode, at: Path) => {
    const { kind, ids, field } = node.assignee
    if ((WF_ASSIGNEE_ID_KINDS as readonly string[]).includes(kind) && !ids?.length)
      fail('assignee_ids', node.id, [...at, 'assignee', 'ids'])
    const want = ASSIGNEE_FIELD[kind]
    if (want && (field === undefined || typeOf(fields, field) !== want))
      fail('assignee_field', node.id, [...at, 'assignee', 'field'])
  }

  const checkCondition = ({ field, op, value }: WfCondition, pathId: string, at: Path) => {
    if (Object.hasOwn(WF_INITIATOR_OPS, field)) {
      if (op !== WF_INITIATOR_OPS[field as keyof typeof WF_INITIATOR_OPS])
        fail('op_mismatch', pathId, [...at, 'op'])
      else if (!nonEmptyList(value, isId)) fail('value_mismatch', pathId, [...at, 'value'])
      return
    }
    const code = fieldConditionError(fields, { field, op, value })
    if (code) fail(code, pathId, [...at, WF_CONDITION_KEY[code]])
  }

  const visit = (first: WfNode | undefined, parentPathId: string | null, start: Path) => {
    let at = start
    for (let node = first; node; node = node.next, at = [...at, 'next']) {
      claim(node.id, at)
      nodes.set(node.id, { node, parentPathId, next: node.next?.id ?? null })
      if (node.type === 'review' || node.type === 'notify') checkAssignee(node, at)
      if (node.type === 'review' && node.whenNobody === 'toUser' && !node.fallbackUserId)
        fail('fallback_user', node.id, [...at, 'fallbackUserId'])
      if (node.type !== 'fork') continue
      const fork = node
      const parallel = fork.mode === 'parallel'
      if (!parallel && fork.paths.filter((p) => p.fallback).length !== 1)
        fail('fallback_count', fork.id, [...at, 'paths'])
      fork.paths.forEach((p, i) => {
        const pat = [...at, 'paths', i]
        claim(p.id, pat)
        paths.set(p.id, { forkId: fork.id, path: p })
        if (parallel && (p.fallback || p.when.length)) fail('parallel_path', p.id, pat)
        else if (p.fallback && p.when.length) fail('fallback_when', p.id, [...pat, 'when'])
        else if (!parallel && !p.fallback && !p.when.length)
          fail('path_when_required', p.id, [...pat, 'when'])
        p.when.forEach((group, g) =>
          group.forEach((c, k) => checkCondition(c, p.id, [...pat, 'when', g, k])),
        )
        visit(p.child, p.id, [...pat, 'child'])
      })
    }
  }
  visit(parsed.data, null, [])

  return errors.length
    ? { ok: false, errors }
    : { ok: true, flow: { root: parsed.data, nodes, paths } }
}
