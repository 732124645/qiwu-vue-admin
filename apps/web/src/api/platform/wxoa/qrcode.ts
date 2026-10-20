import type {
  Page,
  WxoaQrcodeCreate,
  WxoaQrcodeStatsVo,
  WxoaQrcodeUpdate,
  WxoaQrcodeVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/qrcodes'

/** /api/wxoa/qrcodes: an account's channel QR codes; the list names the account (`accountId`). */
export const wxoaQrcodeApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaQrcodeVo>>(BASE, { params }),
  /** creates the code on WeChat and copies its image */
  create: (body: WxoaQrcodeCreate) => api.post<WxoaQrcodeVo>(BASE, body),
  /** the name and the auto tag only */
  update: (id: number, body: WxoaQrcodeUpdate) => api.put(`${BASE}/${id}`, body),
  /** here only: a permanent code keeps working on WeChat */
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  /** scans and subscribes per day, the last `days` days */
  stats: (id: number, days: number) =>
    api.get<WxoaQrcodeStatsVo>(`${BASE}/${id}/stats`, { params: { days } }),
}
