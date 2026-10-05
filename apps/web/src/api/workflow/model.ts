import type {
  WfModelCreate,
  WfModelDetailVo,
  WfModelSortBody,
  WfModelVo,
  WfPublishBody,
  WfVersionDetailVo,
  WfVersionVo,
} from '@qiwu/shared'
import { api, crudApi } from '@/core/request/http'

const BASE = '/wf/models'

/** Process models (/api/wf/models; see docs/design-notes.md#workflow) behind `wfPerms.model`. */
export const wfModelApi = {
  ...crudApi<WfModelVo, WfModelCreate>(BASE),
  setEnabled: (id: number, enabled: boolean) => api.put(`${BASE}/${id}/enabled`, { enabled }),
  /** new sort numbers of several models at once (all or nothing) */
  sort: (body: WfModelSortBody) => api.put(`${BASE}/sort`, body),
  /** published versions, newest first */
  versions: (id: number) => api.get<WfVersionVo[]>(`${BASE}/${id}/versions`),
  /** one version with its tree (the JSON export) */
  version: (id: number, versionId: number) =>
    api.get<WfVersionDetailVo>(`${BASE}/${id}/versions/${versionId}`),
  /** + the designer draft and the form's fields */
  detail: (id: number) => api.get<WfModelDetailVo>(`${BASE}/${id}`),
  saveDraft: (id: number, tree: object) => api.put(`${BASE}/${id}/draft`, { tree }),
  /** a BPMN model's draft: its XML, only parsed until publish */
  saveDraftXml: (id: number, xml: string) => api.put(`${BASE}/${id}/draft`, { xml }),
  /**
   * the next version: `tree` (a BPMN model's `xml`) compiled against the fields (a custom
   * model's: its handler's)
   */
  publish: (id: number, body: WfPublishBody) =>
    api.post<WfVersionVo>(`${BASE}/${id}/versions`, body),
}
