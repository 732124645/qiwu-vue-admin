// RichEditor: wangEditor-next as a v-model of HTML, image uploads under the public
// `richtext` tag, the editor language following setLocale(), against the fake backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus, { ElMessage } from 'element-plus'
import { DomEditor, t as editorT, type IDomEditor } from '@wangeditor-next/editor'
import RichEditor from '@/core/components/RichEditor.vue'
import { htmlText } from '@/core/html'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { mockApi, ok } from './mock-api'

type Insert = (url: string, alt: string, href: string) => void
type Upload = (file: File, insert: Insert) => Promise<void>

function editorOf(w: ReturnType<typeof mount>): IDomEditor {
  const e = (w.findComponent(RichEditor).vm as unknown as { editor?: IDomEditor }).editor
  if (!e) throw new Error('editor not created')
  return e
}

function withModel(initial = '', props: Record<string, unknown> = {}) {
  const model = ref(initial)
  const w = mount(
    defineComponent({
      setup: () => () =>
        h(RichEditor, {
          modelValue: model.value,
          'onUpdate:modelValue': (v: string | null) => (model.value = v ?? ''),
          ...props,
        }),
    }),
    { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
  )
  return { w, model }
}

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setLocale('en-US')
  accessToken.value = 'at'
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('RichEditor', () => {
  it('offers only menus whose output the server whitelist keeps', async () => {
    const { w } = withModel()
    await flushPromises()
    const keys = DomEditor.getToolbar(editorOf(w))?.getConfig().toolbarKeys ?? []
    expect(keys).toEqual(expect.arrayContaining(['bold', 'insertLink', 'uploadImage', 'codeBlock']))
    for (const styled of [
      'color',
      'bgColor',
      'fontSize',
      'fontFamily',
      'justifyCenter',
      'insertVideo',
    ])
      expect(keys).not.toContain(styled)
    const hover = editorOf(w).getConfig().hoverbarKeys ?? {}
    expect(hover.text?.menuKeys).not.toContain('color')
    expect(hover.image?.menuKeys).not.toContain('imageWidth50')
    w.unmount()
  })

  it('binds HTML both ways: the loaded value shows, edits come back, an empty editor is ""', async () => {
    const { w, model } = withModel('<p>hello</p>')
    await flushPromises()
    const editor = editorOf(w)
    expect(editor.getHtml()).toBe('<p>hello</p>')

    editor.setHtml('<p>changed <strong>bold</strong></p>')
    await nextTick()
    expect(model.value).toBe('<p>changed <strong>bold</strong></p>')

    model.value = '<h2>from outside</h2>'
    await flushPromises()
    expect(editor.getHtml()).toBe('<h2>from outside</h2>')

    editor.clear()
    await nextTick()
    expect(model.value).toBe('')
    w.unmount()
  })

  it('uploads images as public richtext objects and inserts them by URL; other files are refused', async () => {
    const calls = mockApi({
      'POST /storage/objects': ok({
        id: 3,
        originalName: 'a.png',
        mime: 'image/png',
        size: 4,
        url: '/files/richtext/a.png',
        isPublic: true,
        bizTag: 'richtext',
        createdAt: '2026-09-27T00:00:00.000Z',
      }),
    })
    const { w } = withModel()
    await flushPromises()
    const conf = editorOf(w).getMenuConfig('uploadImage') as unknown as {
      customUpload: Upload
      allowedFileTypes: string[]
    }
    expect(conf.allowedFileTypes).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    const insert = vi.fn<Insert>()

    await conf.customUpload(new File(['x'], 'a.png', { type: 'image/png' }), insert)
    expect((calls[0]!.data as FormData).get('bizTag')).toBe('richtext')

    await conf.customUpload(new File(['x'], 'evil.svg', { type: 'image/svg+xml' }), insert)
    expect(calls).toHaveLength(1)
    expect(insert).toHaveBeenCalledExactlyOnceWith('/files/richtext/a.png', 'a.png', '')
    expect(error).toHaveBeenLastCalledWith('"evil.svg" is not a PNG, JPG, GIF or WebP image')
    w.unmount()
  })

  it('follows setLocale(): a new editor in the new language, the text kept', async () => {
    const { w, model } = withModel('<p>kept</p>')
    await flushPromises()
    const first = editorOf(w)
    expect(editorT('editor.image')).toBe('Image')

    setLocale('zh-CN')
    await flushPromises()
    expect(editorT('editor.image')).toBe('图片')
    const second = editorOf(w)
    expect(second).not.toBe(first)
    expect(first.isDestroyed).toBe(true)
    expect(second.getHtml()).toBe('<p>kept</p>')
    expect(model.value).toBe('<p>kept</p>')
    w.unmount()
    expect(second.isDestroyed).toBe(true)
  })

  it('disabled: read-only until enabled again', async () => {
    const disabled = ref(true)
    const w = mount(
      defineComponent({
        setup: () => () => h(RichEditor, { modelValue: '<p>x</p>', disabled: disabled.value }),
      }),
      { global: { plugins: [ElementPlus, i18n] }, attachTo: document.body },
    )
    await flushPromises()
    expect(editorOf(w).isDisabled()).toBe(true)
    disabled.value = false
    await flushPromises()
    expect(editorOf(w).isDisabled()).toBe(false)
    w.unmount()
  })
})

describe('RichEditor toolbar names', () => {
  it('every icon button is named by its translated tooltip, in both languages', async () => {
    const names = async () => {
      await flushPromises()
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>('.rich-editor__toolbar button'),
      ]
      const icons = buttons.filter((b) => !b.textContent?.trim())
      expect(icons.length).toBeGreaterThan(10)
      for (const b of icons)
        expect(b.getAttribute('aria-label')).toBe(b.dataset.tooltip!.split('\n')[0])
      return document.querySelector('[data-menu-key="bold"]')!.getAttribute('aria-label')
    }
    const { w } = withModel('<p>x</p>')
    expect(await names()).toBe('Bold')
    setLocale('zh-CN')
    const zh = await names()
    expect(zh).toBeTruthy()
    expect(zh).not.toBe('Bold')
    w.unmount()
  })
})

describe('htmlText', () => {
  it('the text of rich text for a list cell: blocks apart, markup and whitespace gone', () => {
    expect(htmlText('<p>First</p><p>Second<br>line</p><ul><li>a</li><li>b</li></ul>')).toBe(
      'First Second line a b',
    )
    expect(htmlText('<p>a <strong>bold</strong>  word</p>')).toBe('a bold word')
    expect(htmlText(null)).toBe('')
  })
})
