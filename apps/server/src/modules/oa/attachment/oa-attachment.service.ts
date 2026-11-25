import { Injectable, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err } from '@qiwu/shared'
import { In } from 'typeorm'
import type { Principal } from '../../../core/auth/principal.js'
import { BizError } from '../../../core/http/biz-error.js'
import { Leave } from '../../biz/leave/leave.entity.js'
import { FsObject } from '../../platform/storage/fs-object.entity.js'
import { StorageAccess } from '../../platform/storage/storage-access.js'
import { StorageService } from '../../platform/storage/storage.service.js'
import { WfDetailService } from '../../workflow/center/wf-detail.service.js'
import { OaExpenseClaim } from '../expense/expense.entity.js'
import { OaExpenseItem } from '../expense/expense-item.entity.js'
import { OaSealRequest } from '../seal/seal.entity.js'
import { OaTripRequest } from '../trip/trip.entity.js'

type AttachmentKind = 'leave' | 'trip' | 'expense' | 'seal'

/** 固定单据的附件始终跟业务事务提交，不依赖异步回写或全局文件管理权限。 */
@Injectable()
export class OaAttachmentService implements OnModuleInit {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly access: StorageAccess,
    private readonly storage: StorageService,
    private readonly details: WfDetailService,
  ) {}

  onModuleInit(): void {
    this.access.register('oa.attachment', (obj, principal) => this.canRead(obj, principal), {
      exclusive: true,
      feature: 'workflow',
    })
  }

  /** 先锁同租户对象再复查归属；新增、保留和清理均在当前单据事务内，失败整体回滚。 */
  async sync(
    kind: AttachmentKind,
    id: number,
    ids: readonly number[],
    previous: readonly number[],
    userId: number,
  ): Promise<void> {
    const tx = this.txHost.tx
    if (!tx.queryRunner?.isTransactionActive)
      throw new Error('Attachment binding needs a transaction')
    const next = [...new Set(ids)]
    if (next.length > 10) throw new BizError(Err.STORAGE_REF_INVALID)
    const union = [...new Set([...next, ...previous])].sort((a, b) => a - b)
    if (!union.length) return
    const repo = tx.getRepository(FsObject)
    const rows = await repo.find({
      where: { id: In(union) },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    })
    const byId = new Map(rows.map((obj) => [obj.id, obj]))
    const ref = `oa:${kind}:${id}`
    const old = new Set(previous)
    for (const objectId of next) {
      const obj = byId.get(objectId)
      if (
        !obj ||
        obj.bizTag !== 'oa.attachment' ||
        obj.uploaderId !== userId ||
        (obj.bizRef !== null && (obj.bizRef !== ref || !old.has(objectId)))
      )
        throw new BizError(Err.STORAGE_REF_INVALID)
      await this.storage.assertAttachment(obj)
    }
    await this.storage.bindRefs(
      next.filter((objectId) => byId.get(objectId)!.bizRef === null),
      'oa.attachment',
      ref,
      userId,
      tx,
    )
    const removed = rows.filter(
      (obj) =>
        old.has(obj.id) &&
        !next.includes(obj.id) &&
        obj.bizTag === 'oa.attachment' &&
        obj.bizRef === ref,
    )
    // 主单和所有有效明细合并后才能删除，保留二进制给既有保留期清理任务。
    if (removed.length)
      await repo.softDelete({
        id: In(removed.map((obj) => obj.id)),
        bizTag: 'oa.attachment',
        bizRef: ref,
      })
  }

  /** 只读实体和流程授权，避免依赖业务服务形成模块循环；旧引用或已删明细都不能授权。 */
  private async canRead(obj: FsObject, principal: Principal): Promise<boolean> {
    if (obj.bizRef === null) return obj.uploaderId === principal.userId
    const match = /^oa:(leave|trip|expense|seal):([1-9]\d*)$/.exec(obj.bizRef)
    if (!match || !Number.isSafeInteger(Number(match[2]))) return false
    const id = Number(match[2])
    return this.txHost.withTransaction(async () => {
      const tx = this.txHost.tx
      const row =
        match[1] === 'leave'
          ? await tx.getRepository(Leave).findOneBy({ id })
          : match[1] === 'trip'
            ? await tx.getRepository(OaTripRequest).findOneBy({ id })
            : match[1] === 'seal'
              ? await tx.getRepository(OaSealRequest).findOneBy({ id })
              : await tx.getRepository(OaExpenseClaim).findOneBy({ id })
      if (!row) return false
      const active = [...(row.attachmentIds ?? [])]
      if (match[1] === 'expense') {
        const items = await tx.getRepository(OaExpenseItem).findBy({ claimId: id })
        active.push(...items.flatMap((item) => item.attachmentIds ?? []))
      }
      return (
        active.includes(obj.id) &&
        (row.userId === principal.userId ||
          (row.instanceId !== null && (await this.details.canView(row.instanceId))))
      )
    })
  }
}
