import { z } from 'zod'

/** 积分按十进制定点字符串传输，数据库与计费运算不经过浮点数。 */
export const agentCreditAmount = z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/)

/** 每百万 Token 的积分费率；空缓存费率沿用普通输入，图片单价仅作无可计价 Token 时的显式后备。 */
export const agentModelPricing = z.object({
  input: agentCreditAmount,
  output: agentCreditAmount,
  cacheRead: agentCreditAmount.nullable().default(null),
  cacheWrite: agentCreditAmount.nullable().default(null),
  imageCredits: agentCreditAmount.nullable().default(null),
})
export type AgentModelPricing = z.infer<typeof agentModelPricing>

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()
const details = z.record(z.string(), z.number().int().nonnegative()).nullable()

/** 仅保存供应商用量及其明细；null 表示没有报告，不代表真实零用量。 */
export const agentTokenUsage = z.object({
  promptTokens: tokens,
  completionTokens: tokens,
  totalTokens: tokens,
  cacheReadTokens: tokens,
  cacheWriteTokens: tokens,
  reasoningTokens: tokens,
  inputDetails: details,
  outputDetails: details,
  rawUsage: z.record(z.string(), z.unknown()).nullable(),
  usageReported: z.boolean(),
  /** 供应商没给用量时按请求与已输出内容保守估算的 Token（仅输入、输出两项），计入积分与额度 */
  estimated: z.boolean().optional(),
})
export type AgentTokenUsage = z.infer<typeof agentTokenUsage>
