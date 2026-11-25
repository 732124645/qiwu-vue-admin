import { Injectable } from '@nestjs/common'
import { Err, type OaRequestState, type WfFields, type WfInstanceState } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import { WfBusinessHandler } from '../../workflow/runtime/wf-handlers.js'
import type { WfInstanceRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { OaTripRequest } from './trip.entity.js'

export const TRIP_MODEL = 'oa-trip'
/** 条件只暴露业务含义稳定的日期和目的地，精确金额不转成浮点条件。 */
export const TRIP_FIELDS: WfFields = {
  destination: 'string',
  startAt: 'date',
  endAt: 'date',
}

const STATE: Record<WfInstanceState, OaRequestState> = {
  running: 'in_review',
  approved: 'approved',
  rejected: 'rejected',
  canceled: 'canceled',
  terminated: 'canceled',
}

/** 业务主键只接受安全整数的标准十进制形式，拒绝指数及前导零别名。 */
function rowId(key: string): number {
  const id = Number(key)
  if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(id)) throw new BizError(Err.NOT_FOUND)
  return id
}

/** 出差业务接入既有流程事务；任何回写失败都使审批动作整体回滚。 */
@WfBusinessHandler(TRIP_MODEL)
@Injectable()
export class TripWfHandler implements WfBusinessHandler {
  fields = (): WfFields => TRIP_FIELDS

  /** 发起前锁定本租户本人尚未启动的草稿，禁止复用他人单据或重复实例。 */
  async assertStartable(businessKey: string, initiatorId: number, tx: EntityManager) {
    const row = await tx.getRepository(OaTripRequest).findOne({
      where: { id: rowId(businessKey) },
      lock: { mode: 'pessimistic_write' },
    })
    if (!row || row.userId !== initiatorId) throw new BizError(Err.NOT_FOUND)
    if (row.state !== 'draft' || row.instanceId !== null) throw new BizError(Err.CONFLICT)
  }

  /** 使用当前读取得真实业务值，退回重提不接受客户端伪造的条件字段。 */
  async loadFormValues(businessKey: string, tx: EntityManager) {
    const row = await tx.getRepository(OaTripRequest).findOne({
      where: { id: rowId(businessKey) },
      lock: { mode: 'pessimistic_read' },
    })
    if (!row) throw new BizError(Err.NOT_FOUND)
    return {
      destination: row.destination,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt.toISOString(),
    }
  }

  /** 业务行和流程状态同事务更新，终止沿用撤销的业务含义。 */
  async onStateChange(instance: WfInstanceRow, tx: EntityManager) {
    const result = await tx
      .getRepository(OaTripRequest)
      .update(
        { id: rowId(instance.businessKey ?? '') },
        { instanceId: instance.id, state: STATE[instance.state] },
      )
    if (result.affected !== 1) throw new BizError(Err.NOT_FOUND)
  }
}
