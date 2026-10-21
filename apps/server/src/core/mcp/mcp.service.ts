import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { Injectable, Logger } from '@nestjs/common'
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler'
import { Err, type ErrorDef, MCP_PAUSED_PARAM } from '@qiwu/shared'
import type { Request, Response } from 'express'
import { plainIp } from '../auth/auth-params.js'
import type { Principal } from '../auth/principal.js'
import { resolveLocale } from '../i18n/locale.js'
import type { McpCaller } from './mcp-auth.js'
import type { RegisteredTool } from './mcp-registry.js'
import { ToolHost, ToolRefusal } from './tool-host.js'

export {
  argsJson,
  MCP_ARGS_MAX_BYTES,
  MCP_ARGS_MAX_DEPTH,
  MCP_LATE_WAIT_MS,
  MCP_OUTPUT_MAX_BYTES,
  MCP_SWITCH_CACHE_MS,
  OUTPUT_SECRET,
} from './tool-host.js'

/** Tool calls one token may make per minute (every instance together: the throttler's Redis buckets). */
export const MCP_CALLS_PER_MINUTE = 60

/**
 * MCP 协议层（see docs/mcp.md）：每个请求一个无状态的 SDK `Server` + Streamable HTTP 传输（不发会话 id，
 * 身份每次都由令牌决定），只声明 tools 能力，所以 `initialize`、`tools/list`、`tools/call`（及协议自带
 * 的 ping）之外的方法都是 method not found；JSON-RPC 批量请求直接拒绝。`tools/list` 只列调用者能用的
 * 工具；`tools/call` 先过限流与急停（`mcp.paused`），其余护栏（参数大小、工具存在与启用、令牌允许、写入
 * 许可、权限点、参数校验、超时、输出裁剪、操作日志）由共用的 ToolHost 完成。
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name)

  constructor(
    private readonly host: ToolHost,
    @InjectThrottlerStorage() private readonly throttle: ThrottlerStorage,
  ) {}

  /** 处理一个 POST /api/mcp：调用方已认证并处在令牌的租户上下文里。 */
  async handle(req: Request, res: Response, caller: McpCaller): Promise<void> {
    // 批量请求：当前协议版本已取消，SDK 仍会逐条执行；直接拒绝，一个请求只做一件事
    if (Array.isArray(req.body)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: ErrorCode.InvalidRequest, message: 'Batch requests are not supported' },
        id: null,
      })
      return
    }
    const server = new Server(
      { name: 'qiwu-vue-admin', version: '1' },
      { capabilities: { tools: { listChanged: false } } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () =>
      this.guarded('tools/list', async () => ({ tools: (await this.visible(caller)).map(wire) })),
    )
    server.setRequestHandler(CallToolRequestSchema, (r) =>
      this.guarded('tools/call', () =>
        this.call(req, caller, r.params.name, r.params.arguments ?? {}),
      ),
    )
    // 无状态：不生成会话 id；JSON 应答（不开 SSE 流），一次请求一次应答
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }

  /** 平台页改了工具开关：本实例立即生效，其他实例在缓存过期后生效。 */
  forgetSwitches(): void {
    this.host.forgetSwitches()
  }

  /** 调用者此刻可用的工具：启用、令牌允许、写入许可与权限点都满足。 */
  async visible(c: McpCaller): Promise<RegisteredTool[]> {
    return (await this.usable(c.principal)).filter((t) => allowedBy(c, t) === null)
  }

  /**
   * 用户本人此刻能用的工具（不看令牌）：启用且能触达（权限点、套餐功能、平台权限点）。个人中心建令牌
   * 时据此列出可选的工具。
   */
  usable(p: Principal): Promise<RegisteredTool[]> {
    return this.host.usable(p)
  }

  /** `tools/call`：限流与急停在这里，其余护栏在 ToolHost，工具方法只管业务。 */
  async call(req: Request, c: McpCaller, name: string, args: unknown): Promise<CallToolResult> {
    const lang = resolveLocale(req)
    const out = await this.host.execute(name, args, {
      principal: c.principal,
      lang,
      // 限流在急停之前：急停期间反复重试的智能体同样每窗口只记一行日志
      precheck: async () => {
        const hits = await this.throttle.increment(c.bucket, 60_000, MCP_CALLS_PER_MINUTE, 0, 'mcp')
        if (hits.isBlocked) {
          // 同一令牌同一窗口里只记第一次限流拒绝，免得被拒的调用刷满操作日志
          const logged = await this.throttle.increment(`${c.bucket}:refused`, 60_000, 1, 0, 'mcp')
          const r = new ToolRefusal(Err.TOO_MANY_REQUESTS)
          r.quiet = logged.isBlocked
          throw r
        }
        if (await this.host.flag(MCP_PAUSED_PARAM)) throw new ToolRefusal(Err.MCP_PAUSED)
      },
      allow: (t) => allowedBy(c, t),
      log: {
        method: req.method,
        url: req.originalUrl,
        ip: plainIp(req.ip) || null,
        ua: req.get('user-agent') ?? '',
        params: {
          agent: true,
          tool: name.slice(0, 96),
          // 键名避开日志脱敏的敏感词（token、key…），否则令牌类型与 id 会被遮蔽
          credential: c.kind === 'token' ? 'access-token' : 'oauth',
          credentialId: c.id,
        },
      },
    })
    if (out.ok) {
      const answer: CallToolResult = { content: [{ type: 'text', text: out.text }] }
      if (out.tool.output)
        answer.structuredContent = JSON.parse(out.text) as Record<string, unknown>
      return answer
    }
    // 只有未知工具才是协议错误（参数无效），不是工具执行错误
    if (out.unknown) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
    const { key: _, ...body } = this.host.errorOf(lang, out.refusal)
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }
  }

  /**
   * 协议处理器的兜底：McpError（未知工具等）照常交给 SDK；其他异常（数据库、连接…）只记服务端日志，
   * 对外只回通用的内部错误，否则 SDK 会把异常文本原样放进 JSON-RPC 错误。
   */
  private async guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof McpError) throw e
      this.logger.error(e, `mcp ${what} failed`)
      throw new McpError(ErrorCode.InternalError, 'Internal error')
    }
  }
}

/** 令牌对工具的限制：未列出 → 不允许；写入类工具须令牌允许写入。null = 放行。 */
function allowedBy(c: McpCaller, t: RegisteredTool): ErrorDef | null {
  if (c.tools && !c.tools.includes(t.name)) return Err.MCP_TOOL_NOT_ALLOWED
  if (t.kind === 'write' && !c.allowWrite) return Err.MCP_WRITE_NOT_ALLOWED
  return null
}

/** 工具在 tools/list 里的样子。 */
const wire = (t: RegisteredTool): Tool => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema as Tool['inputSchema'],
  ...(t.outputSchema && { outputSchema: t.outputSchema as Tool['outputSchema'] }),
  annotations: { readOnlyHint: t.kind === 'read', destructiveHint: false },
})
