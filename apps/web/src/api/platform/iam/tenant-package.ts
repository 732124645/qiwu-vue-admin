import type {
  Page,
  RoleMenuNode,
  TenantPackageCreate,
  TenantPackageDetailVo,
  TenantPackageOption,
  TenantPackageUpdate,
  TenantPackageVo,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/iam/tenant-packages'

/**
 * /api/iam/tenant-packages (platform pages only; no route while multi-tenancy is off). Deleted one at a
 * time (a package a tenant uses: 409). Fits `useCrudForm` (`get` / `create` / `update`).
 */
export const tenantPackageApi = {
  page: (params: Record<string, unknown>) => api.get<Page<TenantPackageVo>>(BASE, { params }),
  get: (id: number) => api.get<TenantPackageDetailVo>(`${BASE}/${id}`),
  create: (dto: TenantPackageCreate) => api.post(BASE, dto),
  update: (id: number, dto: TenantPackageUpdate) => api.put(`${BASE}/${id}`, dto),
  remove: (id: number) => api.delete(`${BASE}/${id}`),
  /** the enabled packages, for the tenant form */
  options: () => api.get<TenantPackageOption[]>(`${BASE}/options`),
  /** the menus open to tenants as a forest (the package's grant tree) */
  menuTree: () => api.get<RoleMenuNode[]>(`${BASE}/menu-tree`),
}
