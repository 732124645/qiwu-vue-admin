import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { MyInboxItemVo } from '@qiwu/shared'
import { accessToken } from '@/core/request/http'
import { useNotifyStore } from '@/core/stores/notify'
import { mockApi, ok } from './mock-api'

const message: MyInboxItemVo = {
  id: 1,
  category: 'system',
  senderLabel: null,
  title: 'Message',
  body: 'Body',
  readAt: null,
  createdAt: '2026-09-27T09:00:00.000Z',
}
const routes = () => ({
  'GET /messaging/bulletins/feed': ok({
    items: [
      { id: 2, title: 'Notice', kind: 'notice', publishedAt: message.createdAt, read: false },
    ],
    unread: 1,
  }),
  'GET /messaging/inboxes/mine': ok({ items: [message], total: 1 }),
  'GET /messaging/inboxes/mine/unread': ok({ unread: 1 }),
  'POST /messaging/bulletins/feed/2/read': ok({ unread: 0 }),
  'POST /messaging/bulletins/feed/read-all': ok({ unread: 0 }),
  'POST /messaging/inboxes/mine/1/read': ok({ unread: 0 }),
  'POST /messaging/inboxes/mine/read-all': ok({ unread: 0 }),
})

beforeEach(() => {
  setActivePinia(createPinia())
  accessToken.value = 'at'
})

describe('notify store', () => {
  it('loads both feeds, reads each independently, and resets both', async () => {
    const calls = mockApi(routes())
    const store = useNotifyStore()
    await store.load()
    expect(store.unread).toBe(2)
    expect(calls.find((c) => c.url === '/messaging/inboxes/mine')?.params).toMatchObject({
      page: 1,
      pageSize: 8,
      sort: '-createdAt,-id',
    })
    await store.readBulletin(2)
    expect(store.bulletinUnread).toBe(0)
    expect(store.inboxUnread).toBe(1)
    expect(store.bulletins[0]?.read).toBe(true)
    await store.readInbox(1)
    expect(store.inboxUnread).toBe(0)
    expect(store.inbox[0]?.readAt).toBeTruthy()
    await store.readAllBulletins()
    await store.readAllInbox()
    expect(store.unread).toBe(0)
    store.reset()
    expect(store.bulletins).toEqual([])
    expect(store.inbox).toEqual([])
  })

  it('increments synchronously on push, then reloads; older feed answers cannot erase a push or read', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    let asks = 0
    const base = routes()
    mockApi({
      ...base,
      // the first load answers last, with what it saw before the new message: it must be dropped
      'GET /messaging/inboxes/mine': async () => {
        if (++asks > 1) return ok({ items: [message], total: 1 })
        await gate
        return ok({ items: [], total: 0 })
      },
      'GET /messaging/inboxes/mine/unread': async () => {
        const stale = asks === 1
        if (stale) await gate
        return ok({ unread: stale ? 1 : 2 })
      },
    })
    const store = useNotifyStore()
    const old = store.loadInbox()
    store.onInboxNew({ id: 3, title: 'New' })
    expect(store.inboxUnread).toBe(1)
    await Promise.resolve()
    release()
    await old
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(store.inboxUnread).toBe(2)
    expect(store.inbox).toHaveLength(1)

    let releaseBulletin = () => {}
    const bulletinGate = new Promise<void>((resolve) => (releaseBulletin = resolve))
    mockApi({
      ...base,
      'GET /messaging/bulletins/feed': async () => (
        await bulletinGate,
        base['GET /messaging/bulletins/feed']
      ),
    })
    const stale = store.loadBulletins()
    await store.readBulletin(2)
    releaseBulletin()
    await stale
    expect(store.bulletinUnread).toBe(0)
    store.reset()
    expect(store.unread).toBe(0)
  })

  it('does not repopulate another session from a pending read', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const calls = mockApi({
      ...routes(),
      'POST /messaging/inboxes/mine/1/read': async () => (await gate, ok({ unread: 4 })),
    })
    const store = useNotifyStore()
    const pending = store.readInbox(1)
    store.reset()
    release()
    await pending
    expect(store.inboxUnread).toBe(0)
    expect(calls).toHaveLength(1)
  })
})
