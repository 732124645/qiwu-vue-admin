import type {
  ImportMode,
  ImportResult,
  UserCreate,
  UserDetailVo,
  UserOption,
  UserOptionQuery,
  UserResetPasswordBody,
  UserVo,
} from '@qiwu/shared'
import { api, crudApi, download } from '@/core/request/http'
import { listParams } from '@/core/composables/use-crud'

const BASE = '/iam/users'

/** /api/iam/users: the standard CRUD calls plus the module's own actions. */
export const userApi = {
  ...crudApi<UserVo, UserCreate>(BASE),
  /** the row plus its role and position ids (detail drawer, edit form, assign-roles page) */
  get: (id: number) => api.get<UserDetailVo>(`${BASE}/${id}`),
  setEnabled: (id: number, enabled: boolean) => api.put(`${BASE}/${id}/enabled`, { enabled }),
  resetPassword: (id: number, body: UserResetPasswordBody) =>
    api.put(`${BASE}/${id}/password`, body),
  assignRoles: (id: number, roleIds: number[]) => api.put(`${BASE}/${id}/roles`, { roleIds }),
  /** enabled users in the caller's scope for pickers: `deptId` with its subtree, `keyword`; at most PAGE_SIZE_MAX */
  options: (query: Partial<UserOptionQuery> = {}) =>
    api.get<UserOption[]>(`${BASE}/options`, { params: listParams(query) }),
  /** the .xlsx to fill in (dropdowns for gender, enabled and the caller's departments) */
  importTemplate: (filename: string) => download(`${BASE}/import-template`, {}, filename),
  /** multipart `mode` + `file`; failed rows come back as a report to download (`reportId`) */
  importFile(file: File, mode: ImportMode) {
    const form = new FormData()
    form.append('mode', mode)
    form.append('file', file)
    // up to 5000 rows are checked and written one by one
    return api.post<ImportResult>(`${BASE}/import`, form, { timeout: 5 * 60_000 })
  },
}
