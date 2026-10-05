import type { BulletinFeed, BulletinFeedDetail, BulletinUnread } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/messaging/bulletins/feed'

/** /api/messaging/bulletins/feed: the reader side of bulletins, every signed-in user. */
export const bulletinFeedApi = {
  /** the latest published ones and the unread count; silent: the bell polls it, a miss shows nothing */
  feed: () => api.get<BulletinFeed>(BASE, { silent: true }),
  /** one published bulletin with its sanitized body; reading it has no side effect */
  get: (id: number) => api.get<BulletinFeedDetail>(`${BASE}/${id}`),
  /** marks it read (an earlier read time is kept); answers the unread count */
  read: (id: number) => api.post<BulletinUnread>(`${BASE}/${id}/read`),
  readAll: () => api.post<BulletinUnread>(`${BASE}/read-all`),
}
