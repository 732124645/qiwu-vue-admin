import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { ElMessage } from 'element-plus'
import { REALTIME_EVENT, REALTIME_UNAUTHORIZED, RT } from '@qiwu/shared'
import { setLocale } from '@/core/i18n'
import { onRealtime, realtimeStatus, realtimeUp, startRealtime } from '@/core/realtime/socket'
import { accessToken, refreshAccessToken, setSessionHint } from '@/core/request/http'

/** A fake Socket.IO client: records its options, listeners and close; `active` = it will retry. */
class FakeSocket {
  listeners = new Map<string, (arg: unknown) => void>()
  closed = false
  active = true
  constructor(readonly opts: { transports: string[]; auth: (cb: (a: unknown) => void) => void }) {}
  on(event: string, fn: (arg: unknown) => void) {
    this.listeners.set(event, fn)
    return this
  }
  close() {
    this.closed = true
  }
  fire(event: string, arg?: unknown) {
    this.listeners.get(event)?.(arg)
  }
  handshake() {
    let auth: unknown
    this.opts.auth((a) => (auth = a))
    return auth
  }
}
const sockets = vi.hoisted(() => [] as unknown[])
const last = () => sockets.at(-1) as FakeSocket
vi.mock('socket.io-client', () => ({
  io: (opts: FakeSocket['opts']) => {
    const s = new FakeSocket(opts)
    sockets.push(s)
    return s
  },
}))

const nav = vi.hoisted(() => ({
  route: { fullPath: '/iam/users?page=2', meta: {} as { public?: boolean } },
  push: vi.fn<(to: unknown) => Promise<void>>(async () => undefined),
}))
vi.mock('@/core/router', () => ({
  default: {
    currentRoute: {
      get value() {
        return nav.route
      },
    },
    push: nav.push,
  },
}))
vi.mock('element-plus', () => ({
  ElMessage: { warning: vi.fn<(m: string) => void>(), error: vi.fn<(m: string) => void>() },
  ElMessageBox: { confirm: vi.fn<() => Promise<string>>() },
}))
vi.mock('@/core/request/http', async (orig) => ({
  ...(await orig<typeof import('@/core/request/http')>()),
  refreshAccessToken: vi.fn<() => Promise<void>>(async () => undefined),
}))

beforeAll(() => {
  setActivePinia(createPinia())
  accessToken.value = ''
  startRealtime()
})
beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
})

describe('realtime socket', () => {
  it('connects on a token with {token, lang}, reconnects with each new one, closes on sign-out', () => {
    expect(sockets).toEqual([])
    setLocale('en-US')
    accessToken.value = 'at-1'
    const first = last()
    expect(first.opts.transports).toEqual(['websocket'])
    expect(first.handshake()).toEqual({ token: 'at-1', lang: 'en-US' })
    accessToken.value = 'at-2'
    expect(first.closed).toBe(true)
    expect(last().handshake()).toEqual({ token: 'at-2', lang: 'en-US' })
    const second = last()
    accessToken.value = ''
    expect(second.closed).toBe(true)
    expect(sockets).toHaveLength(2)
    setLocale('zh-CN')
  })

  it('routes envelopes on type; unsubscribes by the returned off or when the scope ends', () => {
    accessToken.value = 'at-3'
    const a = vi.fn<(p: unknown) => void>()
    const b = vi.fn<(p: unknown) => void>()
    const off = onRealtime(RT.notifyNew, a)
    const scope = effectScope()
    scope.run(() => onRealtime(RT.notifyNew, b))
    last().fire(REALTIME_EVENT, { type: RT.notifyNew, payload: { id: 7, title: 'New message' } })
    expect(a).toHaveBeenCalledWith({ id: 7, title: 'New message' })
    expect(b).toHaveBeenCalledWith({ id: 7, title: 'New message' })
    off()
    scope.stop()
    last().fire(REALTIME_EVENT, {
      type: RT.notifyNew,
      payload: { id: 8, title: 'Another message' },
    })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a handshake refusal refreshes once; the next refusal waits for a successful connect', () => {
    accessToken.value = 'at-4'
    last().fire('connect_error', new Error('websocket error'))
    expect(refreshAccessToken).not.toHaveBeenCalled()
    last().fire('connect_error', new Error(REALTIME_UNAUTHORIZED))
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    accessToken.value = 'at-5'
    last().fire('connect_error', new Error(REALTIME_UNAUTHORIZED))
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    last().fire('connect')
    last().fire('connect_error', new Error(REALTIME_UNAUTHORIZED))
    expect(refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it('session:kicked: notice, session dropped (the shared refresh hint kept), sign-in page with the way back', () => {
    setSessionHint(true)
    accessToken.value = 'at-6'
    const s = last()
    s.fire(REALTIME_EVENT, { type: RT.sessionKicked, payload: { sid: 'x' } })
    expect(ElMessage.warning).toHaveBeenCalledOnce()
    expect(accessToken.value).toBe('')
    expect(s.closed).toBe(true)
    // another tab may hold a live session on the shared cookie
    expect(localStorage.getItem('qw.auth.session')).toBe('1')
    expect(nav.push).toHaveBeenCalledWith({
      path: '/login',
      query: { redirect: '/iam/users?page=2' },
    })
  })

  it('realtimeUp follows the current socket: up on connect, down on its disconnect, a new token or sign-out', () => {
    accessToken.value = 'at-7'
    const s = last()
    expect(realtimeUp.value).toBe(false)
    s.fire('connect')
    expect(realtimeUp.value).toBe(true)
    s.fire('disconnect', 'transport close')
    expect(realtimeUp.value).toBe(false)
    s.fire('connect')
    accessToken.value = 'at-8'
    expect(realtimeUp.value).toBe(false)
    last().fire('connect')
    // the replaced socket's late disconnect changes nothing
    s.fire('disconnect', 'io client disconnect')
    expect(realtimeUp.value).toBe(true)
    accessToken.value = ''
    expect(realtimeUp.value).toBe(false)
  })

  it('realtimeStatus: reconnecting while opening or retrying, up on connect, down once nothing retries', async () => {
    accessToken.value = 'at-9'
    const s = last()
    expect(realtimeStatus.value).toBe('reconnecting')
    s.fire('connect')
    expect(realtimeStatus.value).toBe('up')
    s.fire('disconnect', 'transport close')
    expect(realtimeStatus.value).toBe('reconnecting')
    s.fire('connect_error', new Error('websocket error'))
    expect(realtimeStatus.value).toBe('reconnecting')
    s.fire('connect')
    s.active = false
    s.fire('disconnect', 'io server disconnect')
    expect(realtimeStatus.value).toBe('down')
    // refused: reconnecting while its one refresh runs, down when that fails
    vi.mocked(refreshAccessToken).mockRejectedValueOnce(new Error('expired'))
    accessToken.value = 'at-10'
    const r = last()
    r.active = false
    r.fire('connect_error', new Error(REALTIME_UNAUTHORIZED))
    expect(realtimeStatus.value).toBe('reconnecting')
    await vi.waitFor(() => expect(realtimeStatus.value).toBe('down'))
    r.fire('connect_error', new Error(REALTIME_UNAUTHORIZED))
    expect(realtimeStatus.value).toBe('down')
    // the replaced socket's late events change nothing
    accessToken.value = 'at-11'
    last().fire('connect')
    r.fire('connect_error', new Error('websocket error'))
    s.fire('disconnect', 'transport close')
    expect(realtimeStatus.value).toBe('up')
    accessToken.value = ''
    expect(realtimeStatus.value).toBe('down')
  })
})
