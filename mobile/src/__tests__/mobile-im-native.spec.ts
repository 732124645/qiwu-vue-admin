import { expect, it, vi } from 'vitest'
import type { ImMediaEvent, ImMediaSnapshot } from '@qiwu/shared/im-media'
import { createNativeImMediaPort, type NativeImSdk } from '../core/im/media-native-port'

const snapshot = (id = ''): ImMediaSnapshot => ({
  connectionId: id,
  state: id ? 'connected' : 'idle',
  localIdentity: '',
  microphone: false,
  camera: false,
  speakerPreferred: false,
  participants: [],
})
function sdk() {
  const native = {
    getSnapshot: vi.fn(() => snapshot()),
    onLiveKitEvent: vi.fn<NativeImSdk['onLiveKitEvent']>(),
    connect: vi.fn<NativeImSdk['connect']>(),
    disconnect: vi.fn<NativeImSdk['disconnect']>(),
    setMicrophoneEnabled: vi.fn<NativeImSdk['setMicrophoneEnabled']>(),
    setCameraEnabled: vi.fn<NativeImSdk['setCameraEnabled']>(),
    switchCamera: vi.fn<NativeImSdk['switchCamera']>(),
    setSpeakerOutputPreferred: vi.fn<NativeImSdk['setSpeakerOutputPreferred']>(),
    requestMicrophonePermission: vi.fn<NativeImSdk['requestMicrophonePermission']>(),
  }
  return native
}

it('one native listener fans out JS subscriptions and page unsubscribe preserves the other page', () => {
  const native = sdk(),
    port = createNativeImMediaPort(native)
  const first = vi.fn(),
    second = vi.fn(),
    off = port.subscribe(first)
  port.subscribe(second)
  const deliver = native.onLiveKitEvent.mock.calls[0]![0] as (event: ImMediaEvent) => void
  const event: ImMediaEvent = { type: 'state', snapshot: snapshot('a'), error: null }
  deliver(event)
  off()
  deliver(event)
  expect(native.onLiveKitEvent).toHaveBeenCalledTimes(1)
  expect(first).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenCalledTimes(2)
})

it('callback results resolve the same port without exposing a room or credentials in state', async () => {
  const native = sdk(),
    port = createNativeImMediaPort(native)
  const pending = port.connect({
    url: 'wss://media.invalid',
    token: 'runtime-only',
    microphone: true,
    camera: false,
  })
  const options = native.connect.mock.calls[0]![0] as Parameters<NativeImSdk['connect']>[0]
  expect(options).toMatchObject({ microphone: true, camera: false })
  options.success!(snapshot('a'))
  await expect(pending).resolves.toEqual(snapshot('a'))
  expect(port.getSnapshot()).not.toHaveProperty('token')
  const closing = port.disconnect('old-a')
  const release = native.disconnect.mock.calls[0]![0] as Parameters<NativeImSdk['disconnect']>[0]
  expect(release.connectionId).toBe('old-a')
  release.success!(snapshot())
  await expect(closing).resolves.toEqual(snapshot())
})

it('synchronous bridge failures are controlled and do not include the original exception', async () => {
  const native = sdk(),
    port = createNativeImMediaPort(native)
  native.connect.mockImplementation(() => {
    throw new Error('private SDK details')
  })
  await expect(port.connect({ url: 'wss://media.invalid', token: 'runtime-only' })).rejects.toEqual(
    { code: 'SDK_UNAVAILABLE', operation: 'connect' },
  )
  native.getSnapshot.mockImplementation(() => {
    throw new Error('private SDK details')
  })
  let failure: unknown
  try { port.getSnapshot() } catch (error) { failure = error }
  expect(failure).toEqual({ code: 'SDK_UNAVAILABLE', operation: 'getSnapshot' })
})

it('microphone permission alone does not connect, publish or capture audio', async () => {
  const native = sdk(),
    port = createNativeImMediaPort(native)
  const pending = port.requestMicrophonePermission()
  const permission = native.requestMicrophonePermission.mock.calls[0]![0] as (
    granted: boolean,
  ) => void
  permission(false)
  await expect(pending).resolves.toBe(false)
  expect(native.connect).not.toHaveBeenCalled()
  expect(native.setMicrophoneEnabled).not.toHaveBeenCalled()
})

it('every device operation keeps its explicit connection identity', async () => {
  const native = sdk(),
    port = createNativeImMediaPort(native)
  for (const method of [
    'setMicrophoneEnabled',
    'setCameraEnabled',
    'setSpeakerOutputPreferred',
  ] as const) {
    const pending = port[method]('room-before-switch', true)
    const options = native[method].mock.calls[0]![0] as Parameters<NativeImSdk[typeof method]>[0]
    expect(options).toMatchObject({ connectionId: 'room-before-switch', enabled: true })
    options.fail!({ code: 'STALE_CONNECTION', operation: method })
    await expect(pending).rejects.toEqual({ code: 'STALE_CONNECTION', operation: method })
  }
})
