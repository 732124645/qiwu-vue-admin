import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import type { ImCall, ImOptions } from '@qiwu/shared'
import type { ImCallView } from '@qiwu/shared/im-client'
import {
  IM_CALL_ACTION_EVENT,
  IM_CALL_SCREEN_EVENT,
  readImCallAction,
  type ImCallScreen,
} from '../core/im/call-screen'

const empty = () => ({
  connectionId: '',
  state: 'idle' as const,
  localIdentity: '',
  microphone: false,
  camera: false,
  speakerPreferred: false,
  participants: [],
})
const call = (id = 10): ImCall => ({
  id,
  roomId: 9,
  mode: 'video',
  state: 'ringing',
  callerId: 2,
  rev: 1,
  createdAt: '2026-01-01',
  startedAt: null,
  endedAt: null,
  inviteExpiresAt: '2026-01-01',
  endReason: null,
  members: [{ userId: 1, displayName: 'Staff', identity: 'staff-1', state: 'invited' }],
  canAccept: true,
  canDecline: true,
  canJoin: false,
  canLeave: false,
  canEnd: false,
})
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
let callbacks: Map<string, Set<(value: unknown) => void>>
let publish!: (view: ImCallView) => void
let model: {
  view: ImCallView
  refresh: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  accept: ReturnType<typeof vi.fn>
  join: ReturnType<typeof vi.fn>
  decline: ReturnType<typeof vi.fn>
  leave: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  onHint: ReturnType<typeof vi.fn>
  retryDisconnect: ReturnType<typeof vi.fn>
}
let host: typeof import('../core/im/calls')
let session: Ref<number>, options: Ref<ImOptions | null>, leader: Ref<boolean>
let nativeConnect: ReturnType<typeof vi.fn>,
  post: ReturnType<typeof vi.fn>,
  optionsGet: ReturnType<typeof vi.fn>
let navigation: { route: string; options: Record<string, string> }[]
let sessionActive = true
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const emit = (name: string, value: unknown) => {
  for (const callback of callbacks.get(name) ?? []) callback(value)
}

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('UNI_PLATFORM', 'app')
  vi.useFakeTimers()
  callbacks = new Map()
  navigation = []
  sessionActive = true
  session = ref(1)
  options = ref(null)
  leader = ref(true)
  nativeConnect = vi.fn()
  post = vi.fn()
  optionsGet = vi.fn(async () => ({
    epoch: 'one',
    voiceEnabled: true,
    callEnabled: true,
    callConfigured: true,
  }))
  model = {
    view: { calls: [], current: null, media: empty(), busy: false, error: null },
    refresh: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    accept: vi.fn(async () => {}),
    join: vi.fn(async () => {}),
    decline: vi.fn(async () => {}),
    leave: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    onHint: vi.fn(async () => {}),
    retryDisconnect: vi.fn(async () => {}),
    reset: vi.fn(),
  }
  model.reset.mockImplementation(() => {
    model.view = { calls: [], current: null, media: empty(), busy: false, error: null }
    publish?.(model.view)
  })
  vi.doMock('@qiwu/shared/im-client', () => ({
    createImCallController: (config: { onChange(view: ImCallView): void }) => {
      publish = (view) => {
        model.view = view
        config.onChange(view)
      }
      return model
    },
  }))
  vi.doMock('../core/im/client', () => ({
    IM_PLATFORM: true,
    imLeader: leader,
    imStart: vi.fn(async () => {}),
    imCurrent: () => ({ leader: leader.value }),
    imOptions: options,
    imState: ref('ready'),
    onImChange: () => () => {},
  }))
  vi.doMock('../core/im/api', () => ({ imApi: { options: optionsGet } }))
  vi.doMock('../core/request', () => ({
    api: { get: vi.fn(), post },
    currentSessionVersion: () => session.value,
    sessionVersion: session,
    hasSession: () => sessionActive,
  }))
  vi.doMock('../core/stores/auth', () => ({
    useAuthStore: () => ({ me: { user: { id: 1 }, features: ['im'] }, passwordChangeDue: false }),
  }))
  vi.doMock('../core/im/media', () => ({
    imMediaReserved: ref(false),
    initializeImMedia: vi.fn(),
    imMedia: { getSnapshot: empty, subscribe: vi.fn(), connect: nativeConnect },
    ensureImMedia: () => ({ setMicrophoneEnabled: vi.fn() }),
    imBrowserMedia: () => ({ audioBlocked: false }),
  }))
  vi.doMock('../core/im/voice', () => ({
    cancelImVoice: vi.fn(async () => {}),
    reconcileImVoice: vi.fn(async () => {}),
  }))
  vi.stubGlobal('getCurrentPages', () => navigation)
  Object.assign(uni, {
    $on: (name: string, callback: (value: unknown) => void) => {
      const set = callbacks.get(name) ?? new Set()
      set.add(callback)
      callbacks.set(name, set)
    },
    $emit: emit,
    navigateTo: vi.fn((input: { url: string; complete(): void }) => {
      const query = new URL(input.url, 'https://app.invalid').searchParams
      navigation = [{ route: 'pages-im/call/index', options: Object.fromEntries(query) }]
      input.complete()
    }),
    redirectTo: vi.fn((input: { url: string; complete(): void }) => {
      const query = new URL(input.url, 'https://app.invalid').searchParams
      navigation = [{ route: 'pages-im/call/index', options: Object.fromEntries(query) }]
      input.complete()
    }),
    navigateBack: vi.fn((input?: { complete?(): void }) => {
      navigation = []
      input?.complete?.()
    }),
  })
  host = await import('../core/im/calls')
  host.initializeImCalls()
  await host.imCallForeground()
})
afterEach(() => {
  host?.imCallBackground()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator)
  else Reflect.deleteProperty(globalThis, 'navigator')
})

it('global foreground invitations open a safe page without accepting or opening devices', async () => {
  publish({ calls: [call()], current: null, media: empty(), busy: false, error: null })
  const dto = host.imCallScreen.value!
  expect(dto.call?.id).toBe(10)
  expect(dto.media.state).toBe('idle')
  expect(model.accept).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
  expect(navigation[0]!.options).toEqual({ callId: '10', screenId: dto.screenId })
  expect(JSON.stringify(dto)).not.toMatch(/token|wss:|Bearer|runtime-only/)
  emit(IM_CALL_ACTION_EVENT, { screenId: dto.screenId, callId: 10, action: 'accept' })
  await flush()
  expect(model.accept).toHaveBeenCalledWith(call())
})

it('closing an old page cannot leave or operate the newer call page', async () => {
  publish({ calls: [call(10), call(11)], current: null, media: empty(), busy: false, error: null })
  const previous = host.imCallScreen.value!
  host.openImCallPage(11)
  const next = host.imCallScreen.value!
  expect(next.screenId).not.toBe(previous.screenId)
  for (const action of ['accept', 'leave', 'end', 'microphone', 'hide'])
    emit(IM_CALL_ACTION_EVENT, { screenId: previous.screenId, callId: 10, action, enabled: true })
  await flush()
  expect(model.accept).not.toHaveBeenCalled()
  expect(model.leave).not.toHaveBeenCalled()
  expect(model.end).not.toHaveBeenCalled()
  expect(host.imCallScreen.value?.screenId).toBe(next.screenId)
})

it('an account generation change closes the screen and rejects all old actions', async () => {
  publish({ calls: [call()], current: null, media: empty(), busy: false, error: null })
  const previous = host.imCallScreen.value!,
    screens: ImCallScreen[] = []
  callbacks.set(IM_CALL_SCREEN_EVENT, new Set([(value) => screens.push(value as ImCallScreen)]))
  sessionActive = false
  session.value++
  expect(host.imCallScreen.value).toBeNull()
  expect(
    screens.some(
      (value) => value.closed && value.call === null && value.media.participants.length === 0,
    ),
  ).toBe(true)
  emit(IM_CALL_ACTION_EVENT, { screenId: previous.screenId, callId: 10, action: 'accept' })
  await flush()
  expect(model.accept).not.toHaveBeenCalled()
  expect(model.reset).toHaveBeenCalled()
})

it('an options response completing in the background cannot restore invitations or SDK state', async () => {
  const pending = deferred<ImOptions>()
  optionsGet.mockReturnValueOnce(pending.promise)
  const running = host.imCallForeground()
  await flush()
  const before = model.refresh.mock.calls.length
  host.imCallBackground()
  pending.resolve({ epoch: 'one', callEnabled: true, callConfigured: true } as ImOptions)
  await running
  await flush()
  expect(model.refresh).toHaveBeenCalledTimes(before)
  expect(host.imCallScreen.value).toBeNull()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it('unconfigured calling never sends create or connects a native room', async () => {
  options.value = { epoch: 'one', callEnabled: true, callConfigured: false } as ImOptions
  await host.startImCall(9, 'audio')
  expect(model.start).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
  expect(host.imCalls.value.error?.code).toBe('UNCONFIGURED')
})

it('the screen action parser rejects forged fields and invalid identifiers', () => {
  const good = { screenId: 'page-1', callId: 10, action: 'microphone', enabled: true }
  expect(readImCallAction(good)).toEqual(good)
  for (const bad of [
    { ...good, token: 'unused' },
    { ...good, callId: -1 },
    { ...good, screenId: '../other' },
    { ...good, action: 'connect' },
    { ...good, enabled: 'yes' },
  ])
    expect(readImCallAction(bad)).toBeNull()
})

it('checks screen and call identifiers independently', async () => {
  publish({ calls: [call()], current: null, media: empty(), busy: false, error: null })
  const dto = host.imCallScreen.value!
  emit(IM_CALL_ACTION_EVENT, { screenId: 'different-page', callId: dto.callId, action: 'accept' })
  emit(IM_CALL_ACTION_EVENT, { screenId: dto.screenId, callId: dto.callId + 1, action: 'accept' })
  await flush()
  expect(model.accept).not.toHaveBeenCalled()
})
it('does not replace foreground configuration with a late background response', async () => {
  const response = deferred<ImOptions>()
  optionsGet.mockReturnValueOnce(response.promise)
  const foreground = host.imCallForeground()
  await flush()
  host.imCallBackground()
  response.resolve({ epoch: 'background', callEnabled: true, callConfigured: true } as ImOptions)
  await foreground
  expect(options.value?.epoch).toBe('one')
})

it('does not start a call when the App backgrounds during cached options resolution', async () => {
  const starting = host.startImCall(9, 'audio')
  host.imCallBackground()
  await starting
  expect(model.start).not.toHaveBeenCalled()
})

it('returning to the foreground does not revive a cached start from before backgrounding', async () => {
  const starting = host.startImCall(9, 'audio')
  host.imCallBackground()
  await host.imCallForeground()
  await starting
  expect(model.start).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it('a pending options request cannot replace foreground configuration or revive its old start', async () => {
  const pending = deferred<ImOptions>()
  options.value = null
  optionsGet.mockReturnValueOnce(pending.promise)
  const starting = host.startImCall(9, 'audio')
  await flush()
  host.imCallBackground()
  const resumed = host.imCallForeground()
  await flush()
  expect(optionsGet).toHaveBeenCalledTimes(3)
  await resumed
  pending.resolve({ epoch: 'old', callEnabled: true, callConfigured: true } as ImOptions)
  await starting
  expect((options.value as ImOptions | null)?.epoch).toBe('one')
  expect(model.start).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it('a H5 leadership handoff retires an already requested start even when this tab later leads again', async () => {
  vi.stubEnv('UNI_PLATFORM', 'h5')
  vi.stubGlobal('navigator', { locks: {} })
  const starting = host.startImCall(9, 'audio')
  leader.value = false
  leader.value = true
  await starting
  await flush()
  expect(model.start).not.toHaveBeenCalled()
  expect(model.reset).toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it('H5 rechecks current leadership after reading options without relying on a UI watcher', async () => {
  vi.stubEnv('UNI_PLATFORM', 'h5')
  vi.stubGlobal('navigator', { locks: {} })
  const starting = host.startImCall(9, 'audio')
  vi.stubGlobal('navigator', {})
  await starting
  expect(model.start).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it('a cached foreground hint cannot run after the App has retired and resumed', async () => {
  host.imCallHint({ callId: 10, roomId: 9, rev: 1 })
  host.imCallBackground()
  await host.imCallForeground()
  await flush()
  expect(model.onHint).not.toHaveBeenCalled()
})

it('restores foreground polling after adopting a new valid server epoch', async () => {
  const before = model.refresh.mock.calls.length
  const requests = optionsGet.mock.calls.length
  optionsGet.mockResolvedValueOnce({
    epoch: 'two',
    voiceEnabled: true,
    callEnabled: true,
    callConfigured: true,
  })
  await host.imCallForeground()
  await flush()
  expect(options.value?.epoch).toBe('two')
  expect(model.refresh).toHaveBeenCalledTimes(before + 1)
  expect(optionsGet).toHaveBeenCalledTimes(requests + 1)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(model.refresh).toHaveBeenCalledTimes(before + 2)
  expect(optionsGet).toHaveBeenCalledTimes(requests + 1)
  expect(model.start).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it('a retired epoch recovery cannot leave a stale timer that prevents the next foreground polling', async () => {
  const before = model.refresh.mock.calls.length,
    refresh = deferred<void>()
  optionsGet.mockResolvedValue({
    epoch: 'two',
    voiceEnabled: true,
    callEnabled: true,
    callConfigured: true,
  })
  model.refresh.mockReturnValueOnce(refresh.promise)
  await host.imCallForeground()
  await flush()
  expect(model.refresh).toHaveBeenCalledTimes(before + 1)
  host.imCallBackground()
  refresh.resolve()
  await flush()
  await host.imCallForeground()
  await flush()
  expect(model.refresh).toHaveBeenCalledTimes(before + 2)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(model.refresh).toHaveBeenCalledTimes(before + 3)
  expect(model.start).not.toHaveBeenCalled()
  expect(nativeConnect).not.toHaveBeenCalled()
})

it.each(['background', 'session', 'leader'] as const)(
  'does not resume an adopted epoch after %s retirement while releasing old devices',
  async (event) => {
    if (event === 'leader') {
      vi.stubEnv('UNI_PLATFORM', 'h5')
      vi.stubGlobal('navigator', { locks: {} })
    }
    const before = model.refresh.mock.calls.length,
      closing = deferred<void>()
    model.reset.mockImplementationOnce(() => {
      publish({
        calls: [],
        current: null,
        media: { ...empty(), state: 'disconnecting', connectionId: 'old-room' },
        busy: false,
        error: null,
      })
    })
    model.retryDisconnect.mockReturnValueOnce(closing.promise)
    optionsGet.mockResolvedValueOnce({
      epoch: 'two',
      voiceEnabled: true,
      callEnabled: true,
      callConfigured: true,
    })
    const foreground = host.imCallForeground()
    await flush()
    expect(options.value?.epoch).toBe('two')
    expect(model.retryDisconnect).toHaveBeenCalledTimes(1)
    if (event === 'background') host.imCallBackground()
    else if (event === 'session') {
      sessionActive = false
      session.value++
    } else leader.value = false
    closing.resolve()
    await foreground
    await flush()
    expect(model.refresh).toHaveBeenCalledTimes(before)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(model.refresh).toHaveBeenCalledTimes(before)
    expect(model.start).not.toHaveBeenCalled()
    expect(model.onHint).not.toHaveBeenCalled()
  },
)
