import type { AgentApprovalMode, AGENT_REASONING } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../db/base.entity.js'
import { TenantColumn } from '../../db/tenant-filter.js'

/** `agent_profile`：配置方案，个人（`ownerUserId` 记本人）或全租户共用（0） */
@Entity('agent_profile')
export class AgentProfile extends BaseEntity {
  /** 所属用户 ID（0 为全租户共用） */
  @Column({ name: 'owner_user_id', type: 'bigint', unsigned: true, default: 0 })
  ownerUserId: number

  /** 名称 */
  @Column({ length: 64 })
  name: string

  /** 模型提供方 ID */
  @Column({ name: 'provider_id', type: 'bigint', unsigned: true, nullable: true })
  providerId: number | null

  /** 模型名 */
  @Column({ type: 'varchar', length: 128, nullable: true })
  model: string | null

  /** 推理强度 */
  @Column({ type: 'varchar', length: 16, nullable: true })
  reasoning: (typeof AGENT_REASONING)[number] | null

  /** 审批模式 */
  @Column({ name: 'approval_mode', type: 'varchar', length: 16, default: 'ask' })
  approvalMode: AgentApprovalMode

  /** 允许的工具名；null 为不限 */
  @Column({ type: 'json', nullable: true })
  tools: string[] | null

  /** 额外说明 */
  @Column({ type: 'text', nullable: true })
  instructions: string | null

  /** 是否为默认（个人方案：本人默认；全租户方案：本租户默认） */
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean

  @TenantColumn()
  tenantId: number
}

/** `agent_memory`：记忆条目，只属于本人 */
@Entity('agent_memory')
export class AgentMemory extends BaseEntity {
  /** 所属用户 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 记忆内容（已遮蔽密钥类内容） */
  @Column({ length: 1000 })
  content: string

  /** 来源（chat 对话中保存、extract 后台提炼、manual 手工） */
  @Column({ type: 'varchar', length: 16, default: 'chat' })
  source: 'chat' | 'extract' | 'manual'

  /** 来源会话 ID */
  @Column({ name: 'source_thread_id', type: 'bigint', unsigned: true, nullable: true })
  sourceThreadId: number | null

  /** 最近一次放进上下文的时间（UTC） */
  @Column({ name: 'last_used_at', type: 'datetime', precision: 3, nullable: true })
  lastUsedAt: Date | null

  @TenantColumn()
  tenantId: number
}
