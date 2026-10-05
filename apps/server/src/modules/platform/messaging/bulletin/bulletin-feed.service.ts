import { Injectable, NotFoundException } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  BULLETIN_FEED_SIZE,
  type BulletinFeed,
  type BulletinFeedDetail,
  type BulletinFeedItem,
} from '@qiwu/shared'
import type { DataSource } from 'typeorm'

interface FeedRow {
  id: number
  title: string
  kind: string
  publishedAt: Date
  read: number
  body?: string
}

const item = ({ body, ...r }: FeedRow): BulletinFeedItem & { body?: string } => ({
  ...r,
  id: Number(r.id),
  publishedAt: new Date(r.publishedAt).toISOString(),
  read: Number(r.read) === 1,
  ...(body === undefined ? {} : { body }),
})

/**
 * The readers' side of bulletins (`bulletin-feed.schema.ts`): every signed-in user, published bulletins
 * only (a draft, a deleted or an unknown id → 404 alike), receipts only ever for the caller. The body was
 * sanitized when saved (core/sanitize.ts), so it goes out as stored.
 */
@Injectable()
export class BulletinFeedService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** The latest published ones (newest first) and the caller's unread count over all of them. */
  async feed(userId: number): Promise<BulletinFeed> {
    const rows: FeedRow[] = await this.ds.query(
      `SELECT b.id, b.title, b.kind, b.published_at AS publishedAt,
         EXISTS (SELECT 1 FROM msg_bulletin_receipt r WHERE r.bulletin_id = b.id AND r.user_id = ? AND r.deleted_at IS NULL) AS \`read\`
       FROM msg_bulletin b WHERE b.published = 1 AND b.deleted_at IS NULL
       ORDER BY b.published_at DESC, b.id DESC LIMIT ?`,
      [userId, BULLETIN_FEED_SIZE],
    )
    return { items: rows.map(item), unread: await this.unread(userId) }
  }

  /** One published bulletin with its body; no side effect (the dialog posts `read` afterwards). */
  async detail(id: number, userId: number): Promise<BulletinFeedDetail> {
    const [row]: FeedRow[] = await this.ds.query(
      `SELECT b.id, b.title, b.kind, b.published_at AS publishedAt, b.body,
         EXISTS (SELECT 1 FROM msg_bulletin_receipt r WHERE r.bulletin_id = b.id AND r.user_id = ? AND r.deleted_at IS NULL) AS \`read\`
       FROM msg_bulletin b WHERE b.id = ? AND b.published = 1 AND b.deleted_at IS NULL`,
      [userId, id],
    )
    if (!row) throw new NotFoundException()
    return item(row) as BulletinFeedDetail
  }

  /**
   * The caller's receipt of published bulletin `id` (a first read's time is kept); the unread count. A
   * receipt is one row for good (like core/db/links.ts): a soft-deleted one is revived, read
   * now.
   */
  async read(id: number, userId: number): Promise<number> {
    const { affectedRows } = await this.ds.query(
      `INSERT INTO msg_bulletin_receipt (bulletin_id, user_id)
         SELECT id, ? FROM msg_bulletin WHERE id = ? AND published = 1 AND deleted_at IS NULL
         ON DUPLICATE KEY UPDATE read_at = IF(msg_bulletin_receipt.deleted_at IS NULL,
           msg_bulletin_receipt.read_at, CURRENT_TIMESTAMP(3)), msg_bulletin_receipt.deleted_at = NULL`,
      [userId, id],
    )
    // 0 rows: not published (or unknown), or read before (a no-op update); only the first is a 404
    if (!affectedRows) {
      const [known] = await this.ds.query(
        'SELECT 1 FROM msg_bulletin WHERE id = ? AND published = 1 AND deleted_at IS NULL',
        [id],
      )
      if (!known) throw new NotFoundException()
    }
    return this.unread(userId)
  }

  /** Receipts for every published bulletin the caller has not read (revived like `read`); unread (0). */
  async readAll(userId: number): Promise<number> {
    await this.ds.query(
      `INSERT INTO msg_bulletin_receipt (bulletin_id, user_id)
         SELECT b.id, ? FROM msg_bulletin b WHERE b.published = 1 AND b.deleted_at IS NULL
         ON DUPLICATE KEY UPDATE read_at = IF(msg_bulletin_receipt.deleted_at IS NULL,
           msg_bulletin_receipt.read_at, CURRENT_TIMESTAMP(3)), msg_bulletin_receipt.deleted_at = NULL`,
      [userId],
    )
    return this.unread(userId)
  }

  async unread(userId: number): Promise<number> {
    const [{ n }] = await this.ds.query(
      `SELECT COUNT(*) AS n FROM msg_bulletin b WHERE b.published = 1 AND b.deleted_at IS NULL AND NOT EXISTS
         (SELECT 1 FROM msg_bulletin_receipt r WHERE r.bulletin_id = b.id AND r.user_id = ? AND r.deleted_at IS NULL)`,
      [userId],
    )
    return Number(n)
  }
}
