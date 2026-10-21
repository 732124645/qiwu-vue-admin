import type { SearchConfig, SearchConfigSource } from '../web/web-search.js'
import { Injectable } from '@nestjs/common'
import { type AGENT_SEARCH_KINDS, type AgentModelVo, Err } from '@qiwu/shared'
import { BizError } from '../../http/biz-error.js'
import type { ChatModel } from './chat-model.js'
import { type ChatModelConfig, OpenAiChatModel } from './openai-chat-model.js'
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
  ) {}

  /**
   * 启用的提供方 + 模型：`providerId` 不给时取默认（没有标默认就取排序最前的启用者），`model` 不给时取
   * 该提供方的第一个模型；找不到、已停用、模型不在其列表里一律 AGENT_NOT_CONFIGURED。
   */
  async resolve(providerId?: number, model?: string): Promise<ResolvedModel> {
    const rows = (await this.providers.rows()).filter((r) => r.enabled)
    const row = providerId === undefined ? rows[0] : rows.find((r) => Number(r.id) === providerId)
    const m = row && (model === undefined ? row.models[0] : row.models.find((x) => x.id === model))
    if (!row || !m) throw new BizError(Err.AGENT_NOT_CONFIGURED)
    return {
      providerId: Number(row.id),
      providerName: row.name,
      model: {
        id: m.id,
        label: m.label || m.id,
        reasoning: m.reasoning,
        vision: m.vision ?? false,
        fast: m.fast ?? false,
        contextWindow: m.contextWindow,
      },
      chat: this.connect({
        baseUrl: row.baseUrl,
        apiKey: this.providers.openKey(row),
        models: row.models,
      }),
    }
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
