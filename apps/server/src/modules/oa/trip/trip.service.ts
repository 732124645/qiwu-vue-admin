import { OaAttachmentService } from '../attachment/oa-attachment.service.js'
import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  tripCreate,
  tripUpdate,
  type TripCreate,
  type TripQuery,
  type TripUpdate,
} from '@qiwu/shared'
import type { EntityManager, SelectQueryBuilder } from 'typeorm'
import { clsGet } from '../../../core/context/cls.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { WfDetailService } from '../../workflow/center/wf-detail.service.js'
import { WfStartService } from '../../workflow/center/wf-start.service.js'
import { WfVersion } from '../../workflow/model/wf-model.entity.js'
import { WfInstanceRow, WfTaskRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { TRIP_MODEL } from './trip-wf.handler.js'
import { OaTripRequest } from './trip.entity.js'

const caller = () => clsGet('principal')!

/** 本人出差单与参与者详情沿用流程可见性，不因部门角色范围误挡真实审批人。 */
@Injectable()
export class TripService extends BaseCrudService<OaTripRequest> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly starts: WfStartService,
    private readonly details: WfDetailService,
    private readonly attachments: OaAttachmentService,
  ) {
    super(txHost, OaTripRequest)
  }

  /** 我的列表恒定限制本人，管理员查看他人单据仍须经流程的权限和数据范围。 */
  protected override filter(qb: SelectQueryBuilder<OaTripRequest>, query: TripQuery) {
    qb.andWhere('t.user_id = :me', { me: caller().userId })
    if (query.destination)
      qb.andWhere('t.destination LIKE :destination', { destination: `%${query.destination}%` })
    if (query.state) qb.andWhere('t.state = :state', { state: query.state })
    if (query.startAtFrom) qb.andWhere('t.start_at >= :from', { from: new Date(query.startAtFrom) })
    if (query.startAtTo) qb.andWhere('t.start_at <= :to', { to: new Date(query.startAtTo) })
    return qb
  }

  /** 列表也规范旧空附件字段，输出契约不因历史行而变化。 */
  async myPage(query: TripQuery) {
    const result = await super.page(query)
    return { ...result, items: result.items.map((row) => this.present(row)) }
  }

  /** 详情仅向申请人或有权查看关联流程的参与者开放，其他情况统一为不存在。 */
  override async get(id: number): Promise<OaTripRequest> {
    const row = await this.repo.findOneBy({ id })
    if (row?.userId === caller().userId) return this.present(row)
    if (row?.instanceId && (await this.details.canView(row.instanceId))) return this.present(row)
    throw new NotFoundException()
  }

  /** 单据创建和流程启动共用事务，选人或模型校验失败不会留下半张申请。 */
  submit(dto: TripCreate): Promise<OaTripRequest> {
    return this.txHost.withTransaction(async () => {
      const parsed = parseOr400(tripCreate, dto)
      const { initiatorPicks, startAt, endAt, ...fields } = parsed
      const { userId, deptId } = caller()
      const row = await this.repo.save(
        this.repo.create({
          ...fields,
          startAt: new Date(startAt),
          endAt: new Date(endAt),
          attachmentIds: parsed.attachmentIds ?? [],
          estimatedAmount: parsed.estimatedAmount ?? null,
          userId,
          deptId,
          state: 'draft',
          instanceId: null,
        }),
      )
      await this.attachments.sync('trip', row.id, row.attachmentIds ?? [], [], userId)
      await this.starts.start(userId, {
        modelKey: TRIP_MODEL,
        businessKey: String(row.id),
        initiatorPicks,
        formValues: {},
      })
      return this.present(await this.repo.findOneByOrFail({ id: row.id }))
    })
  }

  /** 编辑与流程动作统一按实例再业务行取锁，锁内重新判断本人和退回资格。 */
  override update(id: number, dto: TripUpdate): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const input = parseOr400(tripUpdate, dto)
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
      // 先读到的未绑定草稿若已被并发发起，不在持有业务锁时反向补取实例锁。
      if (row.instanceId !== seen.instanceId) throw new BizError(Err.CONFLICT)
      const draft = row.state === 'draft' && row.instanceId === null
      if (!draft && !(instance?.state === 'running' && (await this.sentBack(instance))))
        throw new BizError(Err.CONFLICT)
      const merged = parseOr400(tripCreate, {
        destination: input.destination ?? row.destination,
        startAt: input.startAt ?? row.startAt.toISOString(),
        endAt: input.endAt ?? row.endAt.toISOString(),
        reason: input.reason ?? row.reason,
        estimatedAmount:
          input.estimatedAmount === undefined ? row.estimatedAmount : input.estimatedAmount,
        attachmentIds: input.attachmentIds ?? row.attachmentIds ?? [],
        initiatorPicks: {},
      })
      const changes = {
        ...input,
        ...(input.startAt ? { startAt: new Date(merged.startAt) } : {}),
        ...(input.endAt ? { endAt: new Date(merged.endAt) } : {}),
      }
      if (Object.keys(changes).length) await this.repo.update(id, changes)
      if (input.attachmentIds !== undefined)
        await this.attachments.sync(
          'trip',
          id,
          input.attachmentIds,
          row.attachmentIds ?? [],
          caller().userId,
        )
    })
  }

  /** 报销只能引用本人在当前租户已批准的出差；锁内校验防止引用状态漂移。 */
  async assertExpenseReference(
    id: number,
    userId: number,
    tx: EntityManager,
  ): Promise<OaTripRequest> {
    const row = await tx.getRepository(OaTripRequest).findOne({
      where: { id },
      lock: { mode: 'pessimistic_read' },
    })
    if (!row || row.userId !== userId) throw new NotFoundException()
    if (row.state !== 'approved') throw new BizError(Err.CONFLICT)
    return row
  }

  /** begin 节点来自该实例的发布快照，任务必须仍归本人且待处理。 */
  private async sentBack(instance: WfInstanceRow): Promise<boolean> {
    // 运行中的实例仍可使用已软删的发布快照，与流程引擎保持一致。
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

  /** 历史空 JSON 字段规范为公开契约中的空列表，不改变库里的历史行。 */
  private present(row: OaTripRequest): OaTripRequest {
    row.attachmentIds ??= []
    return row
  }
}
