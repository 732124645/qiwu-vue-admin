import type {
  Page,
  WfAdminInstanceVo,
  WfAdminTaskVo,
  WfDataPageVo,
  WfReassignBody,
  WfTerminateBody,
} from '@qiwu/shared'
import { api, download } from '@/core/request/http'

type Query = Record<string, unknown>

/**
 * Instance and task admin and approval data (/api/wf, access model; see docs/design-notes.md#workflow): `wfPerms.instance` /
 * `wfPerms.task` / `wfPerms.data`; the server keeps lists and actions inside the caller's data scope on the
 * initiator's dept (else 404).
 */
export const wfAdminApi = {
  instances: (params: Query) => api.get<Page<WfAdminInstanceVo>>('/wf/instances', { params }),
  tasks: (params: Query) => api.get<Page<WfAdminTaskVo>>('/wf/tasks', { params }),
  /** 终止: a running instance ends `terminated`, its open tasks canceled */
  terminate: (id: number, body: WfTerminateBody) =>
    api.post<null>(`/wf/instances/${id}/terminate`, body),
  /** 改派: an open review task goes to `body.to` */
  reassign: (id: number, body: WfReassignBody) => api.post<null>(`/wf/tasks/${id}/reassign`, body),
  /** 审批数据 (`wfPerms.data.browse`): model `key`'s instances, a version's form fields as columns */
  data: (key: string, params: Query) =>
    api.get<WfDataPageVo>(`/wf/models/${encodeURIComponent(key)}/data`, { params }),
  /** the same columns and filters as .xlsx (`wfPerms.data.export`), saved as `filename` */
  exportData: (key: string, params: Query, filename: string) =>
    download(`/wf/models/${encodeURIComponent(key)}/data/export`, params, filename),
}
