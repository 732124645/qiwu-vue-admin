import type { AgentModelPricing, AgentTokenUsage } from '@qiwu/shared'

const MILLION = 1_000_000n
const MAX_MICROS = 10n ** 24n - 1n
const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/

/** 积分按微积分读取，计算全程使用整数，避免浮点扣分误差。 */
export function creditMicros(value: string): bigint {
  if (!DECIMAL.test(value)) throw new Error('invalid credit decimal')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * MILLION + BigInt(fraction.padEnd(6, '0'))
}

/** 与数据库 DECIMAL(24,6) 保持同一精度，并拒绝超出存储范围的消费。 */
export function creditString(micros: bigint): string {
  if (micros < 0n || micros > MAX_MICROS) throw new Error('credit amount out of range')
  return `${micros / MILLION}.${String(micros % MILLION).padStart(6, '0')}`
}

/** 缓存与推理都是总量中的细分；只替换缓存对应费率，绝不把细分再次加进总数。 */
export function chargeCredits(
  pricing: AgentModelPricing | null,
  usage: AgentTokenUsage | null,
  kind: 'chat' | 'image' = 'chat',
): string | null {
  if (!pricing) return null
  const free = [
    pricing.input,
    pricing.output,
    pricing.cacheRead ?? pricing.input,
    pricing.cacheWrite ?? pricing.input,
  ].every((rate) => creditMicros(rate) === 0n)
  const flat = () =>
    kind === 'image' && pricing.imageCredits !== null
      ? creditString(creditMicros(pricing.imageCredits))
      : free
        ? '0.000000'
        : null
  const u = usage
  const usable =
    u?.usageReported &&
    u.promptTokens !== null &&
    u.completionTokens !== null &&
    (u.totalTokens === null || u.totalTokens === u.promptTokens + u.completionTokens) &&
    (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) <= u.promptTokens &&
    (u.reasoningTokens ?? 0) <= u.completionTokens
  if (!usable) return flat()
  const inputRate = creditMicros(pricing.input)
  let amount = BigInt(u.promptTokens!) * inputRate
  for (const [tokens, rate] of [
    [u.cacheReadTokens, pricing.cacheRead],
    [u.cacheWriteTokens, pricing.cacheWrite],
  ] as const) {
    if (rate === null) continue
    const specific = creditMicros(rate)
    if (specific === inputRate) continue
    if (tokens === null) return flat()
    amount += BigInt(tokens) * (specific - inputRate)
  }
  amount += BigInt(u.completionTokens!) * creditMicros(pricing.output)
  // 每次调用只向上舍入一次到微积分，不能逐类型先舍入再相加。
  return creditString((amount + MILLION - 1n) / MILLION)
}

/** 0 表示不限额；未知的本轮消费在有限预算下阻断下一次调用。 */
export function creditLimitReached(used: string, limit: string, unpriced = 0): boolean {
  const cap = creditMicros(limit)
  return cap > 0n && (unpriced > 0 || creditMicros(used) >= cap)
}
