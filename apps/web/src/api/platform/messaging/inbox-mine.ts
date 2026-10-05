import type { InboxUnreadVo, MyInboxItemVo, Page } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/messaging/inboxes/mine'

export const inboxMineApi = {
  page: (query: Record<string, unknown>, options: { silent?: boolean } = {}) =>
    api.get<Page<MyInboxItemVo>>(BASE, { params: query, ...options }),
  unread: (options: { silent?: boolean } = {}) => api.get<InboxUnreadVo>(`${BASE}/unread`, options),
  get: (id: number) => api.get<MyInboxItemVo>(`${BASE}/${id}`),
  read: (id: number) => api.post<InboxUnreadVo>(`${BASE}/${id}/read`),
  readAll: () => api.post<InboxUnreadVo>(`${BASE}/read-all`),
}
