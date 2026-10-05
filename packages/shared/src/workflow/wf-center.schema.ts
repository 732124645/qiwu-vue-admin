import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { formSchema } from '../platform/formkit/form-schema.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { WF_ACTIONS, WF_INSTANCE_STATES, WF_SIGN_KINDS, WF_TASK_STATES } from './wf-engine.js'
import { WF_FORM_KINDS } from './wf-model.schema.js'
import { WF_FIELD_ACCESS, WF_ID_MAX, wfFields, wfTree } from './wf.schema.js'

/**
 * Approval center (access model; see docs/design-notes.md#workflow): sign-in only, the caller's own data. Field labels
 * `field.wf.instance.<prop>`.
 */

const id = z.number().int().positive()

/** POST /api/wf/instances: start the current version of model `modelKey` (a model the caller may start). */
export const wfStartBody = z
  .object({
    modelKey: z.string().trim().min(1).max(64),
    /** custom form: the business row (its handler requires the caller's own draft); dynamic: ignored */
    businessKey: z.string().trim().min(1).max(128).optional(),
    /** dynamic form: checked against the version's fields; custom: ignored (read from the business row) */
    formValues: z.record(z.string(), z.unknown()).default({}),
    /** `initiatorPicks` step id → the users picked for it (GET start-info lists those steps) */
    initiatorPicks: z.record(z.string(), z.array(id).max(200)).default({}),
  })
  .register(fieldDomains, { domain: 'wf.instance' })
export type WfStartBody = z.output<typeof wfStartBody>

/** GET /api/wf/startable-models: the enabled, published models the caller may start, in sort order. */
export const wfStartableVo = z.object({
  modelKey: z.string(),
  /** a seeded model's name is a `seed.wf.*` key (`tx()`) */
  name: z.string(),
  /** dict `wf.category` */
  category: z.string(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  formKind: z.enum(WF_FORM_KINDS),
  /** custom: the business page the start page opens instead of starting itself */
  createRoute: z.string().nullable(),
})
export type WfStartableVo = z.infer<typeof wfStartableVo>

/**
 * GET /api/wf/users/options (sign-in only): whom a process dialog picks (transfer, delegate, add-sign, cc, the
 * initiator's picks). Every enabled, live user like `OrgDirectory.enabledUsers`, not the caller's data scope
 * (a staff user's own_rows would leave only themselves), so only id, display name and dept; `keyword` over
 * the display name; by display name, at most `PAGE_SIZE_MAX`.
 */
export const wfUserOptionQuery = z
  .object({ keyword: z.string().trim().max(64).optional() })
  .register(fieldDomains, { domain: 'iam.user' })
export type WfUserOptionQuery = z.output<typeof wfUserOptionQuery>
export const wfUserOptionVo = z.object({
  id: z.number().int(),
  displayName: z.string(),
  /** a seeded dept's is a `seed.dept.*` key (`tx()`) */
  deptName: z.string().nullable(),
})
export type WfUserOption = z.infer<typeof wfUserOptionVo>

/**
 * GET /api/wf/models/:key/start-info: the form the start page renders (a dynamic model's, as its current
 * version published it; null: none) and the steps whose users the initiator picks, in process order.
 */
export const wfStartInfoVo = z.object({
  schema: formSchema.nullable(),
  picks: z.array(
    z.object({
      id: z.string(),
      /** a seeded model's names are `seed.wf.*` keys (`tx()`) */
      name: z.string(),
      /** `review`: the reviewers; `notify`: who gets a copy */
      type: z.enum(['review', 'notify']),
    }),
  ),
})
export type WfStartInfoVo = z.infer<typeof wfStartInfoVo>

/** The started instance: `running`, or already ended when no step had anybody to ask. */
export const wfStartVo = z.object({ id: z.number().int(), state: z.enum(WF_INSTANCE_STATES) })
export type WfStartVo = z.infer<typeof wfStartVo>

/**
 * Where an instance stands at a node or fork path (the progress tree): passed `done`, holding a token
 * `active`, ended there `stopped` (rejected, canceled, terminated), not reached `pending`, a fork path it did
 * not take (and its nodes) `skipped`.
 */
export const WF_NODE_PROGRESS = ['done', 'active', 'pending', 'skipped', 'stopped'] as const
export type WfNodeProgress = (typeof WF_NODE_PROGRESS)[number]

/** A user by id and display name (null once the row is gone). */
const wfUserRef = z.object({ id: z.number().int(), name: z.string().nullable() })

/**
 * GET /api/wf/instances/:id: an instance the caller may see (its initiator, anyone with a task on it, a cc
 * recipient, or a `wf.instance.view` holder whose data scope covers `initiator_dept_id`; else 404). Seeded
 * model and node names are `seed.wf.*` keys (`tx()`); `title` is built on read.
 */
export const wfInstanceDetailVo = z.object({
  id: z.number().int(),
  modelKey: z.string(),
  modelName: z.string(),
  /** `{model name}-{initiator}-{start date}` in the reader's language and time zone (not stored) */
  title: z.string(),
  formKind: z.enum(WF_FORM_KINDS),
  /** custom: the business view shown with `{ businessKey, readonly: true }` */
  viewComponent: z.string().nullable(),
  businessKey: z.string().nullable(),
  state: z.enum(WF_INSTANCE_STATES),
  initiator: wfUserRef,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /**
   * The caller's pending tasks on it, oldest first: what they may act on (`/wf/tasks/:id/…`). A `begin` one
   * = sent back to the initiator, who resubmits (a custom form: after editing the business row) or cancels.
   */
  myTasks: z.array(
    z.object({
      id: z.number().int(),
      nodeId: z.string(),
      /** a seeded model's is a `seed.wf.*` key (`tx()`) */
      nodeName: z.string(),
      type: z.enum(['begin', 'review']),
      /** the step takes no approval or rejection without a comment */
      commentRequired: z.boolean(),
      /** a delegated or add-sign task: only approve (the rest is its parent task's holder's) */
      child: z.boolean(),
    }),
  ),
  /** the add-sign tasks the caller created still pending: a remove-sign (`/wf/tasks/:parentTaskId/…`) takes them */
  signs: z.array(
    z.object({
      id: z.number().int(),
      parentTaskId: z.number().int(),
      nodeName: z.string(),
      user: wfUserRef,
    }),
  ),
  /**
   * The caller's newest approval, while the instance runs and its model allows withdrawing: what a withdraw
   * takes. The engine still refuses once the step after it acted (409).
   */
  withdrawable: z.object({ id: z.number().int(), nodeName: z.string() }).nullable(),
  /** the caller is its initiator, it runs, and its model allows cancelling or it was sent back to them */
  canCancel: z.boolean(),
  /** the caller is its initiator and a review task is pending (once an hour, else 429) */
  canUrge: z.boolean(),
  /** the form fields of the version it runs on (the designer words conditions on user / dept fields by them) */
  fields: wfFields,
  /**
   * A dynamic form as its version published it, without the caller's `hide` fields (null: a custom form,
   * a version without a form, or a tree that no longer compiles)
   */
  schema: formSchema.nullable(),
  /** its values, without the caller's `hide` fields (never sent to them; see docs/design-notes.md#workflow) */
  formValues: z.record(z.string(), z.unknown()),
  /**
   * The caller's field access: `hide` where a step they hold or held a task on hides it (`begin` for the
   * initiator), `edit` where the step of their pending task allows it; unlisted = `read`
   */
  access: z.record(z.string(), z.enum(WF_FIELD_ACCESS)),
  /**
   * the process tree of the version it runs on (the read-only designer draws it); null when it no longer
   * compiles (a hand-edited snapshot): the rest of the detail still shows
   */
  tree: wfTree.nullable(),
  /** node and fork path id → its progress (every node and path of `tree`); null with `tree` */
  progress: z.record(z.string(), z.enum(WF_NODE_PROGRESS)).nullable(),
  /**
   * the normalized BPMN XML of a BPMN model's version (the read-only diagram, marked by `progress`);
   * null for a tree model's version, and with `tree`
   */
  bpmnXml: z.string().nullable(),
  /** `wf_event` rows, oldest first */
  timeline: z.array(
    z.object({
      id: z.number().int(),
      action: z.enum(WF_ACTIONS),
      nodeId: z.string().nullable(),
      nodeName: z.string().nullable(),
      /** null = the system (a notify node, an auto-passed step) */
      actor: wfUserRef.nullable(),
      /** users it went to; `send_back` (and a send-back reject): the node it went back to */
      targets: z.array(
        z.object({ id: z.union([z.number(), z.string()]), name: z.string().nullable() }),
      ),
      comment: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
})
export type WfInstanceDetailVo = z.infer<typeof wfInstanceDetailVo>

/** An instance in the approval center lists; `title` as in the detail. */
export const wfInstanceItemVo = z.object({
  id: z.number().int(),
  modelKey: z.string(),
  modelName: z.string(),
  title: z.string(),
  initiator: wfUserRef,
  state: z.enum(WF_INSTANCE_STATES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
})
export type WfInstanceItemVo = z.infer<typeof wfInstanceItemVo>

/** GET /api/wf/instances/mine: the instances the caller started, newest first. */
export const wfMineQuery = pageQuery(['startedAt', 'id'])
  .extend({ state: z.enum(WF_INSTANCE_STATES).optional() })
  .register(fieldDomains, { domain: 'wf.instance' })
export type WfMineQuery = z.output<typeof wfMineQuery>

/**
 * A task of the caller: GET /api/wf/tasks/todo (`pending`, newest first) and /done (the ones they handled:
 * approved, rejected, sent back, transferred; latest first). `nodeName`: a seeded model's is a `seed.wf.*` key.
 */
export const wfTaskItemVo = z.object({
  id: z.number().int(),
  nodeId: z.string(),
  nodeName: z.string(),
  state: z.enum(WF_TASK_STATES),
  comment: z.string().nullable(),
  createdAt: z.iso.datetime(),
  handledAt: z.iso.datetime().nullable(),
  instance: wfInstanceItemVo,
})
export type WfTaskItemVo = z.infer<typeof wfTaskItemVo>
export const wfTodoQuery = pageQuery(['createdAt', 'id'])
export type WfTodoQuery = z.output<typeof wfTodoQuery>
export const wfDoneQuery = pageQuery(['handledAt', 'id'])
export type WfDoneQuery = z.output<typeof wfDoneQuery>

/** GET /api/wf/ccs/mine: copies sent to the caller, newest first; POST /api/wf/ccs/:id/read marks one read. */
export const wfCcItemVo = z.object({
  id: z.number().int(),
  /** null = a notify step of the process */
  fromUser: wfUserRef.nullable(),
  reason: z.string().nullable(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  instance: wfInstanceItemVo,
})
export type WfCcItemVo = z.infer<typeof wfCcItemVo>
export const wfCcQuery = pageQuery(['createdAt', 'id'])
  .extend({ unread: z.stringbool().optional() })
  .register(fieldDomains, { domain: 'wf.instance' })
export type WfCcQuery = z.output<typeof wfCcQuery>

// Task actions (动作语义; see docs/design-notes.md#workflow): POST /api/wf/tasks/:id/<action> by the task's holder, else 404. Field labels
// `field.wf.task.<prop>`.

const comment = z.string().trim().max(1000).optional()

/** reject (and actions that carry nothing but a comment) */
export const wfCommentBody = z.object({ comment }).register(fieldDomains, { domain: 'wf.task' })
export type WfCommentBody = z.output<typeof wfCommentBody>

/**
 * approve / resubmit: `formValues` = a dynamic form's changes; only the step's `edit` fields are kept
 * (`begin.access` for a resubmit), the rest is dropped. A custom form ignores it: its business row is read.
 */
export const wfDecideBody = z
  .object({ comment, formValues: z.record(z.string(), z.unknown()).optional() })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfDecideBody = z.output<typeof wfDecideBody>

/** send back to `to`: one of GET /api/wf/tasks/:id/back-targets */
export const wfSendBackBody = z
  .object({ to: z.string().min(1).max(WF_ID_MAX), comment })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfSendBackBody = z.output<typeof wfSendBackBody>

/** A step a task may be sent back to: a review step already passed, newest first, then `begin` (the initiator). */
export const wfBackTargetVo = z.object({
  id: z.string(),
  /** a seeded model's names are `seed.wf.*` keys (`tx()`) */
  name: z.string(),
  type: z.enum(['begin', 'review']),
})
export type WfBackTargetVo = z.infer<typeof wfBackTargetVo>

// Routing and lifecycle actions (动作语义; see docs/design-notes.md#workflow): POST /api/wf/tasks/:id/<action> by the task's
// holder (withdraw: who approved it), POST /api/wf/instances/:id/{cancel,urge} by the initiator; else 404.

const users = z.array(id).min(1).max(200)

/** transfer / delegate to `userId`: an enabled user without an open task on the step, else 422 */
export const wfHandOverBody = z
  .object({ userId: id, comment })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfHandOverBody = z.output<typeof wfHandOverBody>

/** add-sign: `before` holds the task until `userIds` all approved; `after` approves it, in effect once they have */
export const wfAddSignBody = z
  .object({ kind: z.enum(WF_SIGN_KINDS), userIds: users, comment })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfAddSignBody = z.output<typeof wfAddSignBody>

/** remove-sign: add-sign tasks of this task still pending */
export const wfRemoveSignBody = z
  .object({ taskIds: users, comment })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfRemoveSignBody = z.output<typeof wfRemoveSignBody>

/** cc: a copy to `userIds` (enabled users, else 422) */
export const wfCcBody = z
  .object({ userIds: users, reason: comment })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfCcBody = z.output<typeof wfCcBody>

/** comment: a timeline entry, nothing else */
export const wfRemarkBody = z
  .object({ comment: z.string().trim().min(1).max(1000) })
  .register(fieldDomains, { domain: 'wf.task' })
export type WfRemarkBody = z.output<typeof wfRemarkBody>
