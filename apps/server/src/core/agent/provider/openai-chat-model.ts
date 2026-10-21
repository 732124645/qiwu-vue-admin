import { Logger } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import OpenAI, { APIConnectionError, APIError } from 'openai'
import { BizError } from '../../http/biz-error.js'
import type {
  ChatCompletion,
  ChatEvent,
  ChatFinishReason,
  ChatMessage,
  ChatModel,
  ChatRequest,
  ChatToolCall,
  ChatUsage,
} from './chat-model.js'

type WireMessage = OpenAI.Chat.ChatCompletionMessageParam
type WireTool = OpenAI.Chat.ChatCompletionFunctionTool

/** What `OpenAiChatModel` needs of a provider row (the key already opened). */
export interface ChatModelConfig {
  baseUrl: string
  /** null: the provider takes no key (a local Ollama) */
  apiKey: string | null
  /** the provider's models; `reasoning` ones get `reasoning_effort` */
  models: readonly { id: string; reasoning: boolean }[]
  /** longest silence (no header, no chunk) before the request fails; default 60 s */
  timeoutMs?: number
  /** retries after a 429 or 5xx answer; default 2 */
  retries?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRIES = 2
/** waits before the 1st, 2nd, … retry */
const BACKOFF_MS = [250, 1000, 2000]
/** what the provider's function names may hold (the OpenAI rule, which compatible servers share) */
const WIRE_NAME = /[^A-Za-z0-9_-]/g
const TIMEOUT = Symbol('timeout')

const FINISH: Record<string, ChatFinishReason> = {
  stop: 'stop',
  tool_calls: 'tool_calls',
  function_call: 'tool_calls',
  length: 'length',
  content_filter: 'content_filter',
}

/** 失败统一成 AGENT_PROVIDER_FAILED，只带简短原因：上游的报错正文可能回显密钥片段或提示词，不外传 */
const failed = (reason: string) => new BizError(Err.AGENT_PROVIDER_FAILED, { reason })

/**
 * 把本系统的工具名（含 `.`）映射成提供方允许的函数名，并能映射回来；清洗后重名的加序号区分。
 * 历史消息里出现、但本次没提供的工具名也按同一规则清洗，保证前后一致。
 */
export function wireNames(names: readonly string[]) {
  const toWire = new Map<string, string>()
  const fromWire = new Map<string, string>()
  for (const name of names) {
    if (toWire.has(name)) continue
    const base = name.replace(WIRE_NAME, '_').slice(0, 64) || 'tool'
    let wire = base
    for (let i = 2; fromWire.has(wire); i++) wire = `${base.slice(0, 60)}_${i}`
    toWire.set(name, wire)
    fromWire.set(wire, name)
  }
  return {
    wire: (name: string) =>
      toWire.get(name) ?? (name.replace(WIRE_NAME, '_').slice(0, 64) || 'tool'),
    name: (wire: string) => fromWire.get(wire) ?? wire,
  }
}

/**
 * OpenAI 兼容的 Chat Completions 适配（DeepSeek、通义千问、Kimi、智谱、Ollama、OpenAI…）：流式文本与
 * 工具调用、`reasoning_effort` 只发给标了推理的模型、静默超时与调用方中断、仅 429/5xx 小退避重试。
 * SDK 自带的重试关掉（它还会重试超时与 408/409），由这里按上面的规则重试。
 */
export class OpenAiChatModel implements ChatModel {
  private readonly logger = new Logger(OpenAiChatModel.name)
  private readonly client: OpenAI
  private readonly timeoutMs: number
  private readonly retries: number

  constructor(private readonly cfg: ChatModelConfig) {
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.retries = cfg.retries ?? DEFAULT_RETRIES
    this.client = new OpenAI({
      baseURL: cfg.baseUrl,
      // SDK 要求有密钥；不需要密钥的本地服务（Ollama）收到占位值会忽略
      apiKey: cfg.apiKey ?? 'none',
      // 不读进程环境里的 OPENAI_* 组织 / 项目，只用库里配置的这一家
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: this.timeoutMs,
    })
  }

  /** 流式调用：文本增量即时产出；工具调用的参数分片按序号拼完整后在文本之后产出；`finish` 最后。 */
  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const names = this.namesOf(req)
    const call = this.guard(req.signal)
    const calls = new Map<number, { id: string; name: string; args: string }>()
    let reason: ChatFinishReason = 'other'
    let finished = false
    try {
      const chunks = await this.withRetry(call, () =>
        this.client.chat.completions.create(
          { ...this.body(req, names.wire), stream: true, stream_options: { include_usage: true } },
          { signal: call.signal },
        ),
      )
      for await (const chunk of chunks) {
        call.touch()
        if (chunk.usage) yield { type: 'usage', usage: usageOf(chunk.usage) }
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta
        // 推理摘要不是 OpenAI 标准字段：DeepSeek、通义千问用 reasoning_content，Ollama 等用 reasoning
        const extra = delta as { reasoning_content?: unknown; reasoning?: unknown } | undefined
        const thought = extra?.reasoning_content ?? extra?.reasoning
        if (typeof thought === 'string' && thought) yield { type: 'reasoning', delta: thought }
        if (delta?.content) yield { type: 'text', delta: delta.content }
        for (const part of delta?.tool_calls ?? []) {
          const c = calls.get(part.index) ?? { id: '', name: '', args: '' }
          if (part.id) c.id = part.id
          if (part.function?.name) c.name += part.function.name
          if (part.function?.arguments) c.args += part.function.arguments
          calls.set(part.index, c)
        }
        if (choice.finish_reason) {
          finished = true
          reason = FINISH[choice.finish_reason] ?? 'other'
        }
      }
      // SDK 的流在中止或连接被断开时会静默结束：没有结束原因的回答是残缺的，不能当成完整回答
      if (call.signal.aborted) throw call.signal.reason
      if (!finished) throw failed('bad_response')
    } catch (e) {
      throw this.fail(e, call)
    } finally {
      call.done()
    }
    for (const [index, c] of [...calls].sort(([a], [b]) => a - b)) {
      if (!c.name) throw failed('bad_response')
      yield {
        type: 'tool_call',
        call: { id: c.id || `call_${index}`, name: names.name(c.name), arguments: c.args || '{}' },
      }
    }
    yield { type: 'finish', reason }
  }

  /** 非流式调用（摘要、标题），同样的超时、中断、重试与错误映射。 */
  async complete(req: ChatRequest): Promise<ChatCompletion> {
    const names = this.namesOf(req)
    const call = this.guard(req.signal)
    try {
      const res = await this.withRetry(call, () =>
        this.client.chat.completions.create(this.body(req, names.wire), { signal: call.signal }),
      )
      const choice = res.choices?.[0]
      if (!choice) throw failed('bad_response')
      const toolCalls: ChatToolCall[] = (choice.message.tool_calls ?? []).flatMap((c, i) =>
        c.type === 'function'
          ? [
              {
                id: c.id || `call_${i}`,
                name: names.name(c.function.name),
                arguments: c.function.arguments || '{}',
              },
            ]
          : [],
      )
      return {
        text: choice.message.content ?? '',
        toolCalls,
        usage: res.usage ? usageOf(res.usage) : { promptTokens: 0, completionTokens: 0 },
        finishReason: FINISH[choice.finish_reason] ?? 'other',
      }
    } catch (e) {
      throw this.fail(e, call)
    } finally {
      call.done()
    }
  }

  /** 本次请求涉及的工具名：提供的工具与历史消息里调用过的。 */
  private namesOf(req: ChatRequest) {
    return wireNames([
      ...(req.tools ?? []).map((t) => t.name),
      ...req.messages.flatMap((m) =>
        m.role === 'assistant' ? (m.toolCalls ?? []).map((c) => c.name) : [],
      ),
    ])
  }

  /** 请求体：消息与工具换成线上格式；推理强度与 max_completion_tokens 只给标了推理的模型。 */
  private body(req: ChatRequest, wire: (name: string) => string) {
    const reasoning = this.cfg.models.some((m) => m.id === req.model && m.reasoning)
    const tools: WireTool[] | undefined = req.tools?.length
      ? req.tools.map((t) => ({
          type: 'function',
          function: { name: wire(t.name), description: t.description, parameters: t.parameters },
        }))
      : undefined
    return {
      model: req.model,
      messages: req.messages.map((m) => toWire(m, wire, { reasoning, model: req.model })),
      ...(tools ? { tools } : {}),
      ...(req.maxTokens
        ? reasoning
          ? { max_completion_tokens: req.maxTokens }
          : { max_tokens: req.maxTokens }
        : {}),
      ...(reasoning && req.reasoning ? { reasoning_effort: req.reasoning } : {}),
    }
  }

  /**
   * 一次调用的中断控制：调用方的 signal 与静默计时器（等响应头、等每个分片）都中止同一个请求；
   * 计时器每收到一个分片重置，所以长回答不会被总时长误杀。
   */
  private guard(outer?: AbortSignal) {
    const ctrl = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const onAbort = () => ctrl.abort(outer?.reason)
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(TIMEOUT), this.timeoutMs)
    }
    if (outer?.aborted) ctrl.abort(outer.reason)
    else outer?.addEventListener('abort', onAbort, { once: true })
    touch()
    return {
      signal: ctrl.signal,
      outer,
      touch,
      // 结束（含调用方提前停止读流）时中止请求，释放连接
      done: () => {
        clearTimeout(timer)
        outer?.removeEventListener('abort', onAbort)
        ctrl.abort()
      },
    }
  }

  /** 只在 429 与 5xx 时小退避重试；中断与超时不重试。 */
  private async withRetry<T>(call: ReturnType<OpenAiChatModel['guard']>, fn: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fn()
        call.touch()
        return res
      } catch (e) {
        const status = e instanceof APIError ? e.status : undefined
        const retryable = status === 429 || (status !== undefined && status >= 500)
        if (!retryable || attempt >= this.retries || call.signal.aborted) throw e
        call.touch()
        await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!, call.signal)
      }
    }
  }

  /** 调用方中断原样抛出中断原因；其余一律映射成不含上游正文的 AGENT_PROVIDER_FAILED。 */
  private fail(e: unknown, call: ReturnType<OpenAiChatModel['guard']>): unknown {
    if (call.outer?.aborted) return abortReason(call.outer)
    if (e instanceof BizError) return e
    const reason =
      call.signal.reason === TIMEOUT
        ? 'timeout'
        : e instanceof APIError && e.status
          ? `http_${e.status}`
          : e instanceof APIConnectionError
            ? 'network'
            : 'bad_response'
    // 只记原因与模型，不记上游消息（可能回显密钥片段）
    this.logger.warn(`chat model call failed: ${reason}`)
    return failed(reason)
  }
}

/**
 * 系统消息格式 → Chat Completions 消息格式；用户消息的图片部分换成 `image_url`（data URL）。
 * 标了推理的模型（`opts.reasoning`）：之前回答带着的推理文字放回 `reasoning_content`——DeepSeek 思考模式等
 * 在请求带工具时要求把之前每一步的推理原样送回，否则 400；没有推理文字的回答不加这个字段，所以不产出
 * 推理文字的服务（OpenAI）收不到它。未标推理的模型一律不发（不认识的字段可能被拒）；推理文字也只回给
 * 产出它的同一个模型（`opts.model`）：会话中途换了模型时，别的模型的推理不发过去。
 */
export function toWire(
  m: ChatMessage,
  wire: (name: string) => string,
  opts: { reasoning?: boolean; model?: string } = {},
): WireMessage {
  switch (m.role) {
    case 'assistant': {
      const same = m.reasoningModel !== undefined && m.reasoningModel === opts.model
      const thought =
        opts.reasoning && same && m.reasoning ? { reasoning_content: m.reasoning } : {}
      return m.toolCalls?.length
        ? {
            role: 'assistant',
            content: m.content,
            ...thought,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: wire(c.name), arguments: c.arguments },
            })),
          }
        : { role: 'assistant', content: m.content ?? '', ...thought }
    }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    case 'user':
      return {
        role: 'user',
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((c) =>
                c.type === 'text'
                  ? { type: 'text', text: c.text }
                  : { type: 'image_url', image_url: { url: c.dataUrl } },
              ),
      }
    default:
      return { role: m.role, content: m.content }
  }
}

const usageOf = (u: { prompt_tokens?: number; completion_tokens?: number }): ChatUsage => ({
  promptTokens: u.prompt_tokens ?? 0,
  completionTokens: u.completion_tokens ?? 0,
})

/** 中断原因：signal 带的 Error，或一个标准的 AbortError。 */
const abortReason = (s: AbortSignal): unknown =>
  s.reason instanceof Error ? s.reason : new DOMException('The operation was aborted', 'AbortError')

/** 可被中断的等待。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}
