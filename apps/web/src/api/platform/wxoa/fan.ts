import type {
  Page,
  WxoaFanBlockingBody,
  WxoaFanRemarkBody,
  WxoaFanTaggingBody,
  WxoaFanVo,
  WxoaSyncVo,
} from '@qiwu/shared'
import { api, download } from '@/core/request/http'

const BASE = '/wxoa/fans'

/** /api/wxoa/fans: list and export take the list filters, `accountId` included. */
export const wxoaFanApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaFanVo>>(BASE, { params }),
  exportFile: (params: Record<string, unknown>, filename: string) =>
    download(`${BASE}/export`, params, filename),
  remark: (id: number, body: WxoaFanRemarkBody) => api.put(`${BASE}/${id}/remark`, body),
  tagging: (body: WxoaFanTaggingBody) => api.post(`${BASE}/tagging`, body),
  blocking: (body: WxoaFanBlockingBody) => api.post(`${BASE}/blocking`, body),
  /** starts the full sync in the background (`B6010` while one runs) */
  sync: (accountId: number) => api.post(`${BASE}/sync`, { accountId }),
  syncState: (accountId: number) => api.get<WxoaSyncVo>(`${BASE}/sync`, { params: { accountId } }),
}
