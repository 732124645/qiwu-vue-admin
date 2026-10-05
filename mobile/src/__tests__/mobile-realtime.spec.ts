// The app's socket. The real socket.io-client over a fake uni SocketTask the spec drives
// with engine.io v4 text frames: the transport and handshake, pushes reloading the counts, one refresh after a
// refused handshake, one socket at a time and sign-in / sign-out closing it, a kick, the fallback poll, and
// engine.io's globals swapped export for export.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import eioSource from 'socket.io-client/../engine.io-client/build/esm/globals.js?raw'
import * as eioGlobals from '@/core/eio-globals'
import { pollCounts, realtimeUp, startRealtime, stopRealtime } from '@/core/realtime'
import { hasSession, setSession } from '@/core/request'
import { useAuthStore } from '@/core/stores/auth'

/** A uni SocketTask whose server side the spec plays. */
interface Task {
  url: string
  fail?: (e: unknown) => void
  /** the frames the client sent */
  sent: string[]
  close: ReturnType<typeof vi.fn>
  open(): void
  recv(frame: string): void
}
const tasks: Task[] = []
const connectSocket = vi.fn((o: UniApp.ConnectSocketOption) => {
  const on: Record<string, (r?: unknown) => void> = {}
  const task: Task = {
    url: o.url,
    fail: o.fail,
    sent: [],
    close: vi.fn(),
    open: () => on.open?.(),
    recv: (data) => on.message?.({ data }),
  }
  tasks.push(task)
  return {
    onOpen: (cb: () => void) => (on.open = cb),
    onMessage: (cb: (r: unknown) => void) => (on.message = cb),
    onClose: (cb: () => void) => (on.close = cb),
    onError: (cb: () => void) => (on.error = cb),
    send: ({ data }: { data: string }) => task.sent.push(data),
    close: task.close,
  } as unknown as UniApp.SocketTask
})
Object.assign(uni, { connectSocket })
// H5: no API origin, the socket goes to the page's own (its proxy)
vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4175' })

/** the calls made, `METHOD /url` */
const calls: string[] = []
const COUNTS = [
  'GET /api/wf/tasks/todo',
  'GET /api/wf/instances/mine',
  'GET /api/messaging/inboxes/mine/unread',
]
const tokens = (n: number) => ({ accessToken: `a${n}`, refreshToken: `r${n}`, expiresIn: 1800 })
let issued = 1

const flush = () => new Promise((r) => setTimeout(r, 5))
const OPEN = '0{"sid":"s","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}'
const push = (type: string, payload: object) => `42${JSON.stringify(['message', { type, payload }])}`

/** The newest socket's server: opens, answers the client's CONNECT frame (returned) with `answer`. */
async function handshake(answer = '40{"sid":"x"}') {
  const task = tasks.at(-1)!
  task.open()
  task.recv(OPEN)
  await flush()
  const connect = task.sent.at(-1)
  task.recv(answer)
  await flush()
  return connect
}

beforeEach(() => {
  setActivePinia(createPinia())
  setSession(tokens(1))
  issued = 1
  calls.length = 0
  tasks.length = 0
  connectSocket.mockClear()
  vi.mocked(uni.showToast).mockClear()
  vi.mocked(uni.reLaunch).mockClear()
  // every call answers after a tick: sign-in and refresh with new tokens, counts with a page or a count
  vi.mocked(uni.request).mockImplementation((o) => {
    calls.push(`${o.method ?? 'GET'} ${o.url}`)
    const data = /\/auth\/(login|refresh)$/.test(o.url)
      ? tokens(++issued)
      : o.url.endsWith('/unread')
        ? { unread: 1 }
        : { items: [], total: 1 }
    setTimeout(() => o.success?.({ statusCode: 200, data: { code: 0, msg: 'ok', data } } as never))
    return {} as UniApp.RequestTask
  })
})

afterEach(() => {
  stopRealtime()
  vi.useRealTimers()
})

it('connects over uni.connectSocket with the access token and language; up and caught up once accepted', async () => {
  startRealtime()
  expect(connectSocket).toHaveBeenCalledTimes(1)
  // a callback: uni answers the SocketTask, not a Promise
  expect(tasks[0]!.url).toBe('ws://127.0.0.1:4175/socket.io/?EIO=4&transport=websocket')
  expect(tasks[0]!.fail).toBeTypeOf('function')
  expect(await handshake()).toBe('40{"token":"a1","lang":"zh-CN"}')
  expect(realtimeUp.value).toBe(true)
  expect(calls).toEqual(COUNTS)
})

it("uni's fail callback is a socket error: down, and Socket.IO tries again after its backoff", async () => {
  vi.useFakeTimers()
  startRealtime()
  tasks[0]!.fail!({ errMsg: 'connectSocket:fail' })
  expect(realtimeUp.value).toBe(false)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(tasks.length).toBeGreaterThan(1)
})

it('a to-do or new-message push reloads the counts; other pushes do not', async () => {
  startRealtime()
  await handshake()
  calls.length = 0
  tasks[0]!.recv(push('wf:task', { instanceId: 1 }))
  await flush()
  expect(calls).toEqual(COUNTS)
  calls.length = 0
  tasks[0]!.recv(push('notify:new', { id: 3, title: 'T' }))
  await flush()
  expect(calls).toEqual(COUNTS)
  calls.length = 0
  tasks[0]!.recv(push('notify:bulletin', { action: 'published', ids: [1] }))
  await flush()
  expect(calls).toEqual([])
})

it('a refused handshake: one refresh, then a new socket on the new token', async () => {
  startRealtime()
  await handshake('44{"message":"unauthorized"}')
  await flush()
  expect(calls).toEqual(['POST /api/auth/refresh'])
  expect(tasks[0]!.close).toHaveBeenCalled()
  expect(tasks).toHaveLength(2)
  expect(await handshake()).toBe('40{"token":"a2","lang":"zh-CN"}')
  expect(realtimeUp.value).toBe(true)
})

it('refused again after the refresh: the socket stays down, no second refresh', async () => {
  startRealtime()
  await handshake('44{"message":"unauthorized"}')
  await flush()
  await handshake('44{"message":"unauthorized"}')
  await flush()
  expect(calls).toEqual(['POST /api/auth/refresh'])
  expect(tasks).toHaveLength(2)
  expect(realtimeUp.value).toBe(false)
  // a foreign origin is not answered with a refresh either
  stopRealtime()
  startRealtime()
  await handshake('44{"message":"forbidden_origin"}')
  await flush()
  expect(calls).toEqual(['POST /api/auth/refresh'])
})

it('one socket at a time and none without a session; stop, sign-in and sign-out close it', async () => {
  startRealtime()
  startRealtime()
  expect(tasks).toHaveLength(1)
  await handshake()
  stopRealtime()
  await flush()
  expect(tasks[0]!.close).toHaveBeenCalled()
  expect(realtimeUp.value).toBe(false)

  setSession(null)
  startRealtime()
  expect(tasks).toHaveLength(1)

  const auth = useAuthStore()
  setSession(tokens(1))
  startRealtime()
  await handshake()
  await auth.logout()
  await flush()
  expect(tasks[1]!.close).toHaveBeenCalled()
  expect(realtimeUp.value).toBe(false)

  setSession(tokens(1))
  startRealtime()
  await handshake()
  await auth.login({ username: 'u', password: 'p' })
  await flush()
  expect(tasks[2]!.close).toHaveBeenCalled()
  // the new user's socket opens on the tab page's show
  startRealtime()
  expect(tasks).toHaveLength(4)
})

it('a kick ends the session: the sign-in page, then the reason', async () => {
  startRealtime()
  await handshake()
  tasks[0]!.recv(push('session:kicked', { sid: 's' }))
  await flush()
  expect(hasSession()).toBe(false)
  expect(realtimeUp.value).toBe(false)
  expect(vi.mocked(uni.reLaunch).mock.calls[0]![0]).toMatchObject({ url: '/pages/login/index' })
  expect(uni.showToast).toHaveBeenCalledWith({
    title: '你已被管理员强制下线，请重新登录',
    icon: 'none',
  })
})

it('the fallback poll loads the counts only while the socket is down', async () => {
  pollCounts()
  expect(calls).toEqual(COUNTS)
  startRealtime()
  await handshake()
  calls.length = 0
  pollCounts()
  expect(calls).toEqual([])
  stopRealtime()
  pollCounts()
  expect(calls).toEqual(COUNTS)
})

it("replaces engine.io-client's globals export for export, without its eval fallback", () => {
  const theirs = [...eioSource.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1])
  expect(theirs.length).toBeGreaterThan(0)
  expect(Object.keys(eioGlobals).sort()).toEqual(theirs.sort())
  // theirs falls back to code from a string (no self / window: the mini program); ours to the timers
  expect(eioSource).toContain('Function("return this")')
  expect(typeof self).toBe('undefined')
  expect(eioGlobals.globalThisShim.setTimeout).toBeTypeOf('function')
  expect(eioGlobals.globalThisShim.clearTimeout).toBeTypeOf('function')
})
