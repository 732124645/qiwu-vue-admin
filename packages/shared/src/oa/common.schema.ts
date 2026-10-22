import { z } from 'zod'

/** 办公申请沿用流程的业务状态，退回后的编辑资格由待办任务决定。 */
export const OA_REQUEST_STATES = ['draft', 'in_review', 'approved', 'rejected', 'canceled'] as const
export const oaRequestState = z.enum(OA_REQUEST_STATES)
export type OaRequestState = z.infer<typeof oaRequestState>

/** 金额使用十进制字符串，限定数据库精度并补齐分位，避免二进制浮点改变金额。 */
export const oaAmount = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/)
  .transform((value) => {
    const [whole, fraction = ''] = value.split('.')
    return `${whole}.${fraction.padEnd(2, '0')}`
  })

/** 报销金额必须严格大于零；预计费用可使用允许零的 oaAmount。 */
export const oaPositiveAmount = oaAmount.refine((value) => value !== '0.00', {
  error: 'validation.invalid',
})

/** 附件仅提交对象 ID；归属、绑定及下载权在业务事务内复查。 */
export const oaAttachmentIds = z
  .array(z.number().int().positive())
  .max(10)
  .refine((ids) => new Set(ids).size === ids.length, { error: 'validation.invalid' })

/** 固定业务单的只读公共字段，身份与流程状态始终由服务端确定。 */
export const oaRequestVoFields = {
  id: z.number().int(),
  userId: z.number().int(),
  deptId: z.number().int().nullable(),
  state: oaRequestState,
  instanceId: z.number().int().nullable(),
  attachmentIds: z.array(z.number().int()),
  createdBy: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedBy: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
}
