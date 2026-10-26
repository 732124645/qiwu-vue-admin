import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { myInboxItemVo, type MyInboxQuery } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { tenantId } from '../../../../core/context/tenant.js'
import { AgentThread } from '../../../../core/agent/entities/agent-thread.entity.js'
import { paginate } from '../../../../core/db/page.js'
import { Inbox } from './inbox.entity.js'

const item = (row: Inbox, threadId?: number) =>
  myInboxItemVo.parse({
    ...row,
    id: Number(row.id),
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    action: threadId === undefined ? undefined : { kind: 'agent-thread', threadId },
  })

/** 仅系统会话通知可以给出站内入口，正文和任意 URL 从不决定跳转目标。 */
function noticeThread(row: Inbox): number | undefined {
  if (!['agent.turn.waiting', 'agent.turn.completed'].includes(row.templateCode)) return
  const id = (row.params as { threadId?: unknown } | null)?.threadId
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined
}

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
    return { items: await this.items(userId, page.items), total: page.total }
  }

  async get(userId: number, id: number) {
    const row = await this.ds
      .getRepository(Inbox)
      .createQueryBuilder('t')
      .where('t.id = :id AND t.userId = :userId', { id, userId })
      .getOne()
    if (!row) throw new NotFoundException()
    return (await this.items(userId, [row]))[0]!
  }

  /** 批量核对本人、当前租户仍存在的会话；误投或已删除会话不暴露编号入口。 */
  private async items(userId: number, rows: Inbox[]) {
    const ids = [...new Set(rows.map(noticeThread).filter((id) => id !== undefined))]
    const owned = new Set<number>()
    // 智能体模块关闭时实体可能未注册，历史通知仍可作为普通文本读取。
    if (ids.length && this.ds.hasMetadata(AgentThread)) {
      const threads = await this.ds
        .getRepository(AgentThread)
        .createQueryBuilder('t')
        .select(['t.id'])
        .where('t.id IN (:...ids)', { ids })
        .andWhere('t.userId = :userId AND t.tenantId = :tenantId', { userId, tenantId: tenantId() })
        .getMany()
      for (const thread of threads) owned.add(Number(thread.id))
    }
    return rows.map((row) => {
      const id = noticeThread(row)
      return item(row, id !== undefined && owned.has(id) ? id : undefined)
    })
  }

  async unread(userId: number) {
    const [{ n }]: { n: number }[] = await this.ds.query(
      'SELECT COUNT(*) AS n FROM msg_inbox WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL AND tenant_id = ?',
      [userId, tenantId()],
    )
    return { unread: Number(n) }
  }

  async read(userId: number, id: number) {
    const result: { affectedRows: number } = await this.ds.query(
      `UPDATE msg_inbox SET read_at = COALESCE(read_at, UTC_TIMESTAMP(3))
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND tenant_id = ?`,
      [id, userId, tenantId()],
    )
    if (!result.affectedRows) {
      const [row] = await this.ds.query(
        'SELECT id FROM msg_inbox WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND tenant_id = ?',
        [id, userId, tenantId()],
      )
      if (!row) throw new NotFoundException()
    }
    return this.unread(userId)
  }

  async readAll(userId: number) {
    await this.ds.query(
      `UPDATE msg_inbox SET read_at = UTC_TIMESTAMP(3)
        WHERE user_id = ? AND read_at IS NULL AND deleted_at IS NULL AND tenant_id = ?`,
      [userId, tenantId()],
    )
    return this.unread(userId)
  }
}
