import { z } from 'zod'
import {
  WF_FIELD_OPS,
  WF_FIELD_TYPES,
  WF_INITIATOR_OPS,
  type WfCondition,
  type WfFields,
  type WfFieldType,
  type WfInitiatorCtx,
  type WfInstance,
  type WfOp,
} from '@qiwu/shared'

/*
 * Fork path conditions (see docs/design-notes.md#workflow): plain comparisons, no eval. A condition that does not type-check
 * against `fields` (unknown field, op the type does not take, missing or mistyped value on either side) never
 * matches, `ne` included: the fork falls through to its fallback instead of guessing.
 */

const isoDateOrTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })])
const isId = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
const IS: Record<WfFieldType, (v: unknown) => boolean> = {
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  date: (v) => isoDateOrTime.safeParse(v).success,
  user: isId,
  dept: isId,
}
/** Dates compare as instants (a bare date = 00:00 UTC, like the DB sessions); the rest as they are. */
const key = (type: WfFieldType, v: unknown) =>
  (type === 'date' ? Date.parse(v as string) : v) as number | string

function formCondition(
  { field, op, value }: WfCondition,
  fields: WfFields,
  formValues: Record<string, unknown>,
): boolean {
  // `find` rather than `fields[field]`: an inherited `constructor` is no type
  const type = WF_FIELD_TYPES.find((t) => t === fields[field])
  if (!type || !(WF_FIELD_OPS[type] as readonly WfOp[]).includes(op)) return false
  const is = IS[type]
  const v = Object.hasOwn(formValues, field) ? formValues[field] : undefined
  if (!is(v)) return false
  if (op === 'contains')
    return typeof value === 'string' && value !== '' && (v as string).includes(value)
  // `in` never takes dates (WF_FIELD_OPS): plain equality
  if (op === 'in') return Array.isArray(value) && (value as unknown[]).includes(v)
  if (!is(value)) return false
  const [a, b] = [key(type, v), key(type, value)]
  switch (op) {
    case 'eq':
      return a === b
    case 'ne':
      return a !== b
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
    default:
      return false
  }
}

/**
 * `$initiator.dept` + `inDeptTree`: the start-time dept lies in one of the listed depts' subtrees, i.e. a
 * prefix of `deptTreePath` (`/1/4/7/`, self included) ends in `/<id>/`. `$initiator.roles` + `hasRole`: any
 * listed role held.
 */
function initiatorCondition({ field, op, value }: WfCondition, ctx: WfInitiatorCtx): boolean {
  if (op !== WF_INITIATOR_OPS[field as keyof typeof WF_INITIATOR_OPS] || !Array.isArray(value))
    return false
  const ids = (value as unknown[]).filter(isId)
  if (op === 'hasRole') return ids.some((id) => ctx.roleIds.includes(id))
  const path = ctx.deptTreePath
  return path !== null && ids.some((id) => path.includes(`/${id}/`))
}

/**
 * A fork path's `when`: OR of AND groups over the instance's form values and its start-time initiator
 * snapshot (`initiator_ctx`, never the live org chart). Pure: reads its arguments, writes nothing.
 */
export function matchWhen(
  when: readonly (readonly WfCondition[])[],
  fields: WfFields,
  instance: Pick<WfInstance, 'formValues' | 'initiatorCtx'>,
): boolean {
  return when.some(
    (group) =>
      group.length > 0 &&
      group.every((c) =>
        Object.hasOwn(WF_INITIATOR_OPS, c.field)
          ? initiatorCondition(c, instance.initiatorCtx)
          : formCondition(c, fields, instance.formValues),
      ),
  )
}
