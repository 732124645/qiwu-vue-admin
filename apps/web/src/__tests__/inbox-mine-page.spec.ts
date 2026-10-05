import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import type { MyInboxItemVo } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useNotifyStore } from '@/core/stores/notify'
import InboxPage from '@/views/platform/messaging/inbox-mine/index.vue'
import { mockApi, ok } from './mock-api'

const row: MyInboxItemVo = {
  id: 5,
  category: 'business',
  senderLabel: 'Team',
  title: 'Report',
  body: '<b>plain</b>\nNext line',
  readAt: null,
  createdAt: '2026-09-27T09:00:00.000Z',
}
let page: VueWrapper
let host: VueWrapper
const body = () => new DOMWrapper(document.body)
const rows = () => page.findAll('.el-table__body .el-table__row')
const callsFor = <T extends { url?: string }>(calls: T[], url: string) =>
  calls.filter((c) => c.url === url)

async function mountPage() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null }, meta: { title: 'notify.inbox.pageTitle' } },
    ],
  })
  await router.push('/')
  const global = { plugins: [ElementPlus, i18n, router], stubs: { transition: false } }
  host = mount(DialogHost, { global, attachTo: document.body })
  page = mount(InboxPage, { global, attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = 'at'
  setLocale('en-US')
})
afterEach(() => {
  page.unmount()
  host.unmount()
  dialogs.splice(0)
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('my inbox page', () => {
  it('lists newest messages with filters, opens plain text, and marks a row read', async () => {
    let readAt: string | null = null
    const calls = mockApi({
      'GET /messaging/inboxes/mine': () => ok({ items: [{ ...row, readAt }], total: 1 }),
      'GET /messaging/inboxes/mine/unread': ok({ unread: 1 }),
      'GET /messaging/inboxes/mine/5': ok(row),
      'POST /messaging/inboxes/mine/5/read': () => ((readAt = row.createdAt), ok({ unread: 0 })),
    })
    await mountPage()
    expect(callsFor(calls, '/messaging/inboxes/mine')[0]?.params).toMatchObject({
      page: 1,
      sort: '-createdAt,-id',
    })
    expect(rows()).toHaveLength(1)
    expect(rows()[0]!.text()).toContain('Unread')
    expect(rows()[0]!.text()).toContain('Business')
    expect(rows()[0]!.text()).toContain('Team')

    await page.findAll('.el-select')[0]!.trigger('click')
    await body()
      .findAll('.el-select-dropdown__item')
      .find((x) => x.text() === 'Unread only')!
      .trigger('click')
    await page.findAll('.el-select')[1]!.trigger('click')
    await body()
      .findAll('.el-select-dropdown__item')
      .find((x) => x.text() === 'Business')!
      .trigger('click')
    await page.find('.qw-search-panel form').trigger('submit')
    await flushPromises()
    expect(callsFor(calls, '/messaging/inboxes/mine').at(-1)?.params).toMatchObject({
      unread: 'true',
      category: 'business',
      page: 1,
    })

    await rows()[0]!
      .findAll('button')
      .find((b) => b.text() === 'View')!
      .trigger('click')
    await flushPromises()
    expect(body().find('.inbox-message-view__body').text()).toContain('<b>plain</b>')
    expect(body().find('.inbox-message-view__body b').exists()).toBe(false)
    expect(callsFor(calls, '/messaging/inboxes/mine/5/read')).toHaveLength(1)
    expect(rows()[0]!.text()).toContain('Read')
    expect(useNotifyStore().inboxUnread).toBe(0)
  })

  it('marks all read, refreshes the list, and shows the empty state', async () => {
    let items = [row]
    const calls = mockApi({
      'GET /messaging/inboxes/mine': () => ok({ items, total: items.length }),
      'GET /messaging/inboxes/mine/unread': ok({ unread: 1 }),
      'POST /messaging/inboxes/mine/read-all': () => ((items = []), ok({ unread: 0 })),
    })
    await mountPage()
    expect(rows()).toHaveLength(1)
    await page
      .findAll('button')
      .find((b) => b.text() === 'Mark all as read')!
      .trigger('click')
    await flushPromises()
    expect(callsFor(calls, '/messaging/inboxes/mine/read-all')).toHaveLength(1)
    expect(useNotifyStore().inboxUnread).toBe(0)
    expect(rows()).toHaveLength(0)
    expect(page.find('.empty-state').exists()).toBe(true)
  })
})
