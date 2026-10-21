import type {
  AgentApprovalMode,
  AgentContext,
  AgentItemKind,
  AgentTurnStatus,
  AGENT_ITEM_STATUSES,
  AGENT_REASONING,
  AGENT_THREAD_STATUSES,
} from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../db/base.entity.js'
import { TenantColumn } from '../../db/tenant-filter.js'

/** `agent_thread`：智能体会话（每个会话属于一个用户，别人的会话一律 404） */
@Entity('agent_thread')
export class AgentThread extends BaseEntity {
  /** 所属用户 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 标题 */
  @Column({ length: 200 })
  title: string

  /** 状态（active、archived） */
  @Column({ type: 'varchar', length: 16, default: 'active' })
  status: (typeof AGENT_THREAD_STATUSES)[number]

  /** 模型提供方 ID */
  @Column({ name: 'provider_id', type: 'bigint', unsigned: true, nullable: true })
  providerId: number | null

  /** 模型名 */
  @Column({ type: 'varchar', length: 128, nullable: true })
  model: string | null

  /** 推理强度 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  reasoning: (typeof AGENT_REASONING)[number] | null

  /** 审批模式（read_only、ask、trust） */
  @Column({ name: 'approval_mode', type: 'varchar', length: 16, default: 'ask' })
  approvalMode: AgentApprovalMode

  /** 计划模式（先出计划、只读） */
  @Column({ name: 'plan_mode', type: 'boolean', default: false })
  planMode: boolean

  /** 是否置顶 */
  @Column({ type: 'boolean', default: false })
  pinned: boolean

  /** 临时会话（不进列表，关闭即删） */
  @Column({ type: 'boolean', default: false })
  temporary: boolean

  /** 所属用户已读到的条目序号 */
  @Column({ name: 'read_seq', type: 'int', default: 0 })
  readSeq: number

  /** 只读分享令牌（同租户内有效）；列表读取时不取 */
  @Column({ name: 'share_token', type: 'char', length: 32, nullable: true, select: false })
  shareToken?: string | null

  /** 信任本会话时已确认过的操作（工具名 + 目标） */
  @Column({ type: 'json', nullable: true })
  trusted: string[] | null

  /** 分叉来源会话 ID */
  @Column({ name: 'forked_from_id', type: 'bigint', unsigned: true, nullable: true })
  forkedFromId: number | null

  /** 所属批次 ID */
  @Column({ name: 'batch_id', type: 'bigint', unsigned: true, nullable: true })
  batchId: number | null

  /** 批量或页面上下文的目标记录（如 `demo.customer:12`） */
  @Column({ name: 'target_ref', type: 'varchar', length: 128, nullable: true })
  targetRef: string | null

  /** 发起时的页面上下文 */
  @Column({ type: 'json', nullable: true })
  context: AgentContext | null

  /** 压缩后的早期对话摘要 */
  @Column({ type: 'mediumtext', nullable: true })
  summary: string | null

  /** 摘要覆盖到的条目序号 */
  @Column({ name: 'summary_seq', type: 'int', default: 0 })
  summarySeq: number

  /** 最近活动时间（UTC） */
  @Column({ name: 'last_active_at', type: 'datetime', precision: 3, nullable: true })
  lastActiveAt: Date | null

  @TenantColumn()
  tenantId: number
}

/** `agent_turn`：一轮 = 用户一句话到智能体答完（中间可能停下等审批） */
@Entity('agent_turn')
export class AgentTurn extends BaseEntity {
  /** 所属会话 ID */
  @Column({ name: 'thread_id', type: 'bigint', unsigned: true })
  threadId: number

  /** 发起人 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 状态（running、waiting、completed、failed、cancelled） */
  @Column({ type: 'varchar', length: 16, default: 'running' })
  status: AgentTurnStatus

  /** 已执行步数 */
  @Column({ type: 'int', default: 0 })
  steps: number

  /** 输入 token 数 */
  @Column({ name: 'prompt_tokens', type: 'int', default: 0 })
  promptTokens: number

  /** 输出 token 数 */
  @Column({ name: 'completion_tokens', type: 'int', default: 0 })
  completionTokens: number

  /** 失败原因代码 */
  @Column({ name: 'error_code', type: 'varchar', length: 32, nullable: true })
  errorCode: string | null

  /** 失败说明 */
  @Column({ name: 'error_msg', type: 'varchar', length: 512, nullable: true })
  errorMsg: string | null

  /** 开始时间（UTC） */
  @Column({
    name: 'started_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  startedAt: Date

  /** 结束时间（UTC） */
  @Column({ name: 'ended_at', type: 'datetime', precision: 3, nullable: true })
  endedAt: Date | null

  @TenantColumn()
  tenantId: number
}

/** `agent_item`：会话条目，按会话内顺序号排列；模型上下文与页面都从这里恢复 */
@Entity('agent_item')
export class AgentItem extends BaseEntity {
  /** 所属会话 ID */
  @Column({ name: 'thread_id', type: 'bigint', unsigned: true })
  threadId: number

  /** 所属轮次 ID */
  @Column({ name: 'turn_id', type: 'bigint', unsigned: true, nullable: true })
  turnId: number | null

  /** 会话内顺序号 */
  @Column({ type: 'int' })
  seq: number

  /** 类型（user、assistant、tool_call、tool_result、approval、plan、error） */
  @Column({ type: 'varchar', length: 16 })
  kind: AgentItemKind

  /** 工具调用与审批的状态 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  status: (typeof AGENT_ITEM_STATUSES)[number] | null

  /** 内容（按类型见 AgentItemPayloads；工具返回的内容不可信） */
  @Column({ type: 'json' })
  payload: unknown

  /** 可检索的纯文本（用户与智能体的消息；全文索引 ngram） */
  @Column({ type: 'mediumtext', nullable: true })
  text: string | null

  @TenantColumn()
  tenantId: number
}

/** `agent_feedback`：对回答的点赞点踩与文字反馈，带 traceId 便于排查 */
@Entity('agent_feedback')
export class AgentFeedback extends BaseEntity {
  /** 会话 ID */
  @Column({ name: 'thread_id', type: 'bigint', unsigned: true })
  threadId: number

  /** 被评价的条目 ID */
  @Column({ name: 'item_id', type: 'bigint', unsigned: true })
  itemId: number

  /** 反馈人 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 评价（1 赞、-1 踩） */
  @Column({ type: 'tinyint' })
  rating: 1 | -1

  /** 文字反馈 */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  comment: string | null

  /** 追踪 ID */
  @Column({ name: 'trace_id', type: 'varchar', length: 64, nullable: true })
  traceId: string | null

  @TenantColumn()
  tenantId: number
}

/** `agent_batch`：列表里选中多条记录批量执行一个技能，每条一个会话 */
@Entity('agent_batch')
export class AgentBatch extends BaseEntity {
  /** 发起人 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 执行的技能名 */
  @Column({ name: 'skill_name', length: 64 })
  skillName: string

  /** 目标数据类型（如 demo.customer） */
  @Column({ length: 64 })
  target: string

  /** 状态（running、completed、cancelled） */
  @Column({ type: 'varchar', length: 16, default: 'running' })
  status: 'running' | 'completed' | 'cancelled'

  /** 目标总数 */
  @Column({ type: 'int', default: 0 })
  total: number

  /** 已完成数 */
  @Column({ type: 'int', default: 0 })
  finished: number

  /** 失败数 */
  @Column({ type: 'int', default: 0 })
  failed: number

  @TenantColumn()
  tenantId: number
}
