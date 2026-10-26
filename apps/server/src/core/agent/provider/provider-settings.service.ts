import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type AgentProviderSave,
  type AgentProviderVo,
  type AgentSearchProviderSave,
  type AgentSearchProviderVo,
  Err,
} from '@qiwu/shared'
import { type FindOptionsWhere, In, Not, type ObjectLiteral } from 'typeorm'
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity.js'
import { AppConfigService } from '../../config/config.module.js'
import { deriveKey, open, type Sealed, seal } from '../../crypto/secret-box.js'
import { BaseCrudService } from '../../db/base-crud.service.js'
import { BizError } from '../../http/biz-error.js'
import { AgentProvider, AgentSearchProvider } from './provider.entity.js'

/**
 * 智能体密钥专用的加密密钥：与 SecretBox 同源（APP_SECRET），但 HKDF 标签独立，
 * 换了标签或 APP_SECRET 旧密文就打不开，要重新填密钥。
 */
const KEY_INFO = 'qw:agent-provider-key:v1'

type Keyed = ObjectLiteral & {
  id: number
  name: string
  isDefault: boolean
  apiKey?: Sealed | null
}

/**
 * 两张“带密钥的平台配置表”共用的写法：密钥只写不读（存 AES-GCM 密文，AAD 为表名，换表打不开），
 * 不填或填空保留原密钥；每张表只有一个默认，设默认时同一事务里清掉其他行的默认。
 */
abstract class KeyedSettings<E extends Keyed> extends BaseCrudService<E> {
  private readonly key: Buffer

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    entity: new () => E,
    cfg: AppConfigService,
    private readonly table: string,
  ) {
    super(txHost, entity)
    this.key = deriveKey(cfg.get('APP_SECRET'), '', KEY_INFO)
  }

  /** 保留原密钥时，改了哪些字段就必须重新填密钥（否则原密钥会被发到新的目标）。 */
  protected abstract keyBoundChanged(stored: E, dto: Partial<E>): boolean

  /** 全部行（含密文，供 `hasKey` 与解密；密文从不离开服务）。 */
  protected rowsWithKey(order: Record<string, 'ASC' | 'DESC'>): Promise<E[]> {
    return this.repo.createQueryBuilder('t').addSelect('t.apiKey').orderBy(order).getMany()
  }

  /** 一行（含密文）；不存在 404。 */
  protected async rowWithKey(id: number): Promise<E> {
    const row = await this.repo
      .createQueryBuilder('t')
      .addSelect('t.apiKey')
      .where('t.id = :id', { id })
      .getOne()
    if (!row) throw new BizError(Err.NOT_FOUND)
    return row
  }

  /**
   * 新建（id 为 null）或整体修改一行：锁行 → 校验名称唯一、改了目标须重填密钥 → 写入（有新密钥才换密文）
   * → 设为默认时清掉其他行的默认，全部在一个事务里。
   */
  protected saveRow(
    id: number | null,
    dto: Partial<Omit<E, 'apiKey'>> & { apiKey?: string },
  ): Promise<E> {
    return this.txHost.withTransaction(async () => {
      const { apiKey, ...rest } = dto
      const fields = rest as Partial<E>
      const newKey = apiKey ? seal(this.key, apiKey, this.table) : undefined
      if (id !== null) {
        await this.lockScopedIds([id])
        const stored = await this.rowWithKey(id)
        if (stored.apiKey && !newKey && this.keyBoundChanged(stored, fields))
          throw new BizError(Err.AGENT_KEY_REQUIRED)
      }
      await this.assertUnique('name', fields.name as E['name'], id ?? undefined)
      if (id === null) {
        id = (await this.create({ ...fields, apiKey: newKey ?? null } as E)).id
      } else {
        await this.update(id, {
          ...fields,
          ...(newKey ? { apiKey: newKey } : {}),
        } as QueryDeepPartialEntity<E>)
      }
      if (fields.isDefault)
        await this.repo.update(
          { id: Not(id), isDefault: true } as FindOptionsWhere<E>,
          { isDefault: false } as unknown as QueryDeepPartialEntity<E>,
        )
      return this.rowWithKey(id)
    })
  }

  /** 删除时连同密文一起清掉：软删的行不再留着可用的密钥。 */
  protected override async deleteRows(ids: readonly number[]): Promise<void> {
    await this.repo.update(
      { id: In([...ids]) } as FindOptionsWhere<E>,
      {
        apiKey: null,
      } as unknown as QueryDeepPartialEntity<E>,
    )
    await super.deleteRows(ids)
  }

  /** 解出明文密钥；没有密钥为 null；打不开（APP_SECRET 变了、被改过）报提供方失败。 */
  openKey(row: E): string | null {
    if (!row.apiKey) return null
    const key = open(this.key, row.apiKey, this.table)
    if (key === null) throw new BizError(Err.AGENT_PROVIDER_FAILED, { reason: 'key_unreadable' })
    return key
  }
}

/** 模型提供方的平台配置（`/api/agent/providers`）。 */
@Injectable()
export class ProviderSettingsService extends KeyedSettings<AgentProvider> {
  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>, cfg: AppConfigService) {
    super(txHost, AgentProvider, cfg, 'agent_provider')
  }

  /** 改了接口地址：原密钥不能跟着发到新地址。 */
  protected keyBoundChanged(stored: AgentProvider, dto: Partial<AgentProvider>): boolean {
    return dto.baseUrl !== undefined && dto.baseUrl !== stored.baseUrl
  }

  /** 全部提供方（含停用），默认在前，再按排序与 id。 */
  rows(): Promise<AgentProvider[]> {
    return this.rowsWithKey({ 't.isDefault': 'DESC', 't.sort': 'ASC', 't.id': 'ASC' })
  }

  async list(): Promise<AgentProviderVo[]> {
    return (await this.rows()).map(providerVo)
  }

  async save(id: number | null, dto: AgentProviderSave): Promise<AgentProviderVo> {
    return providerVo(await this.saveRow(id, dto))
  }

  async removeOne(id: number): Promise<null> {
    await this.remove([id])
    return null
  }
}

/** 联网搜索服务商的平台配置（`/api/agent/search-providers`）。 */
@Injectable()
export class SearchProviderSettingsService extends KeyedSettings<AgentSearchProvider> {
  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>, cfg: AppConfigService) {
    super(txHost, AgentSearchProvider, cfg, 'agent_search_provider')
  }

  /** 换了服务商类型：原密钥不能跟着发给另一家。 */
  protected keyBoundChanged(
    stored: AgentSearchProvider,
    dto: Partial<AgentSearchProvider>,
  ): boolean {
    return dto.kind !== undefined && dto.kind !== stored.kind
  }

  /** 全部服务商（含停用），默认在前。 */
  rows(): Promise<AgentSearchProvider[]> {
    return this.rowsWithKey({ 't.isDefault': 'DESC', 't.id': 'ASC' })
  }

  async list(): Promise<AgentSearchProviderVo[]> {
    return (await this.rows()).map(searchVo)
  }

  async save(id: number | null, dto: AgentSearchProviderSave): Promise<AgentSearchProviderVo> {
    return searchVo(await this.saveRow(id, dto))
  }

  async removeOne(id: number): Promise<null> {
    await this.remove([id])
    return null
  }
}

const providerVo = (r: AgentProvider): AgentProviderVo => ({
  id: Number(r.id),
  name: r.name,
  baseUrl: r.baseUrl,
  hasKey: !!r.apiKey,
  models: r.models.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    reasoning: m.reasoning,
    vision: m.vision ?? false,
    fast: m.fast ?? false,
    contextWindow: m.contextWindow,
    pricing: m.pricing ?? null,
    reasoningDefault: m.reasoningDefault ?? 'provider',
    reasoningStyle: m.reasoningStyle ?? 'standard',
    ...(m.image && { image: true }),
  })),
  enabled: r.enabled,
  isDefault: r.isDefault,
  sort: r.sort,
})

const searchVo = (r: AgentSearchProvider): AgentSearchProviderVo => ({
  id: Number(r.id),
  kind: r.kind,
  name: r.name,
  hasKey: !!r.apiKey,
  enabled: r.enabled,
  isDefault: r.isDefault,
})
