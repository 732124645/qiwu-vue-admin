import {
  attendancePolicyUpdate,
  attendanceSiteCreate,
  attendanceSiteUpdate,
  attendanceSiteQuery,
  clockMyQuery,
  clockQuery,
  clockMySummaryQuery,
  clockSummaryQuery,
  type AttendancePolicyVo,
  type AttendancePolicyUpdate,
  type AttendanceSiteVo,
  type AttendanceSiteCreate,
  type AttendanceSiteUpdate,
  type ClockRecordVo,
  type ClockAdminRecordVo,
  type ClockSummaryPageVo,
  type Page,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/oa'

/** 工作日保持日历日期原样传输；本人查询绝不夹带管理端的身份筛选。 */
export const attendanceApi = {
  mine: (params: Record<string, unknown>) =>
    api.get<Page<ClockRecordVo>>(`${BASE}/clock-records/mine`, {
      params: clockMyQuery.parse(params),
    }),
  admin: (params: Record<string, unknown>) =>
    api.get<Page<ClockAdminRecordVo>>(`${BASE}/clock-records/admin`, {
      params: clockQuery.parse(params),
    }),
  detail: (id: number, admin: boolean) =>
    api.get<ClockAdminRecordVo>(`${BASE}/clock-records/${admin ? 'admin' : 'mine'}/${id}`),
  mineSummary: (params: Record<string, unknown>) =>
    api.get<ClockSummaryPageVo>(`${BASE}/clock-summaries/mine`, {
      params: clockMySummaryQuery.parse(params),
    }),
  summary: (params: Record<string, unknown>) =>
    api.get<ClockSummaryPageVo>(`${BASE}/clock-summaries`, {
      params: clockSummaryQuery.parse(params),
    }),
}

export const attendancePolicyApi = {
  get: () => api.get<AttendancePolicyVo>(`${BASE}/attendance-policies/current`),
  update: (body: AttendancePolicyUpdate) =>
    api.put<AttendancePolicyVo>(
      `${BASE}/attendance-policies/current`,
      attendancePolicyUpdate.parse(body),
    ),
}

export const attendanceSiteApi = {
  page: (params: Record<string, unknown>) =>
    api.get<Page<AttendanceSiteVo>>(`${BASE}/attendance-sites`, {
      params: attendanceSiteQuery.parse(params),
    }),
  get: (id: number) => api.get<AttendanceSiteVo>(`${BASE}/attendance-sites/${id}`),
  create: (body: AttendanceSiteCreate) =>
    api.post<AttendanceSiteVo>(`${BASE}/attendance-sites`, attendanceSiteCreate.parse(body)),
  update: (id: number, body: AttendanceSiteUpdate) =>
    api.put(`${BASE}/attendance-sites/${id}`, attendanceSiteUpdate.parse(body)),
  remove: (id: number) => api.delete(`${BASE}/attendance-sites/${id}`),
}
