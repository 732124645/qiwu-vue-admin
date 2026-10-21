import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../db/base.entity.js'
import { TenantColumn } from '../../db/tenant-filter.js'

/** `agent_usage`：每用户、每天（UTC）、每模型一行的用量；限额与用量页都读它 */
@Entity('agent_usage')
export class AgentUsage extends BaseEntity {
  /** 用户 ID */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 日期（UTC，YYYY-MM-DD） */
  @Column({ type: 'date' })
  day: string

  /** 模型名 */
  @Column({ length: 128 })
  model: string

  /** 模型调用次数 */
  @Column({ type: 'int', default: 0 })
  calls: number

  /** 输入 token 数（bigint：按数字读出，单行不会超出安全整数） */
  @Column({ name: 'prompt_tokens', type: 'bigint', unsigned: true, default: 0 })
  promptTokens: number

  /** 输出 token 数 */
  @Column({ name: 'completion_tokens', type: 'bigint', unsigned: true, default: 0 })
  completionTokens: number

  @TenantColumn()
  tenantId: number
}
