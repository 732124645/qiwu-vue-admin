import type { SearchConfig, SearchConfigSource } from '../web/web-search.js'
import { Injectable } from '@nestjs/common'
import { type AGENT_SEARCH_KINDS, type AgentModelVo, agentModelPricing, Err } from '@qiwu/shared'
import { BizError } from '../../http/biz-error.js'
import type { ChatModel } from './chat-model.js'
import type { AgentUsageTarget } from '../agent-ports.js'
import { type ChatModelConfig, OpenAiChatModel } from './openai-chat-model.js'
import { withUsageEstimate } from './usage.js'
import { ProviderSlots, withProviderSlot } from './provider-slots.js'
import {
  ProviderSettingsService,
  SearchProviderSettingsService,
} from './provider-settings.service.js'

/** A provider and one of its models, ready to call. */
export interface ResolvedModel {
  providerId: number
  providerName: string
  model: AgentModelVo
  chat: ChatModel
}

/** 调用前固定提供方、模型和费率；同名模型和调用中的调价不会混淆历史账目。 */
export const usageTarget = (m: ResolvedModel, kind?: 'chat' | 'image'): AgentUsageTarget => ({
  providerId: m.providerId,
  providerName: m.providerName,
  model: m.model.id,
  pricing: m.model.pricing ? structuredClone(m.model.pricing) : null,
  ...(kind && { kind }),
})

/** The search provider web search uses, its key opened. */
export interface ResolvedSearch {
  id: number
  kind: (typeof AGENT_SEARCH_KINDS)[number]
  apiKey: string | null
}

/**
 * 运行时取模型的入口：按会话选的提供方与模型（不选则用默认）找到启用的那一家，解出密钥，交给
 * `connect` 建 ChatModel。测试里用 `vi.spyOn(registry, 'connect').mockReturnValue(new FakeChatModel(…))`
 * 换成假模型，不连网络。
 */
@Injectable()
export class ProviderRegistry {
  constructor(
    private readonly providers: ProviderSettingsService,
    private readonly searches: SearchProviderSettingsService,
    private readonly slots: ProviderSlots,
  ) {}

  /**
   * 启用的提供方 + 模型：`providerId` 不给时取默认（没有标默认就取排序最前的启用者），`model` 不给时取
   * 该提供方的第一个模型；找不到、已停用、模型不在其列表里一律 AGENT_NOT_CONFIGURED。
   * 没配费率的模型照常可用（升级前的模型都没有费率，拒绝会让助手整体停用），调用记为未计价；
   * 配了但不合法的费率仍拒绝，不能静默当成免费。提供方配了并发上限时，返回的模型每次调用先取得名额
   * （跨实例、跨租户计数），上限每次取模型时从库里读，改了下一次调用就生效。
   */
  async resolve(providerId?: number, model?: string): Promise<ResolvedModel> {
    const rows = (await this.providers.rows()).filter((r) => r.enabled)
    const row = providerId === undefined ? rows[0] : rows.find((r) => Number(r.id) === providerId)
    const m = row && (model === undefined ? row.models[0] : row.models.find((x) => x.id === model))
    if (!row || !m) throw new BizError(Err.AGENT_NOT_CONFIGURED)
    const pricing = m.pricing ? agentModelPricing.safeParse(m.pricing) : null
    if (pricing && !pricing.success) throw new BizError(Err.AGENT_CREDIT_CONFIG_INVALID)
    const id = Number(row.id)
    const chat = withUsageEstimate(
      this.connect({
        baseUrl: row.baseUrl,
        apiKey: this.providers.openKey(row),
        models: row.models,
        retries: 0, // 每次持久调用只发一个物理请求，5xx 结果不明时不自动重发付费请求。
      }),
    )
    // 配了并发上限才套名额（在用量估算之外）；没取到名额的调用经 onSlot 告知计量不计费。空或 0 与不限时完全同一路径
    const limit = row.maxConcurrency
    return {
      providerId: id,
      providerName: row.name,
      model: {
        id: m.id,
        label: m.label || m.id,
        reasoning: m.reasoning,
        vision: m.vision ?? false,
        fast: m.fast ?? false,
        contextWindow: m.contextWindow,
        image: m.image ?? false,
        pricing: pricing?.data ?? null,
        reasoningDefault: m.reasoningDefault ?? 'provider',
        reasoningStyle: m.reasoningStyle ?? 'standard',
      },
      chat: limit
        ? withProviderSlot(chat, (signal) => this.slots.acquire(id, limit, signal))
        : chat,
    }
  }

  /**
   * 生成图片用的模型：启用的提供方里第一个标了图片能力的模型（默认提供方在前，同 {@link resolve} 的顺序，
   * 没配费率的也算，调用记为未计价）；没有为 null（此时不提供 `image.generate`）。
   */
  async resolveImage(): Promise<ResolvedModel | null> {
    for (const row of (await this.providers.rows()).filter((r) => r.enabled)) {
      const m = row.models.find((x) => x.image)
      if (m) return this.resolve(Number(row.id), m.id)
    }
    return null
  }

  /** 按配置建真实的 OpenAI 兼容模型客户端（测试的替换点）。 */
  connect(cfg: ChatModelConfig): ChatModel {
    return new OpenAiChatModel(cfg)
  }

  /** 联网搜索用的服务商：默认的启用者（没有标默认取最前的启用者），没有配置为 null。 */
  async resolveSearch(): Promise<ResolvedSearch | null> {
    const row = (await this.searches.rows()).find((r) => r.enabled)
    if (!row) return null
    return { id: Number(row.id), kind: row.kind, apiKey: this.searches.openKey(row) }
  }
}

/** 联网搜索的配置来源：取第一个已启用的搜索提供方（类型与解密后的密钥），供 `web.search` 使用。 */
@Injectable()
export class ProviderSearchConfig implements SearchConfigSource {
  constructor(private readonly registry: ProviderRegistry) {}

  async current(): Promise<SearchConfig | null> {
    const found = await this.registry.resolveSearch()
    // 没有可用密钥等同于未配置
    return found?.apiKey ? { kind: found.kind, apiKey: found.apiKey } : null
  }
}
