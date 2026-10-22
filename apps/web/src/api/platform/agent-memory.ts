import type { AgentMemoryVo, AgentProfileSave, AgentProfileVo, Page } from '@qiwu/shared'
import { api } from '@/core/request/http'

const PROFILES = '/agent/profiles'
const MEMORIES = '/agent/memories'

/** /api/agent/profiles：本人的与全租户共用的配置方案（没有 `GET /:id`，编辑表单从列表里取一行）。 */
export const agentProfileApi = {
  list: () => api.get<AgentProfileVo[]>(PROFILES),
  get: async (id: number) => {
    const row = (await agentProfileApi.list()).find((r) => r.id === id)
    if (!row) throw new Error(`${PROFILES}/${id} not found`)
    return row
  },
  create: (dto: AgentProfileSave) => api.post<AgentProfileVo>(PROFILES, dto),
  update: (id: number, dto: AgentProfileSave) => api.put<AgentProfileVo>(`${PROFILES}/${id}`, dto),
  remove: (id: number) => api.delete(`${PROFILES}/${id}`),
}

/** /api/agent/memories：本人的记忆（分页、增改删、输入当前密码后全部忘记）。 */
export const agentMemoryApi = {
  page: (params: Record<string, unknown>) => api.get<Page<AgentMemoryVo>>(MEMORIES, { params }),
  get: async (id: number) => {
    // 没有 `GET /:id`：每人至多 200 条记忆，正好是一页的上限，一页里总能找到
    const { items } = await api.get<Page<AgentMemoryVo>>(MEMORIES, {
      params: { page: 1, pageSize: 200 },
    })
    const row = items.find((r) => r.id === id)
    if (!row) throw new Error(`${MEMORIES}/${id} not found`)
    return row
  },
  create: (dto: { content: string }) => api.post<AgentMemoryVo>(MEMORIES, dto),
  update: (id: number, dto: { content: string }) =>
    api.put<AgentMemoryVo>(`${MEMORIES}/${id}`, dto),
  remove: (ids: number[]) => Promise.all(ids.map((id) => api.delete(`${MEMORIES}/${id}`))),
  forgetAll: (currentPassword: string) =>
    api.post<{ removed: number }>(`${MEMORIES}/forget-all`, { currentPassword }),
}
