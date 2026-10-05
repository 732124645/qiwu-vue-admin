import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { myInboxItemVo, type MyInboxQuery } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { paginate } from '../../../../core/db/page.js'
import { Inbox } from './inbox.entity.js'

const item = (row: Inbox) =>
  myInboxItemVo.parse({
    ...row,
    id: Number(row.id),
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  })

@Injectable()
export class MyInboxService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async page(userId: number, query: MyInboxQuery) {
    const qb = this.ds
      .getRepository(Inbox)
      .createQueryBuilder('t')
      .where('t.userId = :userId', { userId })
    if (query.unread !== undefined)
      qb.andWhere(query.unread ? 't.readAt IS NULL' : 't.readAt IS NOT NULL')
    if (query.category) qb.andWhere('t.category = :category', { category: query.category })
    const page = await paginate(qb, {
      ...query,
      sort: query.sort ?? [{ field: 'createdAt', order: 'DESC' }],
    })
    return { items: page.items.map(item), total: page.total }
  }

  async get(userId: number, id: number) {
    const row = await this.ds
      .getRepository(Inbox)
      .createQueryBuilder('t')
      .where('t.id = :id AND t.userId = :userId', { id, userId })
      .getOne()
    if (!row) throw new NotFoundException()
    return item(row)
  }

  async unread(userId: number) {
    const [{ n }]: { n: number }[] = await this.ds.query(
      'SELECT COUNT(*) AS n FROM msg_inbox WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL',
      [userId],
    )
    return { unread: Number(n) }
  }

  async read(userId: number, id: number) {
    const result: { affectedRows: number } = await this.ds.query(
      'UPDATE msg_inbox SET read_at = COALESCE(read_at, UTC_TIMESTAMP(3)) WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [id, userId],
    )
    if (!result.affectedRows) {
      const [row] = await this.ds.query(
        'SELECT id FROM msg_inbox WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
        [id, userId],
      )
      if (!row) throw new NotFoundException()
    }
    return this.unread(userId)
  }

  async readAll(userId: number) {
    await this.ds.query(
      'UPDATE msg_inbox SET read_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL',
      [userId],
    )
    return this.unread(userId)
  }
}
