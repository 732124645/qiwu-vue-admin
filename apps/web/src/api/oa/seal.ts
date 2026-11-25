import {
  sealCreate,
  sealUpdate,
  type SealCreate,
  type SealUpdate,
  type SealVo,
  type Page,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/oa/seal-requests'

/** 办公单据只通过业务接口提交，修改时剔除仅发起阶段使用的选人字段。 */
export const sealApi = {
  page: (params: Record<string, unknown>) => api.get<Page<SealVo>>(BASE, { params }),
  get: (id: number) => api.get<SealVo>(`${BASE}/${id}`),
  create: (body: SealCreate) => api.post<SealVo>(BASE, sealCreate.parse(body)),
  update: (id: number, body: SealUpdate & { initiatorPicks?: unknown }) => {
    const { initiatorPicks: _picks, ...values } = body
    return api.put(`${BASE}/${id}`, sealUpdate.parse(values))
  },
}
