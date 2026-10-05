// openDialog + DialogHost: results, cancel / close / ESC, nesting, route changes, app context.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { useI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElDialog } from 'element-plus'
import { dialogs, openDialog } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'

/** Dialog content: shows a translated word (app i18n inherited), ends with done(`result <label>`) or cancel. */
const Content = defineComponent({
  props: { label: { type: String, required: true } },
  emits: ['done', 'cancel'],
  setup(props, { emit }) {
    const { t } = useI18n()
    return () =>
      h('div', { class: `content-${props.label}` }, [
        t('crud.action.save'),
        h('button', { class: 'ok', onClick: () => emit('done', `result ${props.label}`) }),
        h('button', { class: 'no', onClick: () => emit('cancel') }),
      ])
  },
})

let router: Router
let host: VueWrapper
beforeEach(async () => {
  setLocale('zh-CN')
  const page = { render: () => null }
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: page },
      { path: '/other', component: page },
    ],
  })
  await router.push('/')
  host = mount(DialogHost, {
    // real transitions: el-dialog reports `close` / `closed` from their hooks
    global: { plugins: [ElementPlus, i18n, router], stubs: { transition: false } },
    attachTo: document.body,
  })
})
afterEach(() => {
  host.unmount()
  dialogs.splice(0)
})

const content = (label: string) =>
  host.findAllComponents(Content).find((c) => c.props('label') === label)
const dialogOf = (label: string) =>
  host.findAllComponents(ElDialog).find((d) => d.findComponent(Content).props('label') === label)

describe('openDialog', () => {
  it('resolves with the done result; the entry goes once the close animation ends', async () => {
    const result = openDialog<string>(
      Content,
      { label: 'a' },
      { title: () => i18n.global.t('crud.title.create', { name: 'X' }), width: 600 },
    )
    await flushPromises()
    expect(content('a')?.text()).toBe('保存')
    expect(dialogOf('a')?.props()).toMatchObject({ title: '新增X', width: 600, appendToBody: true })

    await content('a')?.find('.ok').trigger('click')
    await expect(result).resolves.toBe('result a')
    expect(dialogs.map((d) => d.visible)).toEqual([false])
    await vi.waitFor(() => expect(dialogs).toHaveLength(0))
  })

  it('cancel, the close button and ESC resolve undefined', async () => {
    const cancelled = openDialog(Content, { label: 'a' })
    await flushPromises()
    await content('a')?.find('.no').trigger('click')
    await expect(cancelled).resolves.toBeUndefined()

    const closed = openDialog(Content, { label: 'b' })
    await flushPromises()
    // the dialog is teleported to <body>: its own close button in the DOM
    document
      .querySelector('.content-b')
      ?.closest('.el-dialog')
      ?.querySelector<HTMLElement>('.el-dialog__headerbtn')
      ?.click()
    await expect(closed).resolves.toBeUndefined()

    const escaped = openDialog(Content, { label: 'c' })
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))
    await expect(escaped).resolves.toBeUndefined()
  })

  it('closeOnPressEscape false: ESC leaves it open (work in it kept); top passed on', async () => {
    const kept = openDialog(Content, { label: 'k' }, { closeOnPressEscape: false, top: '4vh' })
    await flushPromises()
    expect(dialogOf('k')?.props()).toMatchObject({ closeOnPressEscape: false, top: '4vh' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))
    await flushPromises()
    expect(dialogs.map((d) => d.visible)).toEqual([true])
    await content('k')?.find('.no').trigger('click')
    await expect(kept).resolves.toBeUndefined()
  })

  it('nests: the inner dialog ends on its own, the outer stays open', async () => {
    const outer = openDialog(Content, { label: 'outer' })
    await flushPromises()
    const inner = openDialog(Content, { label: 'inner' })
    await flushPromises()
    expect(dialogs.map((d) => d.visible)).toEqual([true, true])

    await content('inner')?.find('.ok').trigger('click')
    await expect(inner).resolves.toBe('result inner')
    expect(dialogs.map((d) => d.visible)).toEqual([true, false])

    // ESC closes only the top one
    const top = openDialog(Content, { label: 'top' })
    await flushPromises()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape' }))
    await expect(top).resolves.toBeUndefined()
    expect(dialogs.find((d) => d.visible)).toBe(dialogs[0])

    await content('outer')?.find('.ok').trigger('click')
    await expect(outer).resolves.toBe('result outer')
  })

  it('a route change closes the dialogs that did not opt out', async () => {
    const closes = openDialog(Content, { label: 'a' })
    const stays = openDialog(Content, { label: 'b' }, { closeOnRouteChange: false })
    await flushPromises()
    await router.push('/other')
    await flushPromises()
    await expect(closes).resolves.toBeUndefined()
    expect(dialogs.map((d) => d.visible)).toEqual([false, true])

    await content('b')?.find('.ok').trigger('click')
    await expect(stays).resolves.toBe('result b')
  })
})
