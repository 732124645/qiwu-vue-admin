import { Column, Entity } from 'typeorm'
import type { AgentModelPricing, AgentTokenUsage } from '@qiwu/shared'
import { BaseEntity } from '../../db/base.entity.js'
import { TenantColumn } from '../../db/tenant-filter.js'

/** 每租户、用户、UTC 日、提供方及精确模型一行的用量，供预算与用量页读取。 */
@Entity('agent_usage')
export class AgentUsage extends BaseEntity {
  /** 用户 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 日期（UTC，YYYY-MM-DD） */
  @Column({ type: 'date' })
  day: string

  /** 模型名 */
  @Column({ length: 128, collation: 'utf8mb4_bin' })
  model: string

  /** 提供方身份；0 仅用于升级前无法确定来源的历史累计。 */
  @Column({ name: 'provider_id', type: 'bigint', unsigned: true, default: 0 })
  providerId: number

  @Column({ name: 'provider_name', type: 'varchar', length: 64, nullable: true })
  providerName: string | null

  /** 模型调用次数 */
  @Column({ type: 'int', default: 0 })
  calls: number

  /** 输入 token 数（bigint：按数字读出，单行不会超出安全整数） */
  @Column({ name: 'prompt_tokens', type: 'bigint', unsigned: true, default: 0 })
  promptTokens: number

  /** 输出 token 数 */
  @Column({ name: 'completion_tokens', type: 'bigint', unsigned: true, default: 0 })
  completionTokens: number

  /** 已完成计价的积分；未计价与历史调用另列，不把未知金额混成免费。 */
  @Column({ type: 'decimal', precision: 24, scale: 6, default: '0' })
  credits: string

  @Column({ name: 'cache_read_tokens', type: 'bigint', unsigned: true, nullable: true })
  cacheReadTokens: number | null

  @Column({ name: 'cache_write_tokens', type: 'bigint', unsigned: true, nullable: true })
  cacheWriteTokens: number | null

  @Column({ name: 'reasoning_tokens', type: 'bigint', unsigned: true, nullable: true })
  reasoningTokens: number | null

  @Column({ name: 'unpriced_calls', type: 'int', unsigned: true, default: 0 })
  unpricedCalls: number

  @Column({ name: 'unreported_calls', type: 'int', unsigned: true, default: 0 })
  unreportedCalls: number

  @Column({ name: 'legacy_calls', type: 'int', unsigned: true, default: 0 })
  legacyCalls: number

  @TenantColumn()
  tenantId: number
}

/** 每次模型调用的不可变计量明细：保留提供方、当次费率和实际报告，不按新费率重算历史。 */
@Entity('agent_usage_entry')
export class AgentUsageEntry extends BaseEntity {
  /** 调用发出前先登记；进程退出后仍保留未完成尝试，不能伪造零用量。 */
  @Column({ type: 'varchar', length: 16, default: 'complete' })
  status: 'pending' | 'complete' | 'unknown'

  @Column({ name: 'lease_until', type: 'datetime', precision: 3, nullable: true })
  leaseUntil: Date | null

  @Column({ name: 'settled_at', type: 'datetime', precision: 3, nullable: true })
  settledAt: Date | null

  /** 单次调用跨日仍归开始时的 UTC 日，未知尝试也有明确归属。 */
  @Column({ name: 'usage_day', type: 'date', nullable: true })
  usageDay: string | null

  @Column({ name: 'parent_turn_id', type: 'bigint', unsigned: true, nullable: true })
  parentTurnId: number | null

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'provider_id', type: 'bigint', unsigned: true })
  providerId: number

  @Column({ name: 'provider_name', type: 'varchar', length: 64 })
  providerName: string

  @Column({ type: 'varchar', length: 128, collation: 'utf8mb4_bin' })
  model: string

  @Column({ name: 'thread_id', type: 'bigint', unsigned: true, nullable: true })
  threadId: number | null

  @Column({ name: 'turn_id', type: 'bigint', unsigned: true, nullable: true })
  turnId: number | null

  @Column({ type: 'varchar', length: 16, default: 'chat' })
  kind: 'chat' | 'image'

  @Column({ name: 'usage_json', type: 'json', nullable: true })
  usage: AgentTokenUsage | null

  @Column({ type: 'json', nullable: true })
  pricing: AgentModelPricing | null

  @Column({ type: 'decimal', precision: 24, scale: 6, nullable: true })
  credits: string | null

  @Column({ name: 'usage_reported', type: 'boolean', default: false })
  usageReported: boolean

  @TenantColumn()
  tenantId: number
}
