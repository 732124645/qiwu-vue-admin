import type { DemoRealtimeSendBody, DemoRealtimeSendVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

/** /api/demo/realtime: push plain text as `demo:message`; answers the online users reached. */
export const demoRealtimeApi = {
  send: (body: DemoRealtimeSendBody) => api.post<DemoRealtimeSendVo>('/demo/realtime/send', body),
}
