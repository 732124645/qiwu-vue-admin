// An iframe menu page kept alive (see docs/design-notes.md#layering): its frame stays in the document while another tag shows.
// `<keep-alive>` parks a page in a detached node, and a detached iframe loses its document (it reloads when
// shown again): so AppLayout keeps the frames itself.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import ElementPlus from 'element-plus'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'
import { i18n, setLocale } from '@/core/i18n'
import AppLayout from '@/core/layout/AppLayout.vue'
import { LAYOUT, syncMenuRoutes } from '@/core/router'
import { useMenuStore } from '@/core/stores/menu'
import { useAppStore } from '@/core/stores/app'
import { useAuthStore } from '@/core/stores/auth'
import { useTagsStore } from '@/core/stores/tags'
import { me, node } from './mock-api'

let router: Router
let wrapper: VueWrapper
const frame = (src: string) => document.querySelector<HTMLIFrameElement>(`iframe[src="${src}"]`)
const go = async (path: string) => {
  await router.push(path)
  await flushPromises()
}

beforeEach(async () => {
  setActivePinia(createPinia())
  setLocale('en-US')
  useMenuStore().tree = [
    node({ id: 1, routePath: '/home', name: 'Home' }),
    node({
      id: 2,
      routePath: '/docs',
      name: 'menu.home',
      linkType: 'iframe',
      linkUrl: 'about:blank#docs',
      keepAlive: true,
      componentName: 'Docs',
    }),
    node({
      id: 3,
      routePath: '/other',
      name: 'x',
      nameI18n: { 'en-US': 'Other' },
      linkType: 'iframe',
      linkUrl: 'about:blank#o',
    }),
  ]
  router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: LAYOUT, component: AppLayout, children: [] }],
  })
  syncMenuRoutes(router, useMenuStore().routes)
  await router.push('/home')
  wrapper = mount(RouterView, {
    attachTo: document.body,
    global: {
      plugins: [ElementPlus, i18n, router],
      stubs: { HeaderBar: true, SideMenu: true, SettingsDrawer: true, AppLogo: true },
    },
  })
  await flushPromises()
})
afterEach(() => wrapper.unmount())

describe('AppLayout iframe pages', () => {
  it('binds the watermark to the current username without remounting a frame when toggled', async () => {
    const app = useAppStore()
    const auth = useAuthStore()
    expect(app.settings.watermark).toBe(false)
    auth.me = me(['*'])
    await go('/docs')
    const docs = frame('about:blank#docs')!
    const watermark = wrapper.findComponent({ name: 'ElWatermark' })
    expect(watermark.props('content')).toBe('')
    try {
      app.settings.watermark = true
      await flushPromises()
      expect(watermark.props('content')).toBe('admin')
      auth.me.user.username = 'another-user'
      await flushPromises()
      expect(watermark.props('content')).toBe('another-user')
      app.settings.watermark = false
      await flushPromises()
      expect(watermark.props('content')).toBe('')
      expect(frame('about:blank#docs')).toBe(docs)
      expect(docs.isConnected).toBe(true)
      app.settings.watermark = true
      auth.clear()
      await flushPromises()
      expect(watermark.props('content')).toBe('')
    } finally {
      app.settings.watermark = false
    }
  })

  it('resolves the watermark colour after useDark updates html.dark', async () => {
    const app = useAppStore()
    const original = app.dark
    const tokens = document.createElement('style')
    tokens.textContent = ':root { --qw-border: lightblue; } html.dark { --qw-border: navy; }'
    document.head.append(tokens)
    const watermark = wrapper.findComponent({ name: 'ElWatermark' })
    try {
      for (const dark of [!original, original, !original, original]) {
        app.dark = dark
        await flushPromises()
        expect(document.documentElement.classList.contains('dark')).toBe(dark)
        expect(watermark.props('font').color).toBe(dark ? 'navy' : 'lightblue')
      }
    } finally {
      tokens.remove()
      app.dark = original
      await flushPromises()
    }
  })

  it('keeps a kept-alive frame in the document, hidden, while another tag shows', async () => {
    await go('/docs')
    const docs = frame('about:blank#docs')!
    expect(docs.title).toBe(i18n.global.t('menu.home'))
    expect(docs.style.display).not.toBe('none')

    await go('/home')
    // the same element, still in the document: its page is not unloaded
    expect(docs.isConnected).toBe(true)
    expect(docs.style.display).toBe('none')

    await go('/docs')
    expect(frame('about:blank#docs')).toBe(docs)
    expect(docs.style.display).not.toBe('none')
  })

  it('drops the frame when its tag closes, and a page without keep-alive when left', async () => {
    await go('/other')
    // an admin-created name in the page language
    expect(frame('about:blank#o')?.title).toBe('Other')
    await go('/docs')
    expect(frame('about:blank#o')).toBeNull()

    await go('/home')
    useTagsStore().close((t) => t.path === '/docs')
    await flushPromises()
    expect(frame('about:blank#docs')).toBeNull()
  })
})
