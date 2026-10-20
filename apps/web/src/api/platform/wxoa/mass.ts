import type { Page, WxoaMassCreate, WxoaMassPreview, WxoaMassVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/mass-jobs'

/** /api/wxoa/mass-jobs：群发任务与预览。 */
export const wxoaMassApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaMassVo>>(BASE, { params }),
  get: (id: number) => api.get<WxoaMassVo>(`${BASE}/${id}`),
  create: (body: WxoaMassCreate) => api.post<WxoaMassVo>(BASE, body),
  /** 结果未知的任务用原 clientmsgid 重发（微信按它防重） */
  retry: (id: number) => api.post<WxoaMassVo>(`${BASE}/${id}/retry`),
  /** 发给一个粉丝预览，不建群发任务 */
  preview: (body: WxoaMassPreview) => api.post<WxoaMassVo>(`${BASE}/preview`, body),
  /** `index` 只删其中一篇（从 1 开始，放在查询参数里），不填删除整次群发 */
  remove: (id: number, index?: number) =>
    api.delete(`${BASE}/${id}`, { params: index == null ? {} : { index } }),
}
