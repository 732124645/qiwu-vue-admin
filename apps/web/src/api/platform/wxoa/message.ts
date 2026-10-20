import type {
  Page,
  WxoaFanVo,
  WxoaMessageSend,
  WxoaMessageVo,
  WxoaSendWindowVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/messages'
const CONVERSATIONS = '/wxoa/conversations'

/**
 * /api/wxoa/messages (the log, customer-service sending) and /api/wxoa/conversations (fans by their last
 * message, one fan's messages, its send windows). Lists name the account (`accountId`).
 */
export const wxoaMessageApi = {
  page: (params: Record<string, unknown>) => api.get<Page<WxoaMessageVo>>(BASE, { params }),
  /** a customer-service message; outside both send windows WeChat refuses it (`B6007`) */
  send: (body: WxoaMessageSend) => api.post<WxoaMessageVo>(BASE, body),
  conversations: (params: Record<string, unknown>) =>
    api.get<Page<WxoaFanVo>>(CONVERSATIONS, { params }),
  /** newest first, before `beforeId` (exclusive), at most `limit` (≤ 50) */
  fanMessages: (fanId: number, params: { beforeId?: number; limit?: number } = {}) =>
    api.get<WxoaMessageVo[]>(`${CONVERSATIONS}/${fanId}/messages`, { params }),
  window: (fanId: number) => api.get<WxoaSendWindowVo>(`${CONVERSATIONS}/${fanId}/window`),
}
