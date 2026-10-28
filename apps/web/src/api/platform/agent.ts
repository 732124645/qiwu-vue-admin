import type {
  AgentApprovalDecide,
  AgentCancelVo,
  AgentDraftReceiptVo,
  AgentMessageReceiptVo,
  AgentFeedbackSave,
  AgentMessageSend,
  AgentNotifySettings,
  AgentOptionsVo,
  AgentPlanDecide,
  AgentQuestionAnswer,
  AgentRewindPreviewVo,
  AgentSkillVo,
  AgentStatusVo,
  AgentThreadCreate,
  AgentThreadDetailVo,
  AgentThreadUpdate,
  AgentThreadVo,
  AgentTurnVo,
  Page,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

/** 会话列表的查询参数（`agentThreadQuery` 的请求形式）。 */
export interface AgentThreadParams {
  page: number
  pageSize: number
  sort?: string
  keyword?: string
  status?: AgentThreadVo['status']
  view?: 'all' | 'active' | 'unread' | 'pinned'
}

/** /api/agent：“智能助手”对话页用到的接口，会话类接口只作用于本人的会话。 */
export const agentApi = {
  /** 输入框需要的模型、技能、审批模式、开场提示（`route`：从哪个页面打开，给出适合它的提示）、提示词模板与是否已暂停 */
  options: (route?: string) =>
    api.get<AgentOptionsVo>('/agent/options', { params: route ? { route } : undefined }),
  threads: (params: AgentThreadParams) =>
    api.get<Page<AgentThreadVo>>('/agent/threads', { params }),
  createThread: (dto: Partial<AgentThreadCreate>) => api.post<AgentThreadVo>('/agent/threads', dto),
  draftReceipt: (clientDraftId: string) =>
    api.get<AgentDraftReceiptVo>(
      `/agent/threads/client-drafts/${encodeURIComponent(clientDraftId)}`,
    ),
  messageReceipt: (id: number, clientMessageId: string) =>
    api.get<AgentMessageReceiptVo>(
      `/agent/threads/${id}/messages/${encodeURIComponent(clientMessageId)}/receipt`,
    ),
  acknowledgeRecovery: (id: number, revision: number) =>
    api.post<AgentThreadVo>(`/agent/threads/${id}/recovery/acknowledge`, { revision }),
  /** 改名、归档 / 恢复、置顶、换模型或模式 */
  updateThread: (id: number, dto: AgentThreadUpdate) =>
    api.patch<AgentThreadVo>(`/agent/threads/${id}`, dto),
  removeThread: (id: number) => api.delete(`/agent/threads/${id}`),
  /** 撤销本会话对一个工具的放行（之后它的写入重新逐次询问） */
  revokeAllowedTool: (id: number, tool: string) =>
    api.delete<AgentThreadVo>(`/agent/threads/${id}/allowed-tools/${encodeURIComponent(tool)}`),
  /** 复制到第 `seq` 条（含）为止的内容成为新会话 */
  fork: (id: number, seq: number, clientDraftId?: string) =>
    api.post<AgentThreadVo>(`/agent/threads/${id}/fork`, {
      seq,
      ...(clientDraftId && { clientDraftId }),
    }),
  /** 会话、条目（`afterSeq` 之后的，断线补齐用）与最近一轮 */
  items: (id: number, afterSeq?: number, signal?: AbortSignal) =>
    api.get<AgentThreadDetailVo>(`/agent/threads/${id}/items`, {
      params: afterSeq == null ? undefined : { afterSeq },
      signal,
    }),
  /** 发送消息；本轮还在运行时按 `mode` 插话（当前工具步骤之后送达本轮，steer）或排到下一轮（queue） */
  send: (id: number, dto: Partial<AgentMessageSend> & { text: string }) =>
    api.post<AgentTurnVo>(`/agent/threads/${id}/messages`, dto),
  /** 停止本轮；撤下的排队消息原样返回，页面放回输入框 */
  cancel: (id: number) => api.post<AgentCancelVo | null>(`/agent/threads/${id}/cancel`),
  compact: (id: number) => api.post(`/agent/threads/${id}/compact`),
  /** 标记到第 `seq` 条为止已读 */
  read: (id: number, seq: number) => api.post(`/agent/threads/${id}/read`, { seq }),
  /** 本人的全部会话标为已读 */
  readAll: () => api.post('/agent/threads/read-all'),
  /** 由模型根据会话写一个个人技能草稿（停用状态，待本人检查后启用） */
  skillFromThread: (id: number) => api.post<AgentSkillVo>(`/agent/skills/from-thread/${id}`, {}),
  /** 回退到用户消息 `seq` 会留下（不撤销）的写入：已执行或结果不明 */
  rewindPreview: (id: number, seq: number) =>
    api.get<AgentRewindPreviewVo>(`/agent/threads/${id}/rewind-preview`, { params: { seq } }),
  /** 原地删除用户消息 `seq` 及其后的内容；`lastSeq` 是本页见过的最大序号，落后时服务器 409 */
  rewind: (id: number, seq: number, lastSeq: number) =>
    api.post(`/agent/threads/${id}/rewind`, { seq, lastSeq }),
  exportMarkdown: (id: number) =>
    api.get<{ name: string; text: string }>(`/agent/threads/${id}/export`),
  /** 上下文用量、本轮与今日用量和限额 */
  status: (id: number) => api.get<AgentStatusVo>(`/agent/threads/${id}/status`),
  share: (id: number) => api.post<{ token: string }>(`/agent/threads/${id}/share`),
  unshare: (id: number) => api.delete(`/agent/threads/${id}/share`),
  /** 同租户的只读分享快照 */
  shared: (token: string) =>
    api.get<AgentThreadDetailVo>(`/agent/shared/${encodeURIComponent(token)}`),
  feedback: (dto: AgentFeedbackSave) => api.post('/agent/feedback', dto),
  decide: (itemId: number, dto: AgentApprovalDecide) => api.post(`/agent/approvals/${itemId}`, dto),
  answer: (itemId: number, dto: Partial<AgentQuestionAnswer>) =>
    api.post(`/agent/questions/${itemId}`, dto),
  /** 方案卡：批准并按所选模式执行，或继续完善（服务器切换模式并开始执行） */
  decidePlan: (itemId: number, dto: AgentPlanDecide) => api.post(`/agent/plans/${itemId}`, dto),
}

/** /api/agent/notify-settings：本人的提醒设置（站内信总是发，每类提醒可另发邮件）。 */
export const agentNotifyApi = {
  get: () => api.get<AgentNotifySettings>('/agent/notify-settings'),
  save: (dto: AgentNotifySettings) => api.put<AgentNotifySettings>('/agent/notify-settings', dto),
}
