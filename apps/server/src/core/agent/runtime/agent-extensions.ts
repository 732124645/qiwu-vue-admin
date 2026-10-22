import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { AGENT_TURN_STATUSES, agentChartSpec, agentSource } from '@qiwu/shared'
import { z } from 'zod'
import {
  AGENT_APPROVAL_REVIEWER,
  AGENT_BUILTIN_TOOL,
  AGENT_CONTEXT_CONTRIBUTOR,
  AGENT_TOOL_ITEM_KINDS,
  AGENT_TOOL_ITEM_MAX,
  type AgentToolItemKind,
  type AgentApprovalReviewer,
  type AgentBuiltinRun,
  type AgentBuiltinToolMeta,
  type AgentContextContributor,
  type AgentContextInput,
  type AgentContextPart,
  type AgentReviewCall,
  type AgentReviewContext,
  type AgentReviewVerdict,
  type AgentRunContext,
  type AgentRunThread,
} from '../agent-ports.js'
import type { AgentThread } from '../entities/agent-thread.entity.js'
import { planInput } from './turn-tools.js'

/** 一段上下文最多交给模型这么多字符（超出截断）。 */
export const CONTEXT_PART_MAX = 20_000
/** 审查理由最多保留这么多字符。 */
const REASON_MAX = 500

/** 登记的一个内置工具：声明、模型看到的参数 JSON Schema、已绑定的方法与声明它的 provider。 */
export interface RegisteredBuiltin {
  meta: AgentBuiltinToolMeta
  parameters: Record<string, unknown>
  run: AgentBuiltinRun
  provider: object
}

/** 会话行 → 扩展点看到的会话设置。 */
export function runThread(t: AgentThread): AgentRunThread {
  return {
    id: Number(t.id),
    mode: t.approvalMode,
    planMode: t.planMode,
    readOnly: t.approvalMode === 'read_only' || t.planMode,
    memoryEnabled: t.memoryEnabled,
    profileId: t.profileId === null ? null : Number(t.profileId),
    parentThreadId: t.parentThreadId === null ? null : Number(t.parentThreadId),
    automationRunId: t.automationRunId === null ? null : Number(t.automationRunId),
    temporary: t.temporary,
  }
}

const VERDICTS = new Set(['approve', 'reject', 'escalate'])
const BY = new Set(['review', 'pre_approved'])

/**
 * 运行时的扩展点登记表（see docs/agent.md）：启动时扫描全部 provider 上的 `@AgentBuiltinTool` 方法、
 * `@AgentContextContributor` 与 `@AgentApprovalReviewer` 类。用发现机制而不是多值注入令牌：Nest 没有
 * 多值 provider，一个模块只需把自己的 provider 放进 `providers` 就能挂上来，不必改智能体模块。
 * 内置工具重名让启动失败；贡献者与审查者按 `order`、再按类名排序，顺序稳定。
 */
@Injectable()
export class AgentExtensions implements OnModuleInit {
  private readonly logger = new Logger(AgentExtensions.name)
  private readonly tools = new Map<string, RegisteredBuiltin>()
  private contributors: { name: string; c: AgentContextContributor }[] = []
  private reviewers: { name: string; r: AgentApprovalReviewer }[] = []

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  /** 扫描并登记；声明错误（重名、参数不是对象 schema）直接抛出，阻止启动。 */
  onModuleInit(): void {
    const contributors: { order: number; name: string; c: AgentContextContributor }[] = []
    const reviewers: { order: number; name: string; r: AgentApprovalReviewer }[] = []
    // `useExisting` 别名与同一个实例在几个模块里的登记只算一次，免得一个工具被当成重名
    const seen = new Set<object>()
    for (const wrapper of this.discovery.getProviders()) {
      const { metatype, instance } = wrapper
      if (wrapper.isAlias || !instance || typeof instance !== 'object' || seen.has(instance))
        continue
      seen.add(instance)
      const target = instance as Record<string, unknown>
      for (const method of this.scanner.getAllMethodNames(Object.getPrototypeOf(instance))) {
        const fn = target[method]
        if (typeof fn !== 'function') continue
        const meta = this.reflector.get<AgentBuiltinToolMeta | undefined>(AGENT_BUILTIN_TOOL, fn)
        if (meta) this.add(meta, (fn as AgentBuiltinRun).bind(instance), instance)
      }
      if (!metatype) continue
      const name = (metatype as { name?: string }).name ?? ''
      const cm = this.reflector.get<{ order: number } | undefined>(
        AGENT_CONTEXT_CONTRIBUTOR,
        metatype,
      )
      if (cm) contributors.push({ order: cm.order, name, c: instance as AgentContextContributor })
      const rm = this.reflector.get<{ order: number } | undefined>(
        AGENT_APPROVAL_REVIEWER,
        metatype,
      )
      if (rm) reviewers.push({ order: rm.order, name, r: instance as AgentApprovalReviewer })
    }
    const byOrder = (a: { order: number; name: string }, b: { order: number; name: string }) =>
      a.order - b.order || a.name.localeCompare(b.name)
    this.contributors = contributors.sort(byOrder)
    this.reviewers = reviewers.sort(byOrder)
  }

  /** 校验一个内置工具声明后登记（按登记顺序提供给模型）。 */
  private add(meta: AgentBuiltinToolMeta, run: AgentBuiltinRun, provider: object): void {
    const where = `@AgentBuiltinTool('${meta.name}')`
    if (this.tools.has(meta.name)) throw new Error(`${where} registered twice`)
    if (!(meta.input instanceof z.ZodObject))
      throw new Error(`${where}: input must be a zod object`)
    const { $schema: _, ...parameters } = z.toJSONSchema(meta.input, { io: 'input' }) as Record<
      string,
      unknown
    >
    this.tools.set(meta.name, { meta, parameters, run, provider })
  }

  /** 按名字取一个内置工具。 */
  builtin(name: string): RegisteredBuiltin | undefined {
    return this.tools.get(name)
  }

  /** 登记的全部内置工具（按登记顺序；平台“工具策略”页列出它们）。 */
  allBuiltins(): RegisteredBuiltin[] {
    return [...this.tools.values()]
  }

  /** 本次运行提供的内置工具（按登记顺序，`available` 为假的去掉）。 */
  async availableBuiltins(ctx: AgentRunContext): Promise<RegisteredBuiltin[]> {
    const out: RegisteredBuiltin[] = []
    for (const t of this.tools.values())
      if (!t.meta.available || (await t.meta.available(ctx, t.provider))) out.push(t)
    return out
  }

  /** 有没有登记上下文贡献者（没有时调用方不必准备输入）。 */
  hasContributors(): boolean {
    return this.contributors.length > 0
  }

  /**
   * 按顺序收集这一次请求的上下文段：空文字跳过，超长截断；一个贡献者出错只记日志并跳过它（本轮照常），
   * 本轮已被中断时把中断原因抛出去。
   */
  async contextParts(ctx: AgentContextInput): Promise<AgentContextPart[]> {
    const out: AgentContextPart[] = []
    for (const { name, c } of this.contributors) {
      try {
        const part = await c.contribute(ctx)
        if (!part || typeof part.text !== 'string' || !part.text.trim()) continue
        out.push({
          id: String(part.id).slice(0, 40),
          text: part.text.slice(0, CONTEXT_PART_MAX),
        })
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason
        this.logger.warn(
          { contributor: name, err: e instanceof Error ? e.name : 'Error' },
          'agent context part skipped',
        )
      }
    }
    return out
  }

  /** 有没有登记审批审查者。 */
  hasReviewers(): boolean {
    return this.reviewers.length > 0
  }

  /**
   * 按顺序问审查者：第一个不是 null 的结论（approve、reject 或 escalate）生效并返回——escalate 也结束链条，
   * 一个审查者判为要人看的调用，排在后面的审查者不能再放行；全是 null 时返回 null。形状不对的结论当作
   * null；审查者出错只记日志（当作 null）。本轮被中断（停止、急停、丢锁、超时）时立即抛出中断原因：每个
   * 审查者之前、等它的时候（不等慢审查者答完）与返回之前都看一次，中断之后得出的放行不会被用上。调用方
   * 负责只在允许审查时调用（见 TurnRunner.reviewed）。
   */
  async review(ctx: AgentReviewContext, call: AgentReviewCall): Promise<AgentReviewVerdict | null> {
    for (const { name, r } of this.reviewers) {
      ctx.signal.throwIfAborted()
      let v: AgentReviewVerdict | null
      try {
        v = await untilAborted(
          Promise.resolve().then(() => r.review(ctx, call)),
          ctx.signal,
        )
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason
        this.logger.warn(
          { reviewer: name, err: e instanceof Error ? e.name : 'Error' },
          'agent approval review failed',
        )
        continue
      }
      if (!v || !VERDICTS.has(v.verdict) || !BY.has(v.by) || typeof v.reason !== 'string') continue
      ctx.signal.throwIfAborted()
      return { verdict: v.verdict, by: v.by, reason: v.reason.slice(0, REASON_MAX) }
    }
    ctx.signal.throwIfAborted()
    return null
  }
}

/** 等 `p`，但中断信号一到就以中断原因拒绝（不再等它）；监听器在结束时摘掉。 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** 五种工具条目的载荷 schema（`plan` 与 `chart` 用已有的，其余按共享的载荷类型）。 */
const TOOL_ITEM_SCHEMAS: Record<AgentToolItemKind, z.ZodType> = {
  plan: planInput,
  chart: agentChartSpec,
  image: z.object({
    fileId: z.number().int().positive(),
    prompt: z.string().max(4000),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  }),
  report: z.object({
    title: z.string().max(200),
    text: z.string(),
    citations: z.array(agentSource).max(100),
  }),
  subagent: z.object({
    callId: z.string().max(64),
    tasks: z
      .array(
        z.object({
          title: z.string().max(200),
          threadId: z.number().int().positive(),
          status: z.enum([...AGENT_TURN_STATUSES, 'queued']),
          summary: z.string().max(10_000).optional(),
        }),
      )
      .max(10),
  }),
}

/** 内置工具可以写的条目种类。 */
export const isToolItemKind = (kind: string): kind is AgentToolItemKind =>
  (AGENT_TOOL_ITEM_KINDS as readonly string[]).includes(kind)

/**
 * 校验内置工具要写的条目载荷：种类须是五种工具条目之一，载荷按该种的 schema 校验（不合格抛 ZodError），
 * 序列化后不超过 {@link AGENT_TOOL_ITEM_MAX}。返回校验后的载荷。
 */
export function toolItemPayload(kind: string, payload: unknown): Record<string, unknown> {
  if (!isToolItemKind(kind)) throw new Error(`a built-in tool cannot write a ${kind} item`)
  const parsed = TOOL_ITEM_SCHEMAS[kind].parse(payload) as Record<string, unknown>
  if (JSON.stringify(parsed).length > AGENT_TOOL_ITEM_MAX)
    throw new Error(`a ${kind} item is larger than ${AGENT_TOOL_ITEM_MAX} characters`)
  return parsed
}
