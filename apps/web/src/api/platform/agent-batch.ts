import type { AgentBatchCreate, AgentBatchDetailVo, AgentBatchVo } from '@qiwu/shared'
import { api } from '@/core/request/http'

/** /api/agent/batches：对列表里选中的记录批量执行一个技能，只作用于本人的批次。 */
export const agentBatchApi = {
  /** 每条记录一个会话，按并发上限依次开始 */
  create: (dto: AgentBatchCreate) => api.post<AgentBatchVo>('/agent/batches', dto),
  /** 批次、每行的会话、轮次状态与等待中的审批 */
  get: (id: number) => api.get<AgentBatchDetailVo>(`/agent/batches/${id}`),
  /** 一次确认或拒绝批次里所有等待中的审批；目标不是该行记录的跳过（`skipped`），要逐条决定 */
  decide: (id: number, decision: 'approve' | 'reject') =>
    api.post<{ decided: number; skipped: number }>(`/agent/batches/${id}/decide`, { decision }),
}
