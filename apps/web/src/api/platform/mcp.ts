import type {
  AccessTokenAdminVo,
  AccessTokenCreate,
  AccessTokenCreatedVo,
  AccessTokenVo,
  McpToolVo,
  Page,
} from '@qiwu/shared'
import type { AxiosRequestConfig } from 'axios'
import { api } from '@/core/request/http'

/** /api/mcp/tools：平台页“MCP 工具”，列出已注册工具并逐个停用 / 启用。 */
export const mcpToolApi = {
  list: (config?: AxiosRequestConfig) => api.get<McpToolVo[]>('/mcp/tools', config),
  setEnabled: (name: string, enabled: boolean) =>
    api.put(`/mcp/tools/${encodeURIComponent(name)}/enabled`, { enabled }),
}

/** /api/mcp/my-tools：本人此刻能用的工具（启用且有权限），新建令牌时从中挑选。 */
export const myToolApi = {
  list: (config?: AxiosRequestConfig) => api.get<McpToolVo[]>('/mcp/my-tools', config),
}

/** /api/mcp/my-tokens：个人中心里本人的访问令牌；新建的应答带完整令牌，只此一次。 */
export const myTokenApi = {
  list: () => api.get<AccessTokenVo[]>('/mcp/my-tokens'),
  create: (dto: AccessTokenCreate) => api.post<AccessTokenCreatedVo>('/mcp/my-tokens', dto),
  revoke: (id: number) => api.post(`/mcp/my-tokens/${id}/revoke`),
}

/** /api/mcp/tokens：租户管理员查看与吊销本租户全部用户的令牌。 */
export const mcpTokenApi = {
  page: (params: Record<string, unknown>) =>
    api.get<Page<AccessTokenAdminVo>>('/mcp/tokens', { params }),
  revoke: (id: number) => api.post(`/mcp/tokens/${id}/revoke`),
}

/** 令牌此刻的状态：已吊销优先，其次按到期时间判断是否过期。 */
export function tokenState(t: Pick<AccessTokenVo, 'revokedAt' | 'expiresAt'>, now = Date.now()) {
  if (t.revokedAt) return 'revoked' as const
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= now) return 'expired' as const
  return 'active' as const
}
