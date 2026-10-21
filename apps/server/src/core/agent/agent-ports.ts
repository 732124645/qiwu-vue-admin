import type {
  AgentApprovalDecide,
  AgentAttachment,
  AgentMessageSend,
  AgentQuestionAnswer,
  AgentSkillScope,
} from '@qiwu/shared'
import type { Principal } from '../auth/principal.js'

/**
 * 智能体内部各部分之间的接口（see docs/agent.md）：运行时只依赖这里的形状，外部 MCP、技能与说明、
 * 批量任务各自实现并以注入令牌提供，互相不直接引用实现类。
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
  /** 管理员为它设的审批策略（外部工具一律视为可能写入：只有管理员显式设为 auto 才直接执行） */
  policy: 'auto' | 'ask' | 'deny'
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

/** 技能：模型平时只看名字与描述，判断要用时调用内置工具 `skill.load` 取正文。 */
export interface SkillSource {
  listFor(p: Principal): Promise<{ name: string; description: string; scope: AgentSkillScope }[]>
  /** 按名字取一个可用技能（个人 > 租户 > 平台同名时取更近的）；没有则 null */
  load(
    p: Principal,
    name: string,
  ): Promise<{ name: string; body: string; tools: string[] | null } | null>
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
  decideApproval(p: Principal, itemId: number, body: AgentApprovalDecide): Promise<void>
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
