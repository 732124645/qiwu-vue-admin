import type {
  AgentAutomationEventVo,
  AgentAutomationRunVo,
  AgentAutomationSave,
  AgentAutomationToolVo,
  AgentAutomationVo,
  AgentOptionsVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/agent/automations'

/**
 * /api/agent/automations：本人的与本租户共享的自动化（只有创建人能改、启停、立即运行、看历史与删除）。
 * 没有 `GET /:id`：编辑表单从列表里取这一行，以便沿用 `useCrudForm`。
 */
export const agentAutomationApi = {
  list: () => api.get<AgentAutomationVo[]>(BASE),
  /** 编辑表单载入：列表里找不到即视为已被删除 */
  get: async (id: number) => {
    const row = (await agentAutomationApi.list()).find((r) => r.id === id)
    if (!row) throw new Error(`${BASE}/${id} not found`)
    return row
  },
  create: (dto: AgentAutomationSave) => api.post<AgentAutomationVo>(BASE, dto),
  update: (id: number, dto: AgentAutomationSave) =>
    api.put<AgentAutomationVo>(`${BASE}/${id}`, dto),
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  setEnabled: (id: number, enabled: boolean) =>
    api.post<AgentAutomationVo>(`${BASE}/${id}/enabled`, { enabled }),
  /** 立即运行：在隐藏会话里以创建人身份执行 */
  run: (id: number) => api.post<AgentAutomationRunVo>(`${BASE}/${id}/run`),
  runs: (id: number, page = 1, pageSize = 20) =>
    api.get<{ items: AgentAutomationRunVo[]; total: number }>(`${BASE}/${id}/runs`, {
      params: { page, pageSize },
    }),
  /** 可以监听的业务事件（只列本人有浏览权限的） */
  events: () => api.get<AgentAutomationEventVo[]>('/agent/automation-events'),
  /** 此刻能预先同意的写入工具 */
  tools: () => api.get<AgentAutomationToolVo[]>('/agent/automation-tools'),
  /** 技能清单（对话页的选项接口） */
  options: () => api.get<AgentOptionsVo>('/agent/options'),
  /** 配置方案（读不到时为空：按默认行为运行） */
  profiles: async (): Promise<{ id: number; name: string }[]> => {
    try {
      return await api.get<{ id: number; name: string }[]>('/agent/profiles', { silent: true })
    } catch {
      return []
    }
  },
}
