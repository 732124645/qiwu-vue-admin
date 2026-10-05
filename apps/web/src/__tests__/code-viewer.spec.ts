// CodeViewer: shiki/core + the JS regex engine with lazily loaded grammars, a folder tree of
// the files, light and dark theme colors on every token, copy.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import CodeViewer, { fileTree, highlight, languageOf } from '@/core/components/CodeViewer.vue'
import { i18n, setLocale } from '@/core/i18n'

const FILES = [
  {
    path: 'apps/server/src/modules/demo/book/book.entity.ts',
    content: 'export const a: number = 1\n',
  },
  { path: 'apps/server/src/modules/demo/book/book.service.ts', content: 'export class S {}' },
  { path: 'apps/web/src/locales/en-US/demo.book.json', content: '{ "a": 1 }' },
  { path: 'docs/notes.txt', content: 'plain <b>text</b>' },
]

beforeEach(() => setLocale('en-US'))
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  document.documentElement.classList.remove('dark')
  setLocale('zh-CN')
})

describe('fileTree / languageOf / highlight', () => {
  it('groups paths into folders, merging single-folder chains, in the files order', () => {
    const labels = (nodes: ReturnType<typeof fileTree>): unknown[] =>
      nodes.map((n) => (n.children ? [n.label, labels(n.children)] : n.label))
    expect(labels(fileTree(FILES))).toEqual([
      [
        'apps',
        [
          ['server/src/modules/demo/book', ['book.entity.ts', 'book.service.ts']],
          ['web/src/locales/en-US', ['demo.book.json']],
        ],
      ],
      ['docs', ['notes.txt']],
    ])
  })

  it('takes the language given, else the extension, else plain text', () => {
    expect(FILES.map((f) => languageOf(f))).toEqual(['typescript', 'typescript', 'json', 'text'])
    expect(languageOf({ path: 'x.ts', content: '', language: 'vue' })).toBe('vue')
    expect(languageOf({ path: 'a.sql', content: '' })).toBe('sql')
  })

  it('tokenizes with both themes as CSS variables; no grammar → null', async () => {
    const lines = await highlight('const x = 1\n-- sql', 'typescript')
    expect(lines?.[0]?.map((t) => t.content).join('')).toBe('const x = 1')
    expect(lines?.[0]?.[0]?.htmlStyle).toMatchObject({
      '--shiki-light': expect.stringMatching(/^#/),
      '--shiki-dark': expect.stringMatching(/^#/),
    })
    await expect(highlight('x', 'text')).resolves.toBeNull()
    // grammars load on first use: vue brings its embedded languages along
    const vue = await highlight('<template><div :a="b">{{ c }}</div></template>', 'vue')
    expect(vue?.[0]?.length).toBeGreaterThan(5)
    const diff = await highlight('@@ -1 +1 @@\n-a\n+b', 'diff')
    expect(diff?.map((l) => l.map((t) => t.content).join(''))).toEqual(['@@ -1 +1 @@', '-a', '+b'])
  })

  it('loads the JSON grammar and produces light and dark tokens for objects, arrays and null', async () => {
    const content = '{"items":[1,null],"html":"<script>alert(1)</script>"}'
    const lines = await highlight(content, 'json')
    expect(lines?.[0]?.map((token) => token.content).join('')).toBe(content)
    expect(lines?.[0]?.length).toBeGreaterThan(5)
    expect(lines?.[0]?.find((token) => token.content.includes('items'))?.htmlStyle).toMatchObject({
      '--shiki-light': expect.stringMatching(/^#/),
      '--shiki-dark': expect.stringMatching(/^#/),
    })
  })
})

describe('CodeViewer', () => {
  function viewer(props: Record<string, unknown> = {}) {
    const active = ref<string>()
    const w = mount(
      defineComponent({
        setup: () => () =>
          h(CodeViewer, {
            files: FILES,
            active: active.value,
            'onUpdate:active': (v?: string) => (active.value = v),
            ...props,
          }),
      }),
      { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
    )
    return { w, active }
  }
  const code = (w: VueWrapper) =>
    w
      .findAll('.code-viewer__line')
      .map((l) =>
        l
          .findAll('span')
          .map((token) => token.element.textContent)
          .join(''),
      )
      .join('\n')
  const node = (w: VueWrapper, label: string) =>
    w.findAll('.el-tree-node__content').find((n) => n.text() === label)!

  it('shows the first file at once, then its colors; a click in the tree shows another', async () => {
    const { w, active } = viewer()
    expect(active.value).toBe(FILES[0]!.path)
    expect(w.find('.code-viewer__path').text()).toBe(FILES[0]!.path)
    expect(code(w)).toBe('export const a: number = 1\n')
    await vi.waitFor(() =>
      expect(w.find('.code-viewer__line span').attributes('style')).toContain('--shiki-light'),
    )
    expect(w.find('.el-tree').attributes('aria-label')).toBe('Files')
    expect(w.find('.el-tree-node.is-current').text()).toBe('book.entity.ts')

    await node(w, 'demo.book.json').trigger('click')
    await flushPromises()
    expect(active.value).toBe(FILES[2]!.path)
    expect(code(w)).toBe('{ "a": 1 }')
    // a folder click only folds
    await node(w, 'docs').trigger('click')
    expect(active.value).toBe(FILES[2]!.path)

    // no grammar: the text as it is (escaped, not HTML)
    active.value = 'docs/notes.txt'
    await flushPromises()
    expect(code(w)).toBe('plain <b>text</b>')
    expect(w.find('.code-viewer__body b').exists()).toBe(false)
  })

  it.each(['text', 'vue'])(
    'escapes active HTML before and after highlighting (%s)',
    async (language) => {
      const content =
        '<img src="x" onerror="alert(1)"><script>alert(1)</script><iframe src="https://evil.example"></iframe>'
      const { w } = viewer({ files: [{ path: 'payload', language, content }] })
      const escaped = () => {
        expect(code(w)).toBe(content)
        expect(w.find('.code-viewer__body').findAll('img, script, iframe')).toHaveLength(0)
      }
      escaped()
      await vi.waitFor(() =>
        expect(
          (w.find('.code-viewer__line span').attributes('style') ?? '').includes('--shiki-light'),
        ).toBe(language === 'vue'),
      )
      await flushPromises()
      escaped()
      w.unmount()
    },
  )

  it('one file: no tree; copies the shown file', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const success = vi.spyOn(ElMessage, 'success').mockReturnValue(undefined as never)
    const { w } = viewer({ files: [FILES[1]] })
    expect(w.find('.el-tree').exists()).toBe(false)
    await w.find('button[aria-label="Copy code"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('export class S {}')
    expect(success).toHaveBeenCalledWith('Copied')
    expect(w.find('button[aria-label="Copy code"] svg').exists()).toBe(true)
  })

  it('renders JSON tokens as escaped read-only text in either theme', async () => {
    const content = JSON.stringify(
      { html: '<script>alert(1)</script><img src=x onerror=alert(1)>' },
      null,
      2,
    )
    const { w } = viewer({ files: [{ path: 'value.json', content, language: 'json' }] })
    await vi.waitFor(() => expect(w.findAll('.code-viewer__line span').length).toBeGreaterThan(5))
    for (const dark of [false, true]) {
      document.documentElement.classList.toggle('dark', dark)
      expect(code(w)).toBe(content)
      expect(w.findAll('input, textarea, [contenteditable], script, img')).toHaveLength(0)
      expect(w.find('.el-tree').exists()).toBe(false)
      expect(w.find('.code-viewer__line span').attributes('style')).toContain('--shiki-light')
      expect(w.find('.code-viewer__line span').attributes('style')).toContain('--shiki-dark')
    }
    w.unmount()
  })

  it('keeps the plain JSON text when asynchronous highlighting fails', async () => {
    const failed = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error('highlighter unavailable'))
    vi.resetModules()
    vi.doMock('shiki/core', () => ({ createHighlighterCore: failed }))
    let w: VueWrapper | undefined
    try {
      const { default: FallbackViewer } = await import('@/core/components/CodeViewer.vue')
      const content = '{"html":"<script>alert(1)</script>"}'
      w = mount(FallbackViewer, {
        props: { files: [{ path: 'value.json', content, language: 'json' }] },
        global: { plugins: [ElementPlus, i18n] },
      })
      await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce())
      await flushPromises()
      expect(code(w)).toBe(content)
      expect(w.find('.code-viewer__line span').attributes('style')).toBeUndefined()
      expect(w.find('script').exists()).toBe(false)
    } finally {
      w?.unmount()
      vi.doUnmock('shiki/core')
      vi.resetModules()
    }
  })
})
