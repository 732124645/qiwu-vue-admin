import type {
  CgImportableVo,
  CgImportVo,
  CgParentMenuNode,
  CgPreviewVo,
  CgSyncVo,
  CgTableDetailVo,
  CgTableUpdate,
  CgTableVo,
  CgWritableVo,
  CgWriteResultVo,
  DictOption,
} from '@qiwu/shared'
import { api, crudApi, download } from '@/core/request/http'

const BASE = '/codegen/tables'
const crud = crudApi<CgTableVo>(BASE)
// rendering runs every file through Prettier: a batch of many configs outlasts the default 30 s
const RENDER = { timeout: 5 * 60_000 }

/** A dict for the column editor's dict dropdown (`GET /api/settings/dicts/options`). */
export type { DictOption }

/** /api/codegen/tables (generator pages; contract in `codegen-api.schema.ts`; see docs/design-notes.md#codegen). */
export const codegenApi = {
  page: crud.page,
  /** one id → DELETE /:id, several → POST /batch-delete */
  remove: crud.remove,
  get: (id: number) => api.get<CgTableDetailVo>(`${BASE}/${id}`),
  update: (id: number, dto: CgTableUpdate) => api.put(`${BASE}/${id}`, dto),
  /** base tables of this database not imported yet (framework tables left out) */
  importable: () => api.get<CgImportableVo[]>(`${BASE}/importable`),
  import: (tableNames: string[]) => api.post<CgImportVo>(`${BASE}/import`, { tableNames }),
  /** re-reads the table's columns, the manual config kept */
  sync: (id: number) => api.post<CgSyncVo>(`${BASE}/${id}/sync`),
  preview: (id: number) => api.get<CgPreviewVo>(`${BASE}/${id}/preview`, RENDER),
  /** one zip of the configs' files at their repository paths */
  download: (ids: number[], filename: string) =>
    download(`${BASE}/download`, { ids: ids.join(',') }, filename, RENDER),
  /** into the repository (development only): all or nothing, conflicts come back as diffs */
  write: (ids: number[]) => api.post<CgWriteResultVo>(`${BASE}/write`, { ids }, RENDER),
  /** whether writing is on where the server runs; silent: without it the page just hides the button */
  writable: () => api.get<CgWritableVo>(`${BASE}/writable`, { silent: true }),
  parentMenus: () => api.get<CgParentMenuNode[]>(`${BASE}/parent-menus`),
  dictOptions: () => api.get<DictOption[]>('/settings/dicts/options'),
}
