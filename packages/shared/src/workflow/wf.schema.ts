import { z } from 'zod'

/**
 * Workflow process tree (see docs/design-notes.md#workflow): the JSON the designer edits, `wf_version.tree_json` stores and the
 * engine walks. Field names and codes are our own. `compile()` (wf-compile.ts) checks a tree against the
 * form's `fields` before a version is published and indexes it for the engine.
 */

/**
 * Admin pages only (access model; see docs/design-notes.md#workflow): the approval center (start, lists, detail, task actions,
 * urge) needs a sign-in and returns the caller's own data. Seeded to root only.
 */
export const wfPerms = {
  model: {
    browse: 'wf.model.browse',
    /** detail, version list, JSON export */
    view: 'wf.model.view',
    create: 'wf.model.create',
    /** edit, draft save, enable/disable, sort */
    modify: 'wf.model.modify',
    remove: 'wf.model.remove',
    /** new `wf_version` from the draft or an imported JSON */
    publish: 'wf.model.publish',
    /** set a model's process managers, who see every field of its approval data */
    managers: 'wf.model.managers',
  },
  form: {
    browse: 'wf.form.browse',
    view: 'wf.form.view',
    create: 'wf.form.create',
    /** admin-level: a form-create schema is code (see docs/design-notes.md#workflow) */
    modify: 'wf.form.modify',
    remove: 'wf.form.remove',
  },
  instance: {
    browse: 'wf.instance.browse',
    /** any instance's detail within the caller's data scope on `initiator_dept_id` */
    view: 'wf.instance.view',
  },
  task: {
    browse: 'wf.task.browse',
    /** reassign a task, terminate an instance (see docs/design-notes.md#workflow) */
    manage: 'wf.task.manage',
  },
  /** a model's instances by its form fields, within the caller's data scope on `initiator_dept_id` */
  data: {
    browse: 'wf.data.browse',
    export: 'wf.data.export',
  },
} as const

/** Form field types, the only form description the engine, `compile` and the condition builder use. */
export const WF_FIELD_TYPES = ['number', 'string', 'date', 'user', 'dept'] as const
export type WfFieldType = (typeof WF_FIELD_TYPES)[number]
/**
 * Field name → type: `WfBusinessHandler.fields()` (custom) or derived from the form schema (dynamic). A
 * leading `$` is reserved for `WF_INITIATOR_OPS` keys; `compile` ignores such fields.
 */
export type WfFields = Record<string, WfFieldType>
/** A form field name as `fields` keys take it (`fieldsFromFormSchema` checks form-create names with it). */
export const wfFieldName = z.string().min(1).max(64).regex(/^[^$]/)
export const wfFields = z.record(wfFieldName, z.enum(WF_FIELD_TYPES))

export const WF_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'contains',
  'inDeptTree',
  'hasRole',
] as const
export type WfOp = (typeof WF_OPS)[number]

/**
 * Ops a form field of each type takes. Values: the field's type (`date` = ISO date or datetime,
 * `user`/`dept` = id, `string` non-empty); `in` a non-empty list of them; `contains` a substring.
 */
export const WF_FIELD_OPS = {
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in'],
  string: ['eq', 'ne', 'in', 'contains'],
  date: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'],
  user: ['eq', 'ne', 'in'],
  dept: ['eq', 'ne', 'in'],
} as const satisfies Record<WfFieldType, readonly WfOp[]>

/**
 * Initiator conditions and the one op each takes; never on form fields. Values are non-empty id
 * lists: `inDeptTree` = dept ids, subtrees included (prefix match on `initiatorCtx.deptTreePath`);
 * `hasRole` = role ids, any one held.
 */
export const WF_INITIATOR_OPS = {
  '$initiator.dept': 'inDeptTree',
  '$initiator.roles': 'hasRole',
} as const satisfies Record<string, WfOp>

export const WF_ASSIGNEE_KINDS = [
  'users',
  'roles',
  'positions',
  'deptMembers',
  'deptHead',
  'deptHeadChain',
  'initiator',
  'initiatorPicks',
  'initiatorDeptHead',
  'formFieldUser',
  'formFieldDeptHead',
] as const
export type WfAssigneeKind = (typeof WF_ASSIGNEE_KINDS)[number]
/** Kinds that name their users, roles, positions or depts in `ids` (compile requires at least one). */
export const WF_ASSIGNEE_ID_KINDS = [
  'users',
  'roles',
  'positions',
  'deptMembers',
  'deptHead',
] as const satisfies readonly WfAssigneeKind[]

export const WF_FIELD_ACCESS = ['edit', 'read', 'hide'] as const
export const WF_SIGN_MODES = ['any', 'all', 'ordered'] as const
/** `toManager` = the model's process managers (`manager_user_ids`); not `WF_TIMEOUT_ACTIONS`' `toManager`. */
export const WF_WHEN_NOBODY = ['autoPass', 'toManager', 'toUser'] as const
export const WF_WHEN_INITIATOR_IS_REVIEWER = ['self', 'skip', 'deptHead'] as const
export const WF_ON_REJECT = ['finish', 'sendBack'] as const
/** After a send-back to the initiator: `restart` from `begin.next` (default), `sender` = back to that node. */
export const WF_RESUBMIT_TO = ['restart', 'sender'] as const
/**
 * What the remind job does with a review task the first time it is overdue; absent =
 * remind only. `autoPass` / `autoReject` = approve / reject (by the node's `onReject`); `toManager` = transfer
 * to the assignee's superior (dept head, or the parent dept's head when the assignee heads the dept) — not
 * `WF_WHEN_NOBODY`'s `toManager`, which means the model's process managers.
 */
export const WF_TIMEOUT_ACTIONS = ['autoPass', 'autoReject', 'toManager'] as const
export type WfTimeoutAction = (typeof WF_TIMEOUT_ACTIONS)[number]
/** `exclusive` (default): first matching path, else fallback; `inclusive`: every matching path, else fallback; `parallel`: all paths. */
export const WF_FORK_MODES = ['exclusive', 'parallel', 'inclusive'] as const
export type WfForkMode = (typeof WF_FORK_MODES)[number]

/** Longest node / path id (`wf_task.node_id` is varchar(64)) and node name. */
export const WF_ID_MAX = 64
export const WF_NAME_MAX = 64
/** Most nodes in a tree. */
export const WF_NODES_MAX = 200
/**
 * Deepest container nesting (objects and arrays, root = 1) of a tree or draft: MySQL refuses a JSON column
 * value nested deeper than 100 (ER 3157). About 97 chained reviews or 32 nested forks.
 */
export const WF_JSON_DEPTH_MAX = 100
/** Most values (object members and array items, nested ones included) in a tree or draft. */
export const WF_JSON_VALUES_MAX = 100_000
/** Longest `timeout.hours` / `remindEvery` (a year); keeps `due_at` a valid date. */
export const WF_TIMEOUT_HOURS_MAX = 8760

export interface WfAssignee {
  kind: WfAssigneeKind
  /** user / role / position / dept ids, by kind */
  ids?: number[]
  /** how many depts up a head chain goes */
  levels?: number
  /** form field (`formField*` kinds) */
  field?: string
}
export type WfFieldAccess = Record<string, (typeof WF_FIELD_ACCESS)[number]>
export type WfCondValue = number | string | number[] | string[]
/** `field` is a form field or a `WF_INITIATOR_OPS` key. */
export interface WfCondition {
  field: string
  op: WfOp
  value: WfCondValue
}

export interface WfBeginNode {
  id: string
  type: 'begin'
  name: string
  access?: WfFieldAccess
  next?: WfStep
}
export interface WfReviewNode {
  id: string
  type: 'review'
  name: string
  assignee: WfAssignee
  sign: (typeof WF_SIGN_MODES)[number]
  whenNobody: (typeof WF_WHEN_NOBODY)[number]
  /** required with `whenNobody: 'toUser'` */
  fallbackUserId?: number
  whenInitiatorIsReviewer: (typeof WF_WHEN_INITIATOR_IS_REVIEWER)[number]
  onReject: (typeof WF_ON_REJECT)[number]
  /** approve / reject without a comment → 422 */
  commentRequired?: boolean
  resubmitTo?: (typeof WF_RESUBMIT_TO)[number]
  /**
   * tasks get `dueAt = createdAt + hours`, then a reminder every `remindEvery` hours; with `action`
   * the first time due is handled automatically instead
   */
  timeout?: { hours: number; remindEvery?: number; action?: WfTimeoutAction }
  access?: WfFieldAccess
  next?: WfStep
}
/** Carbon copy. */
export interface WfNotifyNode {
  id: string
  type: 'notify'
  name: string
  assignee: WfAssignee
  next?: WfStep
}
export interface WfForkPath {
  id: string
  name: string
  fallback?: boolean
  /** OR of AND groups; empty on fallback and parallel paths */
  when: WfCondition[][]
  /** first node of the path; none = an empty path */
  child?: WfStep
}
export interface WfForkNode {
  id: string
  type: 'fork'
  name: string
  mode?: WfForkMode
  paths: WfForkPath[]
  /** runs once every taken path has finished (join) */
  next?: WfStep
}
/** Any node below `begin`. */
export type WfStep = WfReviewNode | WfNotifyNode | WfForkNode
export type WfNode = WfBeginNode | WfStep

const posInt = z.number().int().positive()
const id = z.string().regex(new RegExp(`^[\\w-]{1,${WF_ID_MAX}}$`))
const name = z.string().trim().min(1).max(WF_NAME_MAX)
const fieldName = z.string().min(1).max(64)
const access = z.record(fieldName, z.enum(WF_FIELD_ACCESS)).optional()
const assignee = z.object({
  kind: z.enum(WF_ASSIGNEE_KINDS),
  ids: z.array(posInt).max(200).optional(),
  levels: posInt.max(20).optional(),
  field: fieldName.optional(),
})
const condition = z.object({
  field: fieldName,
  op: z.enum(WF_OPS),
  value: z.union([
    z.number(),
    z.string().max(200),
    z.array(z.number()).max(200),
    z.array(z.string().max(200)).max(200),
  ]),
})
const hours = posInt.max(WF_TIMEOUT_HOURS_MAX)

const step: z.ZodType<WfStep> = z.lazy(() => z.discriminatedUnion('type', [review, notify, fork]))
const review = z.object({
  id,
  type: z.literal('review'),
  name,
  assignee,
  sign: z.enum(WF_SIGN_MODES),
  whenNobody: z.enum(WF_WHEN_NOBODY),
  fallbackUserId: posInt.optional(),
  whenInitiatorIsReviewer: z.enum(WF_WHEN_INITIATOR_IS_REVIEWER),
  onReject: z.enum(WF_ON_REJECT),
  commentRequired: z.boolean().optional(),
  resubmitTo: z.enum(WF_RESUBMIT_TO).optional(),
  timeout: z
    .object({ hours, remindEvery: hours.optional(), action: z.enum(WF_TIMEOUT_ACTIONS).optional() })
    .optional(),
  access,
  next: step.optional(),
})
const notify = z.object({
  id,
  type: z.literal('notify'),
  name,
  assignee,
  next: step.optional(),
})
const fork = z.object({
  id,
  type: z.literal('fork'),
  name,
  mode: z.enum(WF_FORK_MODES).optional(),
  paths: z
    .array(
      z.object({
        id,
        name,
        fallback: z.boolean().optional(),
        when: z.array(z.array(condition).min(1).max(20)).max(20),
        child: step.optional(),
      }),
    )
    .min(2)
    .max(20),
  next: step.optional(),
})

/** Shape of a whole tree (root = `begin`); `compile()` adds the rules that need `fields` or the whole tree. */
export const wfTree = z.object({
  id,
  type: z.literal('begin'),
  name,
  access,
  next: step.optional(),
})

/**
 * A BPMN element's `qw:Config` body by node type: the tree node without `id`,
 * `type`, `name` and `next`, strict — a `next` would smuggle in a subtree the diagram never shows, so it, an
 * id or any other extra key is refused. Derived from the tree schema: a field a node gains reaches BPMN too.
 */
const configOf = { id: true, type: true, name: true, next: true } as const
export const wfBeginConfig = wfTree.omit(configOf).strict()
export const wfReviewConfig = review.omit(configOf).strict()
export const wfNotifyConfig = notify.omit(configOf).strict()
