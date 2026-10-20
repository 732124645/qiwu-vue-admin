import type {
  Page,
  WxoaDraftCreate,
  WxoaDraftPullResult,
  WxoaDraftSyncResult,
  WxoaDraftUpdate,
  WxoaDraftVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/drafts'

/** 草稿行；`dirty` 表示本地有尚未同步到微信草稿箱的修改（由服务端判断）。 */
export type { WxoaDraftPullResult, WxoaDraftSyncResult, WxoaDraftVo }

/** 已同步到草稿箱且之后没有本地修改的草稿，才能发布或群发。 */
export const wxoaDraftSynced = (d: WxoaDraftVo) => d.mediaId != null && !d.dirty

/** /api/wxoa/drafts：本地图文草稿，同步到微信草稿箱或从草稿箱拉取。 */
export const wxoaDraftApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaDraftVo>>(BASE, { params }),
  get: (id: number) => api.get<WxoaDraftVo>(`${BASE}/${id}`),
  create: (body: WxoaDraftCreate) => api.post<WxoaDraftVo>(BASE, body),
  update: (id: number, body: WxoaDraftUpdate) => api.put<WxoaDraftVo>(`${BASE}/${id}`, body),
  /** 已同步的草稿会先从微信草稿箱删除 */
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  /** 推到微信草稿箱，返回未能同步的正文图片 */
  sync: (id: number) => api.post<WxoaDraftSyncResult>(`${BASE}/${id}/sync`),
  pull: (accountId: number) => api.post<WxoaDraftPullResult>(`${BASE}/pull`, { accountId }),
}
