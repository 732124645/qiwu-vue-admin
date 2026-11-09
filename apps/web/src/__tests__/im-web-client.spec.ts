// Header chat entry: it probes GET /im/options and hides only on 404 (switch off, not in the tenant's
// package) or 403 (not a staff member); a 5xx or a network failure keeps it when this account has a local
// cache, and a 200 shows it with the unread total of the synced rooms (99+). Against the fake backend, an
// in-memory chat cache instead of IndexedDB and a fake realtime socket.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import { AxiosError } from 'axios'
import { RT, type ImRoomDetail } from '@qiwu/shared'
import { deleteDb, imCacheName, type ImCache } from '@qiwu/shared/im-client'
import ImHeaderEntry from '@/core/im/ImHeaderEntry.vue'
import { i18n, setLocale } from '@/core/i18n'
import { accessToken } from '@/core/request/http'
import { useAuthStore } from '@/core/stores/auth'
import { fail, me, mockApi, ok, type Route } from './mock-api'

/** Realtime handlers the store registered, by message type (a test delivers a push by calling one). */
const rt = vi.hoisted(() => ({ handlers: new Map<string, (payload: unknown) => void>() }))
vi.mock('@/core/realtime/socket', async () => ({
  realtimeUp: (await import('vue')).shallowRef(false),
  onRealtime: (type: string, fn: (payload: unknown) => void) => {
    rt.handlers.set(type, fn)
    return () => undefined
  },
}))

/**
 * The cache the store opens: a memory cache, seeded per test (IndexedDB does not exist here); `onClosed` is the
 * store's callback for a connection another tab closed.
 */
const seeded = vi.hoisted(() => ({
  cache: null as ImCache | null,
  onClosed: null as (() => void) | null,
}))
vi.mock('@qiwu/shared/im-client', async (original) => {
  const mod = await original<typeof import('@qiwu/shared/im-client')>()
  return {
    ...mod,
    openIdbCache: async (name: string, options?: { onClosed?: () => void }) => {
      seeded.onClosed = options?.onClosed ?? null
      return seeded.cache ?? mod.createMemoryCache(name)
    },
    deleteDb: vi.fn<(name: string) => Promise<void>>(async () => {}),
  }
})

const OPTIONS = {
  textMaxChars: 5000,
  fileMaxMb: 20,
  fileExts: ['pdf'],
  imageExts: ['png'],
  recallMinutes: 2,
  editMinutes: 5,
  groupRecallAnytime: true,
  groupMaxMembers: 200,
  stickerMax: 100,
  epoch: 'e1',
}
const detail = (roomId: number, unread: number): ImRoomDetail => ({
  roomId,
  periodId: roomId * 10,
  kind: 'direct',
  label: null,
  peerId: 2,
  memberCount: 2,
  closedAt: null,
  role: 'participant',
  visibleFromSeq: 1,
  lastSeq: unread,
  readSeq: 0,
  floorSeq: 1,
  metaRev: 1,
  lastAt: '2026-11-03T00:00:00.000Z',
  unread,
  preview: null,
})

/** The backend: `/options` answers `options`; two rooms with 3 and 120 unread. */
function backend(options: Route) {
  return mockApi({
    'POST /auth/logout': ok(null),
    'GET /im/options': options,
    'GET /im/sync': (config) =>
      config.params?.ids
        ? ok([detail(1, 3), detail(2, 120)])
        : [
            200,
            {
              code: 0,
              msg: 'ok',
              data: {
                epoch: 'e1',
                rooms: [
                  [1, 10, 3, 0, 1, 1],
                  [2, 20, 120, 0, 1, 1],
                ],
              },
            },
            { etag: 'W/"s1"' },
          ],
  })
}

let wrapper: VueWrapper
async function mountEntry() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { render: () => null } },
      { path: '/im/chat', name: 'im-chat', component: { render: () => null } },
    ],
  })
  await router.push('/')
  wrapper = mount(ImHeaderEntry, { global: { plugins: [ElementPlus, i18n, router] } })
  useAuthStore().me = me([])
  for (let i = 0; i < 5; i++) await flushPromises()
}
const button = () => wrapper.find('button.icon-button')
const urls = (calls: { method?: string; url?: string; params?: { ids?: string } }[]) =>
  calls.map(
    (c) => `${c.method?.toUpperCase()} ${c.url}${c.params?.ids ? `?ids=${c.params.ids}` : ''}`,
  )

beforeEach(() => {
  setActivePinia(createPinia())
  setLocale('en-US')
  accessToken.value = 'at'
  seeded.cache = null
  seeded.onClosed = null
})
afterEach(async () => {
  useAuthStore().me = null
  await flushPromises()
  wrapper.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setLocale('zh-CN')
})

describe('header chat entry', () => {
  it('stays hidden when the probe answers 404 (off or not in the package), without syncing', async () => {
    const calls = backend(fail(404, 'A0440'))
    await mountEntry()
    expect(button().exists()).toBe(false)
    expect(urls(calls)).toEqual(['GET /im/options'])
  })

  it('stays hidden for a 403 (not a staff member)', async () => {
    const calls = backend(fail(403, 'B5001'))
    await mountEntry()
    expect(button().exists()).toBe(false)
    expect(urls(calls)).toEqual(['GET /im/options'])
  })

  it('stays hidden on a 5xx without a local cache of this account', async () => {
    backend(fail(503, 'A0500'))
    await mountEntry()
    expect(button().exists()).toBe(false)
  })

  it('still shows on a 5xx or a network failure when this account has a local cache', async () => {
    const { createMemoryCache } =
      await vi.importActual<typeof import('@qiwu/shared/im-client')>('@qiwu/shared/im-client')
    for (const route of [
      fail(503, 'A0500'),
      ((config) => {
        throw new AxiosError('Network Error', 'ERR_NETWORK', config)
      }) satisfies Route,
    ]) {
      setActivePinia(createPinia())
      seeded.cache = createMemoryCache('qw-im-seeded')
      await seeded.cache.putMeta('epoch', 'e1')
      backend(route)
      await mountEntry()
      expect(button().exists()).toBe(true)
      wrapper.unmount()
      wrapper = mount({ render: () => null })
    }
  })

  it('shows on a 200 with the unread total of every room as 99+', async () => {
    const calls = backend(ok(OPTIONS))
    await mountEntry()
    await vi.waitFor(() => expect(wrapper.find('.el-badge__content').text()).toBe('99+'))
    // each room counts at most 100 (the server's per-room cap): 3 + 100, not 3 + 120
    expect(button().attributes('aria-label')).toBe('Chat, 103 unread')
    expect(urls(calls)).toEqual(['GET /im/options', 'GET /im/sync', 'GET /im/sync?ids=1,2'])
    expect(calls[1]!.headers['If-None-Match']).toBeUndefined()
  })
})

describe('clearing and reopening the local cache', () => {
  /** Signed in with a live chat (probe 200) over a memory cache whose deletion the test watches. */
  async function started() {
    // 直接交付外部关库后的通知，不依赖广播与 IndexedDB 两种事件的偶然调度顺序。
    let receive: ((event: MessageEvent) => void) | null = null
    const close = vi.fn<() => void>(() => {
      receive = null
    })
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        set onmessage(listener: (event: MessageEvent) => void) {
          receive = listener
        }
        postMessage = vi.fn<(value: unknown) => void>()
        close = close
      },
    )
    const { createMemoryCache } =
      await vi.importActual<typeof import('@qiwu/shared/im-client')>('@qiwu/shared/im-client')
    seeded.cache = createMemoryCache('qw-im-wired')
    const destroy = vi.spyOn(seeded.cache, 'destroy')
    const calls = backend(ok(OPTIONS))
    await mountEntry()
    await vi.waitFor(() => expect(button().exists()).toBe(true))
    const probes = () => urls(calls).filter((u) => u === 'GET /im/options').length
    const name = await imCacheName(location.origin, 1, 1)
    const notify = (type: 'reset' | 'wipe') =>
      receive?.(new MessageEvent('message', { data: { type, name } }))
    return { destroy, probes, name, notify, close }
  }

  it('a sign-out deletes this account’s cache', async () => {
    const { destroy } = await started()
    await useAuthStore().logout()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('a kick (session:kicked) deletes this account’s cache', async () => {
    const { destroy } = await started()
    rt.handlers.get(RT.sessionKicked)!({ sid: 's', reason: null })
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1))
  })

  it('a connection another tab closed stays locked until the explicit reset or wipe arrives', async () => {
    const { destroy, probes, close } = await started()
    expect(probes()).toBe(1)
    seeded.onClosed!()
    await flushPromises()
    expect(button().exists()).toBe(false)
    expect(probes()).toBe(1)
    expect(close).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
  })

  it('another tab’s explicit reset reopens a connection it closed, once for the same account', async () => {
    const { destroy, probes, notify } = await started()
    seeded.onClosed!()
    await flushPromises()
    notify('reset')
    await vi.waitFor(() => expect(probes()).toBe(2))
    expect(button().exists()).toBe(true)
    expect(destroy).not.toHaveBeenCalled()
  })

  it('another tab’s wipe after closing this connection deletes it without reopening', async () => {
    const { probes, name, notify, close } = await started()
    vi.mocked(deleteDb).mockClear()
    seeded.onClosed!()
    await flushPromises()
    notify('wipe')
    await flushPromises()
    expect(deleteDb).toHaveBeenCalledExactlyOnceWith(name)
    expect(close).toHaveBeenCalledTimes(1)
    expect(probes()).toBe(1)
    expect(button().exists()).toBe(false)
  })
})
