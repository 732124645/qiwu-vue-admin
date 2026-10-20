import type {
  WxoaMenuCreate,
  WxoaMenuPullResult,
  WxoaMenuTryMatchBody,
  WxoaMenuTryMatchVo,
  WxoaMenuUpdate,
  WxoaMenuVo,
  WxoaTagVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/menus'

/** /api/wxoa/menus: an account's default and conditional menus, saved as drafts and published apart. */
export const wxoaMenuApi = {
  list: (accountId: number) => api.get<WxoaMenuVo[]>(BASE, { params: { accountId } }),
  create: (dto: WxoaMenuCreate) => api.post<{ id: number }>(BASE, dto),
  update: (id: number, dto: WxoaMenuUpdate) => api.put(`${BASE}/${id}`, dto),
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  publish: (id: number) => api.post(`${BASE}/${id}/publish`),
  /** WeChat's live menus replace the account's local ones; the menus it could not take are listed */
  pull: (accountId: number) => api.post<WxoaMenuPullResult>(`${BASE}/pull`, { accountId }),
  /** removes every live menu on WeChat, conditional ones included */
  clear: (accountId: number) => api.post(`${BASE}/clear`, { accountId }),
  tryMatch: (dto: WxoaMenuTryMatchBody) => api.post<WxoaMenuTryMatchVo>(`${BASE}/try-match`, dto),
  /** the account's tags, for a conditional menu's match condition */
  tags: (accountId: number) => api.get<WxoaTagVo[]>('/wxoa/tags', { params: { accountId } }),
}
