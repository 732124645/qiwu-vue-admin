import type { Page, WxoaPublishCreate, WxoaPublishPullResult, WxoaPublishVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/publishes'

/** /api/wxoa/publishes：发表记录（本地提交的与从微信拉取的）。 */
export const wxoaPublishApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaPublishVo>>(BASE, { params }),
  get: (id: number) => api.get<WxoaPublishVo>(`${BASE}/${id}`),
  /** 把已同步的草稿提交发布 */
  create: (body: WxoaPublishCreate) => api.post<WxoaPublishVo>(BASE, body),
  pull: (accountId: number) => api.post<WxoaPublishPullResult>(`${BASE}/pull`, { accountId }),
  /** 删除已发表文章（微信侧不可恢复）；`index` 只删其中一篇 */
  remove: (id: number, index?: number) =>
    api.delete(`${BASE}/${id}`, { data: index == null ? {} : { index } }),
}
