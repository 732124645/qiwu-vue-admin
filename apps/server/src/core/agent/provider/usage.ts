import type { ChatUsage } from './chat-model.js'

type NumericTree = { [key: string]: number | NumericTree }
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** 只保存有界数字用量树，提供方夹带的正文、密钥或任意长字符串不进入账本。 */
function numericUsage(value: unknown, depth = 0, room = { keys: 128 }): NumericTree | null {
  const source = object(value)
  if (!source || depth > 3 || room.keys <= 0) return null
  const result: NumericTree = Object.create(null)
  for (const [key, item] of Object.entries(source)) {
    if (room.keys-- <= 0) break
    if (key.length > 64) continue
    if (typeof item === 'number' && Number.isFinite(item)) result[key] = item
    else {
      const nested = numericUsage(item, depth + 1, room)
      if (nested && Object.keys(nested).length) result[key] = nested
    }
  }
  return result
}

function details(value: unknown): Record<string, number> | null {
  const source = object(value)
  if (!source) return null
  const rows = Object.entries(source)
    .slice(0, 64)
    .flatMap(([key, value]) => {
      const n = count(value)
      return n === null || key.length > 64 ? [] : [[key, n] as const]
    })
  return Object.fromEntries(rows)
}

/** 归一化提供方实际返回的用量；缺字段保留 null，不用字符数或固定图片数伪造 Token。 */
export function usageOf(value: unknown, image = false): ChatUsage {
  const source = object(value)
  const inputSource = object(source?.[image ? 'input_tokens_details' : 'prompt_tokens_details'])
  const inputDetails = details(inputSource)
  const modalities = object(inputSource?.multimodal_tokens)
  for (const modality of ['image', 'audio', 'video']) {
    const field = `${modality}_tokens`
    const value = count(inputDetails?.[field]) ?? count(modalities?.[modality])
    if (inputDetails && value !== null) inputDetails[field] = value
  }
  const outputDetails = details(
    source?.[image ? 'output_tokens_details' : 'completion_tokens_details'],
  )
  const promptTokens = count(source?.[image ? 'input_tokens' : 'prompt_tokens'])
  const completionTokens = count(source?.[image ? 'output_tokens' : 'completion_tokens'])
  const sum =
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      count(source?.total_tokens) ?? (sum !== null && Number.isSafeInteger(sum) ? sum : null),
    cacheReadTokens: count(inputDetails?.cached_tokens) ?? count(source?.prompt_cache_hit_tokens),
    cacheWriteTokens:
      count(inputDetails?.cache_write_tokens) ?? count(inputDetails?.created_cache_tokens),
    reasoningTokens: count(outputDetails?.reasoning_tokens),
    inputDetails,
    outputDetails,
    rawUsage: numericUsage(source),
    usageReported: source !== null,
  }
}
