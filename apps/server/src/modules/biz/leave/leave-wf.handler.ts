import { Injectable } from '@nestjs/common'
import { Err, type WfFields, type WfInstanceState } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import { WfBusinessHandler } from '../../workflow/runtime/wf-handlers.js'
import type { WfInstanceRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { Leave } from './leave.entity.js'

/** The model key of the leave process (its seeded model); the business key is the row id. */
export const LEAVE_MODEL = 'leave'
/** What the process decides on (the seeded model's conditions use `days`). */
export const LEAVE_FIELDS: WfFields = { days: 'number', leaveKind: 'string', startAt: 'date' }

/** `biz_leave_request.state` of each instance state: an admin's termination cancels the request. */
const STATE: Record<WfInstanceState, string> = {
  running: 'in_review',
  approved: 'approved',
  rejected: 'rejected',
  canceled: 'canceled',
  terminated: 'canceled',
}

/** A business key names a row id (digits only: `1e3` is no alias of 1000). */
const rowId = (businessKey: string) => (/^[1-9]\d{0,15}$/.test(businessKey) ? +businessKey : null)

/**
 * The leave request's side of process `leave` (see docs/design-notes.md#workflow), inside the workflow action's transaction.
 * The engine decides on the row's values only: a client's `formValues` never reach it.
 */
@WfBusinessHandler(LEAVE_MODEL)
@Injectable()
export class LeaveWfHandler implements WfBusinessHandler {
  fields = (): WfFields => LEAVE_FIELDS

  /** Locks the row (`FOR UPDATE`): the initiator's own (else 404), a draft never started (else 409). */
  async assertStartable(businessKey: string, initiatorId: number, tx: EntityManager) {
    const id = rowId(businessKey)
    const row =
      id === null
        ? null
        : await tx
            .getRepository(Leave)
            .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
    if (!row || row.userId !== initiatorId) throw new BizError(Err.NOT_FOUND)
    if (row.state !== 'draft' || row.instanceId !== null) throw new BizError(Err.CONFLICT)
  }

  /**
   * A current read (`FOR SHARE`): a resubmit whose snapshot predates an edit of the sent-back request
   * (leave.service.ts `update`, which locks the row) waits for it and decides on the edited values.
   */
  async loadFormValues(businessKey: string, tx: EntityManager) {
    const row = await tx.getRepository(Leave).findOneOrFail({
      where: { id: rowId(businessKey) ?? 0 },
      lock: { mode: 'pessimistic_read' },
    })
    return { days: row.days, leaveKind: row.leaveKind, startAt: row.startAt.toISOString() }
  }

  /** The row follows its instance: bound at the start, its state mirrored on every change. */
  async onStateChange(inst: WfInstanceRow, tx: EntityManager) {
    const id = rowId(inst.businessKey ?? '') ?? 0
    await tx.getRepository(Leave).update({ id }, { instanceId: inst.id, state: STATE[inst.state] })
  }
}
