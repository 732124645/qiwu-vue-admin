import type {
  AgentExternalToolVo,
  AgentInstructionSave,
  AgentMcpServerSave,
  AgentMcpServerVo,
  AgentPromptSave,
  AgentPromptVo,
  AgentProviderSave,
  AgentProviderVo,
  AgentSearchProviderSave,
  AgentSearchProviderVo,
  AgentSkillImport,
  AgentSkillSave,
  AgentSkillVo,
  AgentToolPolicy,
  AgentToolVo,
  AgentUsageQuery,
  AgentUsageRowVo,
  ParameterCreate,
  ParameterUpdate,
  ParameterVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'
import { paramApi } from '@/api/platform/settings/param'

/**
 * 不分页的资源（`GET base` 直接返回数组）：增删改查，外加按 id 从列表里取一行，
 * 以便编辑表单沿用 `useCrudForm`（这些资源没有 `GET base/:id`）。
 */
function listApi<T extends { id: number }, C>(base: string) {
  const list = () => api.get<T[]>(base)
  return {
    list,
    /** 编辑表单载入：列表里找不到即视为已被删除 */
    get: async (id: number) => {
      const row = (await list()).find((r) => r.id === id)
      if (!row) throw new Error(`${base}/${id} not found`)
      return row
    },
    create: (dto: C) => api.post<T>(base, dto),
    update: (id: number, dto: C) => api.put<T>(`${base}/${id}`, dto),
    remove: (id: number) => api.delete(`${base}/${id}`),
  }
}

/** 只写字段（密钥、鉴权信息）为空时不发送：服务端据此保留已保存的值。 */
export function dropEmpty<T extends Record<string, unknown>>(dto: T, ...keys: (keyof T)[]): T {
  const out = { ...dto }
  for (const k of keys) {
    const v = out[k]
    const empty =
      v == null ||
      v === '' ||
      (typeof v === 'object' && Object.values(v as object).every((x) => x == null || x === ''))
    if (empty) delete out[k]
  }
  return out
}

/** /api/agent/providers：模型提供方（平台页“智能体设置”）。 */
export const agentProviderApi = listApi<AgentProviderVo, AgentProviderSave>('/agent/providers')
/** /api/agent/search-providers：联网搜索提供方。 */
export const agentSearchApi = listApi<AgentSearchProviderVo, AgentSearchProviderSave>(
  '/agent/search-providers',
)
/** /api/agent/platform-skills：平台技能，含 SKILL.md 导入导出。 */
export const agentPlatformSkillApi = {
  ...listApi<AgentSkillVo, AgentSkillSave>('/agent/platform-skills'),
  importText: (dto: Pick<AgentSkillImport, 'text'>) =>
    api.post<AgentSkillVo>('/agent/platform-skills/import', dto),
  exportText: (id: number) => api.get<{ text: string }>(`/agent/platform-skills/${id}/export`),
}

/** /api/agent/mcp-servers：外部 MCP 服务器，含同步工具与逐个工具的启用与策略。 */
export const agentMcpServerApi = {
  ...listApi<AgentMcpServerVo, AgentMcpServerSave>('/agent/mcp-servers'),
  sync: (id: number) => api.post<AgentMcpServerVo>(`/agent/mcp-servers/${id}/sync`),
  updateTool: (id: number, toolId: number, dto: { enabled?: boolean; policy?: AgentToolPolicy }) =>
    api.put<AgentExternalToolVo>(`/agent/mcp-servers/${id}/tools/${toolId}`, dto),
}

/** /api/agent/tools：本系统工具的审批策略；`null` 恢复按类型的默认值。 */
export const agentToolApi = {
  list: () => api.get<AgentToolVo[]>('/agent/tools'),
  setPolicy: (name: string, policy: AgentToolPolicy | null) =>
    api.put(`/agent/tools/${encodeURIComponent(name)}/policy`, { policy }),
}

/** /api/agent/skills：本人、本租户与平台技能（技能管理页），含 SKILL.md 导入导出。 */
export const agentSkillApi = {
  ...listApi<AgentSkillVo, AgentSkillSave>('/agent/skills'),
  importText: (dto: AgentSkillImport) => api.post<AgentSkillVo>('/agent/skills/import', dto),
  exportText: (id: number) => api.get<{ text: string }>(`/agent/skills/${id}/export`),
}

/** /api/agent/prompts：本人与本租户的提示词模板。 */
export const agentPromptApi = listApi<AgentPromptVo, AgentPromptSave>('/agent/prompts')

/** /api/agent/instructions：个人说明（含语气）与租户说明。 */
export const agentInstructionApi = {
  getMine: () =>
    api.get<{ body: string; tone?: AgentInstructionSave['tone'] }>('/agent/instructions/me'),
  saveMine: (dto: AgentInstructionSave) => api.put('/agent/instructions/me', dto),
  getTenant: () => api.get<{ body: string }>('/agent/instructions/tenant'),
  saveTenant: (body: string) => api.put('/agent/instructions/tenant', { body }),
}

/** /api/agent/usage：按日、用户或模型汇总的调用次数与 token。 */
export const agentUsageApi = {
  list: (query: AgentUsageQuery) => api.get<AgentUsageRowVo[]>('/agent/usage', { params: query }),
}

/**
 * 智能体的系统参数（暂停、限额、信任模式、平台说明、联网模式与域名）：经参数管理接口读写，
 * 只有 root 能改。按键前缀一次取回，再按完整键取用（参数接口的键筛选是“包含”）。
 */
export const agentParamApi = {
  load: async (): Promise<Record<string, ParameterVo>> => {
    const { items } = await paramApi.page({ paramKey: 'agent.', pageSize: 200 })
    return Object.fromEntries(
      items.filter((p) => p.paramKey.startsWith('agent.')).map((p) => [p.paramKey, p]),
    )
  },
  // PUT 只改所发字段（paramUpdate 是部分更新），这里只发值
  save: (row: Pick<ParameterVo, 'id'>, value: string) =>
    paramApi.update(row.id, { paramValue: value } satisfies ParameterUpdate as ParameterCreate),
}
