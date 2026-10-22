import { createHmac } from 'node:crypto'
import { Inject, Injectable, Logger, Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { InjectDataSource, TypeOrmModule } from '@nestjs/typeorm'
import {
  AGENT_PAUSED_PARAM,
  DEFAULT_TENANT_ID,
  Err,
  type ErrorDef,
  validationMessage,
} from '@qiwu/shared'
import { ClsServiceManager } from 'nestjs-cls'
import { I18nService } from 'nestjs-i18n'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AuditWriter } from '../audit/audit-writer.js'
import type { Principal } from '../auth/principal.js'
import { USER_LOOKUP, type UserLookup } from '../auth/user-lookup.js'
import { AppConfigService } from '../config/config.module.js'
import { tenantIdIfAny } from '../context/tenant.js'
import { deriveKey } from '../crypto/secret-box.js'
import { withCheckedPerm } from '../data-scope/data-scope.js'
import { classify } from '../http/http-error.filter.js'
import { currentLocale } from '../i18n/locale.js'
import { MASK } from '../redact.js'
import { ParamService } from '../settings/param.service.js'
import { McpRegistry, type RegisteredTool } from './mcp-registry.js'
import { McpToolSwitch } from './mcp.entity.js'
import type { ToolExecutionContext } from './mcp-tool.js'

/** The largest answer a tool may give (UTF-8 bytes of its JSON). */
export const MCP_OUTPUT_MAX_BYTES = 64 * 1024
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

/** A refused or failed call, answered as a tool error the agent can read. */
export class ToolRefusal extends Error {
  /** refused without an action log row (a caller's repeated refusals within one window) */
  quiet = false

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

/** What one call leaves in its action log row. */
interface CallRecord {
  /** the raw arguments, when within the limits ({@link argsJson}) */
  args?: unknown
  argsDigest: string | null
  error?: ErrorDef
  result?: unknown
  /** a write tool that ran past its time limit and was waited for in the background */
  timedOut?: true
}

/** What a call needs from its channel (the MCP endpoint, the in-app agent) besides the tool and arguments. */
export interface ToolCallContext {
  principal: Principal
  /** the language of refusal messages and validation issues */
  lang: string
  /** runs first (MCP: the rate limit and `mcp.paused`; the agent: `agent.paused`); throws a ToolRefusal to refuse */
  precheck?: () => Promise<void>
  /** the channel's own limit on a tool, checked after the platform switch (MCP: what the token allows) */
  allow?: (t: RegisteredTool) => ErrorDef | null
  /** 仅运行时能提供的消费函数；接收原始调用并返回服务端规范快照，MCP/PAT 入口没有此能力。 */
  confirmPerCall?: (tool: RegisteredTool, input: unknown) => Promise<ToolExecutionContext>
  /** the action log fields of the caller: request line, address and `params` naming the channel */
  log: {
    method: string
    url: string
    ip: string | null
    ua: string
    params: Record<string, unknown>
  }
}

/** One call's outcome: the (masked, capped) answer as JSON text, or why it was refused or failed. */
export type ToolOutcome =
  | { ok: true; tool: RegisteredTool; text: string }
  | { ok: false; tool?: RegisteredTool; refusal: ToolRefusal; unknown?: true }

/** A refusal as the caller reads it: the error code, its key, the translated message and argument issues. */
export interface ToolCallError {
  code: string
  key: string
  message: string
  errors?: { path: string; msg: string }[]
}

/** The in-app agent's call result: the answer's JSON text, or a typed error the model can read. */
export type AgentToolResult =
  { ok: true; tool: RegisteredTool; text: string } | { ok: false; error: ToolCallError }

/** What a tool's `preview` method answers: the record and each field's current → proposed value. */
const toolPreview = z.object({
  target: z.string().max(200),
  fields: z
    .array(z.object({ field: z.string().max(100), from: z.unknown(), to: z.unknown() }))
    .max(100),
})
export type ToolPreview = z.infer<typeof toolPreview>

/** Where an in-app agent call comes from: written into its action log row. */
export interface AgentCallRef {
  threadId: number
  turnId: number
  confirmPerCall?: ToolCallContext['confirmPerCall']
}

/**
 * 工具宿主：MCP 端点与后台智能体共用的工具执行护栏（see docs/mcp.md、docs/agent.md）。依次过通道自己的
 * 前置检查（限流、急停）、参数大小、工具存在与平台启用、通道限制（令牌允许）、权限点 / 套餐功能 / 平台
 * 权限点、参数校验，再在超时内运行、按输出 schema 裁剪、遮蔽密钥字段并限制大小；每次调用（含被拒的）
 * 记一条操作日志。工具方法在调用者的租户、权限与数据权限下运行（CLS principal）。
 */
@Injectable()
export class ToolHost {
  private readonly logger = new Logger(ToolHost.name)
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
    @Inject(USER_LOOKUP) private readonly users: UserLookup,
    cfg: AppConfigService,
  ) {
    this.digestKey = deriveKey(cfg.get('APP_SECRET'), '', 'qw:mcp-args-digest')
  }

  /** 平台页改了工具开关：本实例立即生效，其他实例在缓存过期后（{@link MCP_SWITCH_CACHE_MS}）生效。 */
  forgetSwitches(): void {
    this.switches.clear()
  }

  /** 用户本人此刻能用的工具：平台启用且能触达（权限点、套餐功能、平台权限点），按名称排序。 */
  async usable(p: Principal): Promise<RegisteredTool[]> {
    const off = await this.switches.get()
    const out: RegisteredTool[] = []
    for (const t of this.registry.list())
      if (!off.has(t.name) && (await this.reachable(p, t))) out.push(t)
    return out
  }

  /** 后台智能体：会话发起人此刻能用的本系统工具（审批策略由智能体运行时另行决定）。 */
  list(p: Principal): Promise<RegisteredTool[]> {
    return this.usable(p)
  }

  /**
   * 后台智能体进程内调用一个工具：以 `p`（会话发起人）的身份、在当前租户上下文里，走与 MCP 调用相同的
   * 护栏；`agent.paused` 为真时一律拒绝（`mcp.paused` 只管 MCP 端点）。操作日志标明由智能体在应用内代为
   * 操作，并记会话与轮次 id。调用方（队列任务）须已处在会话所属租户里；不在任何租户里是程序错误，直接抛出。
   */
  async call(
    p: Principal,
    name: string,
    args: unknown,
    ref: AgentCallRef,
  ): Promise<AgentToolResult> {
    if (tenantIdIfAny() === undefined) throw new Error('ToolHost.call: no tenant context')
    const cls = ClsServiceManager.getClsService()
    // 嵌套上下文：只在本次调用里把 principal 换成发起人，结束后调用方的上下文原样不变
    return cls.run({ ifNested: 'inherit' }, async () => {
      cls.set('principal', p)
      const lang = p.locale ?? currentLocale()
      const out = await this.execute(name, args, {
        principal: p,
        lang,
        confirmPerCall: ref.confirmPerCall,
        precheck: async () => {
          if (await this.flag(AGENT_PAUSED_PARAM)) throw new ToolRefusal(Err.AGENT_PAUSED)
        },
        log: {
          method: 'POST',
          url: `/api/agent/threads/${ref.threadId}/messages`,
          ip: null,
          ua: '',
          params: {
            agent: true,
            tool: name.slice(0, 96),
            channel: 'in-app',
            threadId: ref.threadId,
            turnId: ref.turnId,
          },
        },
      })
      return out.ok ? out : { ok: false, error: this.errorOf(lang, out.refusal) }
    })
  }

  /**
   * 后台智能体的审批卡片：工具声明了 `preview` 时，以发起人身份、同样的权限与数据权限、校验过的参数
   * 算出“改哪条记录、每个字段旧值 → 新值”。预览只是展示，任何失败（越权、参数不对、超时、形状不符）
   * 都返回 null，审批照常进行；它不记操作日志，因为不改数据。
   */
  async preview(p: Principal, name: string, args: unknown): Promise<ToolPreview | null> {
    try {
      return (await this.preparePreview(p, name, args))?.preview ?? null
    } catch {
      return null
    }
  }

  /** 一次解析同时供规范参数与预览使用，默认工厂或 transform 不能在同一准备过程中运行两次。 */
  async preparePreview(
    p: Principal,
    name: string,
    args: unknown,
  ): Promise<{ args: unknown; preview: ToolPreview } | null> {
    const tool = this.registry.get(name)
    if (!tool?.runPreview || tenantIdIfAny() === undefined || !(await this.reachable(p, tool)))
      return null
    const input = tool.input.safeParse(args)
    if (!input.success) throw new ToolRefusal(Err.VALIDATION_FAILED)
    const preview = await this.previewCanonical(p, name, input.data)
    return preview ? { args: input.data, preview } : null
  }

  /**
   * 仅供服务端已验证的规范快照重检；不接收客户端 prepared 标记，也不在此授予写入能力。
   * 与首次预览共用权限、超时和返回形状校验，确认服务负责核对 receipt 的 schema 与原始调用未变。
   */
  async previewCanonical(
    p: Principal,
    name: string,
    canonical: unknown,
  ): Promise<ToolPreview | null> {
    const tool = this.registry.get(name)
    if (!tool?.runPreview || tenantIdIfAny() === undefined || !(await this.reachable(p, tool)))
      return null
    const cls = ClsServiceManager.getClsService()
    try {
      const out = await cls.run({ ifNested: 'inherit' }, () => {
        cls.set('principal', p)
        const checked = tool.perm ? { perms: [tool.perm], all: false } : undefined
        return withCheckedPerm(checked, () =>
          this.run({ ...tool, run: tool.runPreview! }, canonical),
        )
      })
      const parsed = toolPreview.safeParse(out)
      return parsed.success ? parsed.data : null
    } catch (e) {
      this.logger.warn({ tool: name, err: e instanceof Error ? e.name : 'Error' }, 'preview failed')
      return null
    }
  }

  /** 布尔型系统参数（`true` 为真）；读参数缓存，多实例随缓存失效一起生效。 */
  async flag(key: string): Promise<boolean> {
    return (await this.params.get(key))?.trim().toLowerCase() === 'true'
  }

  /** 拒绝或失败的说明：错误码与按 `lang` 翻译的消息，智能体据此调整参数或放弃。 */
  errorOf(lang: string, r: ToolRefusal): ToolCallError {
    return {
      code: r.err.code,
      key: r.err.key,
      message: String(this.i18n.translate(r.err.key, { lang, args: r.params })),
      ...(r.issues && { errors: r.issues }),
    }
  }

  /** 一次调用的完整护栏：工具方法只管业务；拒绝与失败都作为结果返回，不抛出。 */
  async execute(name: string, args: unknown, ctx: ToolCallContext): Promise<ToolOutcome> {
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
    let quiet = false
    let late: Promise<unknown> | undefined
    try {
      await ctx.precheck?.()
      // 参数过深或过大：不校验也不运行，日志行照记（不含原始参数）
      if (json === null) throw new ToolRefusal(Err.VALIDATION_FAILED)
      if (!tool) {
        rec.error = Err.NOT_FOUND
        return { ok: false, refusal: new ToolRefusal(Err.NOT_FOUND), unknown: true }
      }
      if ((await this.switches.get()).has(name)) throw new ToolRefusal(Err.MCP_TOOL_DISABLED)
      const refused = ctx.allow?.(tool)
      if (refused) throw new ToolRefusal(refused, { name })
      if (!(await this.reachable(ctx.principal, tool))) throw new ToolRefusal(Err.FORBIDDEN)
      let input: unknown
      let execution: ToolExecutionContext | undefined
      if (tool.perCallConfirmation) {
        // 客户端不能传 prepared；规范参数只来自消费服务端 receipt 的回调。
        if (!ctx.confirmPerCall) throw new ToolRefusal(Err.FORBIDDEN)
        execution = await ctx.confirmPerCall(tool, args)
        if (!execution.confirmation) throw new ToolRefusal(Err.FORBIDDEN)
        input = execution.confirmation.args
      } else {
        // 未声明新能力的普通工具仍在每次执行前照旧解析一次。
        const parsed = tool.input.safeParse(args)
        if (!parsed.success)
          throw new ToolRefusal(Err.VALIDATION_FAILED, {}, this.issues(ctx.lang, parsed.error))
        input = parsed.data
      }
      // 数据权限按工具声明的权限点计算，与对应列表接口一致（PermGuard 对路由做的同一件事）。
      const checked = tool.perm ? { perms: [tool.perm], all: false } : undefined
      const data = await withCheckedPerm(checked, () => this.run(tool, input, execution))
      rec.result = tool.output ? this.shaped(tool, data) : data
      const text = maskedJson(rec.result)
      if (Buffer.byteLength(text) > MCP_OUTPUT_MAX_BYTES)
        throw new ToolRefusal(Err.MCP_OUTPUT_TOO_LARGE, { max: MCP_OUTPUT_MAX_BYTES })
      return { ok: true, tool, text }
    } catch (e) {
      const r = e instanceof ToolRefusal ? e : this.failure(e)
      quiet = r.quiet
      // 写入类工具超时：调用仍在后台运行，可能随后提交；等它结束再按实际结果记日志
      if (r instanceof ToolTimeout && tool?.kind === 'write') late = r.work
      rec.error = r.err
      rec.result = undefined
      return { ok: false, tool, refusal: r }
    } finally {
      if (late) this.logWhenSettled(ctx, name, tool!, rec, late, started)
      else if (!quiet) this.log(ctx, name, tool, rec, Date.now() - started)
    }
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
  private async run(
    tool: RegisteredTool,
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<unknown> {
    const work = Promise.resolve(tool.run(input, context))
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
   * 成功即数据已写入，记结果（输出不符合 schema 记内部错误）；失败记实际的错误；一直不结束记超时。调用方早已收到超时错误。
   */
  private logWhenSettled(
    ctx: ToolCallContext,
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
        this.log(ctx, name, tool, done, Date.now() - started)
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

  private issues(lang: string, error: z.ZodError): { path: string; msg: string }[] {
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
   * 每次调用一条操作日志（`mcp.tool` / `call`，业务 id 为工具名）：通道给出的调用者信息（MCP 的令牌类型
   * 与 id，或智能体的会话与轮次）、参数摘要与（脱敏截断后的）参数；写入类工具成功时也记结果。参数在调用
   * 前已按深度与大小检查并序列化过，这里不会因参数而失败；不阻塞、不抛出。
   */
  private log(
    ctx: ToolCallContext,
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
        method: ctx.log.method,
        url: ctx.log.url,
        ip: ctx.log.ip,
        ua: ctx.log.ua,
        params: {
          ...ctx.log.params,
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

/**
 * 工具注册表与执行护栏（see docs/mcp.md）：由 McpModule（`APP_MCP`）与 AgentModule（`APP_AGENT`）导入，
 * 任一打开即加载，两边共用同一个实例；两者都关着时工具不注册。
 */
@Module({
  imports: [DiscoveryModule, TypeOrmModule.forFeature([McpToolSwitch])],
  providers: [McpRegistry, ToolHost],
  exports: [McpRegistry, ToolHost],
})
export class ToolHostModule {}
