import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { WF_INSTANCE_STATES, WF_TASK_STATES } from './wf-engine.js'

/**
 * Instance and task admin (管理员; see docs/design-notes.md#workflow): behind `wfPerms.instance` / `wfPerms.task`, each list and
 * action limited to the caller's data scope on `wf_instance.initiator_dept_id` (out of scope → 404). Field
 * labels `field.wf.admin.<prop>`. Seeded model and node names are `seed.wf.*` keys (`tx()`).
 */

const id = z.number().int().positive()
const idParam = z.coerce.number().int().positive().optional()
const comment = z.string().trim().max(1000).nullable().default(null)
/** A user or dept by id and name (null once the row is gone). */
const ref = z.object({ id: z.number().int(), name: z.string().nullable() })

/** GET /api/wf/instances: every instance in scope, newest first. */
export const wfAdminInstanceQuery = pageQuery(['startedAt', 'id'])
  .extend({
    modelKey: z.string().trim().max(64).optional(),
    state: z.enum(WF_INSTANCE_STATES).optional(),
    initiatorId: idParam,
  })
  .register(fieldDomains, { domain: 'wf.admin' })
export type WfAdminInstanceQuery = z.output<typeof wfAdminInstanceQuery>

export const wfAdminInstanceVo = z.object({
  id: z.number().int(),
  modelKey: z.string(),
  modelName: z.string(),
  initiator: ref,
  /** the initiator's dept when it started (the data scope column) */
  dept: ref.nullable(),
  state: z.enum(WF_INSTANCE_STATES),
  /** nodes holding a token (several while fork paths run side by side) */
  activeNodeIds: z.array(z.string()),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
})
export type WfAdminInstanceVo = z.infer<typeof wfAdminInstanceVo>

/** GET /api/wf/tasks: every task of an instance in scope, newest first. */
export const wfAdminTaskQuery = pageQuery(['createdAt', 'id'])
  .extend({
    modelKey: z.string().trim().max(64).optional(),
    state: z.enum(WF_TASK_STATES).optional(),
    assigneeId: idParam,
    instanceId: idParam,
  })
  .register(fieldDomains, { domain: 'wf.admin' })
export type WfAdminTaskQuery = z.output<typeof wfAdminTaskQuery>

export const wfAdminTaskVo = z.object({
  id: z.number().int(),
  nodeId: z.string(),
  nodeName: z.string(),
  assignee: ref,
  /** a delegated task's owner (who decides after the delegate) */
  ownerId: z.number().int().nullable(),
  state: z.enum(WF_TASK_STATES),
  createdAt: z.iso.datetime(),
  handledAt: z.iso.datetime().nullable(),
  dueAt: z.iso.datetime().nullable(),
  instance: wfAdminInstanceVo.pick({
    id: true,
    modelKey: true,
    modelName: true,
    initiator: true,
    dept: true,
    state: true,
  }),
})
export type WfAdminTaskVo = z.infer<typeof wfAdminTaskVo>

/** POST /api/wf/instances/:id/terminate: a running instance ends `terminated`, its open tasks canceled. */
export const wfTerminateBody = z.object({ comment }).register(fieldDomains, { domain: 'wf.admin' })
export type WfTerminateBody = z.output<typeof wfTerminateBody>

/**
 * POST /api/wf/tasks/:id/reassign: an open review task goes to `to` (an enabled user without an open task on
 * the node, else 422 `WF_BAD_TARGET`), e.g. when its assignee left.
 */
export const wfReassignBody = z
  .object({ to: id, comment })
  .register(fieldDomains, { domain: 'wf.admin' })
export type WfReassignBody = z.output<typeof wfReassignBody>
