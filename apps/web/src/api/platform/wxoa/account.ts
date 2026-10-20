import type {
  WxoaAccountCreate,
  WxoaAccountDetailVo,
  WxoaAccountOption,
  WxoaAccountTestVo,
  WxoaAccountUpdate,
  WxoaAccountVo,
  WxoaQuotaVo,
} from '@qiwu/shared'
import { api, crudApi } from '@/core/request/http'

const BASE = '/wxoa/accounts'

/** /api/wxoa/accounts: the standard CRUD calls (one id per delete) plus the module's own. */
export const wxoaAccountApi = {
  ...crudApi<WxoaAccountVo, WxoaAccountCreate | WxoaAccountUpdate>(BASE),
  get: (id: number) => api.get<WxoaAccountDetailVo>(`${BASE}/${id}`),
  /** the account switch's list; any `wxoa.*.browse` reads it */
  options: () => api.get<WxoaAccountOption[]>(`${BASE}/options`),
  /** a fresh token (cache bypassed), then a call needing it */
  test: (id: number) => api.post<WxoaAccountTestVo>(`${BASE}/${id}/test`),
  quota: (id: number) => api.get<WxoaQuotaVo>(`${BASE}/${id}/quota`),
  clearQuota: (id: number) => api.post(`${BASE}/${id}/quota/clear`),
}
