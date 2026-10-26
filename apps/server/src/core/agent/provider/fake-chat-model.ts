import type {
  ChatCompletion,
  ChatEvent,
  ChatFinishReason,
  ChatModel,
  ChatRequest,
  ChatToolCall,
  ChatUsage,
} from './chat-model.js'
import { usageOf as normalizeUsage } from './usage.js'

/** One scripted answer of `FakeChatModel`. */
export interface FakeTurn {
  /** the answer text (streamed word by word) */
  text?: string
  /** a reasoning summary, streamed as one `reasoning` event before the text */
  reasoning?: string
  /** tool calls; `args` is serialized to JSON unless it is a string already; ids default to `call_<n>` */
  toolCalls?: { id?: string; name: string; args?: unknown }[]
  usage?: Partial<ChatUsage>
  /** default `tool_calls` when there are tool calls, else `stop` */
  finishReason?: ChatFinishReason
  /** reject with this instead of answering (a provider failure, say) */
  error?: Error
  /** wait before answering (abortable through the request's signal) */
  delayMs?: number
}

/**
 * 测试用的可编排模型：按顺序回放脚本里的回答，不连网络；每次请求记进 `requests` 供断言。
 * 脚本用完再调用会报错，便于发现多出来的模型调用。
 */
export class FakeChatModel implements ChatModel {
  /** every request, in order */
  readonly requests: ChatRequest[] = []
  private next = 0

  constructor(private readonly turns: FakeTurn[]) {}

  /** 回放下一条：先等待（可中断），再按词输出文本增量，然后工具调用、用量与结束原因。 */
  async *stream(req: ChatRequest): AsyncIterable<ChatEvent> {
    const { turn, calls } = await this.take(req)
    if (turn.reasoning) yield { type: 'reasoning', delta: turn.reasoning }
    for (const delta of (turn.text ?? '').split(/(?<=\s)/).filter(Boolean)) {
      throwIfAborted(req.signal)
      yield { type: 'text', delta }
    }
    for (const call of calls) yield { type: 'tool_call', call }
    yield { type: 'usage', usage: usageOf(turn) }
    yield { type: 'finish', reason: finishOf(turn) }
  }

  async complete(req: ChatRequest): Promise<ChatCompletion> {
    const { turn, calls } = await this.take(req)
    const usage = usageOf(turn)
    if (usage.usageReported) req.onUsage?.(usage)
    return {
      text: turn.text ?? '',
      toolCalls: calls,
      usage,
      finishReason: finishOf(turn),
    }
  }

  /** 取下一条脚本并记下请求；中断、脚本出错或用完时抛错。 */
  private async take(req: ChatRequest): Promise<{ turn: FakeTurn; calls: ChatToolCall[] }> {
    this.requests.push(req)
    const turn = this.turns[this.next]
    if (!turn) throw new Error(`FakeChatModel: no scripted turn ${this.next + 1}`)
    this.next++
    if (turn.delayMs) await wait(turn.delayMs, req.signal)
    throwIfAborted(req.signal)
    if (turn.error) throw turn.error
    const calls = (turn.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${this.next}_${i}`,
      name: c.name,
      arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}),
    }))
    return { turn, calls }
  }
}

const usageOf = (t: FakeTurn): ChatUsage => {
  const promptTokens = t.usage?.promptTokens === undefined ? 10 : t.usage.promptTokens
  const completionTokens = t.usage?.completionTokens === undefined ? 5 : t.usage.completionTokens
  return {
    ...normalizeUsage({ prompt_tokens: promptTokens, completion_tokens: completionTokens }),
    ...t.usage,
  }
}

const finishOf = (t: FakeTurn): ChatFinishReason =>
  t.finishReason ?? (t.toolCalls?.length ? 'tool_calls' : 'stop')

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted', 'AbortError')
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}
