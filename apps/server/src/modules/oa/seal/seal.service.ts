import { OaAttachmentService } from '../attachment/oa-attachment.service.js'
import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  sealCreate,
  sealUpdate,
  type SealCreate,
  type SealQuery,
  type SealUpdate,
} from '@qiwu/shared'
import type { SelectQueryBuilder } from 'typeorm'
import { clsGet } from '../../../core/context/cls.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { WfDetailService } from '../../workflow/center/wf-detail.service.js'
import { WfStartService } from '../../workflow/center/wf-start.service.js'
import { WfVersion } from '../../workflow/model/wf-model.entity.js'
import { WfInstanceRow, WfTaskRow } from '../../workflow/runtime/wf-runtime.entity.js'
import { SEAL_MODEL } from './seal-wf.handler.js'
import { OaSealRequest } from './seal.entity.js'

const caller = () => clsGet('principal')!

/** 用印业务只管理本人申请，审批参与者的详情权限由现有工作流判断。 */
@Injectable()
export class SealService extends BaseCrudService<OaSealRequest> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly starts: WfStartService,
    private readonly details: WfDetailService,
    private readonly attachments: OaAttachmentService,
  ) {
    super(txHost, OaSealRequest)
  }

  /** 我的列表始终限制本人，不让部门范围扩大为代他人编辑申请的能力。 */
  protected override filter(qb: SelectQueryBuilder<OaSealRequest>, query: SealQuery) {
    qb.andWhere('t.user_id = :me', { me: caller().userId })
    if (query.documentName)
      qb.andWhere('t.document_name LIKE :name', { name: `%${query.documentName}%` })
    if (query.sealKind) qb.andWhere('t.seal_kind = :kind', { kind: query.sealKind })
    if (query.state) qb.andWhere('t.state = :state', { state: query.state })
    return qb
  }

  /** 空 JSON 附件按空列表返回，不改变库中历史记录。 */
  async myPage(query: SealQuery) {
    const page = await super.page(query)
    return { ...page, items: page.items.map((row) => this.present(row)) }
  }

  /** 申请人或关联流程可见者才能读取业务单，知道主键不构成授权。 */
  override async get(id: number): Promise<OaSealRequest> {
    const row = await this.repo.findOneBy({ id })
    if (row?.userId === caller().userId) return this.present(row)
    if (row?.instanceId && (await this.details.canView(row.instanceId))) return this.present(row)
    throw new NotFoundException()
  }

  /** 保存单据和启动现有审批同事务，选人或模型失败时不保留半张申请。 */
  submit(dto: SealCreate): Promise<OaSealRequest> {
    return this.txHost.withTransaction(async () => {
      const parsed = parseOr400(sealCreate, dto)
      const { initiatorPicks, ...fields } = parsed
      const { userId, deptId } = caller()
      const row = await this.repo.save(
        this.repo.create({
          ...fields,
          userId,
          deptId,
          attachmentIds: parsed.attachmentIds ?? [],
          state: 'draft',
          instanceId: null,
        }),
      )
      await this.attachments.sync('seal', row.id, row.attachmentIds ?? [], [], userId)
      await this.starts.start(userId, {
        modelKey: SEAL_MODEL,
        businessKey: String(row.id),
        initiatorPicks,
        formValues: {},
      })
      return this.present(await this.repo.findOneByOrFail({ id: row.id }))
    })
  }

  /** 编辑先锁实例再锁业务单，并在当前读中复查绑定、本人和退回资格。 */
  override update(id: number, dto: SealUpdate): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const input = parseOr400(sealUpdate, dto)
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
      // 草稿被并发发起后不能持业务锁反向取实例锁，返回冲突让调用方刷新。
      if (row.instanceId !== seen.instanceId) throw new BizError(Err.CONFLICT)
      const draft = row.state === 'draft' && row.instanceId === null
      if (!draft && !(instance?.state === 'running' && (await this.sentBack(instance))))
        throw new BizError(Err.CONFLICT)
      parseOr400(sealCreate, {
        sealKind: input.sealKind ?? row.sealKind,
        documentName: input.documentName ?? row.documentName,
        purpose: input.purpose ?? row.purpose,
        copies: input.copies ?? row.copies,
        expectedDate: input.expectedDate ?? row.expectedDate,
        attachmentIds: input.attachmentIds ?? row.attachmentIds ?? [],
        initiatorPicks: {},
      })
      if (Object.keys(input).length) await this.repo.update(id, input)
      if (input.attachmentIds !== undefined)
        await this.attachments.sync(
          'seal',
          id,
          input.attachmentIds,
          row.attachmentIds ?? [],
          caller().userId,
        )
    })
  }

  /** 读取已发布版本的 begin 节点，并以当前读确认发起人任务仍待处理。 */
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

  /** 返回契约需要附件列表，旧空值仅在响应中规范化。 */
  private present(row: OaSealRequest): OaSealRequest {
    row.attachmentIds ??= []
    return row
  }
}
