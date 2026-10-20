import type { WxoaTagCreate, WxoaTagUpdate, WxoaTagVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/tags'

/** /api/wxoa/tags: an account's fan tags (all of them, no paging). */
export const wxoaTagApi = {
  list: (accountId: number) => api.get<WxoaTagVo[]>(BASE, { params: { accountId } }),
  create: (body: WxoaTagCreate) => api.post(BASE, body),
  update: (id: number, body: WxoaTagUpdate) => api.put(`${BASE}/${id}`, body),
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  /** replaces the local tags with the account's tags on WeChat */
  sync: (accountId: number) => api.post(`${BASE}/sync`, { accountId }),
}
