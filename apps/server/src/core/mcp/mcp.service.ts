import { createHmac } from 'node:crypto'
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
import { Inject, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { InjectThrottlerStorage, type ThrottlerStorage } from '@nestjs/throttler'
import {
  DEFAULT_TENANT_ID,
  Err,
  type ErrorDef,
  MCP_PAUSED_PARAM,
  validationMessage,
} from '@qiwu/shared'
import type { Request, Response } from 'express'
import { I18nService } from 'nestjs-i18n'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit-writer.js'
import { plainIp } from '../auth/auth-params.js'
import type { Principal } from '../auth/principal.js'
import { USER_LOOKUP, type UserLookup } from '../auth/user-lookup.js'
import { AppConfigService } from '../config/config.module.js'
import { deriveKey } from '../crypto/secret-box.js'
import { withCheckedPerm } from '../data-scope/data-scope.js'
import { classify } from '../http/http-error.filter.js'
import { resolveLocale } from '../i18n/locale.js'
import { MASK } from '../redact.js'
import { ParamService } from '../settings/param.service.js'
import type { McpCaller } from './mcp-auth.js'
import { McpRegistry, type RegisteredTool } from './mcp-registry.js'
import { McpToolSwitch } from './mcp.entity.js'

/** The largest answer a tool may give (UTF-8 bytes of its JSON). */
export const MCP_OUTPUT_MAX_BYTES = 64 * 1024
/** Tool calls one token may make per minute (every instance together: the throttler's Redis buckets). */
export const MCP_CALLS_PER_MINUTE = 60
/** The deepest nesting and the largest JSON (UTF-8 bytes) of a call's raw arguments; beyond either it is refused. */
export const MCP_ARGS_MAX_DEPTH = 32
export const MCP_ARGS_MAX_BYTES = 16 * 1024
/** How long the switch list (and the platform's perms) are kept per instance; a save clears its own instance at once. */
export const MCP_SWITCH_CACHE_MS = 5_000
/** How long a write tool past its time limit is waited for in the background before it is logged as unsettled. */
export const MCP_LATE_WAIT_MS = 5 * 60_000

/**
 * Key names masked in a tool's answer: passwords and passphrases, one-time codes, verifiers, tickets,
 * secrets, tokens, named keys and credentials. Narrower than the log rule (no plain `code` or `key`): a
 * dictionary code or a business key is what the agent asked for.
 */
export const OUTPUT_SECRET =
  /pass|pwd|otp|verifier|ticket|token|secret|api_?key|private_?key|(?:access|session|signing|encryption|app)_?key$|credential|authorization|cookie/i

/** A refused or failed call, answered as a tool error the agent can read (`isError`). */
class ToolRefusal extends Error {
  constructor(
    readonly err: ErrorDef,
    readonly params: Record<string, unknown> = {},
    readonly issues?: { path: string; msg: string }[],
  ) {
    super(err.key)
  }
}

/** A tool past its time limit; `work` is the call still running. */
class ToolTimeout extends ToolRefusal {
  constructor(
    seconds: number,
    readonly work: Promise<unknown>,
  ) {
    super(Err.MCP_TIMEOUT, { seconds })
  }
}

/** JSON of `value` with every secret-named key masked at any depth ({@link OUTPUT_SECRET}). */
const maskedJson = (value: unknown): string =>
  JSON.stringify(value ?? null, (k, v: unknown) =>
    k && OUTPUT_SECRET.test(k) ? MASK : typeof v === 'bigint' ? String(v) : v,
  )

/**
 * 原始参数的 JSON：嵌套不超过 {@link MCP_ARGS_MAX_DEPTH} 层、不超过 {@link MCP_ARGS_MAX_BYTES} 字节，否则 null。
 * 先用显式栈逐层数深度（不递归），所以再深的参数也不会让 JSON.stringify 栈溢出、把日志行连同调用一起
 * 丢掉；节点数超过字节上限时提前放弃（每个值至少占一个字节）。
 */
export function argsJson(args: unknown): string | null {
  const stack: [unknown, number][] = [[args, 0]]
  let nodes = 0
  while (stack.length) {
    const [v, depth] = stack.pop()!
    if (++nodes > MCP_ARGS_MAX_BYTES) return null
    if (v === null || typeof v !== 'object') continue
    if (depth >= MCP_ARGS_MAX_DEPTH) return null
    for (const x of Object.values(v)) stack.push([x, depth + 1])
  }
  try {
    const json = JSON.stringify(args ?? null)
    return Buffer.byteLength(json) <= MCP_ARGS_MAX_BYTES ? json : null
  } catch {
    return null
  }
}

/** A value kept for a few seconds per instance; `clear` drops it at once. */
function cached<T>(ms: number, load: () => Promise<T>) {
  let entry: { until: number; value: Promise<T> } | undefined
  return {
    get(): Promise<T> {
      if (!entry || entry.until <= Date.now()) {
        const value = load()
        entry = { until: Date.now() + ms, value }
        // 读失败不缓存：下次重新读
        value.catch(() => {
          if (entry?.value === value) entry = undefined
        })
      }
      return entry.value
    },
    clear(): void {
      entry = undefined
    },
  }
}

/** What one tools/call leaves in its action log row. */
interface CallRecord {
  /** the raw arguments, when within the limits ({@link argsJson}) */
  args?: unknown
  argsDigest: string | null
  error?: ErrorDef
  result?: unknown
  /** a write tool that ran past its time limit and was waited for in the background */
  timedOut?: true
}

/**
 * MCP 协议层（see docs/mcp.md）：每个请求一个无状态的 SDK `Server` + Streamable HTTP 传输（不发会话 id，
 * 身份每次都由令牌决定），只声明 tools 能力，所以 `initialize`、`tools/list`、`tools/call`（及协议自带
 * 的 ping）之外的方法都是 method not found；JSON-RPC 批量请求直接拒绝。`tools/list` 只列调用者能用的
 * 工具；`tools/call` 依次过限流、急停、参数大小、工具存在与启用、令牌允许、写入许可、权限点、参数校验，
 * 再在超时内运行并裁剪输出，每次调用（含被拒的）记一条操作日志。
 */
@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name)
  /** 参数摘要的 HMAC 密钥（由 APP_SECRET 派生）：日志读者拿不到它，就无法用字典反推被遮蔽的低熵参数 */
  private readonly digestKey: Buffer
  /** 平台页停用的工具名（没有行的工具按启用处理），每个实例缓存几秒 */
  private readonly switches = cached(MCP_SWITCH_CACHE_MS, async () => {
    const rows = await this.ds.getRepository(McpToolSwitch).findBy({ enabled: false })
    return new Set(rows.map((r) => r.name))
  })
  /** 平台页菜单携带的权限点（同 AuthGuard 对进入租户的平台人员去掉的那些） */
  private readonly platform = cached(
    MCP_SWITCH_CACHE_MS,
    async () => new Set(await this.users.platformPerms()),
  )

  constructor(
    private readonly registry: McpRegistry,
    private readonly params: ParamService,
    private readonly audit: AuditWriter,
    private readonly i18n: I18nService,
    @InjectDataSource() private readonly ds: DataSource,
    @InjectThrottlerStorage() private readonly throttle: ThrottlerStorage,
    @Inject(USER_LOOKUP) private readonly users: UserLookup,
    cfg: AppConfigService,
  ) {
    this.digestKey = deriveKey(cfg.get('APP_SECRET'), '', 'qw:mcp-args-digest')
  }

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

  /** 平台页改了工具开关：本实例立即生效，其他实例在缓存过期后（{@link MCP_SWITCH_CACHE_MS}）生效。 */
  forgetSwitches(): void {
    this.switches.clear()
  }

  /** 调用者此刻可用的工具：启用、令牌允许、写入许可与权限点都满足。 */
  async visible(c: McpCaller): Promise<RegisteredTool[]> {
    return (await this.usable(c.principal)).filter((t) => allowedBy(c, t) === null)
  }

  /**
   * 用户本人此刻能用的工具（不看令牌）：启用且能触达（权限点、套餐功能、平台权限点）。个人中心建令牌
   * 时据此列出可选的工具。
   */
  async usable(p: Principal): Promise<RegisteredTool[]> {
    const off = await this.switches.get()
    const out: RegisteredTool[] = []
    for (const t of this.registry.list())
      if (!off.has(t.name) && (await this.reachable(p, t))) out.push(t)
    return out
  }

  /** `tools/call`：护栏全部在这里，工具方法只管业务。 */
  async call(req: Request, c: McpCaller, name: string, args: unknown): Promise<CallToolResult> {
    const started = Date.now()
    const tool = this.registry.get(name)
    // 原始参数先序列化并求摘要（任何护栏之前）：日志行的内容此时就定了，之后不会因序列化失败而丢行
    const json = argsJson(args)
    const rec: CallRecord = {
      // 带密钥的摘要：相同调用摘要相同，可比对重复调用；日志里被遮蔽的密码等无法靠穷举还原
      argsDigest:
        json === null ? null : createHmac('sha256', this.digestKey).update(json).digest('hex'),
      ...(json !== null && { args }),
    }
    // 同一令牌同一窗口里只记第一次限流拒绝，免得被拒的调用刷满操作日志
    let quiet = false
    let late: Promise<unknown> | undefined
    try {
      // 限流在急停之前：急停期间反复重试的智能体同样每窗口只记一行日志
      const hits = await this.throttle.increment(c.bucket, 60_000, MCP_CALLS_PER_MINUTE, 0, 'mcp')
      if (hits.isBlocked) {
        const logged = await this.throttle.increment(`${c.bucket}:refused`, 60_000, 1, 0, 'mcp')
        quiet = logged.isBlocked
        throw new ToolRefusal(Err.TOO_MANY_REQUESTS)
      }
      if (await this.paused()) throw new ToolRefusal(Err.MCP_PAUSED)
      // 参数过深或过大：不校验也不运行，日志行照记（不含原始参数）
      if (json === null) throw new ToolRefusal(Err.VALIDATION_FAILED)
      // 未知工具是协议错误（参数无效），不是工具执行错误
      if (!tool) {
        rec.error = Err.NOT_FOUND
        throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
      }
      if ((await this.switches.get()).has(name)) throw new ToolRefusal(Err.MCP_TOOL_DISABLED)
      const refused = allowedBy(c, tool)
      if (refused) throw new ToolRefusal(refused, { name })
      if (!(await this.reachable(c.principal, tool))) throw new ToolRefusal(Err.FORBIDDEN)
      const input = tool.input.safeParse(args)
      if (!input.success)
        throw new ToolRefusal(Err.VALIDATION_FAILED, {}, this.issues(req, input.error))
      // 数据权限按工具声明的权限点计算，与对应列表接口一致（PermGuard 对路由做的同一件事）
      const checked = tool.perm ? { perms: [tool.perm], all: false } : undefined
      const data = await withCheckedPerm(checked, () => this.run(tool, input.data))
      rec.result = tool.output ? this.shaped(tool, data) : data
      const text = maskedJson(rec.result)
      if (Buffer.byteLength(text) > MCP_OUTPUT_MAX_BYTES)
        throw new ToolRefusal(Err.MCP_OUTPUT_TOO_LARGE, { max: MCP_OUTPUT_MAX_BYTES })
      const answer: CallToolResult = { content: [{ type: 'text', text }] }
      if (tool.output) answer.structuredContent = JSON.parse(text) as Record<string, unknown>
      return answer
    } catch (e) {
      // 只有未知工具才是协议错误；工具自己抛出的 McpError 按普通失败处理，不把异常文本交给客户端
      if (!tool && e instanceof McpError) throw e
      const r = e instanceof ToolRefusal ? e : this.failure(e)
      // 写入类工具超时：调用仍在后台运行，可能随后提交；等它结束再按实际结果记日志
      if (r instanceof ToolTimeout && tool?.kind === 'write') late = r.work
      rec.error = r.err
      rec.result = undefined
      return this.refusal(req, r)
    } finally {
      if (late) this.logWhenSettled(req, c, name, tool!, rec, late, started)
      else if (!quiet) this.log(req, c, name, tool, rec, Date.now() - started)
    }
  }

  /** `mcp.paused`：为真时全部 tools/call 立即拒绝；读参数缓存，多实例随缓存失效一起生效。 */
  private async paused(): Promise<boolean> {
    return (await this.params.get(MCP_PAUSED_PARAM))?.trim().toLowerCase() === 'true'
  }

  /**
   * 调用者能否触达工具：持有权限点（root 全部放行，同 PermGuard）；工具声明了套餐功能时，调用者的套餐
   * 须含该功能（同 `@RequireFeature`）；平台页的权限点只给默认租户的用户（同 `@PlatformOnly()`）——
   * 别的租户的会话本来就拿不到这些权限点，这里再挡一层，免得挂在平台权限点上的工具被别的租户调用。
   */
  private async reachable(p: Principal, t: RegisteredTool): Promise<boolean> {
    if (t.perm !== null && p.root !== true && !p.perms.includes(t.perm)) return false
    if (t.feature !== undefined) {
      const features = p.features ?? (p.tenantId !== DEFAULT_TENANT_ID ? [] : undefined)
      if (features !== undefined && !features.includes(t.feature)) return false
    }
    if (t.perm !== null && p.tenantId !== DEFAULT_TENANT_ID)
      return !(await this.platform.get()).has(t.perm)
    return true
  }

  /** 在工具的时限内运行；超时只结束等待，已开始的工作无法中断（写入类工具应保持单次短事务）。 */
  private async run(tool: RegisteredTool, input: unknown): Promise<unknown> {
    const work = Promise.resolve(tool.run(input))
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new ToolTimeout(Math.ceil(tool.timeoutMs / 1000), work)),
            tool.timeoutMs,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 超时的写入类工具：在后台等它真正结束（最多 {@link MCP_LATE_WAIT_MS}），再记一条带 `timedOut` 的日志：
   * 成功即数据已写入，记结果（输出不符合 schema 记内部错误）；失败记实际的错误；一直不结束记超时。智能体早已收到超时错误。
   */
  private logWhenSettled(
    req: Request,
    c: McpCaller,
    name: string,
    tool: RegisteredTool,
    rec: CallRecord,
    work: Promise<unknown>,
    started: number,
  ): void {
    let timer: NodeJS.Timeout | undefined
    const cap = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolRefusal(Err.MCP_TIMEOUT)), MCP_LATE_WAIT_MS)
      timer.unref()
    })
    void Promise.race([work, cap])
      // 与同步路径一致：输出不符合 schema 按内部错误记，不把未裁剪的结果写进日志
      .then((data) => (tool.output ? this.shaped(tool, data) : data))
      .then(
        (result): CallRecord => ({ ...rec, error: undefined, result, timedOut: true }),
        (e: unknown): CallRecord => ({
          ...rec,
          error: (e instanceof ToolRefusal ? e : this.failure(e)).err,
          result: undefined,
          timedOut: true,
        }),
      )
      .then((done) => {
        clearTimeout(timer)
        this.log(req, c, name, tool, done, Date.now() - started)
      })
  }

  /** 有输出 schema 的工具：按它解析（多余字段丢掉）；不符合是工具自身的缺陷，按内部错误处理。 */
  private shaped(tool: RegisteredTool, data: unknown): unknown {
    const r = tool.output!.safeParse(data)
    if (r.success) return r.data
    this.logger.error({ tool: tool.name, issues: r.error.issues.length }, 'mcp tool output invalid')
    throw new ToolRefusal(Err.INTERNAL)
  }

  /** 工具抛出的异常：业务错误照常翻译；其余记日志后只回内部错误，不泄露异常文本。 */
  private failure(e: unknown): ToolRefusal {
    const { err, status, params } = classify(e)
    if (status >= 500) this.logger.error(e, 'mcp tool failed')
    return new ToolRefusal(err, params)
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

  /** 拒绝或失败的应答：错误码与按请求语言翻译的消息，智能体据此调整参数或放弃。 */
  private refusal(req: Request, r: ToolRefusal): CallToolResult {
    const lang = resolveLocale(req)
    const body = {
      code: r.err.code,
      message: String(this.i18n.translate(r.err.key, { lang, args: r.params })),
      ...(r.issues && { errors: r.issues }),
    }
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] }
  }

  private issues(req: Request, error: z.ZodError): { path: string; msg: string }[] {
    const lang = resolveLocale(req)
    return error.issues.slice(0, 20).map((issue) => {
      const path = issue.path.map(String).join('.')
      const { key, params } = validationMessage(issue)
      return {
        path,
        msg: String(this.i18n.translate(key, { lang, args: { ...params, field: path } })),
      }
    })
  }

  /**
   * 每次 tools/call 一条操作日志（`mcp.tool` / `call`，业务 id 为工具名）：标明是智能体代为操作、
   * 令牌类型与 id、参数摘要与（脱敏截断后的）参数；写入类工具成功时也记结果。参数在调用前已按深度与
   * 大小检查并序列化过，这里不会因参数而失败；不阻塞、不抛出。
   */
  private log(
    req: Request,
    c: McpCaller,
    name: string,
    tool: RegisteredTool | undefined,
    rec: CallRecord,
    costMs: number,
  ): void {
    try {
      this.audit.action({
        domain: 'mcp.tool',
        verb: 'call',
        bizId: name.slice(0, 64),
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
          argsDigest: rec.argsDigest,
          ...('args' in rec && { arguments: rec.args }),
          ...(rec.timedOut && { timedOut: true }),
        },
        result: tool?.kind === 'write' && !rec.error ? rec.result : undefined,
        errorKey: rec.error?.key,
        costMs,
        sensitive: tool?.sensitive,
      })
    } catch (e) {
      this.logger.error(e, 'mcp action log skipped')
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
