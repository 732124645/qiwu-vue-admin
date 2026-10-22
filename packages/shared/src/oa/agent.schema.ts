import { z } from 'zod'
import { wfStartBody } from '../workflow/wf-center.schema.js'

/** 工具只查询当前登录人的数据，不接受租户或人员覆盖。 */
export const oaAgentTodo = z.strictObject({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(50).default(20),
  modelKey: z.string().min(1).max(64).optional(),
})
export const oaAgentGet = z.strictObject({ instanceId: z.number().int().positive() })

/** 通用申请仅使用办公通用审批已发布表单，字段由发布快照继续校验。 */
export const oaAgentGeneric = z.strictObject({
  formValues: wfStartBody.shape.formValues,
  initiatorPicks: wfStartBody.shape.initiatorPicks,
})
export type OaAgentGeneric = z.output<typeof oaAgentGeneric>

/** 发起前读取当前发布表单和可选审批人，缺少字段时据此向本人询问。 */
export const oaAgentOptions = z.strictObject({
  kind: z.enum(['leave', 'trip', 'expense', 'seal', 'generic']),
  keyword: z.string().trim().max(64).optional(),
})
