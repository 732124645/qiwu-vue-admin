import { Injectable, type OnModuleDestroy } from '@nestjs/common'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  type CallToolResult,
  ElicitRequestSchema,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { ElicitHandler } from '../agent-ports.js'
import { guardedFetch, McpNetFailure } from './guarded-fetch.js'

/** Connect (initialize) and list the tools, each within this. */
export const MCP_CONNECT_TIMEOUT_MS = 20_000
/** One tool call, not counting the time an elicitation waits for the user. */
export const MCP_CALL_TIMEOUT_MS = 60_000
/** Longest wait for the user's answer to one elicitation; then the server is told `cancel`. */
export const MCP_ELICIT_MAX_MS = 10 * 60_000
/** An idle client is kept this long for the next call to the same server, then closed. */
export const MCP_IDLE_CLIENT_MS = 30_000
/** Tools read from one server at most (pages of `tools/list`). */
export const MCP_MAX_TOOLS = 200
/** Characters of an elicitation message handed on (untrusted text from the server). */
export const MCP_ELICIT_MESSAGE_MAX = 1000

/** Where and how to reach one server; `version` changes whenever its settings change. */
export interface McpTarget {
  id: number
  url: string
  allowPrivate: boolean
  version: string
  /** the auth headers for this connection (an OAuth token is fetched here) */
  headers: () => Promise<Record<string, string>>
}

/** One open client and the state its handlers read. */
interface Conn {
  key: string
  client: Client
  /** the elicitation handler of the call using it now */
  elicit: ElicitHandler | null
  /** elicitations waiting for the user (timers are held meanwhile) */
  waiting: number
  /** the safe reason of the latest refused or failed request */
  reason?: string
  onPause?: () => void
  onResume?: () => void
  idleTimer?: NodeJS.Timeout
}

/**
 * 外部 MCP 服务器连接失败：`reason` 是简短的原因码（address、timeout、too_large、http_401、protocol…），
 * 不含远端返回的任何内容，可以原样给管理员和模型看。
 */
export class McpConnectFailure extends Error {
  constructor(readonly reason: string) {
    super(`mcp server failed: ${reason}`)
    this.name = 'McpConnectFailure'
  }
}

const capped = (text: string, max: number) => (text.length > max ? text.slice(0, max) : text)

/**
 * 外部 MCP 服务器的客户端（Streamable HTTP，SDK 的 Client）：每次连接都经 {@link guardedFetch}（地址检查、
 * 钉住地址、超时与大小上限）；同一服务器的空闲客户端短暂保留供下一次调用复用，用时取出、用完放回，
 * 所以一个客户端同一时刻只服务一次调用（elicitation 回调不会串到别人的调用）。任何失败都关闭该客户端。
 */
@Injectable()
export class McpConnector implements OnModuleDestroy {
  private readonly idle = new Map<number, Conn>()

  /** 列出服务器的全部工具（按页读取，最多 {@link MCP_MAX_TOOLS} 个）。 */
  async listTools(t: McpTarget): Promise<Tool[]> {
    const signal = AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS)
    return this.use(t, signal, async (conn) => {
      const out: Tool[] = []
      let cursor: string | undefined
      do {
        const page = await conn.client.listTools(cursor ? { cursor } : undefined, {
          signal,
          timeout: MCP_CONNECT_TIMEOUT_MS,
        })
        out.push(...page.tools)
        cursor = page.nextCursor
      } while (cursor && out.length < MCP_MAX_TOOLS)
      return out.slice(0, MCP_MAX_TOOLS)
    })
  }

  /**
   * 调用一个工具：参数原样转发；服务器中途发来的 elicitation 交给 `onElicit`（运行时变成问题卡片），
   * 等待回答期间不计调用超时。调用方的 `signal` 中止时原样抛出中止原因。
   */
  async callTool(
    t: McpTarget,
    name: string,
    args: Record<string, unknown>,
    ctx: { signal: AbortSignal; onElicit: ElicitHandler },
  ): Promise<CallToolResult> {
    // 可暂停的调用时限：等用户回答 elicitation 时停表，回答后按剩余时间继续
    const deadline = new AbortController()
    let left = MCP_CALL_TIMEOUT_MS
    let since = Date.now()
    let timer: NodeJS.Timeout | undefined = setTimeout(
      () => deadline.abort(new McpConnectFailure('timeout')),
      left,
    )
    const signal = AbortSignal.any([ctx.signal, deadline.signal])
    try {
      return await this.use(t, signal, async (conn) => {
        conn.elicit = ctx.onElicit
        conn.onPause = () => {
          clearTimeout(timer)
          timer = undefined
          left -= Date.now() - since
        }
        conn.onResume = () => {
          since = Date.now()
          timer = setTimeout(
            () => deadline.abort(new McpConnectFailure('timeout')),
            Math.max(left, 1),
          )
        }
        try {
          return (await conn.client.callTool({ name, arguments: args }, undefined, {
            signal,
            // SDK 自己的时限只作兜底：真正的时限是上面的可暂停计时
            timeout: MCP_CALL_TIMEOUT_MS + MCP_ELICIT_MAX_MS * 3,
          })) as CallToolResult
        } finally {
          conn.elicit = null
          conn.onPause = conn.onResume = undefined
        }
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 关闭某服务器的空闲客户端（设置改了、删除了）。 */
  forget(serverId: number): void {
    const conn = this.idle.get(serverId)
    if (conn) {
      this.idle.delete(serverId)
      void this.close(conn)
    }
  }

  onModuleDestroy(): void {
    for (const id of this.idle.keys()) this.forget(id)
  }

  /** 取出（或新建）客户端运行 `fn`；成功放回空闲池，失败关闭并换成安全的原因码。 */
  private async use<T>(t: McpTarget, signal: AbortSignal, fn: (c: Conn) => Promise<T>): Promise<T> {
    const key = `${t.id}:${t.version}`
    let conn: Conn | undefined = this.idle.get(t.id)
    this.idle.delete(t.id)
    if (conn) clearTimeout(conn.idleTimer)
    if (conn && conn.key !== key) {
      void this.close(conn)
      conn = undefined
    }
    try {
      conn ??= await this.open(t, key, signal)
      const out = await fn(conn)
      this.release(t.id, conn)
      return out
    } catch (e) {
      if (conn) void this.close(conn)
      throw this.failure(e, conn, signal)
    }
  }

  /** 新建并初始化一个客户端；声明支持表单式 elicitation（URL 式的一律拒绝）。 */
  private async open(t: McpTarget, key: string, signal: AbortSignal): Promise<Conn> {
    const client = new Client(
      { name: 'qiwu-agent', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    )
    const conn: Conn = { key, client, elicit: null, waiting: 0 }
    client.setRequestHandler(ElicitRequestSchema, async (req): Promise<ElicitResult> => {
      const params = req.params
      if (!conn.elicit || params.mode === 'url' || !('requestedSchema' in params))
        return { action: 'decline' }
      if (++conn.waiting === 1) conn.onPause?.()
      let timer: NodeJS.Timeout | undefined
      try {
        const answer = await Promise.race([
          conn.elicit({
            message: capped(String(params.message ?? ''), MCP_ELICIT_MESSAGE_MAX),
            schema: params.requestedSchema as Record<string, unknown>,
          }),
          new Promise<{ action: 'cancel' }>((resolve) => {
            timer = setTimeout(() => resolve({ action: 'cancel' }), MCP_ELICIT_MAX_MS)
          }),
        ])
        return answer.action === 'accept'
          ? { action: 'accept', content: (answer.content ?? {}) as ElicitResult['content'] }
          : { action: answer.action }
      } finally {
        clearTimeout(timer)
        if (--conn.waiting === 0) conn.onResume?.()
      }
    })
    let headers: Record<string, string>
    try {
      headers = await t.headers()
    } catch (e) {
      throw e instanceof McpConnectFailure ? e : new McpConnectFailure('auth')
    }
    const transport = new StreamableHTTPClientTransport(new URL(t.url), {
      requestInit: { headers },
      fetch: guardedFetch({
        allowPrivate: t.allowPrivate,
        onFailure: (reason) => (conn.reason = reason),
        paused: () => conn.waiting > 0,
      }),
      // 断线不自动重连：客户端本来就短命，失败即关闭
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    })
    // 后台事件流的错误（可选的 GET 流被拒、超时）不影响请求本身，这里不抛出
    client.onerror = () => undefined
    try {
      await client.connect(transport, { signal, timeout: MCP_CONNECT_TIMEOUT_MS })
    } catch (e) {
      await client.close().catch(() => undefined)
      if (signal.aborted) throw e
      throw new McpConnectFailure(
        e instanceof McpNetFailure ? e.reason : (conn.reason ?? 'protocol'),
      )
    }
    return conn
  }

  /** 放回空闲池（同一服务器只留一个，多出的关闭），到时自动关闭。 */
  private release(serverId: number, conn: Conn): void {
    if (this.idle.has(serverId)) {
      void this.close(conn)
      return
    }
    conn.idleTimer = setTimeout(() => {
      if (this.idle.get(serverId) === conn) this.idle.delete(serverId)
      void this.close(conn)
    }, MCP_IDLE_CLIENT_MS)
    conn.idleTimer.unref()
    this.idle.set(serverId, conn)
  }

  private async close(conn: Conn): Promise<void> {
    clearTimeout(conn.idleTimer)
    await conn.client.close().catch(() => undefined)
  }

  /** 把任何失败换成 {@link McpConnectFailure}；调用方中止时原样抛出中止原因。 */
  private failure(e: unknown, conn: Conn | undefined, signal: AbortSignal): unknown {
    if (e instanceof McpConnectFailure) return e
    if (signal.aborted && signal.reason instanceof McpConnectFailure) return signal.reason
    if (
      signal.aborted &&
      !(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError')
    )
      return signal.reason
    if (signal.aborted) return new McpConnectFailure('timeout')
    if (e instanceof McpNetFailure) return new McpConnectFailure(e.reason)
    return new McpConnectFailure(conn?.reason ?? 'protocol')
  }
}
