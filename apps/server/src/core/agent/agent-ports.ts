import { SetMetadata } from '@nestjs/common'
import type {
  AgentApprovalDecide,
  AgentApprovalMode,
  AgentAttachment,
  AgentItemKind,
  AgentItemPayloads,
  AgentMessageSend,
  AgentModelPricing,
  AgentNotifySettings,
  AgentQuestionAnswer,
  AgentSkillScope,
  AgentSource,
  AgentTokenUsage,
  ErrorDef,
  McpToolKind,
} from '@qiwu/shared'
import type { z } from 'zod'
import type { Principal } from '../auth/principal.js'
import type { TurnUrls } from './web/turn-urls.js'

/**
 * 智能体内部各部分之间的接口（see docs/agent.md）：运行时只依赖这里的形状，外部 MCP、技能与说明、
 * 批量任务各自实现并以注入令牌提供，互相不直接引用实现类。内置工具、上下文贡献者与审批审查者用文件末尾
 * 的装饰器登记，运行时启动时扫描，加新的不必改运行时。
 */

/** 交给模型的一个外部工具（来自外部 MCP 服务器，内容一律不可信）。 */
export interface ExternalToolDescriptor {
  /** 模型看到的名字：`ext.<服务器名>.<工具名>`（规整为字母、数字、`-`），在本系统内唯一 */
  name: string
  title: string
  /** 来自服务器的描述，已截断；不可信 */
  description: string
  /** 参数的 JSON Schema（来自服务器） */
  parameters: Record<string, unknown>
  /**
   * 管理员为它设的审批策略（外部工具一律视为可能写入：只有管理员显式设为 auto 才直接执行；`review` 只在
   * 会话为自动审查模式时交给审查模型，其余照 ask 等人）
   */
  policy: 'auto' | 'ask' | 'review' | 'deny'
  serverName: string
}

/** 外部服务器在工具调用中途要求用户补充信息（MCP elicitation）：运行时把它变成问题卡片并等待回答。 */
export type ElicitHandler = (req: {
  message: string
  /** 平铺的 JSON Schema 表单 */
  schema: Record<string, unknown>
}) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>

export interface ExternalToolSource {
  /** 当前可用的外部工具（服务器已启用、工具已启用且策略不是 deny） */
  list(p: Principal): Promise<ExternalToolDescriptor[]>
  /** 调用一个外部工具；返回给模型的文本已按不可信内容包装并限长 */
  call(
    p: Principal,
    name: string,
    args: unknown,
    ctx: { signal: AbortSignal; onElicit: ElicitHandler },
  ): Promise<{ ok: boolean; text: string }>
}
export const EXTERNAL_TOOL_SOURCE = Symbol('qw:agent:external-tools')

/** 一个取出的技能：id 在它所属范围（个人与租户同一张表，平台另一张）里唯一。 */
export interface LoadedSkill {
  id: number
  name: string
  body: string
  tools: string[] | null
  scope: AgentSkillScope
}

/** 按 id 与范围指向的一个技能（自动化的预先同意绑定的是它，不是名字）：只有本人的个人技能与平台技能。 */
export interface AgentSkillRef {
  id: number
  scope: 'user' | 'platform'
}

/**
 * 按名字取技能时的选项：`noTenant` 跳过全租户技能（只取本人的个人技能与平台技能）——自动化的会话没人
 * 实时看着，交给模型的指令只来自创建人本人或平台，别人能改的全租户技能不算。
 */
export interface SkillLookup {
  noTenant?: boolean
}

/** 技能：模型平时只看名字与描述，判断要用时调用内置工具 `skill.load` 取正文。 */
export interface SkillSource {
  listFor(
    p: Principal,
    opts?: SkillLookup,
  ): Promise<{ name: string; description: string; scope: AgentSkillScope }[]>
  /** 按名字取一个可用技能（个人 > 租户 > 平台同名时取更近的）；没有则 null */
  load(p: Principal, name: string, opts?: SkillLookup): Promise<LoadedSkill | null>
  /**
   * 按 id 与范围取一个仍可用的技能：个人的须仍是本人的、启用的，平台的须仍启用；不在、停用、换了主人或
   * 范围的为 null。不按名字取，同名的别的技能遮不住它
   */
  loadRef(p: Principal, ref: AgentSkillRef): Promise<LoadedSkill | null>
}
export const SKILL_SOURCE = Symbol('qw:agent:skills')

/** 系统提示里的说明：平台参数 → 租户说明 → 个人说明与语气。 */
export interface InstructionSource {
  compose(p: Principal): Promise<string>
}
export const INSTRUCTION_SOURCE = Symbol('qw:agent:instructions')

/** 运行时对外提供的操作（会话接口、批量任务都经它启动和推进轮次）。 */
export interface TurnControl {
  /** 发一条消息：没有进行中的轮次就开新一轮；有则按 `mode` 追加（steer）或排队（queue） */
  send(p: Principal, threadId: number, msg: AgentMessageSend): Promise<{ turnId: number }>
  cancel(p: Principal, threadId: number): Promise<void>
  compact(p: Principal, threadId: number): Promise<void>
  decideApproval(
    p: Principal,
    itemId: number,
    body: AgentApprovalDecide,
    source?: 'interactive' | 'batch',
  ): Promise<void>
  answerQuestion(p: Principal, itemId: number, body: AgentQuestionAnswer): Promise<void>
}
export const TURN_CONTROL = Symbol('qw:agent:turn-control')

/** 消息附带的一个文件，已按发送人的读取权限取出并换成模型能用的形式。 */
export interface ResolvedAttachment {
  meta: AgentAttachment
  /** text：文本文件（及表格的第一张表）；image：可交给识图模型的图片；unsupported：只告诉模型文件名 */
  kind: 'text' | 'image' | 'unsupported'
  /** 文本内容，过长时已截断并注明 */
  text?: string
  /** 图片的 `data:` URL */
  imageDataUrl?: string
}

/**
 * 消息附件的来源（由存储模块实现）：按 `fileIds` 的顺序取文件；不存在、已删除、其他租户的或发送人
 * 无权读取的一律 404（BizError NOT_FOUND）。
 */
export interface AttachmentSource {
  resolve(p: Principal, fileIds: number[]): Promise<ResolvedAttachment[]>
}
export const ATTACHMENT_SOURCE = Symbol('qw:agent:attachments')

/**
 * 本人的智能体通知设置的存取（由 iam 模块以个人偏好 `iam_user_pref` 的 `agent.notify` 键实现）：只在当前
 * 租户里读写本人的一行。读出的值未经校验（可能是旧格式），由调用方校验。
 */
export interface AgentNotifyPrefs {
  /** 存的值，未设置为 null */
  getAgentNotify(userId: number): Promise<unknown>
  /** 写入或替换（值过大 413，新键超过个数上限 409） */
  setAgentNotify(userId: number, value: AgentNotifySettings): Promise<void>
}
export const AGENT_NOTIFY_PREFS = Symbol('qw:agent:notify-prefs')

/** 本人可用的一个配置方案（个人的，或全租户共用的）。 */
export interface AgentRunProfile {
  id: number
  name: string
  /** user：本人的个人方案（只有本人能改）；tenant：全租户共用（有权限的人都能改） */
  scope: 'user' | 'tenant'
  providerId: number | null
  model: string | null
  reasoning: 'off' | 'low' | 'medium' | 'high' | null
  approvalMode: AgentApprovalMode
  /** 允许的工具名；null 为不限 */
  tools: string[] | null
  instructions: string | null
}

/**
 * 配置方案的来源（see docs/agent.md）：新建会话时带入模型、推理强度与审批模式，运行时按方案限制工具。
 * 方案被删除、改成别人的个人方案或在别的租户时一律当作没有（null），会话退回默认行为。
 */
export interface ProfileSource {
  /** 本人可用的一个方案；不存在或本人已不能用时为 null */
  find(p: Principal, id: number): Promise<AgentRunProfile | null>
  /** 本人的默认方案：个人默认优先，其次全租户默认；没有为 null */
  defaultFor(p: Principal): Promise<AgentRunProfile | null>
}
export const PROFILE_SOURCE = Symbol('qw:agent:profiles')

// ---- 运行时扩展点：内置工具、上下文贡献者、审批审查者（see docs/agent.md） ----

/** 本次运行所在会话的设置（运行开始时读出）。 */
export interface AgentRunThread {
  id: number
  /** 会话的审批模式 */
  mode: AgentApprovalMode
  planMode: boolean
  /** 只读或计划模式：不提供写入工具 */
  readOnly: boolean
  memoryEnabled: boolean
  profileId: number | null
  /** 子智能体的会话（不进列表） */
  parentThreadId: number | null
  /** 自动化开的会话（不进列表） */
  automationRunId: number | null
  temporary: boolean
}

/** 扩展点拿到的本次运行：发起人（按其权限运行）、会话、轮次、语言与中断信号。 */
export interface AgentRunContext {
  principal: Principal
  thread: AgentRunThread
  turnId: number
  /** 发起人的语言（`zh-CN`、`en-US`） */
  lang: string
  /** 中断、急停、限额时触发；长时间的工作须响应它 */
  signal: AbortSignal
}

/** 内置工具可以写的界面条目（运行时自己的条目——消息、调用、结果、审批、提问——不由工具写）。 */
export const AGENT_TOOL_ITEM_KINDS = ['plan', 'chart', 'image', 'report', 'subagent'] as const
export type AgentToolItemKind = (typeof AGENT_TOOL_ITEM_KINDS)[number]
/** 一个工具条目的载荷序列化后最多这么多字符。 */
export const AGENT_TOOL_ITEM_MAX = 200_000
export type AgentToolItemPayload<K extends AgentToolItemKind> = K extends keyof AgentItemPayloads
  ? AgentItemPayloads[K]
  : Record<string, unknown>

/** 本轮的一个条目（只读视图，不含运行时的内部部分）。 */
export interface AgentToolItem {
  id: number
  kind: AgentItemKind
  status: string | null
  payload: unknown
}

/**
 * 内置工具读写本轮界面条目的入口（经 ItemStore 写入，提交后推送给会话主人）。载荷按该种条目的 schema
 * 校验（不合格抛 ZodError，模型得到校验失败），序列化后不超过 {@link AGENT_TOOL_ITEM_MAX} 字符。
 */
export interface AgentToolItems {
  /** 本轮某一类工具条目，按顺序（只允许五种工具条目） */
  list(kind: AgentToolItemKind): AgentToolItem[]
  /**
   * 追加一个条目，返回它的 id。同一次调用里第 n 次 `add` 按调用 id 与 n 去重：调用重做（重启、丢锁）时
   * 不会多出条目，而是替换上次写下的那一条
   */
  add<K extends AgentToolItemKind>(kind: K, payload: AgentToolItemPayload<K>): Promise<number>
  /** 整体替换本轮一个工具条目的载荷（运行时自己的内部部分保留）；不是本轮的或不是工具条目的抛错 */
  replace<K extends AgentToolItemKind>(id: number, payload: AgentToolItemPayload<K>): Promise<void>
}

/** 内置工具的结果：`content` 交给模型；外部来的文字须标 `untrusted`（模型被告知不照它做）。 */
export interface AgentToolResult {
  ok: boolean
  content: string
  untrusted?: boolean
  error?: { code: string; message: string }
  /** 外部来的、本轮之后可以读取与引用的链接（如子智能体读过或搜到的），计入本轮可读链接 */
  urls?: string[]
}

/** 向会话主人提的问题（与 `ask.user` 同一形状）。 */
export type AgentToolQuestion = AgentItemPayloads['question']['questions'][number]

/** 内置工具要停下等会话主人回答（由 {@link AgentToolContext.ask} 生成，原样返回给运行时）。 */
export interface AgentToolWait {
  readonly wait: 'question'
  readonly questions: AgentToolQuestion[]
}

/** 扩展模型调用的持久入口：先留调用记录，再发上游，统一使用当前轮次与父轮的预算。 */
export interface AgentModelCalls {
  invokeModel<T extends { usage?: AgentModelUsage | null }>(
    target: AgentUsageTarget,
    work: (receipt: { signal: AbortSignal; onUsage(usage: AgentModelUsage): void }) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>
}

/** 内置工具执行时拿到的上下文。 */
export interface AgentToolContext extends AgentRunContext, AgentModelCalls {
  /** 模型这次调用的 id */
  callId: string
  items: AgentToolItems
  /** 本次运行提供给模型的工具（名字与类型，模式、策略与技能清单都已算进去） */
  tools: readonly { name: string; kind: McpToolKind }[]
  /**
   * 兼容旧扩展的事后观测；真正上游调用应使用 invokeModel，才能保留进程中断时的已发出请求。
   * 子任务的当前计量已由持久父轮关联原子汇总，不再事后重复累加。
   */
  recordUsage(
    target: AgentUsageTarget,
    usage: AgentModelUsage,
    opts?: { daily?: boolean; credits?: string | null; failed?: boolean },
  ): Promise<void>
  /** 已发出的收费请求没有可信产物时，持久登记风险并停止本轮，不能让模型再次尝试。 */
  requireRecovery(error?: AgentToolResult['error']): Promise<never>
  /** 本轮积分 或本人、本租户今日积分 已用完时返回是哪一项（此时不该再调用模型），否则 null */
  overBudget(): Promise<'turn_credits' | 'user_daily' | 'tenant_daily' | null>
  /** 本轮可读的链接（用户给的、搜索带回的；与 `web.fetch` 同一份） */
  readableUrls(): Promise<TurnUrls>
  /**
   * 像 `ask.user` 一样停下等会话主人回答：`return ctx.ask(questions)`；回答作为这次调用的结果交给模型
   * （工具不会再被调用）。只给 read 类内置工具用（写入类已经过审批），write 类调用时抛错。
   */
  ask(questions: AgentToolQuestion[]): AgentToolWait
  /** 一个错误码加说明的失败结果（说明按发起人的语言翻译） */
  fail(err: ErrorDef, detail?: string): AgentToolResult
}

/** `@AgentBuiltinTool` 的声明。 */
export interface AgentBuiltinToolMeta<S extends z.ZodObject = z.ZodObject> {
  /** 模型看到的名字，全局唯一（`memory.save`）；与本系统工具重名时内置工具优先 */
  name: string
  title: string
  /** 模型据此判断何时调用 */
  description: string
  /**
   * write：与其他写入工具同一条审批路径（停下等人或经审批审查者），只读与计划模式下不提供，`$技能` 的工具
   * 清单里没有它时也不提供。read：不经审批、可能被重做（重启或丢锁后再执行一次），所以必须幂等；开会话或
   * 调用模型的只读内置工具必须按调用幂等（重做时复用这次调用已经建好的会话、已经生成的结果，不重复花钱）。
   * 两类都受平台的工具开关与策略（`cfg_mcp_tool` 按名字一行）约束
   */
  kind: McpToolKind
  /** 参数，执行前校验；也是模型看到的 JSON Schema */
  input: S
  /**
   * 写入类：只能由人逐次确认（或“信任本会话”）——管理员设的 auto 与 review 都按 ask，也从不交给审批审查者
   * 放行；deny 与平台停用照常有效。用于记住个人信息这类须本人同意的写入
   */
  humanOnly?: boolean
  /** 本次运行是否提供它（缺省总是提供）；`provider` 是声明它的 provider 实例 */
  available?: (ctx: AgentRunContext, provider: unknown) => boolean | Promise<boolean>
}

export const AGENT_BUILTIN_TOOL = 'qw:agent:builtin-tool'

/** 内置工具方法的形状：收到已校验的参数与上下文。 */
export type AgentBuiltinRun<S extends z.ZodObject = z.ZodObject> = (
  input: z.output<S>,
  ctx: AgentToolContext,
) => Promise<AgentToolResult | AgentToolWait> | AgentToolResult | AgentToolWait

/**
 * 把 provider 的一个方法声明为智能体的内置工具（see docs/agent.md）：启动时扫描全部 provider 登记，
 * 名称重复让启动失败。方法收到已校验的参数与 {@link AgentToolContext}，在运行时里执行（不经 MCP 的
 * 令牌与限流）；它按 `ctx.principal` 的身份办事，自己负责权限与数据检查。
 */
export const AgentBuiltinTool =
  <S extends z.ZodObject>(meta: AgentBuiltinToolMeta<S>) =>
  <T extends AgentBuiltinRun<S>>(
    target: object,
    key: string | symbol,
    desc: TypedPropertyDescriptor<T>,
  ): void => {
    SetMetadata(AGENT_BUILTIN_TOOL, meta)(target, key, desc)
  }

/** 上下文贡献者看到的这一次模型请求（`/status` 估算上下文时 `turnId` 为 null）。 */
export interface AgentContextInput extends Omit<AgentRunContext, 'turnId'> {
  turnId: number | null
  /** 最新一条用户消息的文字（还没有时为 null），供挑选相关内容 */
  userText: string | null
}

/** 一段上下文：`id` 是稳定的标识（`memory`、`profile`），`text` 交给模型（超长截断）。 */
export interface AgentContextPart {
  id: string
  text: string
}

/**
 * 上下文贡献者：每次请求模型前按顺序调用，返回的文字作为用户角色的上下文消息放在历史最前面（从不进
 * 系统提示），并计入 `/status` 的上下文估算。失败只记日志、跳过这一段。`turnId` 为 null（`/status` 的估算）
 * 时不得有任何副作用（不写库、不调用模型、不记用量），只读出会给的文字。
 */
export interface AgentContextContributor {
  contribute(ctx: AgentContextInput): Promise<AgentContextPart | null>
}

export const AGENT_CONTEXT_CONTRIBUTOR = 'qw:agent:context-contributor'

/** 把一个 provider 登记为上下文贡献者（类须实现同名接口）；`order` 小的在前，缺省 100。 */
export const AgentContextContributor = (meta: { order?: number } = {}): ClassDecorator =>
  SetMetadata(AGENT_CONTEXT_CONTRIBUTOR, { order: meta.order ?? 100 })

/** 交给审批审查者的一次写入调用：工具、参数、改动预览与来源，从不包括任何工具的输出内容。 */
export interface AgentReviewCall {
  callId: string
  tool: string
  title: string
  /** local：本系统工具；web：联网工具；mcp：外部服务器；builtin：内置工具 */
  origin: 'local' | 'web' | 'mcp' | 'builtin'
  /** 此刻生效的策略（`review`：管理员允许自动审查） */
  policy: 'ask' | 'review'
  args: unknown
  changes?: AgentItemPayloads['approval']['changes']
  /** 本轮联网工具带回的来源：链接与标题来自外部，不可信，只能当数据看 */
  sources: AgentSource[]
}

/**
 * 审查结论：approve 直接执行、reject 告诉模型、escalate 交给人；`by` 说明是谁做的决定。运行时核对 approve
 * 是否有权放行，不符合的降为 escalate 交给人：`review` 要求工具此刻的策略是 `review`、会话此刻的审批模式是
 * `auto_review`；`pre_approved` 只在自动化开的会话里有效。
 */
export interface AgentReviewVerdict {
  verdict: 'approve' | 'reject' | 'escalate'
  reason: string
  by: 'review' | 'pre_approved'
}

/** 一次模型调用的用量（与 ChatModel 报的同一形状）。 */
export type AgentModelUsage = AgentTokenUsage

/** 计费目标由调用前解析的提供方和模型决定，不能按可重名的模型标识事后猜费率。 */
export interface AgentUsageTarget {
  providerId: number
  providerName: string
  model: string
  pricing: AgentModelPricing | null
  kind?: 'chat' | 'image'
}

/** 审查者拿到的本次运行：在运行上下文之外，可以把自己的模型调用记进本轮与发起人的用量。 */
export interface AgentReviewContext extends AgentRunContext, AgentModelCalls {
  /** 兼容旧审查者的事后观测；新调用使用 invokeModel，原始用量与积分统一持久登记。 */
  recordUsage(target: AgentUsageTarget, usage: AgentModelUsage): Promise<void>
  /** 本轮积分 或本人、本租户今日积分 已用完时返回是哪一项（此时不该再调用模型），否则 null */
  overBudget(): Promise<'turn_credits' | 'user_daily' | 'tenant_daily' | null>
}

/**
 * 审批审查者：一个写入调用要停下等人之前按顺序调用；第一个不是 null 的结论生效（escalate 也结束链条：
 * 一个审查者判为要人看的调用，后面的审查者不能再放行），全是 null 时照常出审批卡等人。策略为 deny 的
 * 工具、只读与计划模式、急停时从不调用。审查者须响应 `ctx.signal`：中断时运行时不再等它的结论。
 */
export interface AgentApprovalReviewer {
  review(ctx: AgentReviewContext, call: AgentReviewCall): Promise<AgentReviewVerdict | null>
}

export const AGENT_APPROVAL_REVIEWER = 'qw:agent:approval-reviewer'

/** 把一个 provider 登记为审批审查者（类须实现同名接口）；`order` 小的在前，缺省 100。 */
export const AgentApprovalReviewer = (meta: { order?: number } = {}): ClassDecorator =>
  SetMetadata(AGENT_APPROVAL_REVIEWER, { order: meta.order ?? 100 })

/**
 * 智能体生成的图片的存放处（由存储模块实现，同 {@link AttachmentSource} 的写法）：文件记在发起人名下（私有，
 * 本人可下载），并带一个调用键，同一次工具调用重做时按键找回已存的文件，不再生成一次。
 */
export interface AgentImageStore {
  /** 按调用键找本人已存的图片（带实际宽高，读不出时没有）；没有为 null */
  find(p: Principal, key: string): Promise<AgentStoredImage | null>
  /** 存一张图片（png / jpeg / webp / gif，按内容识别），返回文件 id 与实际宽高；不是图片的内容 422、不建文件 */
  save(p: Principal, key: string, image: { data: Buffer; name: string }): Promise<AgentStoredImage>
  /**
   * 删掉一个会话生成的图片（会话被删除时全部；撤回一轮时只删 `callIds` 这些调用生成的）：调用键以
   * `<会话 id>:<调用 id>` 开头。只在当前租户里删
   */
  drop(threadId: number, callIds?: string[]): Promise<void>
}
export const AGENT_IMAGE_STORE = Symbol('qw:agent:image-store')

/** 存好的一张图片。 */
export interface AgentStoredImage {
  fileId: number
  size?: { width: number; height: number }
}
