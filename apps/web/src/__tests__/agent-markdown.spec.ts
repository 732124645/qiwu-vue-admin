import { createPinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ElMessage } from 'element-plus'
import { i18n, setLocale } from '@/core/i18n'
import * as downloads from '@/core/request/http'
import { highlight } from '@/core/components/CodeViewer.vue'
import ChatItem from '@/views/platform/agent/chat/ChatItem.vue'
import MarkdownCodeBlock from '@/views/platform/agent/chat/MarkdownCodeBlock.vue'
import { MarkdownText, safeMarkdownHref } from '@/views/platform/agent/chat/markdown'
import type { ChatRow } from '@/views/platform/agent/chat/thread-state'

const words = {
  plainText: 'Plain text',
  wrap: 'Wrap long lines',
  unwrap: 'Keep original lines',
  copyCode: 'Copy code block',
  source: 'View Markdown source',
  rendered: 'Read formatted message',
  download: 'Download Markdown',
  expand: 'Expand reading',
}
i18n.global.mergeLocaleMessage('en-US', { agent: { chat: { markdown: words } } })
const wrappers: VueWrapper[] = []
const clipboard = vi.fn<(value: string) => Promise<void>>()
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const global = () => ({ plugins: [createPinia(), i18n], stubs: { OutputCard: true } })
const text = (value: string) => {
  const w = mount(MarkdownText, { props: { text: value }, global: global() })
  wrappers.push(w)
  return w
}
const answer = (value: string, kind: 'assistant' | 'report' = 'assistant') => {
  const row = {
    kind: 'item',
    item: {
      id: 7,
      seq: 7,
      kind,
      payload: { text: value, ...(kind === 'report' ? { title: 'Report', citations: [] } : {}) },
      status: 'done',
      turnId: 1,
      createdAt: '2026-01-01T00:00:00Z',
    },
  } as ChatRow
  const w = mount(ChatItem, { props: { row }, global: global() })
  wrappers.push(w)
  return w
}
const action = (w: VueWrapper, label: string) => w.get(`button[aria-label="${label}"]`)

beforeEach(() => {
  setLocale('en-US')
  clipboard.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboard },
  })
  vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
  vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.restoreAllMocks()
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  setLocale('zh-CN')
})

it('renders nested GFM lists, emphasis, strikethrough, tasks, escaped pipes and ordered starts', () => {
  const w = text(
    '- [x] **top**\n  - *nested* and ~~old~~\n- [ ] waiting\n\n3. three\n4. four\n\n| A | B |\n| :--- | ---: |\n| a\\|b | `c\\|d` |',
  )
  expect(w.find('ul ul em').text()).toBe('nested')
  expect(w.find('li strong').text()).toBe('top')
  expect(w.find('del').text()).toBe('old')
  expect(
    w
      .findAll<HTMLInputElement>('input')
      .map((input) => [input.element.checked, input.element.disabled]),
  ).toEqual([
    [true, true],
    [false, true],
  ])
  expect(w.find('ol').attributes('start')).toBe('3')
  expect(w.findAll('td').map((cell) => cell.text())).toEqual(['a|b', 'c|d'])
  expect(w.findAll('th')[1]!.attributes('style')).toContain('text-align: right')
})

it('decodes ordinary text entities and escapes, while inline and fenced code remain literal text', () => {
  const w = text(
    'A &amp; B &lt;b&gt; &#x1f600; \\*literal\\* and `&amp; <b>`\n\n```html\n<script>window.payload=1</script>\n```',
  )
  expect(w.find('p').text()).toContain('A & B <b> 😀 *literal*')
  expect(w.find('p code').text()).toBe('&amp; <b>')
  expect(w.find('pre code').text()).toBe('<script>window.payload=1</script>')
  expect(w.find('script').exists()).toBe(false)
  expect(w.find('p b').exists()).toBe(false)
})

it.each([
  'javascript:alert(1)',
  'jav&#x61;script:alert(1)',
  'java&#10;script:alert(1)',
  'javascript&colon;alert(1)',
  'data:text/html,x',
  '//example.com',
  'https:\\example.com',
  'https://name:secret@example.com',
])('refuses an unsafe or ambiguous link %s', (href) => {
  expect(safeMarkdownHref(href)).toBeNull()
  const w = text(`[unsafe](${href})`)
  expect(w.find('a').exists()).toBe(false)
})

it('rejects raw URL controls while leaving GFM bare HTTP autolinks safe', () => {
  expect(safeMarkdownHref('\u0001https://example.com')).toBeNull()
  expect(safeMarkdownHref('https://example.com/a\u0085b')).toBeNull()
  const w = text('[unsafe](\u0001https://example.com)')
  for (const link of w.findAll('a'))
    expect(safeMarkdownHref(link.attributes('href')!)).not.toBeNull()
})

it('never creates HTML or remote-image nodes and exposes only explicit safe image links', () => {
  const w = text(
    '<img src="https://remote.example/pixel" onerror="alert(1)">\n\n![diagram](https://remote.example/pixel.png)\n\n![blocked](data:image/svg+xml,x)\n\n[docs](https://example.com/a?x=1&amp;y=2)',
  )
  expect(w.find('img').exists()).toBe(false)
  expect(w.find('script').exists()).toBe(false)
  expect(w.text()).toContain('<img src=')
  const links = w.findAll('a')
  expect(links.map((link) => link.attributes('href'))).toEqual([
    'https://remote.example/pixel.png',
    'https://example.com/a?x=1&y=2',
  ])
  for (const link of links)
    expect(link.attributes()).toMatchObject({ target: '_blank', rel: 'noopener noreferrer' })
})

it('handles unfinished streaming fences without treating their HTML as markup', async () => {
  const w = text('```html\n<div')
  expect(w.find('pre code').text()).toBe('<div')
  await w.setProps({ text: '```html\n<div>one</div>' })
  expect(w.find('pre code').text()).toBe('<div>one</div>')
  await w.setProps({ text: '```html\n<div>one</div>\n```\n\n**tail**' })
  expect(w.find('pre code').text()).toBe('<div>one</div>')
  expect(w.find('strong').text()).toBe('tail')
  expect(w.find('pre code div').exists()).toBe(false)
})

it.each(['> '.repeat(500) + 'deep', 'x'.repeat(128_001), '- [ ] item\n'.repeat(2000)])(
  'retains all source when parse depth, text or node budgets are exceeded',
  (source) => {
    const w = text(source)
    expect(w.get('.qw-md__raw').element.textContent).toBe(source)
    expect(w.findComponent(MarkdownCodeBlock).exists()).toBe(false)
  },
)

it('loads the existing JavaScript-regex highlighter lazily for common code languages', async () => {
  for (const [lang, source] of [
    ['javascript', 'const n = 1'],
    ['python', 'print(1)'],
    ['shellscript', 'echo hello'],
    ['html', '<div>hello</div>'],
    ['css', '.x { display: block }'],
  ]) {
    const tokens = await highlight(source!, lang!)
    expect(tokens).not.toBeNull()
    expect(tokens!.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(
      source,
    )
  }
})

it('copies each complete code block and toggles long-line wrapping independently', async () => {
  const w = text('```js\nconst x = "<b>"\n```\n\n```text\nsecond\n```')
  const blocks = w.findAllComponents(MarkdownCodeBlock)
  await action(blocks[0]!, words.copyCode).trigger('click')
  await flushPromises()
  expect(clipboard).toHaveBeenLastCalledWith('const x = "<b>"')
  await action(blocks[0]!, words.wrap).trigger('click')
  expect(blocks[0]!.get('pre').classes()).toContain('is-wrapped')
  expect(blocks[1]!.get('pre').classes()).not.toContain('is-wrapped')
  await action(blocks[0]!, words.unwrap).trigger('click')
  expect(blocks[0]!.get('pre').classes()).not.toContain('is-wrapped')
  await action(blocks[1]!, words.copyCode).trigger('click')
  await flushPromises()
  expect(clipboard).toHaveBeenLastCalledWith('second')
})

it.each(['constructor', '__proto__', 'toString'])(
  'keeps an unknown language %s as plain code',
  async (language) => {
    const w = mount(MarkdownCodeBlock, {
      props: { code: '<img onerror=alert(1)>', language },
      global: global(),
    })
    wrappers.push(w)
    await flushPromises()
    expect(w.get('code').text()).toBe('<img onerror=alert(1)>')
    expect(w.find('img').exists()).toBe(false)
    expect(w.find('.agent-md-code__token').exists()).toBe(false)
  },
)

it('retains a large code block without starting expensive highlighting', async () => {
  await highlight('const x = 1', 'javascript')
  const code = 'x'.repeat(32_001)
  const w = mount(MarkdownCodeBlock, { props: { code, language: 'javascript' }, global: global() })
  wrappers.push(w)
  await flushPromises()
  expect(w.get('code').element.textContent).toBe(code)
  expect(w.find('.agent-md-code__token').exists()).toBe(false)
})

it('copies and downloads the exact Markdown source while raw/rendered reading and inspect remain local', async () => {
  const source = '\r\n# Answer\r\n\r\n- **bold**\r\n\n```html\n<b>text</b>\n```\n'
  const save = vi.spyOn(downloads, 'saveBlob').mockImplementation(() => undefined)
  const w = answer(source)
  await action(w, String(i18n.global.t('agent.chat.action.copy'))).trigger('click')
  await flushPromises()
  expect(clipboard).toHaveBeenLastCalledWith(source)
  await action(w, words.source).trigger('click')
  expect(w.get('.agent-msg__raw').element.textContent).toBe(source)
  await action(w, words.rendered).trigger('click')
  expect(w.find('.qw-md h3').text()).toBe('Answer')
  await action(w, words.download).trigger('click')
  expect(save).toHaveBeenCalledTimes(1)
  const [blob, name] = save.mock.calls[0]!
  expect(name).toBe('message-7.md')
  expect(await blob.text()).toBe(source)
  await action(w, words.expand).trigger('click')
  expect(w.emitted('inspect')).toEqual([[7]])
})

it('offers report inspection without changing its existing export or readonly behavior', async () => {
  const w = answer('Report body', 'report')
  await action(w, words.expand).trigger('click')
  expect(w.emitted('inspect')).toEqual([[7]])
  expect(w.find('button[aria-label="Download Markdown"]').exists()).toBe(false)
})
