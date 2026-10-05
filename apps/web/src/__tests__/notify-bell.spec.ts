// Header bell (see docs/design-notes.md#layering): the bulletin feed's unread badge and latest list, the detail dialog with
// the server-sanitized body, read on open, read all, refresh on push / reconnect / poll (socket down
// only) / focus, against the fake backend and a fake realtime socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus, { ElBadge, ElMessage } from 'element-plus'
import { type BulletinFeedItem, type MyInboxItemVo, RT } from '@qiwu/shared'
import { dialogs } from '@/core/dialog'
import DialogHost from '@/core/dialog/DialogHost.vue'
import { i18n, setLocale } from '@/core/i18n'
import NotifyBell from '@/core/layout/NotifyBell.vue'
import { realtimeUp } from '@/core/realtime/socket'
import { accessToken } from '@/core/request/http'
import { fail, mockApi, ok, type Route } from './mock-api'

/** The fake socket: `realtimeUp` as a plain ref, subscriptions kept by type so a test can push. */
const pushes = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
vi.mock('@/core/realtime/socket', async () => ({
  realtimeUp: (await import('vue')).shallowRef(false),
  onRealtime: (type: string, fn: (payload: unknown) => void) => {
    pushes.set(type, fn)
    return () => pushes.delete(type)
  },
}))

const item = (id: number, read: boolean): BulletinFeedItem => ({
  id,
  title: `Notice ${id}`,
  kind: 'notice',
  publishedAt: '2026-09-27T08:00:00.000Z',
  read,
})
const BODY = '<p>Hello <strong>all</strong>, see <a href="https://example.com/x">this</a></p>'
const message = (id: number, readAt: string | null = null): MyInboxItemVo => ({
  id,
  title: `Message ${id}`,
  category: 'system',
  senderLabel: null,
  body: '<b>x</b>\nSecond line',
  readAt,
  createdAt: '2026-09-27T09:00:00.000Z',
})

/** A fake feed with 3 bulletins, 7 and 8 unread; read / read-all answer the count left. */
function backend(extra: Record<string, Route> = {}) {
  const items = [item(8, false), item(7, false), item(6, true)]
  const messages: MyInboxItemVo[] = []
  const unread = () => items.filter((i) => !i.read).length
  const calls = mockApi({
    'GET /messaging/bulletins/feed': () =>
      ok({ items: items.map((i) => ({ ...i })), unread: unread() }),
    'GET /messaging/bulletins/feed/7': ok({ ...item(7, false), body: BODY }),
    'GET /messaging/bulletins/feed/6': ok({ ...item(6, true), body: '<p>old</p>' }),
    'POST /messaging/bulletins/feed/7/read': () => {
      items[1]!.read = true
      return ok({ unread: unread() })
    },
    'POST /messaging/bulletins/feed/read-all': () => {
      items.forEach((i) => (i.read = true))
      return ok({ unread: 0 })
    },
    'GET /messaging/inboxes/mine': () =>
      ok({ items: messages.map((m) => ({ ...m })), total: messages.length }),
    'GET /messaging/inboxes/mine/unread': () =>
      ok({ unread: messages.filter((m) => !m.readAt).length }),
    'GET /messaging/inboxes/mine/1': () => ok({ ...messages[0] }),
    'POST /messaging/inboxes/mine/1/read': () => {
      messages[0]!.readAt = '2026-09-27T10:00:00.000Z'
      return ok({ unread: messages.filter((m) => !m.readAt).length })
    },
    'POST /messaging/inboxes/mine/read-all': () => {
      messages.forEach((m) => (m.readAt = '2026-09-27T10:00:00.000Z'))
      return ok({ unread: 0 })
    },
    'GET /settings/dicts/messaging.bulletin_kind/entries': ok({
      version: 1,
      entries: [
        {
          value: 'notice',
          label: 'Notice',
          labelI18n: { 'en-US': 'Notice' },
          tagType: 'primary',
          cssClass: null,
          isDefault: false,
          sortNo: 0,
        },
      ],
    }),
    ...extra,
  })
  return { calls, messages }
}
const urls = (calls: { method?: string; url?: string }[]) =>
  calls
    .map((c) => `${c.method?.toUpperCase()} ${c.url}`)
    .filter((u) => u.includes('bulletins/feed'))
const inboxUrls = (calls: { method?: string; url?: string }[]) =>
  calls.map((c) => `${c.method?.toUpperCase()} ${c.url}`).filter((u) => u.includes('inboxes/mine'))

let host: VueWrapper
let bell: VueWrapper
async function mountBell() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  await router.push('/')
  const global = { plugins: [ElementPlus, i18n, router], stubs: { transition: false } }
  host = mount(DialogHost, { global, attachTo: document.body })
  bell = mount(NotifyBell, { global, attachTo: document.body })
  await flushPromises()
}
const body = () => new DOMWrapper(document.body)
const badge = () => bell.find('.el-badge__content')
const trigger = () => bell.find('button.icon-button')
/** Clicks the bell; the popover opens on a (zero) timer, then reloads the feed. */
async function openList() {
  await trigger().trigger('click')
  await vi.waitFor(() => expect(trigger().attributes('aria-expanded')).toBe('true'))
  await flushPromises()
}
const entry = (title: string) =>
  body()
    .findAll('.notify-bell__item')
    .find((b) => b.text().includes(title))!

let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  realtimeUp.value = false
  error = vi.spyOn(ElMessage, 'error').mockReturnValue(undefined as never)
})
afterEach(() => {
  bell.unmount()
  host.unmount()
  dialogs.splice(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  setLocale('zh-CN')
})

describe('NotifyBell', () => {
  it('shows the unread count on the bell and the latest bulletins, unread ones marked', async () => {
    const { calls } = backend()
    await mountBell()
    expect(badge().text()).toBe('2')
    expect(trigger().attributes('aria-label')).toBe('Notifications, 2 unread')

    await openList()
    expect(
      body()
        .findAll('.notify-bell__title')
        .map((n) => n.text()),
    ).toEqual(['Notice 8', 'Notice 7', 'Notice 6'])
    expect(body().findAll('.notify-bell__item.is-unread')).toHaveLength(2)
    expect(entry('Notice 8').find('[aria-label="Unread"]').exists()).toBe(true)
    expect(entry('Notice 8').text()).toContain('Notice')
    // opening the list reloads the feed
    expect(urls(calls)).toEqual(['GET /messaging/bulletins/feed', 'GET /messaging/bulletins/feed'])
  })

  it('opens one in a dialog with its sanitized HTML as is, then marks it read', async () => {
    const { calls } = backend()
    await mountBell()
    await openList()
    await entry('Notice 7').trigger('click')
    await flushPromises()

    const dialog = body().find('.el-dialog')
    expect(dialog.find('.el-dialog__title').text()).toBe('Notice 7')
    expect(dialog.find('.bulletin-view__body').html()).toContain(BODY)
    expect(dialog.find('.bulletin-view__body strong').text()).toBe('all')
    expect(urls(calls).slice(-2)).toEqual([
      'GET /messaging/bulletins/feed/7',
      'POST /messaging/bulletins/feed/7/read',
    ])
    expect(badge().text()).toBe('1')

    // links leave for a new tab without a handle on this page
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    await dialog.find('.bulletin-view__body a').trigger('click')
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')

    await dialog.find('.qw-dialog-footer button').trigger('click')
    await vi.waitFor(() => expect(dialogs).toHaveLength(0))

    // a read one opens without another receipt
    await openList()
    await entry('Notice 6').trigger('click')
    await flushPromises()
    expect(urls(calls).filter((u) => u.startsWith('POST'))).toHaveLength(1)
  })

  it('marks all as read', async () => {
    backend()
    await mountBell()
    await openList()
    await body().find('.notify-bell__read-all').trigger('click')
    await flushPromises()
    expect(bell.findComponent(ElBadge).props('hidden')).toBe(true)
    expect(trigger().attributes('aria-label')).toBe('Notifications')
    expect(body().findAll('.notify-bell__item.is-unread')).toHaveLength(0)
    expect(body().find('.notify-bell__read-all').attributes('disabled')).toBeDefined()
  })

  it('a bulletin withdrawn meanwhile says so and reloads the feed', async () => {
    const { calls } = backend({
      'GET /messaging/bulletins/feed/8': fail(404, 'A0440', 'Not found'),
    })
    await mountBell()
    await openList()
    await entry('Notice 8').trigger('click')
    await flushPromises()
    expect(error).toHaveBeenCalledWith('Not found')
    expect(dialogs).toHaveLength(0)
    expect(urls(calls).at(-1)).toBe('GET /messaging/bulletins/feed')
  })

  it('polls every minute while visible, reloads on focus, and a failed load stays quiet', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let broken = false
    const { calls } = backend({
      'GET /messaging/bulletins/feed': () =>
        broken ? fail(500, 'Z0001') : ok({ items: [], unread: 3 }),
    })
    await mountBell()
    expect(badge().text()).toBe('3')

    vi.advanceTimersByTime(60_000)
    await flushPromises()
    window.dispatchEvent(new Event('focus'))
    await flushPromises()
    expect(urls(calls)).toHaveLength(3)

    broken = true
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(badge().text()).toBe('3')
    expect(error).not.toHaveBeenCalled()

    await openList()
    expect(body().find('.notify-bell__empty').text()).toBe('No bulletins yet')
  })

  it('a notify:bulletin push reloads the feed and the count at once', async () => {
    let unread = 1
    const { calls } = backend({ 'GET /messaging/bulletins/feed': () => ok({ items: [], unread }) })
    await mountBell()
    expect(badge().text()).toBe('1')
    unread = 4
    pushes.get(RT.notifyBulletin)!({ action: 'published', ids: [9] })
    await flushPromises()
    expect(badge().text()).toBe('4')
    expect(urls(calls)).toHaveLength(2)
  })

  it('polls only while the socket is down and reloads when it comes back', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { calls } = backend()
    await mountBell()
    expect(inboxUrls(calls)).toHaveLength(2)
    realtimeUp.value = true
    await flushPromises()
    expect(urls(calls)).toHaveLength(2)
    expect(inboxUrls(calls)).toHaveLength(4)
    vi.advanceTimersByTime(120_000)
    await flushPromises()
    expect(urls(calls)).toHaveLength(2)
    expect(inboxUrls(calls)).toHaveLength(4)

    realtimeUp.value = false
    vi.advanceTimersByTime(60_000)
    await flushPromises()
    expect(urls(calls)).toHaveLength(3)
    expect(inboxUrls(calls)).toHaveLength(6)
    realtimeUp.value = true
    await flushPromises()
    expect(urls(calls)).toHaveLength(4)
    expect(inboxUrls(calls)).toHaveLength(8)
  })

  it('shows messages, renders their body as text, and reads one once', async () => {
    const { calls, messages } = backend()
    messages.push(message(1))
    await mountBell()
    expect(badge().text()).toBe('3')
    await openList()
    await body().find('#tab-inbox').trigger('click')
    expect(body().find('#tab-inbox').text()).toContain('1')
    expect(entry('Message 1').find('[aria-label="Unread"]').exists()).toBe(true)
    expect(entry('Message 1').text()).toContain('System')
    await entry('Message 1').trigger('click')
    await flushPromises()
    const dialog = body().find('.el-dialog')
    expect(dialog.find('.el-dialog__title').text()).toBe('Message 1')
    expect(dialog.find('.inbox-message-view__body').text()).toContain('<b>x</b>')
    expect(dialog.find('.inbox-message-view__body b').exists()).toBe(false)
    expect(
      inboxUrls(calls).filter((u) => u === 'POST /messaging/inboxes/mine/1/read'),
    ).toHaveLength(1)
    expect(badge().text()).toBe('2')
  })

  it('a new message raises the badge before its reload answers', async () => {
    const { messages } = backend()
    messages.push(message(1))
    await mountBell()
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const latest = [message(2), message(1)]
    const calls = mockApi({
      'GET /messaging/inboxes/mine': async () => (await gate, ok({ items: latest, total: 2 })),
      'GET /messaging/inboxes/mine/unread': async () => (await gate, ok({ unread: 2 })),
    })
    pushes.get(RT.notifyNew)!({ id: 2, title: 'New' })
    await flushPromises()
    expect(badge().text()).toBe('4')
    release()
    await flushPromises()
    expect(inboxUrls(calls)).toEqual([
      'GET /messaging/inboxes/mine',
      'GET /messaging/inboxes/mine/unread',
    ])
    await openList()
    await body().find('#tab-inbox').trigger('click')
    expect(entry('Message 2').exists()).toBe(true)
  })

  it('reads all messages without reading bulletins', async () => {
    const { calls, messages } = backend()
    messages.push(message(1))
    await mountBell()
    await openList()
    await body().find('#tab-inbox').trigger('click')
    await body().find('.notify-bell__read-all').trigger('click')
    await flushPromises()
    expect(badge().text()).toBe('2')
    expect(urls(calls).filter((u) => u.startsWith('POST'))).toHaveLength(0)
    expect(inboxUrls(calls).filter((u) => u.startsWith('POST'))).toEqual([
      'POST /messaging/inboxes/mine/read-all',
    ])
  })

  it('reports a message that disappeared and reloads the inbox', async () => {
    const { calls, messages } = backend({
      'GET /messaging/inboxes/mine/1': fail(404, 'A0440', 'Message not found'),
    })
    messages.push(message(1))
    await mountBell()
    await openList()
    await body().find('#tab-inbox').trigger('click')
    await entry('Message 1').trigger('click')
    await flushPromises()
    expect(error).toHaveBeenCalledWith('Message not found')
    expect(dialogs).toHaveLength(0)
    expect(inboxUrls(calls).slice(-2)).toEqual([
      'GET /messaging/inboxes/mine',
      'GET /messaging/inboxes/mine/unread',
    ])
  })
})
