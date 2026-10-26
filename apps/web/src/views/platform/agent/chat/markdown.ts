import { Lexer, type MarkedToken, type Token } from 'marked'
import { defineComponent, h, type VNodeChild } from 'vue'
import MarkdownCodeBlock from './MarkdownCodeBlock.vue'

const MAX_TEXT = 128_000
const MAX_DEPTH = 32
const MAX_NODES = 5000
const ENTITIES: Record<string, string> = {
  amp: '&',
  AMP: '&',
  lt: '<',
  LT: '<',
  gt: '>',
  GT: '>',
  quot: '"',
  QUOT: '"',
  apos: "'",
  nbsp: '\u00a0',
}

/** 常见实体和数字字符只转成文本，不把模型内容送进 HTML/DOM 解析器。 */
function decode(text: string): string {
  return text.replace(
    /&(?:#([xX][\da-fA-F]+|\d+)|(amp|AMP|lt|LT|gt|GT|quot|QUOT|apos|nbsp));/g,
    (raw, numeric: string | undefined, named: string | undefined) => {
      if (named) return ENTITIES[named] ?? raw
      const point =
        numeric!.startsWith('x') || numeric!.startsWith('X')
          ? Number.parseInt(numeric!.slice(1), 16)
          : Number(numeric)
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : '\ufffd'
    },
  )
}

/** 链接只允许明确的 HTTP(S)/mailto；控制字符、实体混淆和 URL 凭据不能变成可执行入口。 */
export function safeMarkdownHref(value: string): string | null {
  const href = decode(value)
  if (!/^(https?:\/\/|mailto:)/i.test(href)) return null
  for (const char of href) {
    const point = char.codePointAt(0)!
    if (point <= 0x20 || (point >= 0x7f && point <= 0x9f)) return null
  }
  try {
    const url = new URL(href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}

/** 给依赖自身的递归也设上限，避免深嵌套先在 lexer 内耗尽调用栈。 */
function lex(text: string): Token[] {
  const lexer = new Lexer({ gfm: true, breaks: true })
  let depth = 0,
    work = 0
  const bounded = <T>(source: string, run: () => T): T => {
    if (++depth > MAX_DEPTH || (work += source.length) > MAX_TEXT * 8)
      throw new RangeError('markdown parse limit')
    try {
      return run()
    } finally {
      depth--
    }
  }
  const block = lexer.blockTokens.bind(lexer),
    inline = lexer.inlineTokens.bind(lexer)
  lexer.blockTokens = ((...args: Parameters<Lexer['blockTokens']>) =>
    bounded(args[0], () => block(...args))) as Lexer['blockTokens']
  lexer.inlineTokens = (...args) => bounded(args[0], () => inline(...args))
  return lexer.lex(text)
}

/** GFM token 只生成安全 VNode；超长/深层/高节点输入整段退为原文，正文不会被截断。 */
export function renderMarkdown(text: string): VNodeChild[] {
  const plain = () => [h('pre', { class: 'qw-md__raw' }, text)]
  if (text.length > MAX_TEXT) return plain()
  let remaining = MAX_NODES
  const take = () => {
    if (--remaining < 0) throw new RangeError('markdown render limit')
  }
  const render = (tokens: Token[], depth = 0, taskLabel = ''): VNodeChild[] => {
    if (depth > MAX_DEPTH) throw new RangeError('markdown render depth')
    return tokens.flatMap((raw): VNodeChild[] => {
      take()
      const token = raw as MarkedToken
      const children = (list: Token[]) => render(list, depth + 1, taskLabel)
      switch (token.type) {
        case 'space':
        case 'def':
          return []
        case 'text':
          return token.tokens ? children(token.tokens) : [decode(token.text)]
        case 'escape':
          return [token.text]
        case 'paragraph':
          return [h('p', children(token.tokens))]
        case 'heading':
          return [
            h(`h${Math.min(6, token.depth + 2)}`, { class: 'qw-md__h' }, children(token.tokens)),
          ]
        case 'strong':
          return [h('strong', children(token.tokens))]
        case 'em':
          return [h('em', children(token.tokens))]
        case 'del':
          return [h('del', children(token.tokens))]
        case 'br':
          return [h('br')]
        case 'hr':
          return [h('hr')]
        case 'codespan':
          return [h('code', token.text)]
        case 'code':
          return [h(MarkdownCodeBlock, { code: token.text, language: token.lang ?? '' })]
        case 'html':
          return token.block ? [h('pre', { class: 'qw-md__raw' }, token.raw)] : [token.raw]
        case 'blockquote':
          return [h('blockquote', children(token.tokens))]
        case 'link':
        case 'image': {
          const href = safeMarkdownHref(token.href)
          const content =
            token.type === 'image' ? [decode(token.text) || token.href] : children(token.tokens)
          return [
            href
              ? h(
                  'a',
                  {
                    href,
                    title: token.title ? decode(token.title) : undefined,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                    ...(token.type === 'image' ? { class: 'qw-md__image-link' } : {}),
                  },
                  content,
                )
              : h('span', content),
          ]
        }
        case 'list':
          return [
            h(
              token.ordered ? 'ol' : 'ul',
              token.ordered ? { start: token.start || 1 } : {},
              token.items.map((item) => {
                take()
                return h(
                  'li',
                  { class: item.task ? 'qw-md__task' : undefined },
                  render(item.tokens, depth + 1, item.text),
                )
              }),
            ),
          ]
        case 'checkbox':
          return [
            h('input', {
              type: 'checkbox',
              checked: token.checked,
              disabled: true,
              'aria-label': decode(taskLabel),
            }),
          ]
        case 'list_item':
          return [h('li', children(token.tokens))]
        case 'table': {
          const cell = (value: (typeof token.header)[number], tag: 'th' | 'td') => {
            take()
            return h(tag, { style: { textAlign: value.align ?? 'left' } }, children(value.tokens))
          }
          return [
            h(
              'div',
              { class: 'qw-md__table' },
              h('table', [
                h(
                  'thead',
                  h(
                    'tr',
                    token.header.map((value) => cell(value, 'th')),
                  ),
                ),
                h(
                  'tbody',
                  token.rows.map((row) => {
                    take()
                    return h(
                      'tr',
                      row.map((value) => cell(value, 'td')),
                    )
                  }),
                ),
              ]),
            ),
          ]
        }
        default:
          return [h('span', raw.raw)]
      }
    })
  }
  try {
    return render(lex(text))
  } catch {
    return plain()
  }
}

export const MarkdownText = defineComponent({
  name: 'MarkdownText',
  props: { text: { type: String, required: true } },
  setup: (props) => () => h('div', { class: 'qw-md' }, renderMarkdown(props.text)),
})
