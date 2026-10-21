import type { AGENT_MCP_AUTH_KINDS, AgentToolPolicy } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../db/base.entity.js'
import type { Sealed } from '../../crypto/secret-box.js'

/** `agent_mcp_server`：外部 MCP 服务器（平台表）；鉴权信息加密存储、只写不读，返回内容一律不可信 */
@Entity('agent_mcp_server')
export class AgentMcpServer extends BaseEntity {
  /** 名称 */
  @Column({ length: 64 })
  name: string

  /** Streamable HTTP 地址 */
  @Column({ length: 512 })
  url: string

  /** 鉴权方式（none、header、oauth） */
  @Column({ name: 'auth_kind', type: 'varchar', length: 16, default: 'none' })
  authKind: (typeof AGENT_MCP_AUTH_KINDS)[number]

  /** 鉴权信息（secret-box 密文）；列表读取时不取 */
  @Column({ name: 'auth_secret', type: 'json', nullable: true, select: false })
  authSecret?: Sealed | null

  /** 是否允许内网地址（root 显式勾选） */
  @Column({ name: 'allow_private', type: 'boolean', default: false })
  allowPrivate: boolean

  /** 是否启用 */
  @Column({ type: 'boolean', default: true })
  enabled: boolean

  /** 最近连接状态（unknown、ok、error） */
  @Column({ type: 'varchar', length: 16, default: 'unknown' })
  status: 'unknown' | 'ok' | 'error'

  /** 最近一次连接错误 */
  @Column({ name: 'last_error', type: 'varchar', length: 512, nullable: true })
  lastError: string | null

  /** 最近同步工具列表的时间（UTC） */
  @Column({ name: 'synced_at', type: 'datetime', precision: 3, nullable: true })
  syncedAt: Date | null
}

/** `agent_mcp_tool`：外部 MCP 服务器上发现的工具（平台表）；新发现的默认停用、默认需要确认 */
@Entity('agent_mcp_tool')
export class AgentMcpTool extends BaseEntity {
  /** 所属服务器 ID */
  @Column({ name: 'server_id', type: 'bigint', unsigned: true })
  serverId: number

  /** 服务器上的工具名 */
  @Column({ length: 128 })
  name: string

  /** 标题 */
  @Column({ type: 'varchar', length: 200, nullable: true })
  title: string | null

  /** 描述（来自服务器，不可信） */
  @Column({ type: 'text', nullable: true })
  description: string | null

  /** 参数 JSON Schema（来自服务器） */
  @Column({ name: 'input_schema', type: 'json', nullable: true })
  inputSchema: Record<string, unknown> | null

  /** 服务器声明为只读（不可信，仅供参考） */
  @Column({ name: 'read_only_hint', type: 'boolean', default: false })
  readOnlyHint: boolean

  /** 是否启用 */
  @Column({ type: 'boolean', default: false })
  enabled: boolean

  /** 审批策略（auto、ask、deny） */
  @Column({ type: 'varchar', length: 8, default: 'ask' })
  policy: AgentToolPolicy
}
