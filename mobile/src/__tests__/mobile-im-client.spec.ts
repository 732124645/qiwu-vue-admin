// 移动端聊天客户端的接线（共同引擎换成记录调用的替身）：登录后按账号打开缓存并冷启动、删除别的命名
// 空间；回前台、断线轮询与断线后的重连跑全量同步（首次连上不跑）；会话过期（refresh 被拒）只锁定不删，同一账号重登复用；主动退出与被踢
// （含另一台设备登录的 app_replaced）清除；实时提示交给引擎；登录体按端带 mobileKind。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as shared from '@qiwu/shared/im-client'
import type { ImChange, ImOutboxRecord } from '@qiwu/shared/im-client'
import * as client from '@/core/im/client'
import { pollCounts, startRealtime, stopRealtime } from '@/core/realtime'
import { refreshAccessToken, sessionEnd } from '@/core/request'
import { MOBILE_KIND, useAuthStore } from '@/core/stores/auth'
import { removeLocalFile } from '@/core/im/cache-sqlite'
import { imApi } from '@/core/im/api'
import { outboxCopies, rememberOutboxCopy } from '@/core/im/file-pick'

const h = vi.hoisted(() => {
  type Listener = (change: ImChange) => void
  const engines: ReturnType<typeof make>[] = []
  function make() {
    const listeners = new Set<Listener>()
    const engine = {
      state: 'idle' as string,
      start: vi.fn(async () => {
        engine.state = 'ready'
        for (const fn of listeners) fn({ type: 'state', state: 'ready' })
      }),
      fullSync: vi.fn(async () => {}),
      retry: vi.fn(async (_id: string) => {}),
      lock: vi.fn(() => void (engine.state = 'locked')),
      unlock: vi.fn(async () => {
        engine.state = 'ready'
        for (const fn of listeners) fn({ type: 'state', state: 'ready' })
      }),
      clear: vi.fn(async () => {}),
      dispose: vi.fn(),
      totalUnread: vi.fn(async () => 3),
      onEntryHint: vi.fn(),
      onRoomHint: vi.fn(),
      loadDirectory: vi.fn(async () => true),
      loadStickers: vi.fn(async () => true),
      subscribe: (fn: Listener) => {
        listeners.add(fn)
        return () => void listeners.delete(fn)
      },
      /** 像引擎那样通知订阅者 */
      emit: (change: ImChange) => {
        for (const fn of listeners) fn(change)
      },
    }
    return engine
  }
  return { engines, make }
})

vi.mock('@qiwu/shared/im-client', async (importOriginal) => ({
  IM_CACHE_SCHEMA: '1',
  imHomeTenantId: (await importOriginal<typeof import('@qiwu/shared/im-client')>()).imHomeTenantId,
  imCacheName: vi.fn(async (_source: string, tenantId: number, userId: number) => `qw-im-${tenantId}-${userId}`),
  openIdbCache: vi.fn(async (name: string, _options?: { onClosed?: () => void }) => ({
    name,
    close: vi.fn(async () => {}),
    listRooms: async () => [{}, {}],
    listOutbox: async () => [],
  })),
  deleteOtherIdbCaches: vi.fn(async () => {}),
  deleteDb: vi.fn(async (_name: string) => {}),
  electLeader: vi.fn((_name: string, onChange: (leader: boolean) => void) => {
    onChange(true)
    return () => {}
  }),
  createImEngine: vi.fn(() => {
    const e = h.make()
    h.engines.push(e)
    return e
  }),
}))

// App 的 SQLite 缓存与删文件（App 用例里换上）
vi.mock('@/core/im/cache-sqlite', () => ({
  openSqliteCache: vi.fn(async (name: string) => ({
    name,
    close: vi.fn(async () => {}),
    listRooms: async () => [],
    listOutbox: async () => [],
  })),
  deleteOtherSqliteCaches: vi.fn(async () => {}),
  removeLocalFile: vi.fn(async () => {}),
}))

// 多租户关闭（没有租户信息）按默认租户分库
const NAME = 'qw-im-1-7'
const flush = () => new Promise((r) => setTimeout(r, 5))
let refreshOk = true
let issued = 0
const channels: {
  name: string
  onmessage: ((event: { data: object }) => void) | null
  sent: object[]
  closed: boolean
}[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  h.engines.length = 0
  channels.length = 0
  refreshOk = true
  vi.mocked(shared.createImEngine).mockClear()
  vi.mocked(shared.openIdbCache).mockClear()
  vi.mocked(shared.deleteOtherIdbCaches).mockClear()
  vi.mocked(shared.deleteDb).mockClear()
  vi.stubGlobal('BroadcastChannel', class {
    onmessage: ((event: { data: object }) => void) | null = null
    sent: object[] = []
    closed = false
    constructor(readonly name: string) {
      channels.push(this)
    }
    postMessage(message: object) {
      this.sent.push(message)
    }
    close() {
      this.closed = true
    }
  })
  vi.mocked(uni.request).mockImplementation((o) => {
    const url = o.url.replace(/^\/api/, '')
    const refused = url === '/auth/refresh' && !refreshOk
    const data =
      url === '/auth/login' || url === '/auth/refresh'
        ? { accessToken: `a${++issued}`, refreshToken: `r${issued}`, expiresIn: 1800 }
        : url === '/auth/me'
          ? { user: { id: 7 }, perms: [], flags: { mustChangePassword: false, passwordExpired: false } }
          : { items: [], total: 0, unread: 0 }
    setTimeout(() =>
      o.success?.(
        (refused
          ? { statusCode: 401, data: { code: 'A1003', msg: 'expired' } }
          : { statusCode: 200, data: { code: 0, msg: 'ok', data } }) as never,
      ),
    )
    return {} as UniApp.RequestTask
  })
})

afterEach(async () => {
  stopRealtime()
  await client.imWipe()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete (globalThis as { plus?: unknown }).plus
})

/** 登录并进入有聊天的页面 */
async function signedIn() {
  await useAuthStore().login({ username: 'u', password: 'p' })
  await client.imStart()
  await flush()
  return h.engines.at(-1)!
}

it('a sign-in opens this account’s cache, removes the others and cold-starts once', async () => {
  const engine = await signedIn()
  expect(shared.openIdbCache).toHaveBeenCalledWith(NAME, expect.anything())
  expect(shared.deleteOtherIdbCaches).toHaveBeenCalledWith(NAME)
  // 引擎知道当前账号：提示里自己发的消息不算未读
  expect(shared.createImEngine).toHaveBeenCalledWith(expect.objectContaining({ userId: 7 }))
  expect(engine.start).toHaveBeenCalledTimes(1)
  expect(client.imState.value).toBe('ready')
  expect(client.imChatVisible.value).toBe(true)
  expect(client.imUnread.value).toBe(3)
  // later shows of a tab page start nothing again
  await client.imStart()
  expect(shared.createImEngine).toHaveBeenCalledTimes(1)
  expect(engine.start).toHaveBeenCalledTimes(1)
})

it('back in the foreground: one full sync; the fallback poll syncs only while in front', async () => {
  const engine = await signedIn()
  client.imForeground()
  expect(engine.fullSync).toHaveBeenLastCalledWith('foreground')
  pollCounts()
  expect(engine.fullSync).toHaveBeenLastCalledWith('poll')
  client.imBackground()
  engine.fullSync.mockClear()
  pollCounts()
  expect(engine.fullSync).not.toHaveBeenCalled()
  client.imForeground()
})

it('an expired session (refresh refused) locks the cache, deletes nothing; the same account reuses it', async () => {
  const engine = await signedIn()
  refreshOk = false
  await expect(refreshAccessToken()).rejects.toMatchObject({ status: 401 })
  await flush()
  expect(engine.lock).toHaveBeenCalled()
  expect(engine.clear).not.toHaveBeenCalled()
  expect(shared.deleteOtherIdbCaches).not.toHaveBeenCalledWith(null)
  expect(client.imState.value).toBe('locked')
  expect(client.imChatVisible.value).toBe(false)
  expect(client.imCurrent()).toBeNull()

  refreshOk = true
  const again = await signedIn()
  expect(again).not.toBe(engine)
  expect(shared.openIdbCache).toHaveBeenLastCalledWith(NAME, expect.anything())
  // only the other namespaces go: this account's cache is kept
  expect(shared.deleteOtherIdbCaches).toHaveBeenLastCalledWith(NAME)
  expect(engine.clear).not.toHaveBeenCalled()
  expect(client.imState.value).toBe('ready')
})

it('a sign-out wipes the cache (not a lock)', async () => {
  const engine = await signedIn()
  await useAuthStore().logout()
  await flush()
  expect(engine.clear).toHaveBeenCalled()
  expect(shared.deleteOtherIdbCaches).toHaveBeenLastCalledWith(null)
  expect(engine.lock).not.toHaveBeenCalled()
  expect(client.imCurrent()).toBeNull()
  expect(client.imUnread.value).toBe(0)
  expect(channels[0]!.sent).toContainEqual({ type: 'wipe', name: NAME })
  expect(channels[0]!.sent).not.toContainEqual({ type: 'reset', name: NAME })
})

it('the sign-in names this build’s mobile kind only when the platform is known', async () => {
  await useAuthStore().login({ username: 'u', password: 'p' })
  const body = vi
    .mocked(uni.request)
    .mock.calls.map(([o]) => o)
    .find((o) => o.url === '/api/auth/login')!.data
  // vitest has no uni platform: the field is left out (the H5 build sends 'h5', the App 'app')
  expect(body).not.toHaveProperty('mobileKind')
  expect(MOBILE_KIND).toBeUndefined()
})

it('opening the chat fetches the directory and stickers once; a failed fetch is tried again next time', async () => {
  const engine = await signedIn()
  engine.loadDirectory.mockResolvedValueOnce(false)
  client.imOpenChat()
  await flush()
  client.imOpenChat()
  await flush()
  client.imOpenChat()
  await flush()
  expect(engine.loadDirectory).toHaveBeenCalledTimes(2)
  expect(engine.loadStickers).toHaveBeenCalledTimes(2)
})

it('H5: an externally closed cache locks without reopening, until its explicit lifecycle notice arrives', async () => {
  const engine = await signedIn()
  const onClosed = vi.mocked(shared.openIdbCache).mock.calls.at(-1)![1]!.onClosed!
  onClosed()
  await flush()
  engine.emit({ type: 'state', state: 'ready' })
  await client.imStart()
  expect(engine.lock).toHaveBeenCalled()
  expect(engine.unlock).not.toHaveBeenCalled()
  expect(engine.unlock).not.toHaveBeenCalled()
  expect(engine.dispose).not.toHaveBeenCalled()
  expect(shared.openIdbCache).toHaveBeenCalledTimes(1)
  expect(client.imState.value).toBe('locked')
  expect(client.imCurrent()).toBeNull()
  expect(channels[0]!.closed).toBe(false)
})

it('H5: an external close followed by sign-out never recreates the account database or echoes reset', async () => {
  const engine = await signedIn()
  vi.mocked(shared.openIdbCache).mock.calls.at(-1)![1]!.onClosed!()
  channels[0]!.onmessage!({ data: { type: 'wipe', name: NAME } })
  await flush()
  expect(shared.deleteDb).toHaveBeenCalledWith(NAME)
  expect(shared.openIdbCache).toHaveBeenCalledTimes(1)
  expect(engine.dispose).toHaveBeenCalled()
  expect(client.imCurrent()).toBeNull()
  expect(channels[0]!.sent).toEqual([])
  expect(channels[0]!.closed).toBe(true)
  client.imForeground()
  await client.imStart()
  expect(shared.openIdbCache).toHaveBeenCalledTimes(1)
  const again = await signedIn()
  expect(again).not.toBe(engine)
  expect(shared.openIdbCache).toHaveBeenCalledTimes(2)
})

it('H5: an external close followed by reset reopens and cold-starts the same account', async () => {
  const engine = await signedIn()
  vi.mocked(shared.openIdbCache).mock.calls.at(-1)![1]!.onClosed!()
  channels[0]!.onmessage!({ data: { type: 'reset', name: NAME } })
  await flush()
  expect(shared.openIdbCache).toHaveBeenCalledTimes(2)
  expect(engine.dispose).toHaveBeenCalled()
  const again = h.engines.at(-1)!
  expect(again).not.toBe(engine)
  expect(again.start).toHaveBeenCalledTimes(1)
  expect(client.imState.value).toBe('ready')
  vi.mocked(shared.openIdbCache).mock.calls[0]![1]!.onClosed!()
  expect(again.lock).not.toHaveBeenCalled()
  expect(client.imState.value).toBe('ready')
})

it('H5: an epoch clear announces reset before retiring its channel', async () => {
  const engine = await signedIn()
  engine.emit({ type: 'cleared' })
  await flush()
  expect(channels[0]!.sent).toContainEqual({ type: 'reset', name: NAME })
  expect(channels[0]!.closed).toBe(true)
  expect(shared.openIdbCache).toHaveBeenCalledTimes(2)
})

it('H5: peer cache notifications refresh local readers without another sync or a notification loop', async () => {
  const engine = await signedIn()
  const changes = vi.fn()
  const off = client.onImChange(changes)
  for (const message of [
    { type: 'rooms' },
    { type: 'entries', roomId: 2 },
    { type: 'directory' },
    { type: 'stickers' },
  ]) channels[0]!.onmessage!({ data: { ...message, name: NAME } })
  channels[0]!.onmessage!({ data: { type: 'wipe', name: 'qw-im-another-account' } })
  await flush()
  expect(changes.mock.calls.map(([change]) => change)).toEqual([
    { type: 'rooms', roomIds: [] },
    { type: 'entries', roomId: 2 },
    { type: 'directory' },
    { type: 'stickers' },
  ])
  expect(engine.fullSync).not.toHaveBeenCalled()
  expect(engine.dispose).not.toHaveBeenCalled()
  expect(channels[0]!.sent).toEqual([])
  off()
})

it('H5: follower outbox writes wake the leader with pending IDs on the desktop-compatible lock', async () => {
  vi.mocked(shared.electLeader).mockImplementationOnce((_name, changed) => {
    changed(false)
    return () => {}
  })
  const engine = await signedIn()
  const cache = await vi.mocked(shared.openIdbCache).mock.results.at(-1)!.value
  vi.spyOn(cache, 'listOutbox').mockResolvedValue([
    { roomId: 2, clientEntryId: 'pending', state: 'pending' },
    { roomId: 2, clientEntryId: 'failed', state: 'failed' },
  ] as ImOutboxRecord[])
  engine.emit({ type: 'outbox', roomId: 2 })
  await flush()
  expect(shared.electLeader).toHaveBeenLastCalledWith(`qw-im:${NAME}`, expect.any(Function))
  expect(channels[0]!.name).toBe('qw-im')
  expect(channels[0]!.sent).toContainEqual({ type: 'outbox', name: NAME, roomId: 2, id: 'pending' })
  expect(channels[0]!.sent).not.toContainEqual(expect.objectContaining({ id: 'failed' }))
  expect(engine.retry).not.toHaveBeenCalled()
})

it('H5: the leader retries a peer outbox request, while another account cannot dispatch it', async () => {
  const engine = await signedIn()
  channels[0]!.onmessage!({ data: { type: 'outbox', name: NAME, roomId: 2, id: 'pending' } })
  channels[0]!.onmessage!({ data: { type: 'outbox', name: 'qw-im-other', roomId: 2, id: 'foreign' } })
  await flush()
  expect(engine.retry).toHaveBeenCalledExactlyOnceWith('pending')
})

it('H5: the new leader drains pending outbox rows, but a closed cache cannot take over', async () => {
  let becomeLeader = (_leader: boolean) => {}
  vi.mocked(shared.electLeader).mockImplementationOnce((_name, changed) => {
    becomeLeader = changed
    changed(false)
    return () => {}
  })
  const engine = await signedIn()
  const cache = await vi.mocked(shared.openIdbCache).mock.results.at(-1)!.value
  vi.spyOn(cache, 'listOutbox').mockResolvedValue([
    { roomId: 2, clientEntryId: 'pending', state: 'pending' },
  ] as ImOutboxRecord[])
  becomeLeader(true)
  await flush()
  expect(engine.fullSync).toHaveBeenCalledExactlyOnceWith('foreground')
  expect(engine.retry).toHaveBeenCalledExactlyOnceWith('pending')
  engine.fullSync.mockClear()
  engine.retry.mockClear()
  vi.mocked(shared.openIdbCache).mock.calls.at(-1)![1]!.onClosed!()
  becomeLeader(true)
  await flush()
  expect(engine.fullSync).not.toHaveBeenCalled()
  expect(engine.retry).not.toHaveBeenCalled()
})

it.each(['namespace', 'old caches'] as const)('H5: sign-out during %s lookup cannot open a stale database', async (stage) => {
  await useAuthStore().login({ username: 'u', password: 'p' })
  let resume = () => {}
  const waiting = new Promise<void>((resolve) => { resume = resolve })
  if (stage === 'namespace') vi.mocked(shared.imCacheName).mockImplementationOnce(async () => {
    await waiting
    return NAME
  })
  else vi.mocked(shared.deleteOtherIdbCaches).mockImplementationOnce(() => waiting)
  const start = client.imStart()
  await flush()
  await client.imWipe()
  resume()
  await start
  expect(shared.openIdbCache).not.toHaveBeenCalled()
})

it('App: once a sent file is acknowledged (its outbox item gone), its outbox copy is deleted', async () => {
  vi.stubEnv('UNI_PLATFORM', 'app')
  const engine = await signedIn()
  expect(shared.openIdbCache).not.toHaveBeenCalled()
  expect(channels).toEqual([])
  rememberOutboxCopy('_doc/im-outbox/k1-a.pdf')
  engine.emit({ type: 'outbox', roomId: 1 })
  await flush()
  expect(removeLocalFile).toHaveBeenCalledWith('_doc/im-outbox/k1-a.pdf')
  expect(outboxCopies()).toEqual([])
})

describe('a lost local file is the user’s to resolve (400 local), not a network error', () => {
  const file = { name: 'a.pdf', size: 3, mime: 'application/pdf', localRef: 'blob:http://x/1' }

  it('H5: a blob address that no longer reads', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(imApi.upload(1, file)).rejects.toMatchObject({ status: 400, code: 'local' })
    expect(uni.uploadFile).not.toHaveBeenCalled()
  })

  it('App: a path that no longer resolves', async () => {
    vi.stubEnv('UNI_PLATFORM', 'app')
    vi.stubGlobal('plus', {
      io: {
        resolveLocalFileSystemURL: (_p: string, _ok: () => void, fail: () => void) => fail(),
      },
    })
    await expect(
      imApi.upload(1, { ...file, localRef: '_doc/im-outbox/k1-a.pdf' }),
    ).rejects.toMatchObject({ status: 400, code: 'local' })
    expect(uni.uploadFile).not.toHaveBeenCalled()
  })
})

describe('over the realtime socket', () => {
  interface Task {
    sent: string[]
    open(): void
    recv(frame: string): void
    drop(): void
  }
  const tasks: Task[] = []
  const OPEN =
    '0{"sid":"s","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}'
  const push = (type: string, payload: object) =>
    `42${JSON.stringify(['message', { type, payload }])}`

  beforeEach(() => {
    tasks.length = 0
    vi.stubGlobal('location', { protocol: 'http:', host: '127.0.0.1:4175', origin: 'http://127.0.0.1:4175' })
    Object.assign(uni, {
      connectSocket: vi.fn(() => {
        const on: Record<string, (r?: unknown) => void> = {}
        const task: Task = {
          sent: [],
          open: () => on.open?.(),
          recv: (data) => on.message?.({ data }),
          drop: () => on.close?.({ code: 1006, reason: '' }),
        }
        tasks.push(task)
        return {
          onOpen: (cb: () => void) => (on.open = cb),
          onMessage: (cb: (r: unknown) => void) => (on.message = cb),
          onClose: (cb: () => void) => (on.close = cb),
          onError: (cb: () => void) => (on.error = cb),
          send: ({ data }: { data: string }) => task.sent.push(data),
          close: vi.fn(),
        }
      }),
    })
  })

  /** 打开最新的连接并完成握手 */
  async function handshake() {
    const task = tasks.at(-1)!
    task.open()
    task.recv(OPEN)
    await flush()
    task.recv('40{"sid":"x"}')
    await flush()
    return task
  }

  async function connected() {
    const engine = await signedIn()
    startRealtime()
    const task = await handshake()
    return { engine, task }
  }

  it('the first connect does not sync; a reconnect after a drop does', async () => {
    const { engine, task } = await connected()
    expect(engine.fullSync).not.toHaveBeenCalledWith('reconnect')
    task.drop()
    await vi.waitFor(() => expect(tasks).toHaveLength(2), { timeout: 3000 })
    await handshake()
    expect(engine.fullSync).toHaveBeenLastCalledWith('reconnect')
  })

  it('chat hints go to the engine as they are', async () => {
    const { engine, task } = await connected()
    task.recv(push('im:entry', { roomId: 4, seq: 9, authorId: 2, kind: 'text' }))
    task.recv(push('im:room', { roomId: 4, readSeq: 9 }))
    await flush()
    expect(engine.onEntryHint).toHaveBeenCalledWith({ roomId: 4, seq: 9, authorId: 2, kind: 'text' })
    expect(engine.onRoomHint).toHaveBeenCalledWith({ roomId: 4, readSeq: 9 })
  })

  it('a kick (another device took the App session) wipes the cache and says why', async () => {
    const { engine, task } = await connected()
    task.recv(push('session:kicked', { sid: 'x', reason: 'app_replaced' }))
    await flush()
    expect(engine.clear).toHaveBeenCalled()
    expect(engine.lock).not.toHaveBeenCalled()
    expect(shared.deleteOtherIdbCaches).toHaveBeenLastCalledWith(null)
    expect(sessionEnd.value).toBe('app_replaced')
  })
})
