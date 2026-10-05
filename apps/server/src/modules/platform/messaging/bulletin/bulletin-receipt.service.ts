import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import type { BulletinReceiptQuery, BulletinReceiptVo, Page } from '@qiwu/shared'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { contains, sorted } from '../../../../core/db/page.js'
import { User } from '../../iam/user/user.entity.js'
import { Bulletin } from './bulletin.entity.js'

interface ReceiptRow {
  userId: number
  username: string
  displayName: string
  deptName: string | null
  readAt: Date
}

/**
 * Who read a bulletin (admin, `GET /api/messaging/bulletins/:id/receipts`): the receipts of the users in
 * the caller's `iam_user` data scope (the route's perm `messaging.bulletin.view`; see docs/design-notes.md#data-scope), through the
 * users' `scopedQb` like the role members list. Read only.
 */
@Injectable()
export class BulletinReceiptService extends BaseCrudService<User> {
  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>) {
    super(txHost, User)
  }

  /** A page of the readers of bulletin `id` (unknown → 404; a draft simply has none). */
  async receipts(
    id: number,
    { keyword, ...paging }: BulletinReceiptQuery,
  ): Promise<Page<BulletinReceiptVo>> {
    if (!(await this.txHost.tx.getRepository(Bulletin).existsBy({ id })))
      throw new NotFoundException()
    const qb = this.scopedQb('t')
      .innerJoin(
        'msg_bulletin_receipt',
        'r',
        'r.user_id = t.id AND r.bulletin_id = :id AND r.deleted_at IS NULL',
        { id },
      )
      .leftJoin('t.dept', 'd')
      .select([
        't.id AS userId',
        't.username AS username',
        't.display_name AS displayName',
        'd.name AS deptName',
        'r.read_at AS readAt',
      ])
    if (keyword)
      qb.andWhere('(t.username LIKE :kw OR t.display_name LIKE :kw)', { kw: contains(keyword) })
    const total = await qb.getCount()
    const rows = await sorted(qb, paging.sort ?? [{ field: 'readAt', order: 'DESC' }], {
      readAt: 'r.read_at',
    })
      .offset((paging.page - 1) * paging.pageSize)
      .limit(paging.pageSize)
      .getRawMany<ReceiptRow>()
    return {
      items: rows.map((r) => ({
        ...r,
        userId: Number(r.userId),
        readAt: new Date(r.readAt).toISOString(),
      })),
      total,
    }
  }
}
