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

/**
 * 按费率计一次调用的积分。缓存与推理都是总量中的细分：只替换缓存对应费率，绝不把细分再次加进总数。
 * 配了费率的模型只要有输入、输出两个数就一定计价，宁多勿少：
 * - 需要的缓存细分缺失或不合理（细分超过输入）时，全部输入按输入 / 缓存读取 / 缓存写入里最高的费率计；
 * - total 与输入加输出不一致时不放弃，以输入 + 输出为准；推理超过输出时说明输出没含推理，加上推理计。
 * 只有没有可用数字时才返回 null（没配费率，或这次需要调用方改用估算结算）；图片有单张后备积分时按单张收。
 */
export function chargeCredits(
  pricing: AgentModelPricing | null,
  usage: AgentTokenUsage | null,
  kind: 'chat' | 'image' = 'chat',
): string | null {
  if (!pricing) return null
  const rates = [pricing.input, pricing.cacheRead, pricing.cacheWrite].flatMap((r) =>
    r === null ? [] : [creditMicros(r)],
  )
  const free = creditMicros(pricing.output) === 0n && rates.every((rate) => rate === 0n)
  const flat =
    kind === 'image' && pricing.imageCredits !== null
      ? creditString(creditMicros(pricing.imageCredits))
      : null
  const u = usage
  // 估算用量的图片在有单张后备积分时仍按单张收，不用估算 Token 改价
  if (u?.estimated && flat) return flat
  if (!(u?.usageReported || u?.estimated) || u.promptTokens === null || u.completionTokens === null)
    return flat ?? (free ? '0.000000' : null)
  const inputRate = creditMicros(pricing.input)
  const detailsValid = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) <= u.promptTokens
  let amount = 0n
  const missing = [
    [u.cacheReadTokens, pricing.cacheRead],
    [u.cacheWriteTokens, pricing.cacheWrite],
  ].some(
    ([tokens, rate]) =>
      rate !== null &&
      creditMicros(rate as string) !== inputRate &&
      (tokens === null || !detailsValid),
  )
  if (missing) {
    const highest = rates.reduce((a, b) => (b > a ? b : a), inputRate)
    amount = BigInt(u.promptTokens) * highest
  } else {
    amount = BigInt(u.promptTokens) * inputRate
    for (const [tokens, rate] of [
      [u.cacheReadTokens, pricing.cacheRead],
      [u.cacheWriteTokens, pricing.cacheWrite],
    ] as const)
      if (rate !== null && tokens !== null)
        amount += BigInt(tokens) * (creditMicros(rate) - inputRate)
  }
  const reasoning = u.reasoningTokens ?? 0
  const output =
    reasoning > u.completionTokens ? u.completionTokens + reasoning : u.completionTokens
  amount += BigInt(output) * creditMicros(pricing.output)
  // 每次调用只向上舍入一次到微积分，不能逐类型先舍入再相加。
  return creditString((amount + MILLION - 1n) / MILLION)
}

/**
 * 0 表示不限额；按已记入的积分判断（配了费率的调用总有积分：实际用量不可用时按估算记入）。只有模型没配
 * 费率的调用不计积分、也不阻断后续调用，它们只在用量页的完整性提示里列出。
 */
export function creditLimitReached(used: string, limit: string): boolean {
  const cap = creditMicros(limit)
  return cap > 0n && creditMicros(used) >= cap
}
