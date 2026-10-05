import { z } from 'zod'
import { pageQuery } from '../common/pagination.js'
import { fieldDomains } from '../validation/zod-i18n.js'
import { WF_INSTANCE_STATES } from './wf-engine.js'
import { WF_FIELD_TYPES, WF_OPS, wfFieldName } from './wf.schema.js'

/**
 * Approval data: a model's instances with their form values as columns, behind `wfPerms.data`
 * (root only), limited to the caller's data scope on `wf_instance.initiator_dept_id`. Root and the model's
 * process admins see every field, anyone else not the ones a step of the version hides. Field labels
 * `field.wf.data.<prop>`; the export's fixed columns use the same labels.
 */

/** The fixed columns before the form fields, page and export alike (labels `field.wf.data.<name>`). */
export const WF_DATA_BASE_COLUMNS = [
  'id',
  'state',
  'initiator',
  'dept',
  'startedAt',
  'endedAt',
] as const

/** Most field filters in one query. */
export const WF_DATA_FILTERS_MAX = 10
const scalar = z.union([z.number(), z.string().max(200)])

/**
 * One field filter: a field of the chosen version's form that the caller sees, an op its type takes
 * and a value of its type, as fork conditions take them (`fieldConditionError`, checked on the server against
 * the snapshot: else 400).
 */
export const wfDataFilter = z.object({
  field: wfFieldName,
  op: z.enum(WF_OPS),
  value: z.union([scalar, z.array(scalar).min(1).max(50)]),
})
export type WfDataFilter = z.infer<typeof wfDataFilter>

/** `filters` travels as JSON text in the query string. */
const filtersParam = z
  .string()
  .max(4000)
  .transform((text, ctx): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      ctx.addIssue({ code: 'custom', message: 'validation.invalid' })
      return z.NEVER
    }
  })
  .pipe(z.array(wfDataFilter).max(WF_DATA_FILTERS_MAX))

/**
 * GET /api/wf/models/:key/data (and `/export`, same filters and sort): every instance of the model, newest
 * first; `version` (a version number, default the current one) picks the form whose fields are the columns
 * and that `filters` are checked against.
 */
export const wfDataQuery = pageQuery(['startedAt', 'endedAt', 'id'])
  .extend({
    version: z.coerce.number().int().positive().optional(),
    state: z.enum(WF_INSTANCE_STATES).optional(),
    initiatorId: z.coerce.number().int().positive().optional(),
    startedAtFrom: z.iso.datetime({ offset: true }).optional(),
    startedAtTo: z.iso.datetime({ offset: true }).optional(),
    filters: filtersParam.optional(),
  })
  .register(fieldDomains, { domain: 'wf.data' })
export type WfDataQuery = z.output<typeof wfDataQuery>

/** A form field column: its name, type and title in the reader's language (the field name without one). */
export const wfDataColumn = z.object({
  field: z.string(),
  type: z.enum(WF_FIELD_TYPES),
  label: z.string(),
})
export type WfDataColumn = z.infer<typeof wfDataColumn>

/** A user or dept by id and name (null once the row is gone). */
const ref = z.object({ id: z.number().int(), name: z.string().nullable() })

export const wfDataRowVo = z.object({
  id: z.number().int(),
  /** the version the instance runs on */
  version: z.number().int(),
  state: z.enum(WF_INSTANCE_STATES),
  initiator: ref,
  /** the initiator's dept when it started (the data scope column) */
  dept: ref.nullable(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  /**
   * The columns' values as stored, a `user` / `dept` id as `{ id, name }`; a column the instance has no
   * value for is absent.
   */
  values: z.record(z.string(), z.unknown()),
})
export type WfDataRowVo = z.infer<typeof wfDataRowVo>

export const wfDataPageVo = z.object({
  /** the version whose fields are the columns; null = never published (nothing to list) */
  version: z.number().int().nullable(),
  /** published version numbers, newest first */
  versions: z.array(z.number().int()),
  /** the version's fields the caller may see */
  columns: z.array(wfDataColumn),
  /**
   * how many of the version's fields are withheld from the caller: hidden on some step (begin included), only
   * root and the model's process admins see them; 0 = none
   */
  withheld: z.number().int(),
  items: z.array(wfDataRowVo),
  total: z.number().int(),
})
export type WfDataPageVo = z.infer<typeof wfDataPageVo>
