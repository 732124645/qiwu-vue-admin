import type { AGENT_SEARCH_KINDS } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import type { Sealed } from '../../crypto/secret-box.js'
import { BaseEntity } from '../../db/base.entity.js'

/** A model of a provider as stored in `agent_provider.models`. */
export interface ProviderModel {
  id: string
  label?: string
  reasoning: boolean
  /** 模型能读图片 */
  vision?: boolean
  /** 作为“快速”选项提供 */
  fast?: boolean
  /** 图片模型：作为内置工具 `image.generate` 提供给智能体 */
  image?: boolean
  contextWindow: number
}

/**
 * `agent_provider`：模型提供方（平台表，所有租户共用）。密钥是 AES-GCM 密文（见 provider-settings），
 * 默认不查出，接口只回 `hasKey`。
 */
@Entity('agent_provider')
export class AgentProvider extends BaseEntity {
  @Column({ length: 64 })
  name: string

  /** 接口类型；目前只有 `openai-compatible` */
  @Column({ type: 'varchar', length: 24, default: 'openai-compatible' })
  kind: string

  @Column({ name: 'base_url', length: 512 })
  baseUrl: string

  /** 密钥密文；只在需要时 `addSelect('t.apiKey')` */
  @Column({ name: 'api_key', type: 'json', nullable: true, select: false })
  apiKey?: Sealed | null

  @Column({ type: 'json' })
  models: ProviderModel[]

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean

  @Column({ type: 'int', default: 0 })
  sort: number
}

/** `agent_search_provider`：联网搜索服务商（平台表）；密钥同上。 */
@Entity('agent_search_provider')
export class AgentSearchProvider extends BaseEntity {
  @Column({ type: 'varchar', length: 24 })
  kind: (typeof AGENT_SEARCH_KINDS)[number]

  @Column({ length: 64 })
  name: string

  /** 密钥密文；只在需要时 `addSelect('t.apiKey')` */
  @Column({ name: 'api_key', type: 'json', nullable: true, select: false })
  apiKey?: Sealed | null

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean
}
