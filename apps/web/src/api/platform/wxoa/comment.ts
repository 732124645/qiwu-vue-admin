import type { Page, WxoaCommentOpen, WxoaCommentReply, WxoaCommentVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/comments'
const one = (id: string) => `${BASE}/${encodeURIComponent(id)}`

/** /api/wxoa/comments：文章留言，直接读写微信；路径里的 id 是微信的留言 id。 */
export const wxoaCommentApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaCommentVo>>(BASE, { params }),
  open: (body: WxoaCommentOpen) => api.post(`${BASE}/open`, body),
  close: (body: WxoaCommentOpen) => api.post(`${BASE}/close`, body),
  elect: (id: string, body: WxoaCommentOpen) => api.post(`${one(id)}/elect`, body),
  unelect: (id: string, body: WxoaCommentOpen) => api.delete(`${one(id)}/elect`, { data: body }),
  reply: (id: string, body: Omit<WxoaCommentReply, 'commentId'>) =>
    api.post(`${one(id)}/reply`, body),
  removeReply: (id: string, body: WxoaCommentOpen) =>
    api.delete(`${one(id)}/reply`, { data: body }),
  remove: (id: string, body: WxoaCommentOpen) => api.delete(one(id), { data: body }),
}
