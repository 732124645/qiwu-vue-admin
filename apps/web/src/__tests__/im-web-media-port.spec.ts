import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImMediaEvent } from '@qiwu/shared/im-media'
import { createBrowserMediaPort } from '../../../../packages/shared/src/platform/im/media/browser.js'

interface Gate {
  promise: Promise<void>
  resolve(): void
}
const gate = (): Gate => {
  let resolve!: () => void
  return {
    promise: new Promise<void>((r) => {
      resolve = r
    }),
    resolve: () => resolve(),
  }
}
interface FakeParticipant {
  identity: string
  name: string
  isMicrophoneEnabled: boolean
  isCameraEnabled: boolean
  trackPublications: Map<string, { track: { stop(): void } }>
  video: { attach(): HTMLVideoElement; detach(element: HTMLMediaElement): void } | null
}
interface FakeRoom {
  localParticipant: FakeParticipant
  handlers: Map<string, ((...args: unknown[]) => void)[]>
  disconnects: number
  emit(type: string, ...args: unknown[]): void
}
const sdk = vi.hoisted(() => ({
  rooms: [] as FakeRoom[],
  connectGate: null as Gate | null,
  cameraGate: null as Gate | null,
  audioGate: null as Gate | null,
  disconnectFails: false,
}))
// 替换媒体 SDK 端口，DOM 使用测试环境自己的真实元素；不连接远端服务。
vi.mock(
  '../../../../packages/shared/node_modules/livekit-client/dist/livekit-client.esm.mjs',
  () => {
    const names = [
      'ParticipantConnected',
      'ParticipantDisconnected',
      'TrackPublished',
      'TrackUnpublished',
      'TrackMuted',
      'TrackUnmuted',
      'LocalTrackPublished',
      'LocalTrackUnpublished',
      'Reconnecting',
      'Reconnected',
      'Disconnected',
      'AudioPlaybackStatusChanged',
      'TrackSubscribed',
      'TrackUnsubscribed',
    ]
    class Room {
      handlers = new Map<string, ((...args: unknown[]) => void)[]>()
      remoteParticipants = new Map()
      disconnects = 0
      canPlaybackAudio = true
      localParticipant = {
        identity: 'u1',
        name: 'Ann',
        isMicrophoneEnabled: false,
        isCameraEnabled: false,
        trackPublications: new Map<string, { track: { stop(): void } }>(),
        video: null as FakeParticipant['video'],
        getTrackPublication: () =>
          this.localParticipant.video ? { track: this.localParticipant.video } : undefined,
        setMicrophoneEnabled: async (enabled: boolean) => {
          this.localParticipant.isMicrophoneEnabled = enabled
          this.localParticipant.trackPublications.set('microphone', {
            track: {
              stop: () => {
                this.localParticipant.isMicrophoneEnabled = false
              },
            },
          })
        },
        setCameraEnabled: async (enabled: boolean) => {
          if (sdk.cameraGate) await sdk.cameraGate.promise
          this.localParticipant.isCameraEnabled = enabled
          this.localParticipant.video = {
            attach: () => document.createElement('video'),
            detach: () => undefined,
          }
          this.localParticipant.trackPublications.set('camera', {
            track: {
              stop: () => {
                this.localParticipant.isCameraEnabled = false
              },
            },
          })
        },
      }
      constructor() {
        sdk.rooms.push(this)
      }
      on(type: string, handler: (...args: unknown[]) => void) {
        const group = this.handlers.get(type) ?? []
        group.push(handler)
        this.handlers.set(type, group)
        return this
      }
      emit(type: string, ...args: unknown[]) {
        for (const handler of this.handlers.get(type) ?? []) handler(...args)
      }
      async connect() {
        if (sdk.connectGate) await sdk.connectGate.promise
      }
      async disconnect() {
        this.disconnects++
        if (sdk.disconnectFails) throw new Error('private SDK URL and credential must not escape')
      }
      removeAllListeners() {
        this.handlers.clear()
      }
      async startAudio() {
        if (sdk.audioGate) await sdk.audioGate.promise
        this.canPlaybackAudio = true
      }
    }
    return {
      Room,
      RoomEvent: Object.fromEntries(names.map((name) => [name, name])),
      Track: { Kind: { Audio: 'audio', Video: 'video' }, Source: { Camera: 'camera' } },
      LogLevel: { silent: 'silent' },
      setLogLevel: () => undefined,
    }
  },
)
beforeEach(() => {
  sdk.rooms = []
  sdk.connectGate = sdk.cameraGate = null
  sdk.audioGate = null
  sdk.disconnectFails = false
})
afterEach(() => {
  document.body.replaceChildren()
})

describe('browser media Room lifecycle', () => {
  it('rejects unbounded or insecure input before creating an SDK Room', async () => {
    const media = createBrowserMediaPort()
    await expect(
      media.connect({ url: 'ws://remote.example.test', token: 'token' }),
    ).rejects.toMatchObject({ code: 'INVALID_URL' })
    await expect(
      media.connect({ url: 'wss://media.example.test', token: '\n' }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' })
    await expect(
      media.connect({ url: 'wss://media.example.test?access_token=secret', token: 'token' }),
    ).rejects.toMatchObject({ code: 'INVALID_URL' })
    expect(sdk.rooms).toHaveLength(0)
  })
  it('does not create a second Room and cancels a late connection before capture', async () => {
    sdk.connectGate = gate()
    const media = createBrowserMediaPort()
    const connecting = media.connect({
      url: 'wss://media.example.test',
      token: 'runtime-secret',
      microphone: true,
      camera: true,
    })
    const cancelled = connecting.catch((error: unknown) => error)
    const id = media.getSnapshot().connectionId
    await expect(
      media.connect({ url: 'wss://media.example.test', token: 'second' }),
    ).rejects.toMatchObject({ code: 'BUSY' })
    await media.disconnect(id)
    sdk.connectGate.resolve()
    await expect(cancelled).resolves.toMatchObject({ code: 'CANCELLED' })
    expect(sdk.rooms).toHaveLength(1)
    expect(sdk.rooms[0]!.localParticipant.isMicrophoneEnabled).toBe(false)
    expect(sdk.rooms[0]!.localParticipant.isCameraEnabled).toBe(false)
    expect(media.getSnapshot().state).toBe('idle')
  })
  it('stops media published after cancellation even when SDK disconnect itself is a no-op', async () => {
    const media = createBrowserMediaPort()
    await media.connect({ url: 'wss://media.example.test', token: 'token' })
    sdk.cameraGate = gate()
    const camera = media.setCameraEnabled(media.getSnapshot().connectionId, true)
    const cancelled = camera.catch((error: unknown) => error)
    await media.disconnect(media.getSnapshot().connectionId)
    sdk.cameraGate.resolve()
    await expect(cancelled).resolves.toMatchObject({ code: 'CANCELLED' })
    expect(sdk.rooms[0]!.localParticipant.isCameraEnabled).toBe(false)
    expect(sdk.rooms[0]!.disconnects).toBeGreaterThanOrEqual(2)
  })
  it('keeps failed cleanup occupied and never returns raw SDK details', async () => {
    const media = createBrowserMediaPort()
    await media.connect({ url: 'wss://media.example.test', token: 'token' })
    const id = media.getSnapshot().connectionId
    sdk.disconnectFails = true
    await expect(media.disconnect(id)).rejects.toMatchObject({
      code: 'SDK_ERROR',
      operation: 'disconnect',
      message: 'SDK_ERROR',
    })
    expect(media.getSnapshot().state).toBe('disconnecting')
    await expect(
      media.connect({ url: 'wss://media.example.test', token: 'next' }),
    ).rejects.toMatchObject({ code: 'BUSY' })
    sdk.disconnectFails = false
    await media.disconnect(id)
    expect(media.getSnapshot().state).toBe('idle')
  })
  it('remembers a connecting video tile, follows camera publication, and unmounts only its own view', async () => {
    const media = createBrowserMediaPort()
    sdk.connectGate = gate()
    const connecting = media.connect({
      url: 'wss://media.example.test',
      token: 'token',
      camera: true,
    })
    const host = document.createElement('div')
    document.body.append(host)
    const id = media.getSnapshot().connectionId
    const off = media.attachVideo(host, id, 'u1')
    expect(host.querySelector('video')).toBeNull()
    sdk.connectGate.resolve()
    await connecting
    expect(host.querySelector('video')).not.toBeNull()
    off()
    expect(host.querySelector('video')).toBeNull()
    expect(media.getSnapshot().state).toBe('connected')
    await media.disconnect(id)
  })
  it('retains internal disconnection handling after external listeners unsubscribe', async () => {
    const media = createBrowserMediaPort(),
      listener = vi.fn<(event: ImMediaEvent) => void>()
    const off = media.subscribe(listener)
    await media.connect({ url: 'wss://media.example.test', token: 'token' })
    off()
    const calls = listener.mock.calls.length
    sdk.rooms[0]!.emit('Disconnected')
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(media.getSnapshot().state).toBe('idle')
    expect(listener).toHaveBeenCalledTimes(calls)
  })
  it('does not apply a previous playback authorization to a new Room', async () => {
    const media = createBrowserMediaPort()
    await media.connect({ url: 'wss://media.example.test', token: 'first' })
    sdk.audioGate = gate()
    const playback = media.startAudio(),
      retired = playback.catch((error: unknown) => error)
    await media.disconnect(media.getSnapshot().connectionId)
    await media.connect({ url: 'wss://media.example.test', token: 'second' })
    media.audioBlocked = true
    sdk.audioGate.resolve()
    await expect(retired).resolves.toMatchObject({ code: 'SDK_ERROR' })
    expect(media.audioBlocked).toBe(true)
    expect(media.getSnapshot().state).toBe('connected')
    await media.disconnect(media.getSnapshot().connectionId)
  })
  it('contains audio attachment errors without exposing the SDK exception to the host', async () => {
    const media = createBrowserMediaPort(),
      listener = vi.fn<(event: ImMediaEvent) => void>()
    media.subscribe(listener)
    await media.connect({ url: 'wss://media.example.test', token: 'token' })
    expect(() =>
      sdk.rooms[0]!.emit('TrackSubscribed', {
        kind: 'audio',
        attach: () => {
          throw new Error('private media credential')
        },
      }),
    ).not.toThrow()
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'SDK_ERROR', operation: 'attachAudio' }),
      }),
    )
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private media credential')
    await media.disconnect(media.getSnapshot().connectionId)
  })
  it('lets an idle listener create and cancel the next connection without the previous cleanup blocking it', async () => {
    const media = createBrowserMediaPort()
    await media.connect({ url: 'wss://media.example.test', token: 'first' })
    const firstId = media.getSnapshot().connectionId
    let next: Promise<import('@qiwu/shared/im-media').ImMediaSnapshot> | null = null
    let cancelled: Promise<import('@qiwu/shared/im-media').ImMediaSnapshot> | null = null
    const off = media.subscribe((event) => {
      if (event.snapshot.state === 'idle' && event.snapshot.connectionId === firstId) {
        next = media.connect({ url: 'wss://media.example.test', token: 'second' })
        void next.catch(() => undefined)
      } else if (event.snapshot.state === 'connecting' && event.snapshot.connectionId !== firstId) {
        cancelled = media.disconnect(event.snapshot.connectionId)
        void cancelled.catch(() => undefined)
      }
    })
    await media.disconnect(firstId)
    expect(next).not.toBeNull()
    expect(cancelled).not.toBeNull()
    await expect(next).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(cancelled).resolves.toMatchObject({ state: 'idle' })
    expect(media.getSnapshot().state).toBe('idle')
    off()
  })
})

it('rejects an old disconnect and ignores an old video intent after replacement', async () => {
  const media = createBrowserMediaPort()
  await media.connect({ url: 'wss://media.example.test', token: 'first', camera: true })
  const previous = media.getSnapshot().connectionId
  await media.disconnect(previous)
  await media.connect({ url: 'wss://media.example.test', token: 'second', camera: true })
  await expect(media.disconnect(previous)).rejects.toMatchObject({ code: 'STALE_CONNECTION' })
  expect(sdk.rooms[1]!.disconnects).toBe(0)
  const host = document.createElement('div')
  media.attachVideo(host, previous, 'u1')
  expect(host.querySelector('video')).toBeNull()
  const current = media.getSnapshot().connectionId
  media.attachVideo(host, current, 'u1')
  expect(host.querySelector('video')).not.toBeNull()
  await media.disconnect(current)
})

it('requires the exact connected identity for each browser device action and serializes pending capture', async () => {
  const media = createBrowserMediaPort()
  await media.connect({ url: 'wss://media.example.test', token: 'token' })
  await expect(media.setMicrophoneEnabled('retired', true)).rejects.toMatchObject({
    code: 'STALE_CONNECTION',
  })
  expect(sdk.rooms[0]!.localParticipant.isMicrophoneEnabled).toBe(false)
  const id = media.getSnapshot().connectionId
  sdk.cameraGate = gate()
  const camera = media.setCameraEnabled(id, true)
  await expect(media.setMicrophoneEnabled(id, true)).rejects.toMatchObject({ code: 'BUSY' })
  expect(sdk.rooms[0]!.localParticipant.isMicrophoneEnabled).toBe(false)
  sdk.cameraGate.resolve()
  await camera
  await media.disconnect(id)
})
