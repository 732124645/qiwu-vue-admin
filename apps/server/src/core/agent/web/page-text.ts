import sanitizeHtml from 'sanitize-html'

/** Links listed under a page's text, at most. */
export const PAGE_LINKS_MAX = 30

export interface PageText {
  title: string
  text: string
  links: { text: string; url: string }[]
}

// tags whose text is page chrome or code, dropped with their content
const DROPPED = [
  'script',
  'style',
  'noscript',
  'template',
  'textarea',
  'option',
  'select',
  'svg',
  'iframe',
  'object',
  'nav',
  'footer',
  'xmp',
]
// tags that end a line in the text
const BLOCKS = [
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]
const BLOCK_TAG = new RegExp(`</?(?:${BLOCKS.join('|')})\\b[^>]*>`, 'g')

/** sanitize-html 输出里只会出现这几种实体（其余实体解析时已解码）。 */
const unescape = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * 把 HTML 转成给模型读的纯文本：标题、正文（块级元素换行，脚本、样式、导航等连内容一起丢弃）与链接列表。
 * 先用 sanitize-html 把任意 HTML 规整成只含少数标签、属性只剩 href 的规范输出，
 * 再对这份规范输出做简单替换（不对原始 HTML 用正则）。相对链接按 `base` 解析，只保留 http/https。
 */
export function htmlToText(html: string, base: string): PageText {
  const clean = sanitizeHtml(html, {
    allowedTags: [...BLOCKS, 'a', 'title'],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https'],
    nonTextTags: DROPPED,
  })
  let title = ''
  const links: PageText['links'] = []
  const seen = new Set<string>()
  const body = clean
    .replace(/<title>([\s\S]*?)<\/title>/g, (_, t: string) => {
      title ||= squash(unescape(t))
      return ''
    })
    .replace(
      /<a(?: href="([^"]*)")?>([\s\S]*?)<\/a>/g,
      (_, href: string | undefined, inner: string) => {
        const text = squash(unescape(inner.replace(/<[^>]*>/g, ' ')))
        const url = href ? resolveLink(unescape(href), base) : null
        if (url && !seen.has(url) && links.length < PAGE_LINKS_MAX) {
          seen.add(url)
          links.push({ text, url })
        }
        return inner
      },
    )
    .replace(BLOCK_TAG, '\n')
    .replace(/<[^>]*>/g, '')
  const text = unescape(body)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text, links }
}

function resolveLink(href: string, base: string): string | null {
  try {
    const url = new URL(href, base)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}
