import type {
  AGENT_AUTOMATION_RUN_STATUSES,
  AGENT_AUTOMATION_TRIGGERS,
  AGENT_AUTOMATION_WRITE_MODES,
  AgentAutomationEvent,
} from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import type { AgentSkillRef } from '../agent-ports.js'
import { BaseEntity } from '../../db/base.entity.js'
import { TenantColumn } from '../../db/tenant-filter.js'

/**
 * 预先同意的一个写入工具：工具名、同意的时间与凭据——同意时与这个工具有关的生效事实的摘要（`facts`，含
 * 技能正文与方案说明）、工具平台开关行的值（`switch`）；此刻重算的与之不同即作废。`skill` 是同意时自动化
 * 绑定的技能（按 id 与范围，运行时按它取，不按名字；没有技能为 null）。
 */
export interface PreApprovedTool {
  tool: string
  at: string
  facts: string
  switch: string
  skill?: AgentSkillRef | null
}

/** `agent_automation`：定时、业务事件或手动触发的技能 / 提示词，以所属用户（创建人）的身份运行 */
@Entity('agent_automation')
export class AgentAutomation extends BaseEntity {
  /** 所属用户 ID（以其身份运行） */
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  /** 名称 */
  @Column({ length: 100 })
  name: string

  /** 是否启用 */
  @Column({ type: 'boolean', default: true })
  enabled: boolean

  /** 是否全租户共享 */
  @Column({ type: 'boolean', default: false })
  shared: boolean

  /** 触发方式（schedule、event、manual） */
  @Column({ name: 'trigger_kind', type: 'varchar', length: 16 })
  triggerKind: (typeof AGENT_AUTOMATION_TRIGGERS)[number]

  /** cron 表达式（定时） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  cron: string | null

  /** 时区（定时） */
  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone: string | null

  /** 触发事件（操作日志的领域、动作） */
  @Column({ type: 'json', nullable: true })
  event: AgentAutomationEvent | null

  /** 执行的技能名 */
  @Column({ type: 'varchar', length: 64, nullable: true })
  skill: string | null

  /** 提示词 */
  @Column({ type: 'text', nullable: true })
  prompt: string | null

  /** 配置方案 ID */
  @Column({ name: 'profile_id', type: 'bigint', unsigned: true, nullable: true })
  profileId: number | null

  /** 写入模式 */
  @Column({ name: 'write_mode', type: 'varchar', length: 16, default: 'read_only' })
  writeMode: (typeof AGENT_AUTOMATION_WRITE_MODES)[number]

  /** 预先同意的写入工具（及同意时间） */
  @Column({ name: 'pre_approved', type: 'json', nullable: true })
  preApproved: PreApprovedTool[] | null

  /** 结果通知方式 */
  @Column({ type: 'json', nullable: true })
  notify: { inbox: boolean; mail: boolean } | null

  /** 最近运行时间（UTC） */
  @Column({ name: 'last_run_at', type: 'datetime', precision: 3, nullable: true })
  lastRunAt: Date | null

  /** 下次运行时间（UTC） */
  @Column({ name: 'next_run_at', type: 'datetime', precision: 3, nullable: true })
  nextRunAt: Date | null

  @TenantColumn()
  tenantId: number
}

/** `agent_automation_run`：自动化的一次运行（触发来源、隐藏会话、结果摘要） */
@Entity('agent_automation_run')
export class AgentAutomationRun extends BaseEntity {
  /** 自动化 ID */
  @Column({ name: 'automation_id', type: 'bigint', unsigned: true })
  automationId: number

  /** 运行用的会话 ID */
  @Column({ name: 'thread_id', type: 'bigint', unsigned: true, nullable: true })
  threadId: number | null

  /** 触发方式 */
  @Column({ name: 'trigger_kind', type: 'varchar', length: 16 })
  triggerKind: (typeof AGENT_AUTOMATION_TRIGGERS)[number]

  /** 触发事件内容（领域、动作、记录 ID） */
  @Column({ type: 'json', nullable: true })
  event: (AgentAutomationEvent & { bizId?: string | null }) | null

  /** 状态 */
  @Column({ type: 'varchar', length: 16, default: 'running' })
  status: (typeof AGENT_AUTOMATION_RUN_STATUSES)[number]

  /** 结果摘要 */
  @Column({ type: 'text', nullable: true })
  summary: string | null

  /** 失败或跳过的原因代码 */
  @Column({ name: 'error_code', type: 'varchar', length: 32, nullable: true })
  errorCode: string | null

  /** 开始时间（UTC） */
  @Column({ name: 'started_at', type: 'datetime', precision: 3 })
  startedAt: Date

  /** 结束时间（UTC） */
  @Column({ name: 'ended_at', type: 'datetime', precision: 3, nullable: true })
  endedAt: Date | null

  @TenantColumn()
  tenantId: number
}
