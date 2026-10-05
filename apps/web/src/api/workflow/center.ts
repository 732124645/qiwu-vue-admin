import type {
  DeptTreeNode,
  Page,
  WfAddSignBody,
  WfBackTargetVo,
  WfCcBody,
  WfCcItemVo,
  WfCommentBody,
  WfDecideBody,
  WfHandOverBody,
  WfInstanceDetailVo,
  WfInstanceItemVo,
  WfRemarkBody,
  WfRemoveSignBody,
  WfSendBackBody,
  WfStartableVo,
  WfStartBody,
  WfStartInfoVo,
  WfStartVo,
  WfTaskItemVo,
  WfUserOption,
  WfUserOptionQuery,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

type Query = Record<string, unknown>
type Options = { silent?: boolean }

/** Approval center (/api/wf, access model; see docs/design-notes.md#workflow): sign-in only, the caller's own data. */
export const wfCenterApi = {
  /** whom a process dialog picks: every enabled user (not the caller's data scope), by display name */
  userOptions: (params: WfUserOptionQuery = {}) =>
    api.get<WfUserOption[]>('/wf/users/options', { params }),
  /** what a process form's dept field picks and shows: every enabled department (a forest, not the scope) */
  deptOptions: () => api.get<DeptTreeNode[]>('/wf/depts/options'),
  /** the models the caller may start (the start page cards) */
  startable: () => api.get<WfStartableVo[]>('/wf/startable-models'),
  /** the model's form (dynamic) and the steps whose users the initiator picks */
  startInfo: (modelKey: string) => api.get<WfStartInfoVo>(`/wf/models/${modelKey}/start-info`),
  start: (body: Pick<WfStartBody, 'modelKey' | 'formValues' | 'initiatorPicks'>) =>
    api.post<WfStartVo>('/wf/instances', body),
  /** the instances I started */
  mine: (params: Query) => api.get<Page<WfInstanceItemVo>>('/wf/instances/mine', { params }),
  /** my pending tasks */
  todo: (params: Query, options: Options = {}) =>
    api.get<Page<WfTaskItemVo>>('/wf/tasks/todo', { params, ...options }),
  /** the tasks I handled */
  done: (params: Query) => api.get<Page<WfTaskItemVo>>('/wf/tasks/done', { params }),
  /** copies sent to me (`unread`: true / false narrows by read state) */
  ccs: (params: Query) => api.get<Page<WfCcItemVo>>('/wf/ccs/mine', { params }),
  readCc: (id: number) => api.post<null>(`/wf/ccs/${id}/read`),
  /** an instance I may see, its timeline and my pending tasks on it */
  detail: (id: number) => api.get<WfInstanceDetailVo>(`/wf/instances/${id}`),
  /** the initiator resubmits what was sent back to them (the `begin` task) */
  resubmit: (taskId: number, body: WfDecideBody = {}) =>
    api.post<null>(`/wf/tasks/${taskId}/resubmit`, body),
  // decisions on my task; a step with `commentRequired` takes no approval / rejection without one
  approve: (taskId: number, body: WfDecideBody) =>
    api.post<null>(`/wf/tasks/${taskId}/approve`, body),
  reject: (taskId: number, body: WfCommentBody) =>
    api.post<null>(`/wf/tasks/${taskId}/reject`, body),
  /** the steps a send-back may go to: steps already passed, newest first, then `begin` (the initiator) */
  backTargets: (taskId: number) => api.get<WfBackTargetVo[]>(`/wf/tasks/${taskId}/back-targets`),
  sendBack: (taskId: number, body: WfSendBackBody) =>
    api.post<null>(`/wf/tasks/${taskId}/send-back`, body),
  transfer: (taskId: number, body: WfHandOverBody) =>
    api.post<null>(`/wf/tasks/${taskId}/transfer`, body),
  /** the user handles it first, then it is back with me to decide */
  delegate: (taskId: number, body: WfHandOverBody) =>
    api.post<null>(`/wf/tasks/${taskId}/delegate`, body),
  // Before-signers hold my task until they approved, after-signers follow my approval
  addSign: (taskId: number, body: WfAddSignBody) =>
    api.post<null>(`/wf/tasks/${taskId}/add-sign`, body),
  /** my add-sign tasks still pending (`taskIds`) of my task `taskId` */
  removeSign: (taskId: number, body: WfRemoveSignBody) =>
    api.post<null>(`/wf/tasks/${taskId}/remove-sign`, body),
  cc: (taskId: number, body: WfCcBody) => api.post<null>(`/wf/tasks/${taskId}/cc`, body),
  comment: (taskId: number, body: WfRemarkBody) =>
    api.post<null>(`/wf/tasks/${taskId}/comment`, body),
  /** my approval `taskId`, while the step after it has not acted (else 409) */
  withdraw: (taskId: number, body: WfCommentBody) =>
    api.post<null>(`/wf/tasks/${taskId}/withdraw`, body),
  // the initiator's
  cancel: (id: number, body: WfCommentBody) => api.post<null>(`/wf/instances/${id}/cancel`, body),
  /** once an hour per instance, else 429 */
  urge: (id: number, options: Options = {}) =>
    api.post<null>(`/wf/instances/${id}/urge`, undefined, options),
}
