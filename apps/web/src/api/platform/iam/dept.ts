import type { DeptCreate, DeptTreeNode, DeptVo } from '@qiwu/shared'
import { api, treeApi } from '@/core/request/http'

const BASE = '/iam/depts'

/** /api/iam/depts: the tree resource's calls plus the module's own. */
export const deptApi = {
  ...treeApi<DeptVo, DeptCreate>(BASE),
  setEnabled: (id: number, enabled: boolean) => api.put(`${BASE}/${id}/enabled`, { enabled }),
  /** enabled departments in the caller's data scope, a forest by `sort_no` (pickers, any signed-in user) */
  tree: () => api.get<DeptTreeNode[]>(`${BASE}/tree`),
}
