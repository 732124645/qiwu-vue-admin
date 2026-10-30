import { Injectable, Logger } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  AGENT_PROVIDER_MODELS_MAX,
  type AgentProviderModelsQuery,
  type AgentProviderModelsVo,
  type AgentProviderSave,
  type AgentProviderVo,
  type AgentSearchProviderSave,
  type AgentSearchProviderVo,
  Err,
} from '@qiwu/shared'
import { type FindOptionsWhere, In, Not, type ObjectLiteral } from 'typeorm'
import { z } from 'zod'
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

/** 拉取模型清单的总超时：只是表单里的一次查询，不重试 */
const MODELS_TIMEOUT_MS = 10_000
/** OpenAI 兼容的 `GET /models` 应答；其他字段忽略 */
const modelsWire = z.object({
  data: z.array(z.object({ id: z.string(), owned_by: z.string().optional().catch(undefined) })),
})

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

  /**
   * 从服务商的 `GET {baseUrl}/models` 读可用模型，供表单勾选添加，不写任何数据。
   * 密钥来源（安全关键）：请求里填了 `apiKey` 就用它；否则只有 `id` 指向已保存的提供方、且 `baseUrl`
   * 与已保存的地址完全一致时才解出已保存的密钥。地址改了而又没填新密钥时拒绝（AGENT_KEY_REQUIRED），
   * 绝不把已保存的密钥发到别的地址，否则改个地址就能把密钥送到自己的服务器上。没有密钥的提供方
   * （本地 Ollama）不带 Authorization。密钥不进日志、不进应答。
   */
  async upstreamModels(dto: AgentProviderModelsQuery): Promise<AgentProviderModelsVo> {
    let key = dto.apiKey || null
    if (!key && dto.id !== undefined) {
      const stored = await this.rowWithKey(dto.id)
      if (stored.apiKey && stored.baseUrl !== dto.baseUrl)
        throw new BizError(Err.AGENT_KEY_REQUIRED)
      key = this.openKey(stored)
    }
    const items = new Map<string, string | undefined>()
    for (const m of await fetchModels(dto.baseUrl, key)) {
      const id = m.id.trim()
      // 存不进模型清单的 id（空、超长）不给出
      if (id && id.length <= 128 && !items.has(id)) items.set(id, m.owned_by || undefined)
    }
    return {
      items: [...items]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, AGENT_PROVIDER_MODELS_MAX)
        .map(([id, ownedBy]) => (ownedBy ? { id, ownedBy } : { id })),
    }
  }
}

const logger = new Logger(ProviderSettingsService.name)

/** 上游模型清单最多读这么多字节：超出按服务没有正常应答处理，不把任意大的正文读进内存。 */
const MODELS_MAX_BYTES = 2 * 1024 * 1024

/**
 * 按上限读出正文（声明的长度或实际读到的超过上限就停下并取消读取）：超出为 undefined。只在超出时提前结束，
 * 不信任 Content-Length（可能缺失或不实）。
 */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  if (Number(res.headers.get('content-length')) > max) {
    await res.body?.cancel().catch(() => undefined)
    return undefined
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 请求 `GET {baseUrl}/models`：短超时、不重试、不跟随重定向（重定向会把 Authorization 带到别处）。
 * 失败只给简短原因、不回显上游正文（可能含密钥片段）：401/403 是密钥被拒，其余是服务没有正常应答。
 */
async function fetchModels(baseUrl: string, key: string | null) {
  let res: Response
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Accept: 'application/json', ...(key && { Authorization: `Bearer ${key}` }) },
      redirect: 'manual',
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    })
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : 'network'
    logger.warn(`model list failed: ${reason}`)
    throw new BizError(Err.AGENT_PROVIDER_FAILED, { reason })
  }
  if (res.status === 401 || res.status === 403) {
    logger.warn(`model list failed: http_${res.status}`)
    throw new BizError(Err.AGENT_PROVIDER_KEY_REJECTED)
  }
  let body: unknown = null
  if (res.ok) {
    const text = await readCapped(res, MODELS_MAX_BYTES).catch(() => null)
    if (text === undefined) {
      logger.warn('model list failed: too_large')
      throw new BizError(Err.AGENT_PROVIDER_FAILED, { reason: 'too_large' })
    }
    try {
      body = text === null ? null : JSON.parse(text)
    } catch {
      body = null
    }
  } else await res.body?.cancel().catch(() => undefined)
  const parsed = modelsWire.safeParse(body)
  if (!parsed.success) {
    const reason = res.ok ? 'bad_response' : `http_${res.status}`
    logger.warn(`model list failed: ${reason}`)
    throw new BizError(Err.AGENT_PROVIDER_FAILED, { reason })
  }
  return parsed.data.data
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
  maxConcurrency: r.maxConcurrency ?? null,
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
