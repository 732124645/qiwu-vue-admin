/**
 * The model interface the agent runtime talks to, independent of any vendor SDK. One implementation
 * speaks the OpenAI-compatible Chat Completions API (`OpenAiChatModel`), one replays scripted turns in
 * tests (`FakeChatModel`).
 *
 * Tool names are the system's own (`demo.customer.search`); an adapter maps them to whatever its wire
 * format allows and back, so the runtime only ever sees its own names.
 */

/** A conversation message, oldest first. */
export type ChatMessage =
  | { role: 'system'; content: string }
  /** a user message: plain text, or text and image parts (images only for models flagged `vision`) */
  | { role: 'user'; content: string | ChatContentPart[] }
  /**
   * an earlier model answer: its text (null when it only called tools), the tool calls it made, and the
   * reasoning text the provider streamed with it with the model that produced it (sent back only to that
   * same model, when it is a reasoning model)
   */
  | {
      role: 'assistant'
      content: string | null
      toolCalls?: ChatToolCall[]
      reasoning?: string
      reasoningModel?: string
    }
  /** the result of one tool call, answered under the call's id */
  | { role: 'tool'; toolCallId: string; content: string }

/** A part of a user message: text, or an image as a `data:` URL. */
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

/** A tool call the model made. */
export interface ChatToolCall {
  /** the model's call id; tool results answer under it */
  id: string
  /** the system's tool name */
  name: string
  /** the arguments as the JSON text the model wrote (may be invalid JSON: the caller parses and checks it) */
  arguments: string
}

/** A tool offered to the model. */
export interface ChatTool {
  name: string
  description: string
  /** JSON Schema of the arguments (an `object` schema) */
  parameters: Record<string, unknown>
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
}

/** Why the model stopped: done, wants tools run, hit the token limit, was filtered, or anything else. */
export type ChatFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other'

/**
 * What `stream()` yields: text deltas as they come, reasoning-summary deltas when the provider streams
 * them (`reasoning_content` / `reasoning`), each tool call once complete (after the text), usage when the
 * provider reports it, and `finish` always last.
 */
export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; call: ChatToolCall }
  | { type: 'usage'; usage: ChatUsage }
  | { type: 'finish'; reason: ChatFinishReason }

export interface ChatRequest {
  /** a model id of the provider */
  model: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  /** reasoning effort; sent only to models flagged `reasoning`, ignored for the others */
  reasoning?: 'low' | 'medium' | 'high'
  /** aborting it ends the request at once with the signal's reason (never an AGENT_PROVIDER_FAILED) */
  signal?: AbortSignal
  /** the longest answer in tokens */
  maxTokens?: number
}

/** The whole answer of `complete()`. */
export interface ChatCompletion {
  text: string
  toolCalls: ChatToolCall[]
  usage: ChatUsage
  finishReason: ChatFinishReason
}

/**
 * A chat model. Failures are `BizError(Err.AGENT_PROVIDER_FAILED, { reason })` with a short safe
 * `reason` (`timeout`, `network`, `http_<status>`, `bad_response`): never the key, never the upstream
 * body. An aborted `signal` rejects with the signal's reason instead.
 */
export interface ChatModel {
  stream(req: ChatRequest): AsyncIterable<ChatEvent>
  /** one answer without streaming (summaries, titles) */
  complete(req: ChatRequest): Promise<ChatCompletion>
}
