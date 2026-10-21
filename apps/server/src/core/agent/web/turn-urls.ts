// a URL in free text ends at whitespace, quotes, angle brackets or CJK / full-width punctuation
// (quote characters in regexes of this folder are written as \x22 \x27 \x60: the i18n check reads a bare one as a string)
const URL_IN_TEXT = /https?:\/\/[^\s<>\x22\x27\x60\u3000-\u303f\uff00-\uffef]+/gi
// sentence punctuation right after a URL is not part of it
const TRAILING = /[.,;:!?)\]}]+$/

/**
 * 比较用的规范形式：只认 http/https；协议与主机名小写、默认端口省略（WHATWG URL 已做），去掉片段。
 * 路径与查询串原样比较：把数据拼进查询串的“新链接”就不再相同。无效时 null。
 */
export function normalizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.hash = ''
  return url.href
}

/**
 * 一轮里智能体可以读取的链接（来源限制，防止网页内容诱导把内部数据拼进 URL 发出去）：
 * 本轮 `web.search` 返回的结果链接，加上用户消息里给出的链接；其余链接 `web.fetch` 一律拒绝。
 * 重定向不在这里检查：起点允许，抓取器跟随的重定向就允许（每跳仍做公网地址检查）。
 * 轮次在审批后续跑时，用 {@link list} 存下、`new TurnUrls(saved)` 恢复。
 */
export class TurnUrls {
  private readonly urls = new Set<string>()

  constructor(urls: Iterable<string> = []) {
    for (const url of urls) this.add(url)
  }

  add(url: string): void {
    const normalized = normalizeUrl(url)
    if (normalized) this.urls.add(normalized)
  }

  /** 收下一段用户消息里出现的全部链接。 */
  addFromText(text: string): void {
    for (const [match] of text.matchAll(URL_IN_TEXT)) this.add(match.replace(TRAILING, ''))
  }

  allows(url: string): boolean {
    const normalized = normalizeUrl(url)
    return normalized !== null && this.urls.has(normalized)
  }

  list(): string[] {
    return [...this.urls]
  }
}
