// The form designer (see docs/design-notes.md#workflow) offers only what saving keeps. Every component left in its
// list makes a rule the whitelist (sanitizeFormSchema) takes as the designer adds it; the refused ones (an
// unknown type, the upload's `$FNX` onSuccess) and the groups they leave empty are hidden. Embedded or kept
// alive in a page not shown, it leaves no document hotkeys behind, and no `window.onbeforeunload` once gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, shallowRef, type Component } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import FcDesigner, { type DragRule } from '@form-create/designer'
import { sanitizeFormSchema } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import FormDesigner, {
  HIDDEN_MENUS,
  REFUSED_ITEMS,
} from '@/views/platform/formkit/FormDesigner.vue'

vi.mock('@/api/platform/settings/dict', () => ({ dictApi: { options: async () => [] } }))

const global = { plugins: [ElementPlus, i18n] }
beforeEach(() => setLocale('en-US'))
afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('FormDesigner component list', () => {
  it('every component it offers makes a rule the whitelist takes; the refused ones are hidden', async () => {
    const w = mount(FormDesigner, { global, attachTo: document.body })
    await flushPromises()
    const { menuList } = w.findComponent(FcDesigner).vm as unknown as {
      menuList: { name: string; list: DragRule[] }[]
    }
    const shown = menuList
      .filter((m) => !HIDDEN_MENUS.includes(m.name))
      .flatMap((m) => m.list.filter((d) => !REFUSED_ITEMS.includes(d.name)))
    expect(shown.map((d) => d.name)).toEqual(
      expect.arrayContaining([
        'input',
        'select',
        'datePicker',
        'qw-upload',
        'qw-date-range-days',
        'qw-detail-table',
      ]),
    )
    const refused = shown.filter((d) => {
      // the designer adds the field id
      const r = sanitizeFormSchema({ rule: [{ field: 'f', ...d.rule({ t: (k: string) => k }) }] })
      // the day count is saved once its date fields are named (calc_ref until then)
      return !r.ok && r.errors.some((e) => e.code !== 'calc_ref')
    })
    expect(refused.map((d) => d.name)).toEqual([])
    // hidden: the built-in upload (qw-upload is the one), rich text, raw html, layouts, …
    expect(REFUSED_ITEMS).toEqual(
      expect.arrayContaining(['upload', 'fcEditor', 'html', 'colorPicker', 'fcRow', 'elTabs']),
    )
    // a hidden group offered nothing the whitelist takes
    for (const m of menuList.filter((x) => HIDDEN_MENUS.includes(x.name)))
      expect(m.list.filter((d) => !REFUSED_ITEMS.includes(d.name))).toEqual([])
    w.unmount()
    expect(window.onbeforeunload).toBeNull()
  })

  it('embedded: no document hotkeys', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const w = mount(FormDesigner, { props: { schema: { rule: [] } }, global })
    await flushPromises()
    expect(add.mock.calls.map(([type]) => type)).not.toContain('paste')
    w.unmount()
  })

  it('kept alive: its hotkeys only while its page shows', async () => {
    const page = shallowRef<Component>(FormDesigner)
    const Other = { render: () => null }
    const Host = defineComponent({ setup: () => () => h(KeepAlive, null, [h(page.value)]) })
    const w = mount(Host, { global })
    await flushPromises()
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')
    const types = (spy: typeof add) => spy.mock.calls.map(([type]) => type)
    page.value = Other
    await nextTick()
    expect(types(remove)).toEqual(expect.arrayContaining(['keydown', 'paste']))
    page.value = FormDesigner
    await nextTick()
    expect(types(add)).toEqual(expect.arrayContaining(['keydown', 'paste']))
    w.unmount()
  })
})
