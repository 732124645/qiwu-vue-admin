import type {
  Page,
  TenantCreate,
  TenantCreatedVo,
  TenantEnterBody,
  TenantInitialPasswordVo,
  TenantOption,
  TenantUpdate,
  TenantVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/iam/tenants'

/**
 * /api/iam/tenants (platform pages only; no route while multi-tenancy is off). No delete and no export:
 * a tenant is never deleted. Fits `useCrudForm` (`get` / `create` / `update`).
 */
export const tenantApi = {
  page: (params: Record<string, unknown>) => api.get<Page<TenantVo>>(BASE, { params }),
  get: (id: number) => api.get<TenantVo>(`${BASE}/${id}`),
  /** opens the tenant; the answer carries its initial password, this once only */
  create: (dto: TenantCreate) => api.post<TenantCreatedVo>(BASE, dto),
  /** the code and the administrator are fixed once opened: never sent (the server answers 400) */
  update: (id: number, dto: TenantUpdate | TenantCreate) => {
    const { code: _code, admin: _admin, ...body } = dto as TenantCreate
    return api.put(`${BASE}/${id}`, body satisfies TenantUpdate)
  },
  setEnabled: (id: number, enabled: boolean) => api.put(`${BASE}/${id}/enabled`, { enabled }),
  /** every tenant (id, code, name), for filters */
  options: () => api.get<TenantOption[]>(`${BASE}/options`),
  /** a new initial password of the tenant, answered this once only */
  resetInitialPassword: (id: number) =>
    api.post<TenantInitialPasswordVo>(`${BASE}/${id}/initial-password`),
  /** work inside the tenant (audited, at most two hours); reload the whole page afterwards */
  enter: (id: number, body: TenantEnterBody) => api.post<null>(`${BASE}/${id}/enter`, body),
  /** back to one's own tenant; reload the whole page afterwards */
  leave: () => api.post<null>(`${BASE}/leave`),
}
