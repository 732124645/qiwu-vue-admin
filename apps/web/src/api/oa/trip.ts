import {
  tripCreate,
  tripUpdate,
  type TripCreate,
  type TripUpdate,
  type TripVo,
  type Page,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/oa/trips'

/** 办公单据只通过业务接口提交，修改时剔除仅发起阶段使用的选人字段。 */
export const tripApi = {
  page: (params: Record<string, unknown>) => api.get<Page<TripVo>>(BASE, { params }),
  get: (id: number) => api.get<TripVo>(`${BASE}/${id}`),
  create: (body: TripCreate) => api.post<TripVo>(BASE, tripCreate.parse(body)),
  update: (id: number, body: TripUpdate & { initiatorPicks?: unknown }) => {
    const { initiatorPicks: _picks, ...values } = body
    return api.put(`${BASE}/${id}`, tripUpdate.parse(values))
  },
}
