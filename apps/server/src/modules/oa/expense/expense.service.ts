import { OaAttachmentService } from '../attachment/oa-attachment.service.js'
import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  expenseCreate,
  expenseUpdate,
  type ExpenseCreate,
  type ExpenseItemInput,
  type ExpenseQuery,
  type ExpenseUpdate,
} from '@qiwu/shared'
import { In, type SelectQueryBuilder } from 'typeorm'
import { clsGet } from '../../../core/context/cls.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { WfDetailService } from '../../workflow/center/wf-detail.service.js'
import { WfStartService } from '../../workflow/center/wf-start.service.js'
import { WfVersion } from '../../workflow/model/wf-model.entity.js'
import { WfInstanceRow, WfTaskRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { TripService } from '../trip/trip.service.js'
import { sumExpenseAmounts } from './expense-money.js'
import { OaExpenseItem } from './expense-item.entity.js'
import { EXPENSE_MODEL } from './expense-wf.handler.js'
import { OaExpenseClaim } from './expense.entity.js'

const caller = () => clsGet('principal')!

/** 报销主子单据只通过整单事务写入，详情沿用既有流程参与者的访问规则。 */
@Injectable()
export class ExpenseService extends BaseCrudService<OaExpenseClaim> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly starts: WfStartService,
    private readonly details: WfDetailService,
    private readonly attachments: OaAttachmentService,
    private readonly trips: TripService,
  ) {
    super(txHost, OaExpenseClaim)
  }

  /** 我的报销列表恒定限制本人，角色数据范围不能把它扩成全员列表。 */
  protected override filter(qb: SelectQueryBuilder<OaExpenseClaim>, query: ExpenseQuery) {
    qb.andWhere('t.user_id = :me', { me: caller().userId })
    if (query.reason) qb.andWhere('t.reason LIKE :reason', { reason: `%${query.reason}%` })
    if (query.tripId) qb.andWhere('t.trip_id = :tripId', { tripId: query.tripId })
    if (query.state) qb.andWhere('t.state = :state', { state: query.state })
    return qb
  }

  /** 列表仅返回主单，历史空附件字段规范成公开契约的空数组。 */
  async myPage(query: ExpenseQuery) {
    const result = await super.page(query)
    return { ...result, items: result.items.map((row) => this.present(row)) }
  }

  /** 同一只读快照内判断可见性并读取主子单据，避免并发改单拼接出不一致的金额。 */
  override async get(id: number): Promise<OaExpenseClaim & { items: OaExpenseItem[] }> {
    return this.txHost.withTransaction(async () => {
      const row = await this.repo.findOneBy({ id })
      if (
        !row ||
        (row.userId !== caller().userId &&
          !(row.instanceId && (await this.details.canView(row.instanceId))))
      )
        throw new NotFoundException()
      return {
        ...this.present(row),
        items: await this.itemsOf(id),
      }
    })
  }

  /** 精确汇总、保存主子表和启动审批共用事务，任何一项失败都不留下半张单。 */
  submit(dto: ExpenseCreate): Promise<OaExpenseClaim & { items: OaExpenseItem[] }> {
    return this.txHost.withTransaction(async () => {
      const input = parseOr400(expenseCreate, dto)
      if (input.items.some((item) => item.id !== undefined))
        throw new BizError(Err.VALIDATION_FAILED)
      const { userId, deptId } = caller()
      if (input.tripId != null)
        await this.trips.assertExpenseReference(input.tripId, userId, this.txHost.tx)
      const row = await this.repo.save(
        this.repo.create({
          userId,
          deptId,
          reason: input.reason,
          tripId: input.tripId ?? null,
          totalAmount: sumExpenseAmounts(input.items.map((item) => item.amount)),
          currency: 'CNY',
          attachmentIds: input.attachmentIds ?? [],
          state: 'draft',
          instanceId: null,
        }),
      )
      await this.replaceItems(row.id, input.items, [])
      await this.attachments.sync(
        'expense',
        row.id,
        [
          ...(input.attachmentIds ?? []),
          ...input.items.flatMap((item) => item.attachmentIds ?? []),
        ],
        [],
        userId,
      )
      await this.starts.start(userId, {
        modelKey: EXPENSE_MODEL,
        businessKey: String(row.id),
        initiatorPicks: input.initiatorPicks,
        formValues: {},
      })
      return this.get(row.id)
    })
  }

  /** 编辑按实例、主单、明细取锁，重新提交不能绕过最新退回资格或读取旧合计。 */
  override update(id: number, dto: ExpenseUpdate): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const input = parseOr400(expenseUpdate, dto)
      const seen = await this.repo.findOneBy({ id })
      if (!seen || seen.userId !== caller().userId) throw new NotFoundException()
      const instance =
        seen.instanceId === null
          ? null
          : await this.txHost.tx.getRepository(WfInstanceRow).findOne({
              where: { id: seen.instanceId },
              lock: { mode: 'pessimistic_write' },
            })
      const row = await this.repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
      if (!row || row.userId !== caller().userId) throw new NotFoundException()
      // 未绑定快照若已被发起，不能持业务锁反向补抢实例锁。
      if (row.instanceId !== seen.instanceId) throw new BizError(Err.CONFLICT)
      const draft = row.state === 'draft' && row.instanceId === null
      if (!draft && !(instance?.state === 'running' && (await this.sentBack(instance))))
        throw new BizError(Err.CONFLICT)
      const tripId = input.tripId === undefined ? row.tripId : input.tripId
      if (tripId != null)
        await this.trips.assertExpenseReference(tripId, caller().userId, this.txHost.tx)
      const items = await this.itemsOf(id, true)
      const changes = {
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.tripId !== undefined ? { tripId: input.tripId ?? null } : {}),
        ...(input.attachmentIds !== undefined ? { attachmentIds: input.attachmentIds } : {}),
        ...(input.items !== undefined
          ? { totalAmount: sumExpenseAmounts(input.items.map((item) => item.amount)) }
          : {}),
      }
      if (input.items !== undefined) await this.replaceItems(id, input.items, items)
      if (Object.keys(changes).length) await this.repo.update(id, changes)
      if (input.attachmentIds !== undefined || input.items !== undefined)
        await this.attachments.sync(
          'expense',
          id,
          [
            ...(input.attachmentIds ?? row.attachmentIds ?? []),
            ...(input.items ?? items).flatMap((item) => item.attachmentIds ?? []),
          ],
          [...(row.attachmentIds ?? []), ...items.flatMap((item) => item.attachmentIds ?? [])],
          caller().userId,
        )
    })
  }

  /** 以当前读加载有效明细；整单锁约定保证它与主单总额属于同一次写入。 */
  private async itemsOf(claimId: number, locked = false): Promise<OaExpenseItem[]> {
    const rows = await this.txHost.tx.getRepository(OaExpenseItem).find({
      where: { claimId },
      order: { sortNo: 'ASC', id: 'ASC' },
      ...(locked ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    })
    for (const row of rows) row.attachmentIds ??= []
    return rows
  }

  /** 差异写入只认本单当前有效明细 ID，删除也限制本单与租户，绝不复活旧行。 */
  private async replaceItems(
    claimId: number,
    input: ExpenseItemInput[],
    old: OaExpenseItem[],
  ): Promise<void> {
    const ids = input.flatMap((item) => (item.id === undefined ? [] : [item.id]))
    if (new Set(ids).size !== ids.length) throw new BizError(Err.VALIDATION_FAILED)
    const allowed = new Set(old.map((item) => item.id))
    if (ids.some((id) => !allowed.has(id))) throw new NotFoundException()
    const repo = this.txHost.tx.getRepository(OaExpenseItem)
    for (const [i, item] of input.entries()) {
      const values = {
        expenseDate: item.expenseDate,
        expenseKind: item.expenseKind,
        amount: item.amount,
        description: item.description,
        attachmentIds: item.attachmentIds ?? [],
        sortNo: i + 1,
      }
      if (item.id === undefined) await repo.insert({ ...values, claimId })
      else {
        const updated = await repo.update({ id: item.id, claimId }, values)
        if (updated.affected !== 1) throw new NotFoundException()
      }
    }
    const removed = old.filter((item) => !ids.includes(item.id)).map((item) => item.id)
    if (removed.length) await repo.softDelete({ id: In(removed), claimId })
  }

  /** begin 必须仍属于本人且待处理；锁定读避免等待实例锁后沿用旧快照。 */
  private async sentBack(instance: WfInstanceRow): Promise<boolean> {
    const version = await this.txHost.tx.getRepository(WfVersion).findOne({
      where: { id: instance.versionId },
      withDeleted: true,
      lock: { mode: 'pessimistic_read' },
    })
    if (!version) return false
    return !!(await this.txHost.tx.getRepository(WfTaskRow).findOne({
      where: {
        instanceId: instance.id,
        nodeId: version.treeJson.id,
        assigneeId: caller().userId,
        state: 'pending',
      },
      lock: { mode: 'pessimistic_read' },
    }))
  }

  /** 规范空附件，只改变响应对象，不回写历史业务行。 */
  private present(row: OaExpenseClaim): OaExpenseClaim {
    row.attachmentIds ??= []
    return row
  }
}
