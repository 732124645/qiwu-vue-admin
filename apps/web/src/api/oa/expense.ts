import {
  expenseCreate,
  expenseUpdate,
  type ExpenseCreate,
  type ExpenseUpdate,
  type ExpenseDetail,
  type Page,
} from '@qiwu/shared'
import { api } from '@/core/request/http'

const BASE = '/oa/expense-claims'

/** 办公单据只通过业务接口提交，修改时剔除仅发起阶段使用的选人字段。 */
export const expenseApi = {
  page: (params: Record<string, unknown>) => api.get<Page<ExpenseDetail>>(BASE, { params }),
  get: (id: number) => api.get<ExpenseDetail>(`${BASE}/${id}`),
  create: (body: ExpenseCreate) => api.post<ExpenseDetail>(BASE, expenseCreate.parse(body)),
  update: (id: number, body: ExpenseUpdate & { initiatorPicks?: unknown }) => {
    const { initiatorPicks: _picks, ...values } = body
    return api.put(`${BASE}/${id}`, expenseUpdate.parse(values))
  },
}
