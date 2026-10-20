import type { WxoaMessageVo, WxoaTemplateSendBody, WxoaTemplateVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/wxoa/templates'

/**
 * /api/wxoa/templates: the account's template messages as WeChat lists them (cached briefly;
 * `refresh` asks WeChat again). The send records are the message log's `channel=template` rows.
 */
export const wxoaTemplateApi = {
  list: (accountId: number, refresh = false) =>
    api.get<WxoaTemplateVo[]>(BASE, { params: { accountId, ...(refresh ? { refresh } : {}) } }),
  /** deletes the template on WeChat */
  remove: (accountId: number, templateId: string) =>
    api.delete(`${BASE}/${encodeURIComponent(templateId)}`, { params: { accountId } }),
  /** one pending row per fan, sent by the server after it answers */
  send: (templateId: string, body: WxoaTemplateSendBody) =>
    api.post<WxoaMessageVo[]>(`${BASE}/${encodeURIComponent(templateId)}/send`, body),
}
