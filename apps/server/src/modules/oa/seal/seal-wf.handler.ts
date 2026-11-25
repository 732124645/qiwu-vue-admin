import { Injectable } from '@nestjs/common'
import {
  Err,
  sealCreate,
  type OaRequestState,
  type WfFields,
  type WfInstanceState,
} from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { WfBusinessHandler } from '../../workflow/runtime/wf-handlers.js'
import type { WfInstanceRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { OaSealRequest } from './seal.entity.js'

export const SEAL_MODEL = 'oa-seal'
export const SEAL_FIELDS: WfFields = { sealKind: 'string', copies: 'number', expectedDate: 'date' }
const STATE: Record<WfInstanceState, OaRequestState> = {
  running: 'in_review',
  approved: 'approved',
  rejected: 'rejected',
  canceled: 'canceled',
  terminated: 'canceled',
}

/** 业务主键只接受安全整数的标准十进制形式。 */
function rowId(key: string): number {
  const id = Number(key)
  if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(id)) throw new BizError(Err.NOT_FOUND)
  return id
}

/** 用印接入现有审批事务；批准只表示获准用印，不表示实际盖章。 */
@WfBusinessHandler(SEAL_MODEL)
@Injectable()
export class SealWfHandler implements WfBusinessHandler {
  fields = (): WfFields => SEAL_FIELDS

  /** 发起前锁定本人未绑定的草稿，其他人的单据不可代发或重复启动。 */
  async assertStartable(businessKey: string, initiatorId: number, tx: EntityManager) {
    const row = await tx.getRepository(OaSealRequest).findOne({
      where: { id: rowId(businessKey) },
      lock: { mode: 'pessimistic_write' },
    })
    if (!row || row.userId !== initiatorId) throw new BizError(Err.NOT_FOUND)
    if (row.state !== 'draft' || row.instanceId !== null) throw new BizError(Err.CONFLICT)
  }

  /** 流程条件仅从当前业务行取得，重新提交时不信任客户端的 formValues。 */
  async loadFormValues(businessKey: string, tx: EntityManager) {
    const row = await tx.getRepository(OaSealRequest).findOne({
      where: { id: rowId(businessKey) },
      lock: { mode: 'pessimistic_read' },
    })
    if (!row) throw new BizError(Err.NOT_FOUND)
    parseOr400(sealCreate, {
      sealKind: row.sealKind,
      documentName: row.documentName,
      purpose: row.purpose,
      copies: row.copies,
      expectedDate: row.expectedDate,
      attachmentIds: row.attachmentIds ?? [],
      initiatorPicks: {},
    })
    return { sealKind: row.sealKind, copies: row.copies, expectedDate: row.expectedDate }
  }

  /** 行丢失或写回失败必须回滚审批，不能在没有业务结果时显示通过。 */
  async onStateChange(instance: WfInstanceRow, tx: EntityManager) {
    const result = await tx
      .getRepository(OaSealRequest)
      .update(
        { id: rowId(instance.businessKey ?? '') },
        { instanceId: instance.id, state: STATE[instance.state] },
      )
    if (result.affected !== 1) throw new BizError(Err.NOT_FOUND)
  }
}
