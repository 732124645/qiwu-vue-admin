import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImCall, ImCallGrant } from '@qiwu/shared'
import {
  createImCallController,
  emptyImMediaSnapshot,
  type ImCallApi,
  type ImCallView,
} from '@qiwu/shared/im-client'
import type { ImMediaEvent, ImMediaPort, ImMediaSnapshot } from '@qiwu/shared/im-media'

const call = (patch: Partial<ImCall> = {}): ImCall => ({
  id: 1,
  roomId: 10,
  mode: 'audio',
  state: 'ringing',
  callerId: 7,
  rev: 1,
  createdAt: '2026-11-05T00:00:00Z',
  startedAt: null,
  endedAt: null,
  inviteExpiresAt: '2026-11-05T00:00:45Z',
  endReason: null,
  members: [{ userId: 7, displayName: 'Ann', identity: 'u7', state: 'accepted' }],
  canAccept: false,
  canDecline: false,
  canJoin: true,
  canLeave: true,
  canEnd: true,
  ...patch,
})
const grant = (item = call()): ImCallGrant => ({
  call: item,
  url: 'wss://media.example.test',
  token: 'runtime-only-secret',
  identity: 'u7',
  expiresAt: '2026-11-05T00:01:00Z',
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((r, fail) => {
    resolve = r
    reject = fail
  })
  return { promise, resolve, reject }
}

class Media implements ImMediaPort {
  snapshot = emptyImMediaSnapshot()
  listeners = new Set<(event: ImMediaEvent) => void>()
  failDisconnect = false
  gate: ReturnType<typeof deferred<ImMediaSnapshot>> | null = null
  calls: string[] = []
  getSnapshot() {
    return this.snapshot
  }
  subscribe(fn: (event: ImMediaEvent) => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  emit() {
    for (const fn of this.listeners) fn({ type: 'state', snapshot: this.snapshot, error: null })
  }
  async connect() {
    this.calls.push('connect')
    this.snapshot = { ...emptyImMediaSnapshot(), connectionId: 'connection-a', state: 'connecting' }
    this.emit()
    if (this.gate) return this.gate.promise
    this.snapshot = { ...this.snapshot, state: 'connected', microphone: true }
    this.emit()
    return this.snapshot
  }
  async disconnect(id: string) {
    this.calls.push(`disconnect:${id}`)
    if (id !== this.snapshot.connectionId)
      throw Object.assign(new Error('STALE_CONNECTION'), {
        code: 'STALE_CONNECTION',
        operation: 'disconnect',
      })
    this.snapshot = { ...this.snapshot, state: 'disconnecting' }
    this.emit()
    if (this.failDisconnect)
      throw Object.assign(new Error('SDK_ERROR'), { code: 'SDK_ERROR', operation: 'disconnect' })
    this.snapshot = { ...emptyImMediaSnapshot(), connectionId: id }
    this.emit()
    return this.snapshot
  }
  async setMicrophoneEnabled() {
    return this.snapshot
  }
  async setCameraEnabled() {
    return this.snapshot
  }
  async switchCamera() {
    return this.snapshot
  }
  async setSpeakerOutputPreferred() {
    return this.snapshot
  }
}
function setup(options: { leaveOnMediaDisconnect?: boolean } = {}) {
  vi.useFakeTimers()
  const item = call(),
    media = new Media()
  const api: ImCallApi = {
    active: vi.fn<ImCallApi['active']>(async () => [item]),
    get: vi.fn<ImCallApi['get']>(async () => item),
    create: vi.fn<ImCallApi['create']>(async () => item),
    accept: vi.fn<ImCallApi['accept']>(async () => item),
    decline: vi.fn<ImCallApi['decline']>(async () => ({
      ...item,
      canAccept: false,
      canDecline: false,
    })),
    join: vi.fn<ImCallApi['join']>(async () => grant()),
    heartbeat: vi.fn<ImCallApi['heartbeat']>(async () => item),
    leave: vi.fn<ImCallApi['leave']>(async () => ({ ...item, state: 'ending' as const })),
    end: vi.fn<ImCallApi['end']>(async () => ({ ...item, state: 'ending' as const })),
  }
  const views: ImCallView[] = []
  const beforeConnect = vi.fn<() => void>()
  const controller = createImCallController({
    api,
    media,
    beforeConnect,
    ...options,
    onChange: (view) => {
      views.push(structuredClone(view))
    },
  })
  return { item, api, media, controller, views, beforeConnect }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('employee call coordination', () => {
  it('ends a recovered caller call without first creating a local media connection', async () => {
    const f = setup()
    await f.controller.refresh()
    await f.controller.end(f.controller.view.calls[0])
    expect(f.api.end).toHaveBeenCalledExactlyOnceWith(f.item.id)
    expect(f.media.calls).toEqual([])
    expect(f.controller.view.current).toBeNull()
    f.controller.dispose()
  })
  it('ending another known caller call preserves the current media and its heartbeat', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    const other = call({ id: 2, roomId: 20 })
    vi.mocked(f.api.end).mockResolvedValue({ ...other, state: 'ending' })
    await f.controller.end(other)
    expect(f.api.end).toHaveBeenCalledExactlyOnceWith(2)
    expect(f.controller.view.current?.id).toBe(f.item.id)
    expect(f.media.calls).toEqual(['connect'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.api.heartbeat).toHaveBeenCalledExactlyOnceWith(f.item.id)
    f.controller.dispose()
  })
  it('connects only after a grant, keeps the token outside observable state, and sends one heartbeat at a time', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    expect(f.beforeConnect).toHaveBeenCalledOnce()
    expect(f.media.calls).toEqual(['connect'])
    expect(JSON.stringify(f.views)).not.toContain('runtime-only-secret')
    expect(f.controller.view.media.state).toBe('connected')
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.api.heartbeat).toHaveBeenCalledTimes(1)
    await f.controller.end()
    expect(f.api.end).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.api.heartbeat).toHaveBeenCalledTimes(1)
    f.controller.dispose()
  })
  it('drops a grant that returns after identity reset without opening media or sending old HTTP actions', async () => {
    const f = setup(),
      response = deferred<ImCallGrant>()
    vi.mocked(f.api.join).mockReturnValue(response.promise)
    const pending = f.controller.start(10, 'audio')
    await Promise.resolve()
    await Promise.resolve()
    f.controller.reset()
    response.resolve(grant())
    await pending
    expect(f.media.calls).toEqual([])
    expect(f.api.leave).not.toHaveBeenCalled()
    expect(f.controller.view.current).toBeNull()
    f.controller.dispose()
  })
  it('releases only the cancelled connection when SDK completion arrives late', async () => {
    const f = setup()
    f.media.gate = deferred<ImMediaSnapshot>()
    const pending = f.controller.start(10, 'audio')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(f.media.snapshot.state).toBe('connecting')
    f.controller.reset()
    f.media.gate.resolve({ ...f.media.snapshot, state: 'connected' })
    await pending
    expect(
      f.media.calls
        .filter((c) => c.startsWith('disconnect:'))
        .every((c) => c === 'disconnect:connection-a'),
    ).toBe(true)
    expect(f.controller.view.current).toBeNull()
    f.controller.dispose()
  })
  it('preserves failed cleanup as occupied and retries the same SDK identifier', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    f.media.failDisconnect = true
    await f.controller.leave()
    expect(f.controller.view.media.state).toBe('disconnecting')
    expect(f.controller.view.error).toEqual({ code: 'SDK_ERROR', operation: 'disconnect' })
    await f.controller.start(20, 'video')
    expect(f.api.create).toHaveBeenCalledTimes(1)
    f.media.failDisconnect = false
    await f.controller.retryDisconnect()
    expect(f.controller.view.media.state).toBe('idle')
    expect(f.media.calls.at(-1)).toBe('disconnect:connection-a')
    f.controller.dispose()
  })
  it('does not stop the current media when rejecting a different invitation fails', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    vi.mocked(f.api.decline).mockRejectedValue({ status: 404, code: 'B5030' })
    await f.controller.decline(call({ id: 2, roomId: 20, canDecline: true }))
    expect(f.media.calls).toEqual(['connect'])
    expect(f.controller.view.media.state).toBe('connected')
    expect(f.api.leave).not.toHaveBeenCalled()
    f.controller.dispose()
  })
  it('does not reconnect with an older grant after a newer ending hint', async () => {
    const f = setup(),
      response = deferred<ImCallGrant>()
    vi.mocked(f.api.join).mockReturnValue(response.promise)
    const pending = f.controller.start(10, 'audio')
    for (let i = 0; i < 4; i++) await Promise.resolve()
    vi.mocked(f.api.get).mockResolvedValue(call({ rev: 3, state: 'ending' }))
    await f.controller.onHint({ callId: 1, roomId: 10, rev: 3 })
    response.resolve(grant())
    await pending
    expect(f.media.calls).toEqual([])
    expect(f.controller.view.current?.state).toBe('ending')
    f.controller.dispose()
  })
  it('can issue a non-credential idempotency key in an App runtime without crypto', async () => {
    const f = setup()
    vi.stubGlobal('crypto', undefined)
    await f.controller.start(10, 'audio')
    expect(vi.mocked(f.api.create).mock.calls[0]?.[1].clientCallId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    f.controller.dispose()
  })
  it('retires the lease and stops heartbeats when established media disconnects permanently', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
    f.media.emit()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(f.api.leave).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.api.heartbeat).not.toHaveBeenCalled()
    f.controller.dispose()
  })
  it('stops local media after the server cannot renew the foreground lease', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    vi.mocked(f.api.heartbeat).mockRejectedValue({ status: 0 })
    await vi.advanceTimersByTimeAsync(30000)
    expect(f.media.calls).toContain('disconnect:connection-a')
    expect(f.api.leave).toHaveBeenCalledWith(1)
    f.controller.dispose()
  })
  it('does not end the shared session call when a passive Web disconnect may have handed media to another tab', async () => {
    const f = setup({ leaveOnMediaDisconnect: false })
    await f.controller.start(10, 'audio')
    f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
    f.media.emit()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(15000)
    expect(f.api.heartbeat).not.toHaveBeenCalled()
    expect(f.api.leave).not.toHaveBeenCalled()
    expect(f.api.end).not.toHaveBeenCalled()
    expect(f.controller.view.current).toBeNull()
    expect(f.controller.view.media.state).toBe('idle')
    f.controller.dispose()
  })
  it('retires a passively disconnected Web connection before a pending connect callback returns', async () => {
    const f = setup({ leaveOnMediaDisconnect: false })
    f.media.gate = deferred<ImMediaSnapshot>()
    const pending = f.controller.start(10, 'audio')
    for (let i = 0; i < 5; i++) await Promise.resolve()
    f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
    f.media.emit()
    f.media.gate.resolve({ ...f.media.snapshot, state: 'connected' })
    await pending
    expect(f.api.leave).not.toHaveBeenCalled()
    expect(f.api.end).not.toHaveBeenCalled()
    expect(f.controller.view.current).toBeNull()
    expect(f.controller.view.media.state).toBe('idle')
    f.controller.dispose()
  })
  it('does not clear a newly started call when the previous leave response arrives', async () => {
    const f = setup()
    await f.controller.start(10, 'audio')
    const response = deferred<ImCall>()
    vi.mocked(f.api.leave).mockReturnValue(response.promise)
    const leaving = f.controller.leave()
    for (let i = 0; i < 4; i++) await Promise.resolve()
    const next = call({ id: 2, roomId: 20 })
    vi.mocked(f.api.create).mockResolvedValue(next)
    vi.mocked(f.api.join).mockResolvedValue(grant(next))
    await f.controller.start(20, 'audio')
    response.resolve(call({ state: 'ending' }))
    await leaving
    expect(f.controller.view.current?.id).toBe(2)
    expect(f.controller.view.media.state).toBe('connected')
    f.controller.dispose()
  })
})

it('drops a create response completed after identity retirement', async () => {
  const f = setup(),
    response = deferred<ImCall>()
  vi.mocked(f.api.create).mockReturnValue(response.promise)
  const starting = f.controller.start(10, 'audio')
  f.controller.reset()
  response.resolve(f.item)
  await starting
  expect(f.api.join).not.toHaveBeenCalled()
  expect(f.media.calls).toEqual([])
  expect(f.controller.view.current).toBeNull()
  f.controller.dispose()
})
it('keeps a newer list revision when an older hint request completes later', async () => {
  const f = setup()
  await f.controller.start(10, 'audio')
  vi.mocked(f.api.get)
    .mockResolvedValueOnce(call({ rev: 3 }))
    .mockResolvedValueOnce(call({ rev: 2 }))
  await f.controller.onHint({ callId: 1, roomId: 10, rev: 3 })
  await f.controller.onHint({ callId: 1, roomId: 10, rev: 2 })
  expect(f.controller.view.calls[0]?.rev).toBe(3)
  f.controller.dispose()
})
it('rechecks identity after waiting for older microphone capture to stop', async () => {
  const f = setup(),
    stopping = deferred<void>()
  f.beforeConnect.mockImplementation(() => stopping.promise)
  const starting = f.controller.start(10, 'audio')
  for (let i = 0; i < 5; i++) await Promise.resolve()
  f.controller.reset()
  stopping.resolve()
  await starting
  expect(f.media.calls).toEqual([])
  f.controller.dispose()
})
it('does not send an old leave after reset during local SDK release', async () => {
  const f = setup(),
    closing = deferred<ImMediaSnapshot>()
  await f.controller.start(10, 'audio')
  vi.spyOn(f.media, 'disconnect').mockReturnValue(closing.promise)
  const leaving = f.controller.leave()
  f.controller.reset()
  closing.resolve(emptyImMediaSnapshot())
  await leaving
  expect(f.api.leave).not.toHaveBeenCalled()
  f.controller.dispose()
})
it('does not apply a heartbeat response completed after reset', async () => {
  const f = setup(),
    reply = deferred<ImCall>()
  await f.controller.start(10, 'audio')
  vi.mocked(f.api.heartbeat).mockReturnValue(reply.promise)
  await vi.advanceTimersByTimeAsync(5000)
  f.controller.reset()
  reply.resolve(f.item)
  for (let i = 0; i < 5; i++) await Promise.resolve()
  expect(f.controller.view.calls).toEqual([])
  f.controller.dispose()
})

it('checks a newer ending hint after awaiting previous microphone cleanup', async () => {
  const f = setup(),
    cleanup = deferred<void>()
  f.beforeConnect.mockImplementation(() => cleanup.promise)
  const starting = f.controller.start(10, 'audio')
  for (let i = 0; i < 5; i++) await Promise.resolve()
  vi.mocked(f.api.get).mockResolvedValue(call({ rev: 3, state: 'ending', canJoin: false }))
  await f.controller.onHint({ callId: 1, roomId: 10, rev: 3 })
  cleanup.resolve()
  await starting
  expect(f.media.calls).toEqual([])
  expect(f.controller.view.current?.state).toBe('ending')
  f.controller.dispose()
})

it('an active-list response begun before a new call cannot stop the new media', async () => {
  const f = setup()
  const response = deferred<ImCall[]>()
  vi.mocked(f.api.active).mockReturnValue(response.promise)
  const refreshing = f.controller.refresh()
  await f.controller.start(10, 'audio')
  response.resolve([])
  await refreshing
  expect(f.controller.view.current?.id).toBe(1)
  expect(f.controller.view.media.state).toBe('connected')
  f.controller.dispose()
})

it.each(['create', 'accept', 'join'] as const)(
  'does not remove media from a list read during pending %s',
  async (operation) => {
    const f = setup(),
      result = deferred<ImCall[]>(),
      create = deferred<ImCall>(),
      accepted = deferred<ImCall>(),
      joined = deferred<ImCallGrant>()
    vi.mocked(f.api.active).mockReturnValue(result.promise)
    vi.mocked(f.api.create).mockReturnValue(create.promise)
    vi.mocked(f.api.accept).mockReturnValue(accepted.promise)
    vi.mocked(f.api.join).mockReturnValue(joined.promise)
    const starting =
      operation === 'create'
        ? f.controller.start(10, 'audio')
        : f.controller[operation](call({ canAccept: true }))
    const refreshing = f.controller.refresh()
    create.resolve(f.item)
    accepted.resolve(f.item)
    joined.resolve(grant())
    await starting
    expect(f.controller.view.media.state).toBe('connected')
    result.resolve([])
    await refreshing
    expect(f.controller.view.current?.id).toBe(1)
    expect(f.controller.view.media.state).toBe('connected')
    expect(f.controller.view.calls.some((entry) => entry.id === 1)).toBe(true)
    f.controller.dispose()
  },
)

it('keeps a revision updated after an absent list snapshot began', async () => {
  const f = setup(),
    result = deferred<ImCall[]>()
  await f.controller.start(10, 'audio')
  vi.mocked(f.api.active).mockReturnValue(result.promise)
  const refreshing = f.controller.refresh()
  vi.mocked(f.api.get).mockResolvedValue(call({ rev: 3 }))
  await f.controller.onHint({ callId: 1, roomId: 10, rev: 3 })
  result.resolve([])
  await refreshing
  expect(f.controller.view.current?.rev).toBe(3)
  expect(f.controller.view.calls[0]?.rev).toBe(3)
  expect(f.controller.view.media.state).toBe('connected')
  f.controller.dispose()
})

it.each(['terminal', 'missing'] as const)(
  'a late %s hint affects its original call while preserving the replacement',
  async (outcome) => {
    const f = setup({ leaveOnMediaDisconnect: false }),
      response = deferred<ImCall>()
    await f.controller.start(10, 'audio')
    vi.mocked(f.api.get).mockReturnValue(response.promise)
    const pending = f.controller.onHint({ callId: 1, roomId: 10, rev: 2 })
    f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
    f.media.emit()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const next = call({ id: 2, roomId: 20 })
    vi.mocked(f.api.create).mockResolvedValue(next)
    vi.mocked(f.api.join).mockResolvedValue(grant(next))
    await f.controller.start(20, 'audio')
    const calls = [...f.media.calls]
    if (outcome === 'terminal') response.resolve(call({ rev: 2, state: 'ending' }))
    else response.reject({ status: 404 })
    await pending
    expect(f.controller.view.current?.id).toBe(2)
    expect(f.controller.view.media.state).toBe('connected')
    expect(f.media.calls).toEqual(calls)
    const expected =
      outcome === 'terminal' ? { id: 1, state: 'ending' } : { id: 2, state: 'ringing' }
    expect(f.controller.view.calls).toContainEqual(expect.objectContaining(expected))
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.api.heartbeat).toHaveBeenCalledWith(2)
    f.controller.dispose()
  },
)

it.each(['reply', 'rejection'] as const)(
  'an old heartbeat %s cannot retire a later lease of the same business call',
  async (outcome) => {
    const f = setup({ leaveOnMediaDisconnect: false }),
      response = deferred<ImCall>()
    await f.controller.start(10, 'audio')
    vi.mocked(f.api.heartbeat).mockReturnValueOnce(response.promise)
    await vi.advanceTimersByTimeAsync(5000)
    f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
    f.media.emit()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const newer = call({ rev: 3 })
    vi.mocked(f.api.join).mockResolvedValue(grant(newer))
    await f.controller.join(newer)
    const calls = [...f.media.calls]
    if (outcome === 'reply') response.resolve(call({ rev: 2, state: 'ending' }))
    else response.reject({ status: 403 })
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(f.controller.view.current?.rev).toBe(3)
    expect(f.controller.view.media.state).toBe('connected')
    expect(f.media.calls).toEqual(calls)
    expect(f.api.leave).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.api.heartbeat).toHaveBeenCalledTimes(2)
    f.controller.dispose()
  },
)

it('preserves a concurrently updated noncurrent call when an older active snapshot omits it', async () => {
  const f = setup(),
    result = deferred<ImCall[]>()
  const other = call({ id: 2, roomId: 20, rev: 1, canDecline: true })
  vi.mocked(f.api.active).mockResolvedValue([other])
  await f.controller.refresh()
  vi.mocked(f.api.active).mockReturnValue(result.promise)
  const refreshing = f.controller.refresh()
  vi.mocked(f.api.decline).mockResolvedValue({ ...other, rev: 3, canDecline: false })
  await f.controller.decline(other)
  result.resolve([])
  await refreshing
  expect(f.controller.view.calls).toContainEqual(expect.objectContaining({ id: 2, rev: 3 }))
  f.controller.dispose()
})
it('does not replace a newer noncurrent row with an older row returned by active', async () => {
  const f = setup(),
    result = deferred<ImCall[]>()
  const other = call({ id: 2, roomId: 20, rev: 1, canDecline: true })
  vi.mocked(f.api.active).mockResolvedValue([other])
  await f.controller.refresh()
  vi.mocked(f.api.active).mockReturnValue(result.promise)
  const refreshing = f.controller.refresh()
  vi.mocked(f.api.decline).mockResolvedValue({ ...other, rev: 3, canDecline: false })
  await f.controller.decline(other)
  result.resolve([other])
  await refreshing
  expect(f.controller.view.calls).toContainEqual(expect.objectContaining({ id: 2, rev: 3 }))
  f.controller.dispose()
})
it.each(['reply', 'missing'] as const)(
  'a stale %s hint cannot close a new binding of the same call',
  async (outcome) => {
    const f = setup({ leaveOnMediaDisconnect: false }),
      response = deferred<ImCall>()
    await f.controller.start(10, 'audio')
    vi.mocked(f.api.get).mockReturnValue(response.promise)
    const pending = f.controller.onHint({ callId: 1, roomId: 10, rev: 2 })
    f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
    f.media.emit()
    for (let i = 0; i < 5; i++) await Promise.resolve()
    await f.controller.join(f.item)
    const previous = [...f.media.calls]
    if (outcome === 'reply') response.resolve(call({ rev: 2, state: 'ending' }))
    else response.reject({ status: 404 })
    await pending
    expect(f.controller.view.media.state).toBe('connected')
    expect(f.media.calls).toEqual(previous)
    f.controller.dispose()
  },
)
it('an older terminal hint cannot stop a current connection after a newer nonterminal hint', async () => {
  const f = setup(),
    old = deferred<ImCall>()
  await f.controller.start(10, 'audio')
  vi.mocked(f.api.get)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(call({ rev: 3 }))
  const pending = f.controller.onHint({ callId: 1, roomId: 10, rev: 2 })
  await f.controller.onHint({ callId: 1, roomId: 10, rev: 3 })
  old.resolve(call({ rev: 2, state: 'ending' }))
  await pending
  expect(f.controller.view.current?.rev).toBe(3)
  expect(f.controller.view.media.state).toBe('connected')
  f.controller.dispose()
})
it('an old terminal active snapshot cannot close a new binding of the same call', async () => {
  const f = setup({ leaveOnMediaDisconnect: false }),
    response = deferred<ImCall[]>()
  await f.controller.start(10, 'audio')
  vi.mocked(f.api.active).mockReturnValue(response.promise)
  const pending = f.controller.refresh()
  f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
  f.media.emit()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await f.controller.join(f.item)
  const previous = [...f.media.calls]
  response.resolve([call({ rev: 2, state: 'ending' })])
  await pending
  expect(f.controller.view.media.state).toBe('connected')
  expect(f.media.calls).toEqual(previous)
  f.controller.dispose()
})

it('preserves a new noncurrent result adopted while an older empty list is pending', async () => {
  const f = setup(),
    response = deferred<ImCall[]>()
  vi.mocked(f.api.active).mockReturnValue(response.promise)
  const pending = f.controller.refresh()
  const other = call({ id: 2, roomId: 20 })
  vi.mocked(f.api.end).mockResolvedValue({ ...other, rev: 2, state: 'ending' })
  await f.controller.end(other)
  response.resolve([])
  await pending
  expect(f.controller.view.calls).toContainEqual(
    expect.objectContaining({ id: 2, rev: 2, state: 'ending' }),
  )
  f.controller.dispose()
})
it('preserves a row already newer than an active response at read time', async () => {
  const f = setup(),
    other = call({ id: 2, roomId: 20, rev: 3 })
  vi.mocked(f.api.active)
    .mockResolvedValueOnce([other])
    .mockResolvedValueOnce([{ ...other, rev: 1 }])
  await f.controller.refresh()
  await f.controller.refresh()
  expect(f.controller.view.calls[0]?.rev).toBe(3)
  f.controller.dispose()
})

it('an old absent active snapshot cannot close a new binding of the same call', async () => {
  const f = setup({ leaveOnMediaDisconnect: false }),
    response = deferred<ImCall[]>()
  await f.controller.start(10, 'audio')
  vi.mocked(f.api.active).mockReturnValue(response.promise)
  const pending = f.controller.refresh()
  f.media.snapshot = { ...f.media.snapshot, state: 'idle' }
  f.media.emit()
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await f.controller.join(f.item)
  response.resolve([])
  await pending
  expect(f.controller.view.current?.id).toBe(1)
  expect(f.controller.view.media.state).toBe('connected')
  f.controller.dispose()
})
