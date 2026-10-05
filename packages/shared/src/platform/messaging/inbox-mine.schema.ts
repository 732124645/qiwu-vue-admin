import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { INBOX_CATEGORIES } from './messaging.schema.js'

/**
 * My inbox, `/api/messaging/inboxes/mine`, registered before the generated admin inbox `/:id` route.
 * Any signed-in user, no `@RequirePerm`. Every query and read is limited to `user_id = caller`;
 * another user's id returns 404, exactly like an unknown id.
 * - GET /mine {@link MyInboxQuery} → Page<{@link MyInboxItemVo}>.
 * - GET /mine/unread → {@link InboxUnreadVo}.
 * - GET /mine/:id → {@link MyInboxItemVo}, with no read side effect.
 * - POST /mine/:id/read → {@link InboxUnreadVo}.
 * - POST /mine/read-all → {@link InboxUnreadVo}.
 */
export const myInboxQuery = pageQuery(['createdAt', 'id'])
  .extend({
    unread: z.stringbool().optional(),
    category: z.enum(INBOX_CATEGORIES).optional(),
  })
  .register(fieldDomains, { domain: 'messaging.inboxMine' })
export type MyInboxQuery = z.output<typeof myInboxQuery>

export const myInboxItemVo = z.object({
  id: z.number().int().positive(),
  category: z.enum(INBOX_CATEGORIES),
  senderLabel: z.string().nullable(),
  title: z.string(),
  /** Plain text: never `v-html`; the web uses `white-space: pre-line`. */
  body: z.string(),
  readAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
})
export type MyInboxItemVo = z.infer<typeof myInboxItemVo>

export const inboxUnreadVo = z.object({ unread: z.number().int().nonnegative() })
export type InboxUnreadVo = z.infer<typeof inboxUnreadVo>
