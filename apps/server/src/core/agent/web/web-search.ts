import { Logger } from '@nestjs/common'
import { AGENT_SEARCH_KINDS, Err } from '@qiwu/shared'
import { z } from 'zod'
import { BizError } from '../../http/biz-error.js'
import { normalizeUrl } from './turn-urls.js'

export type AgentSearchKind = (typeof AGENT_SEARCH_KINDS)[number]

/** The configured search provider: its kind and the unsealed API key. */
export interface SearchConfig {
  kind: AgentSearchKind
  apiKey: string
}

/** Where the default enabled search provider comes from (bound by the agent module); null: none configured. */
export interface SearchConfigSource {
  current(): Promise<SearchConfig | null>
}
export const SEARCH_CONFIG_SOURCE = Symbol('qw:agent:search-config')

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

/** Results per search: the default and the most a call may ask for. */
export const WEB_SEARCH_COUNT = 5
export const WEB_SEARCH_MAX = 10
export const WEB_SEARCH_TIMEOUT_MS = 10_000
const SNIPPET_MAX = 600
const TITLE_MAX = 200

/** The providers' official endpoints (tests point them at a local fake). */
export const SEARCH_ENDPOINTS: Record<AgentSearchKind, string> = {
  bocha: 'https://api.bochaai.com/v1/web-search',
  tavily: 'https://api.tavily.com/search',
}

// only the fields used; anything else in the answer is ignored
const bochaAnswer = z.object({
  code: z.union([z.number(), z.string()]).optional(),
  data: z.object({
    webPages: z
      .object({
        value: z.array(
          z.object({
            name: z.string().nullish(),
            url: z.string(),
            snippet: z.string().nullish(),
            summary: z.string().nullish(),
          }),
        ),
      })
      .nullish(),
  }),
})
const tavilyAnswer = z.object({
  results: z.array(
    z.object({ title: z.string().nullish(), url: z.string(), content: z.string().nullish() }),
  ),
})

const clip = (s: string | null | undefined, max: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/**
 * 联网搜索：按当前配置的提供方（博查 / Tavily）调用其官方接口，统一成 `{ title, url, snippet }`。
 * 失败（未配置、超时、非 2xx、应答形状不对）一律 AGENT_WEB_FAILED，消息固定，不回显对方内容与密钥；
 * 结果数有上限，只保留 http/https 链接。
 */
export class WebSearch {
  private readonly logger = new Logger(WebSearch.name)

  constructor(
    private readonly source: SearchConfigSource,
    private readonly endpoints: Record<AgentSearchKind, string> = SEARCH_ENDPOINTS,
    private readonly timeoutMs = WEB_SEARCH_TIMEOUT_MS,
  ) {}

  /** 搜索一次；`signal` 中止（中断、急停）时请求随之结束。 */
  async search(
    query: string,
    opts: { count?: number; signal?: AbortSignal } = {},
  ): Promise<WebSearchResult[]> {
    const count = Math.min(Math.max(Math.trunc(opts.count ?? WEB_SEARCH_COUNT), 1), WEB_SEARCH_MAX)
    const config = await this.source.current()
    if (!config?.apiKey)
      throw new BizError(Err.AGENT_WEB_FAILED, { reason: 'search_not_configured' })
    const raw =
      config.kind === 'bocha'
        ? this.fromBocha(
            await this.post(
              config,
              { query, count, summary: true, freshness: 'noLimit' },
              opts.signal,
            ),
          )
        : this.fromTavily(await this.post(config, { query, max_results: count }, opts.signal))
    return raw
      .flatMap((r) => {
        const url = normalizeUrl(r.url)
        return url
          ? [{ title: clip(r.title, TITLE_MAX), url, snippet: clip(r.snippet, SNIPPET_MAX) }]
          : []
      })
      .slice(0, count)
  }

  /** 两家都是 `POST` JSON + `Authorization: Bearer <key>`。 */
  private async post(config: SearchConfig, body: object, signal?: AbortSignal): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(this.endpoints[config.kind], {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
      })
    } catch (err) {
      const reason = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network'
      this.logger.warn(`${config.kind} search failed: ${reason}`)
      throw new BizError(Err.AGENT_WEB_FAILED, { reason })
    }
    if (!res.ok) {
      // 只记状态码：对方的错误正文可能回显请求内容（状态码随错误带出，供诊断页显示）
      this.logger.warn(`${config.kind} search answered HTTP ${res.status}`)
      await res.body?.cancel()
      throw new BizError(Err.AGENT_WEB_FAILED, { reason: 'status', status: res.status })
    }
    return res.json().catch(() => null)
  }

  private fromBocha(json: unknown) {
    const parsed = bochaAnswer.safeParse(json)
    // 博查在应答体里另有 code，200 才是成功
    if (!parsed.success || (parsed.data.code !== undefined && String(parsed.data.code) !== '200'))
      throw this.badAnswer('bocha')
    return (parsed.data.data.webPages?.value ?? []).map((v) => ({
      title: v.name,
      url: v.url,
      snippet: v.summary || v.snippet,
    }))
  }

  private fromTavily(json: unknown) {
    const parsed = tavilyAnswer.safeParse(json)
    if (!parsed.success) throw this.badAnswer('tavily')
    return parsed.data.results.map((r) => ({ title: r.title, url: r.url, snippet: r.content }))
  }

  private badAnswer(kind: AgentSearchKind) {
    this.logger.warn(`${kind} search answer has an unexpected shape`)
    return new BizError(Err.AGENT_WEB_FAILED, { reason: 'answer' })
  }
}
