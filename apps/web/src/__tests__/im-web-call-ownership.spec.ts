import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import type { ImCall } from '@qiwu/shared'
import { emptyImMediaSnapshot, type ImCallApi } from '@qiwu/shared/im-client'
import type { ImMediaSnapshot } from '@qiwu/shared/im-media'

interface ImHost {
  enabled: boolean
  leader: boolean
  state: string
  options: { epoch: string; callEnabled: boolean; callConfigured: boolean }
}
interface AuthHost {
  locked: boolean
  mustChangePassword: boolean
  me: { user: { id: number } }
  tenant: { id: number }
}
const state = vi.hoisted(() => ({
  im: null as ImHost | null,
  auth: null as AuthHost | null,
  api: null as ImCallApi | null,
}))
vi.mock('@/core/stores/auth', () => ({ useAuthStore: () => state.auth }))
vi.mock('@/core/im/im-store', () => ({ useImStore: () => state.im }))
vi.mock('@/api/platform/im', () => ({
  get imCallApi() {
    return state.api
  },
}))
vi.mock('@/core/realtime/socket', () => ({ onRealtime: vi.fn<() => void>() }))
vi.mock('@/core/im/voice', () => ({ stopImVoice: vi.fn<() => void>() }))
vi.mock('@vueuse/core', () => ({
  useEventListener: vi.fn<() => void>(),
  useIntervalFn: vi.fn<() => void>(),
}))
vi.mock('@qiwu/shared/im-media', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qiwu/shared/im-media')>()),
  createBrowserMediaPort: () => {
    let snapshot = emptyImMediaSnapshot()
    return {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      disconnect: vi.fn<() => Promise<ImMediaSnapshot>>(async () => {
        snapshot = emptyImMediaSnapshot()
        return snapshot
      }),
      connect: vi.fn<() => Promise<ImMediaSnapshot>>(async () => {
        snapshot = { ...emptyImMediaSnapshot(), connectionId: 'media-one', state: 'connected' }
        return snapshot
      }),
    }
  },
}))
let useStore: typeof import('@/core/im/calls-store').useImCallsStore
const call: ImCall = {
  id: 1,
  roomId: 10,
  mode: 'audio',
  state: 'ringing',
  callerId: 1,
  rev: 1,
  createdAt: '2026-01-01',
  startedAt: null,
  endedAt: null,
  inviteExpiresAt: '2026-01-01',
  endReason: null,
  canAccept: true,
  canDecline: true,
  canJoin: true,
  canLeave: true,
  canEnd: true,
  members: [],
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { locks: {} })
  setActivePinia(createPinia())
  state.im = reactive({
    enabled: true,
    leader: false,
    state: 'ready',
    options: { epoch: 'one', callEnabled: true, callConfigured: true },
  })
  state.auth = reactive({
    locked: false,
    mustChangePassword: false,
    me: { user: { id: 1 } },
    tenant: { id: 1 },
  })
  state.api = {
    active: vi.fn<ImCallApi['active']>(async () => []),
    get: vi.fn<ImCallApi['get']>(async () => call),
    create: vi.fn<ImCallApi['create']>(async () => call),
    accept: vi.fn<ImCallApi['accept']>(async () => call),
    decline: vi.fn<ImCallApi['decline']>(async () => call),
    join: vi.fn<ImCallApi['join']>(async () => ({
      call,
      url: 'wss://example.test',
      token: 'runtime-only',
      identity: 'staff-1',
      expiresAt: '2026-01-01',
    })),
    leave: vi.fn<ImCallApi['leave']>(async () => call),
    end: vi.fn<ImCallApi['end']>(async () => call),
    heartbeat: vi.fn<ImCallApi['heartbeat']>(async () => call),
  }
  useStore = (await import('@/core/im/calls-store')).useImCallsStore
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each(['create', 'accept', 'decline', 'join', 'end'] as const)(
  'checks current tab ownership for a stale UI %s action',
  async (name) => {
    const store = useStore()
    if (name === 'create') await store.controller.start(10, 'audio')
    else await store.controller[name](call)
    expect(state.api![name]).not.toHaveBeenCalled()
    state.im!.leader = true
    if (name === 'create') await store.controller.start(10, 'audio')
    else await store.controller[name](call)
    expect(state.api![name]).toHaveBeenCalledTimes(1)
    store.controller.dispose()
  },
)
