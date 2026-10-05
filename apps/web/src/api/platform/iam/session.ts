import type { Page, SessionKickBody, SessionKickVo, SessionVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/iam/sessions'

/** /api/iam/sessions: the live sessions and ending them. */
export const sessionApi = {
  page: (params: Record<string, unknown>) => api.get<Page<SessionVo>>(BASE, { params }),
  /** one session by its sid */
  kick: (sid: string) => api.delete(`${BASE}/${sid}`),
  /** several sessions (`sids`) or every session of a user (`userId`) */
  kickMany: (body: SessionKickBody) => api.post<SessionKickVo>(`${BASE}/kick`, body),
}
