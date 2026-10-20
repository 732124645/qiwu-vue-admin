import type {
  Page,
  WxoaQrcodeVo,
  WxoaReplyRuleCreate,
  WxoaReplyRuleUpdate,
  WxoaReplyRuleVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/reply-rules'

/** /api/wxoa/reply-rules: an account's auto-reply rules; the list names the account (`accountId`). */
export const wxoaReplyRuleApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaReplyRuleVo>>(BASE, { params }),
  get: (id: number) => api.get<WxoaReplyRuleVo>(`${BASE}/${id}`),
  create: (dto: WxoaReplyRuleCreate) => api.post<WxoaReplyRuleVo>(BASE, dto),
  /** the whole rule; never `accountId` (a rule stays with its account) */
  update: (id: number, dto: WxoaReplyRuleUpdate) => api.put(`${BASE}/${id}`, dto),
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  /** the account's channel QR codes (the newest 200), whose scenes a scan rule may pick */
  qrcodes: (accountId: number) =>
    api.get<Page<WxoaQrcodeVo>>('/wxoa/qrcodes', {
      params: { accountId, pageSize: 200, sort: '-createdAt' },
    }),
}
