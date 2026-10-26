import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MyInboxItemVo } from '@qiwu/shared'
import { i18n, setLocale } from '@/core/i18n'
import { useAuthStore } from '@/core/stores/auth'
import { useMenuStore } from '@/core/stores/menu'
import InboxMessageView from '@/core/layout/InboxMessageView.vue'
import { me, node } from './mock-api'

let wrapper: VueWrapper | undefined
const message: MyInboxItemVo = {
  id: 1,
  category: 'business',
  senderLabel: null,
  title: 'Waiting',
  body: '<a href="https://outside.example.invalid">Open</a>',
  readAt: null,
  createdAt: '2026-10-27T00:00:00.000Z',
  action: { kind: 'agent-thread', threadId: 73 },
}

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  useAuthStore().me = me(['agent.chat.use'])
  useMenuStore().tree = [
    node({
      id: 1,
      routePath: '/agent/chat',
      routeName: 'agent-chat',
      component: 'platform/agent/chat/index',
    }),
  ]
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
  setLocale('zh-CN')
})

async function show(row: MyInboxItemVo = message) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/agent/chat', name: 'agent-chat', component: { render: () => null } },
    ],
  })
  await router.push('/')
  wrapper = mount(InboxMessageView, {
    props: { message: row },
    global: { plugins: [ElementPlus, i18n, router] },
  })
  return router
}

describe('inbox conversation action', () => {
  it('opens only the fixed internal thread route and keeps notification text literal', async () => {
    const router = await show()
    expect(wrapper!.find('.inbox-message-view__body a').exists()).toBe(false)
    expect(wrapper!.find('.inbox-message-view__body').text()).toBe(message.body)
    const button = wrapper!.findAll('button').find((b) => b.text() === 'Open conversation')!
    await button.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.fullPath).toBe('/agent/chat?thread=73')
    expect(wrapper!.emitted('cancel')).toHaveLength(1)
  })

  it.each(['permission', 'disabled', 'legacy', 'invalid', 'external'] as const)(
    'has no action for %s',
    async (kind) => {
      const row = { ...message }
      if (kind === 'permission') useAuthStore().me = me([])
      if (kind === 'disabled') useMenuStore().tree = []
      if (kind === 'legacy') delete row.action
      if (kind === 'invalid')
        row.action = { kind: 'agent-thread', threadId: Number.MAX_SAFE_INTEGER + 1 }
      if (kind === 'external')
        row.action = {
          kind: 'url',
          url: 'https://outside.example.invalid',
        } as unknown as MyInboxItemVo['action']
      await show(row)
      expect(wrapper!.findAll('button').map((button) => button.text())).toEqual(['Close'])
    },
  )

  it('disables repeat navigation while the internal route is loading', async () => {
    const router = await show()
    let finish!: (value: undefined) => void
    const push = vi.spyOn(router, 'push').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const button = wrapper!.findAll('button')[0]!
    await button.trigger('click')
    await button.trigger('click')
    expect(button.attributes('disabled')).toBeDefined()
    expect(push).toHaveBeenCalledTimes(1)
    finish(undefined)
    await flushPromises()
    expect(wrapper!.emitted('cancel')).toHaveLength(1)
  })
})
