import type { AGENT_TONES } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../db/base.entity.js'
import { TenantColumn } from '../../db/tenant-filter.js'

/** `agent_platform_skill`：平台技能（平台表，所有租户可用），正文是说明文字，不含可执行代码 */
@Entity('agent_platform_skill')
export class AgentPlatformSkill extends BaseEntity {
  /** 技能名（`$技能名` 调用） */
  @Column({ length: 64 })
  name: string

  /** 何时使用（智能体据此选择） */
  @Column({ length: 512 })
  description: string

  /** 技能正文 */
  @Column({ type: 'mediumtext' })
  body: string

  /** 允许使用的工具名；null 为不限 */
  @Column({ type: 'json', nullable: true })
  tools: string[] | null

  /** 是否启用 */
  @Column({ type: 'boolean', default: true })
  enabled: boolean
}

/** `agent_skill`：租户与个人的技能；`ownerUserId` 为 0 是全租户共用 */
@Entity('agent_skill')
export class AgentSkill extends BaseEntity {
  /** 所属用户 ID（0 为全租户共用） */
  @Column({ name: 'owner_user_id', type: 'bigint', unsigned: true, default: 0 })
  ownerUserId: number

  /** 技能名（`$技能名` 调用） */
  @Column({ length: 64 })
  name: string

  /** 何时使用（智能体据此选择） */
  @Column({ length: 512 })
  description: string

  /** 技能正文 */
  @Column({ type: 'mediumtext' })
  body: string

  /** 允许使用的工具名；null 为不限 */
  @Column({ type: 'json', nullable: true })
  tools: string[] | null

  /** 是否启用 */
  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @TenantColumn()
  tenantId: number
}

/** `agent_instruction`：租户说明与个人说明（`ownerUserId` 为 0 是租户说明），拼进系统提示 */
@Entity('agent_instruction')
export class AgentInstruction extends BaseEntity {
  /** 所属用户 ID（0 为租户说明） */
  @Column({ name: 'owner_user_id', type: 'bigint', unsigned: true, default: 0 })
  ownerUserId: number

  /** 说明正文 */
  @Column({ type: 'text' })
  body: string

  /** 回答语气预设（仅个人说明） */
  @Column({ type: 'varchar', length: 16, nullable: true })
  tone: (typeof AGENT_TONES)[number] | null

  @TenantColumn()
  tenantId: number
}

/** `agent_prompt`：提示词模板，个人（`ownerUserId` 记本人）或全租户共用（0） */
@Entity('agent_prompt')
export class AgentPrompt extends BaseEntity {
  /** 所属用户 ID（0 为全租户共用） */
  @Column({ name: 'owner_user_id', type: 'bigint', unsigned: true, default: 0 })
  ownerUserId: number

  /** 模板名 */
  @Column({ length: 64 })
  name: string

  /** 模板内容 */
  @Column({ type: 'text' })
  body: string

  @TenantColumn()
  tenantId: number
}
