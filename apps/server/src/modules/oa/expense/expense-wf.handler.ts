import { Injectable } from '@nestjs/common'
import { Err, type OaRequestState, type WfFields, type WfInstanceState } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import { WfBusinessHandler } from '../../workflow/runtime/wf-handlers.js'
import type { WfInstanceRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { OaExpenseItem } from './expense-item.entity.js'
import { sumExpenseAmounts } from './expense-money.js'
import { OaExpenseClaim } from './expense.entity.js'

export const EXPENSE_MODEL = 'oa-expense'
export const EXPENSE_FIELDS: WfFields = { reason: 'string', totalAmount: 'number' }

const STATE: Record<WfInstanceState, OaRequestState> = {
  running: 'in_review',
  approved: 'approved',
  rejected: 'rejected',
  canceled: 'canceled',
  terminated: 'canceled',
}

/** 只接受安全整数的标准十进制主键，拒绝指数和别名。 */
function rowId(key: string): number {
  const id = Number(key)
  if (!/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(id)) throw new BizError(Err.NOT_FOUND)
  return id
}

/** 报销接入既有引擎；主子金额或状态回写出错都必须回滚本次流程动作。 */
@WfBusinessHandler(EXPENSE_MODEL)
@Injectable()
export class ExpenseWfHandler implements WfBusinessHandler {
  fields = (): WfFields => EXPENSE_FIELDS

  /** 仅本人当前租户未启动的草稿可绑定流程，重复启动统一冲突。 */
  async assertStartable(businessKey: string, initiatorId: number, tx: EntityManager) {
    const row = await tx.getRepository(OaExpenseClaim).findOne({
      where: { id: rowId(businessKey) },
      lock: { mode: 'pessimistic_write' },
    })
    if (!row || row.userId !== initiatorId) throw new BizError(Err.NOT_FOUND)
    if (row.state !== 'draft' || row.instanceId !== null) throw new BizError(Err.CONFLICT)
  }

  /** 当前读复核主子合计，分支值来自真实明细，不信任客户端或失配的库内总额。 */
  async loadFormValues(businessKey: string, tx: EntityManager) {
    const row = await tx.getRepository(OaExpenseClaim).findOne({
      where: { id: rowId(businessKey) },
      lock: { mode: 'pessimistic_read' },
    })
    if (!row) throw new BizError(Err.NOT_FOUND)
    const items = await tx.getRepository(OaExpenseItem).find({
      where: { claimId: row.id },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_read' },
    })
    const total = sumExpenseAmounts(items.map((item) => item.amount))
    if (total !== row.totalAmount || row.currency !== 'CNY') throw new BizError(Err.CONFLICT)
    // 分支只比较已限定为两位小数的有界金额；求和和存储仍保留精确整数分与十进制文本。
    return { reason: row.reason, totalAmount: Number(total) }
  }

  /** 业务结果与实例同事务写入，单据丢失时不能让审批静默成功。 */
  async onStateChange(instance: WfInstanceRow, tx: EntityManager) {
    const updated = await tx
      .getRepository(OaExpenseClaim)
      .update(
        { id: rowId(instance.businessKey ?? '') },
        { instanceId: instance.id, state: STATE[instance.state] },
      )
    if (updated.affected !== 1) throw new BizError(Err.NOT_FOUND)
  }
}
