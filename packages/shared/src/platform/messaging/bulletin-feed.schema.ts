import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Bulletin reader side (通知公告), `/api/messaging/bulletins/feed`: every signed-in user, no
 * `@RequirePerm`; published bulletins only (a draft, deleted or unknown id → 404 alike). The admin CRUD
 * (`bulletin.schema.ts`, `bulletinPerms`) is generated separately.
 *
 * - `GET /feed` → `bulletinFeedVo`: the latest `BULLETIN_FEED_SIZE` published (`published_at` desc, then id
 *   desc) and the caller's unread count over all published ones (the bell)
 * - `GET /feed/:id` → `bulletinFeedDetailVo`: one with its body; no side effect (the dialog then POSTs read)
 * - `POST /feed/:id/read` → `bulletinUnreadVo`: the caller's receipt (an earlier `read_at` is kept), then
 *   the unread count
 * - `POST /feed/read-all` → `bulletinUnreadVo`: receipts for every published one not read yet
 *
 * Admin, `GET /api/messaging/bulletins/:id/receipts` (`messaging.bulletin.view`): `bulletinReceiptQuery` →
 * `Page<bulletinReceiptVo>`, the users who read it, only those in the caller's `iam_user` data scope
 * (see docs/design-notes.md#data-scope); an unknown bulletin → 404.
 */

export const BULLETIN_FEED_SIZE = 5

export const bulletinFeedItemVo = z.object({
  id: z.number().int(),
  title: z.string(),
  /** dict `messaging.bulletin_kind` (`notice` / `announcement`) */
  kind: z.string(),
  publishedAt: z.iso.datetime(),
  /** the caller has a receipt */
  read: z.boolean(),
})
export type BulletinFeedItem = z.infer<typeof bulletinFeedItemVo>

export const bulletinFeedVo = z.object({
  items: z.array(bulletinFeedItemVo),
  unread: z.number().int(),
})
export type BulletinFeed = z.infer<typeof bulletinFeedVo>

/** `body`: HTML sanitized when saved (`core/sanitize.ts` whitelist), the one `v-html` source here. */
export const bulletinFeedDetailVo = bulletinFeedItemVo.extend({ body: z.string() })
export type BulletinFeedDetail = z.infer<typeof bulletinFeedDetailVo>

export const bulletinUnreadVo = z.object({ unread: z.number().int() })
export type BulletinUnread = z.infer<typeof bulletinUnreadVo>

/** GET /:id/receipts query: paging, sort, `keyword` = username or display name contains. */
export const bulletinReceiptQuery = pageQuery(['readAt', 'username'])
  .extend({ keyword: z.string().trim().max(64).optional() })
  .register(fieldDomains, { domain: 'messaging.bulletinReceipt' })
export type BulletinReceiptQuery = z.output<typeof bulletinReceiptQuery>

export const bulletinReceiptVo = z.object({
  userId: z.number().int(),
  username: z.string(),
  displayName: z.string(),
  deptName: z.string().nullable(),
  readAt: z.iso.datetime(),
})
export type BulletinReceiptVo = z.infer<typeof bulletinReceiptVo>
