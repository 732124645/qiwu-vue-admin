import type { ChatMessage, ChatModel, ChatTool, ChatUsage } from './chat-model.js'

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

/** 估算时一张输入图片按这么多 Token 计。 */
const IMAGE_ESTIMATE = 1000
/**
 * 生成一张图片、供应商没报用量又没配单张积分时的输出估算。按 Token 计费的图片模型里，常见的最高一档
 * （OpenAI gpt-image-1 高质量、1536×1024）约 6240 个输出 Token；取这个上限，宁多勿少。
 */
export const IMAGE_OUTPUT_ESTIMATE = 6240
/** UTF-8 字节数 / 3：英文偏高、中文接近实际，估算宁多勿少，避免借用量缺失少计积分。 */
const textTokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 3)

/** 一次请求的输入 Token 估算：消息正文、回传的推理与工具调用、工具定义，图片按固定数。 */
export function estimateInputTokens(
  messages: readonly ChatMessage[],
  tools: readonly ChatTool[] = [],
): number {
  let text = tools.length ? JSON.stringify(tools) : ''
  let images = 0
  for (const m of messages) {
    if (Array.isArray(m.content))
      for (const c of m.content) {
        if (c.type === 'text') text += c.text
        else images++
      }
    else text += m.content ?? ''
    if (m.role === 'assistant') {
      text += m.reasoning ?? ''
      for (const c of m.toolCalls ?? []) text += c.name + c.arguments
    }
  }
  return textTokens(text) + images * IMAGE_ESTIMATE
}

/** 已输出内容（回答、推理、工具调用参数）的 Token 估算；什么都没输出时为 0。 */
export const estimateOutputTokens = (...parts: string[]) => textTokens(parts.join(''))

/**
 * 供应商没有报告用量时的估算用量：只有输入、输出两项，标为 `estimated`，不冒充供应商报告
 * （`usageReported` 仍为 false），也不计入 Token 统计，只用于按费率计积分。
 */
export function estimatedUsage(promptTokens: number, completionTokens = 0): ChatUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    inputDetails: null,
    outputDetails: null,
    rawUsage: null,
    usageReported: false,
    estimated: true,
  }
}

/**
 * 给非流式调用补上用量估算：发请求前先回报只含输入的估算（调用中断、超时、进程崩溃时按它结算），
 * 供应商报告了实际用量就以实际为准，没报告时按输入与输出内容估算。流式调用由轮次执行器自己估算。
 * 这样配了费率的模型不能靠中途停止或服务不报用量而免费使用。
 */
export function withUsageEstimate(chat: ChatModel): ChatModel {
  return {
    stream: (req) => chat.stream(req),
    async complete(req) {
      const input = estimateInputTokens(req.messages, req.tools)
      req.onUsage?.(estimatedUsage(input))
      const res = await chat.complete(req)
      if (res.usage.usageReported) return res
      const output = estimateOutputTokens(
        res.text,
        ...res.toolCalls.map((c) => c.name + c.arguments),
      )
      return { ...res, usage: estimatedUsage(input, output) }
    },
    ...(chat.image && {
      async image(req) {
        const input = estimateOutputTokens(req.prompt)
        req.onUsage?.(estimatedUsage(input))
        const res = await chat.image!(req)
        // 成功但没报用量：按提示词与固定的图片输出估算（配了单张积分时计费仍按单张）
        return res.usage?.usageReported
          ? res
          : { ...res, usage: estimatedUsage(input, IMAGE_OUTPUT_ESTIMATE) }
      },
    }),
  }
}
