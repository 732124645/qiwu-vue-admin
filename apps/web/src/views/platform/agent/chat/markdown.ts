import { defineComponent, h, type VNode, type VNodeChild } from 'vue'

/**
 * 模型回答的 Markdown 安全子集：段落、标题、列表、引用、代码块、表格、行内代码、粗体与链接。
 * 直接生成 VNode，文字一律作为文本节点交给 Vue 转义，从不使用 v-html，所以模型或网页带来的
 * HTML 只会原样显示。链接只放行 http(s) 与 mailto，新窗口打开并带 rel=noopener noreferrer。
 * 流式输出中途未闭合的代码块按代码块显示到末尾。
 */

const SAFE_HREF = /^(https?:|mailto:)/i
// 写成字符串：仓库的 i18n 检查按引号切分注释，正则字面量里的反引号会让它误判
const INLINE = new RegExp(
  '`([^`\\n]+)`|\\*\\*([^*\\n]+)\\*\\*|\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)|(https?://[^\\s<>()\\]]+)',
  'g',
)

function link(href: string, text: string): VNodeChild {
  return SAFE_HREF.test(href)
    ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text)
    : text
}

/** 行内标记；换行变成 <br>。 */
export function inline(text: string): VNodeChild[] {
  const out: VNodeChild[] = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(...breaks(text.slice(last, m.index)))
    const [, code, bold, label, href, bare] = m
    if (code != null) out.push(h('code', code))
    else if (bold != null) out.push(h('strong', bold))
    else if (label != null) out.push(link(href!, label))
    else out.push(link(bare!, bare!))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...breaks(text.slice(last)))
  return out
}

function breaks(text: string): VNodeChild[] {
  return text.split('\n').flatMap((part, i) => (i ? [h('br'), part] : [part]))
}

const FENCE = new RegExp('^\\s*`{3}')
const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
/** 第 `i` 行是表头（下一行是分隔行） */
const tableAt = (lines: string[], i: number) =>
  lines[i]!.includes('|') && TABLE_SEP.test(lines[i + 1] ?? '') && lines[i + 1]!.includes('-')

/** 把整段 Markdown 解析成块级 VNode。 */
export function renderMarkdown(text: string): VNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: VNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    if (FENCE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!)
      i++
      out.push(h('pre', h('code', body.join('\n'))))
      continue
    }
    if (tableAt(lines, i)) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim())
        rows.push(cells(lines[i++]!))
      out.push(
        h('div', { class: 'qw-md__table' }, [
          h('table', [
            h(
              'thead',
              h(
                'tr',
                head.map((c) => h('th', inline(c))),
              ),
            ),
            h(
              'tbody',
              rows.map((r) =>
                h(
                  'tr',
                  head.map((_, k) => h('td', inline(r[k] ?? ''))),
                ),
              ),
            ),
          ]),
        ]),
      )
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      // 页面标题是 h2，回答里的 # 从 h3 开始，保持标题层级
      const level = Math.min(6, heading[1]!.length + 2)
      out.push(h(`h${level}`, { class: 'qw-md__h' }, inline(heading[2]!)))
      i++
      continue
    }
    const first = LIST.exec(line)
    if (first) {
      const ordered = /\d/.test(first[1]!)
      const entries: string[] = []
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!)
        if (m && /\d/.test(m[1]!) === ordered) entries.push(m[2]!)
        // 缩进的续行接在上一项后面
        else if (/^\s{2,}\S/.test(lines[i]!) && entries.length)
          entries[entries.length - 1] += `\n${lines[i]!.trim()}`
        else break
        i++
      }
      out.push(
        h(
          ordered ? 'ol' : 'ul',
          entries.map((e) => h('li', inline(e))),
        ),
      )
      continue
    }
    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!)
      out.push(h('blockquote', renderMarkdown(body.join('\n'))))
      continue
    }
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !FENCE.test(lines[i]!) &&
      !LIST.test(lines[i]!) &&
      !HEADING.test(lines[i]!) &&
      !QUOTE.test(lines[i]!) &&
      // 段落后不空行直接跟表格
      !(para.length && tableAt(lines, i))
    )
      para.push(lines[i++]!)
    out.push(h('p', inline(para.join('\n'))))
  }
  return out
}

/** `<MarkdownText :text>`：渲染上面的安全子集。 */
export const MarkdownText = defineComponent({
  name: 'MarkdownText',
  props: { text: { type: String, required: true } },
  setup: (props) => () => h('div', { class: 'qw-md' }, renderMarkdown(props.text)),
})
