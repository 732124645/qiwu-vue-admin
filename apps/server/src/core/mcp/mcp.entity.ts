import type { AgentToolPolicy } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../db/base.entity.js'
import { TenantColumn } from '../db/tenant-filter.js'

/** `iam_access_token`：个人访问令牌（智能体接入），库里只有摘要与末几位 */
@Entity('iam_access_token')
export class AccessToken extends BaseEntity {
  /** 所属用户 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 令牌名称 */
  @Column({ length: 64 })
  name: string

  /** 令牌 SHA-256 摘要（hex）；读列表时不取 */
  @Column({ name: 'token_digest', type: 'char', length: 64, select: false })
  tokenDigest?: string

  /** 令牌末尾几位（展示用） */
  @Column({ name: 'token_hint', length: 16 })
  tokenHint: string

  /** 允许的工具名；null 为全部工具（含以后新增的），写入类工具仍须允许写入 */
  @Column({ type: 'json', nullable: true })
  tools: string[] | null

  /** 是否允许写入类工具 */
  @Column({ name: 'allow_write', type: 'boolean', default: false })
  allowWrite: boolean

  /** 到期时间（UTC）；null 为不过期 */
  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: true })
  expiresAt: Date | null

  /** 最近使用时间（UTC） */
  @Column({ name: 'last_used_at', type: 'datetime', precision: 3, nullable: true })
  lastUsedAt: Date | null

  /** 吊销时间（UTC）；吊销后永久失效 */
  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null

  @TenantColumn()
  tenantId: number
}

/** `cfg_mcp_tool`：平台对工具的整体停用（平台表；没有行的工具按启用处理） */
@Entity('cfg_mcp_tool')
export class McpToolSwitch extends BaseEntity {
  /** 工具名 */
  @Column({ length: 96 })
  name: string

  /** 是否启用 */
  @Column({ type: 'boolean', default: true })
  enabled: boolean

  /** 后台智能体里的审批策略（auto、ask、deny）；null 为按类型默认：只读 auto、写入 ask */
  @Column({ name: 'agent_policy', type: 'varchar', length: 8, nullable: true })
  agentPolicy: AgentToolPolicy | null
}
