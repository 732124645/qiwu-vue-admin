import {
  LogLevel,
  Room,
  RoomEvent,
  Track,
  setLogLevel,
  type LocalVideoTrack,
  type VideoTrack,
} from 'livekit-client'
import { ImMediaError, type ImMediaEvent, type ImMediaPort, type ImMediaSnapshot } from './types.js'

interface Tile {
  id: string
  participant: string
  track?: VideoTrack
  video?: HTMLVideoElement
}

/** 票据不能含 C0/C1 控制字符，避免上游将隐藏换行或分隔符当作合法凭据。 */
function tokenHasControl(token: string): boolean {
  for (const character of token) {
    const code = character.charCodeAt(0)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

/** 官方 Web SDK 的薄适配；每个端口只持有一个 Room，并用连接编号隔离迟到回调。 */
export class BrowserMediaPort implements ImMediaPort {
  private room: Room | null = null
  private id = ''
  private state: ImMediaSnapshot['state'] = 'idle'
  private generation = 0
  private busy = false
  private closing: Room | null = null
  private facing: 'user' | 'environment' = 'user'
  private listeners = new Set<(event: ImMediaEvent) => void>()
  private videos = new Map<HTMLElement, Tile>()
  private audio = new Map<Track, { room: Room; element: HTMLMediaElement }>()
  private roomIds = new WeakMap<Room, string>()
  audioBlocked = false

  getSnapshot(): ImMediaSnapshot {
    const r = this.room
    const participants = r ? [r.localParticipant, ...r.remoteParticipants.values()] : []
    return {
      connectionId: this.id,
      state: this.state,
      localIdentity: r?.localParticipant.identity ?? '',
      microphone: r?.localParticipant.isMicrophoneEnabled ?? false,
      camera: r?.localParticipant.isCameraEnabled ?? false,
      speakerPreferred: false,
      participants: participants
        .filter((p) => p.identity)
        .map((p) => ({
          identity: p.identity,
          name: p.name ?? '',
          local: p === r?.localParticipant,
          microphone: p.isMicrophoneEnabled,
          camera: p.isCameraEnabled,
        })),
    }
  }
  subscribe(listener: (event: ImMediaEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit(type: ImMediaEvent['type'], error: ImMediaEvent['error'] = null) {
    const event = { type, snapshot: this.getSnapshot(), error }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* 宿主回调不能打断资源释放。 */
      }
    }
  }
  private current(r: Room, gen: number) {
    return (
      this.room === r &&
      this.generation === gen &&
      this.state !== 'idle' &&
      this.state !== 'disconnecting'
    )
  }
  private check(r: Room, gen: number, operation: string) {
    if (!this.current(r, gen)) throw new ImMediaError('CANCELLED', operation)
  }

  /** 只在用户明确发起或接受后传入运行时票据，初始化媒体也逐阶段检查取消。 */
  async connect(options: {
    url: string
    token: string
    microphone?: boolean
    camera?: boolean
  }): Promise<ImMediaSnapshot> {
    if (this.room || this.state !== 'idle') throw new ImMediaError('BUSY', 'connect')
    let address: URL
    try {
      address = new URL(options.url)
    } catch {
      throw new ImMediaError('INVALID_URL', 'connect')
    }
    if (
      address.username ||
      address.password ||
      address.hash ||
      address.origin !== options.url.replace(/\/$/, '') ||
      options.url.length > 2048 ||
      !(
        address.protocol === 'wss:' ||
        (address.protocol === 'ws:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname))
      )
    )
      throw new ImMediaError('INVALID_URL', 'connect')
    if (!options.token || options.token.length > 16384 || tokenHasControl(options.token))
      throw new ImMediaError('INVALID_TOKEN', 'connect')
    setLogLevel(LogLevel.silent)
    const r = new Room({ adaptiveStream: true, dynacast: true })
    const gen = ++this.generation
    this.id =
      globalThis.crypto?.randomUUID?.() ??
      `media_${Date.now()}_${Math.random().toString(36).slice(2)}`
    this.roomIds.set(r, this.id)
    this.room = r
    this.state = 'connecting'
    this.facing = 'user'
    this.busy = false
    const update = (type: 'participants' | 'tracks') => {
      if (this.current(r, gen)) {
        this.refreshVideos()
        this.emit(type)
      }
    }
    r.on(RoomEvent.ParticipantConnected, () => update('participants'))
      .on(RoomEvent.ParticipantDisconnected, () => update('participants'))
      .on(RoomEvent.TrackPublished, () => update('tracks'))
      .on(RoomEvent.TrackUnpublished, () => update('tracks'))
      .on(RoomEvent.TrackMuted, () => update('tracks'))
      .on(RoomEvent.TrackUnmuted, () => update('tracks'))
      .on(RoomEvent.LocalTrackPublished, () => update('tracks'))
      .on(RoomEvent.LocalTrackUnpublished, () => update('tracks'))
      .on(RoomEvent.Reconnecting, () => {
        if (this.current(r, gen)) {
          this.state = 'reconnecting'
          this.emit('state')
        }
      })
      .on(RoomEvent.Reconnected, () => {
        if (this.current(r, gen)) {
          this.state = 'connected'
          this.refreshVideos()
          this.emit('state')
        }
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.current(r, gen)) void this.disconnect(this.id).catch(() => undefined)
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (this.current(r, gen)) {
          this.audioBlocked = !r.canPlaybackAudio
          this.emit('audio-route')
        }
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (!this.current(r, gen)) return
        if (track.kind === Track.Kind.Audio) {
          try {
            const element = track.attach()
            this.audio.set(track, { room: r, element })
            element.style.display = 'none'
            document.body.append(element)
            void element.play().catch(() => {
              if (this.current(r, gen)) {
                this.audioBlocked = true
                this.emit('audio-route')
              }
            })
          } catch {
            this.emit('error', new ImMediaError('SDK_ERROR', 'attachAudio'))
          }
        }
        update('tracks')
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        const entry = this.audio.get(track)
        if (entry?.room === r)
          try {
            track.detach(entry.element)
            entry.element.remove()
            this.audio.delete(track)
          } catch {
            if (this.current(r, gen))
              this.emit('error', new ImMediaError('SDK_ERROR', 'detachAudio'))
          }
        update('tracks')
      })
    this.emit('state')
    try {
      this.check(r, gen, 'connect')
      await r.connect(options.url, options.token)
      this.check(r, gen, 'connect')
      if (options.microphone) {
        await r.localParticipant.setMicrophoneEnabled(true)
        this.check(r, gen, 'connect')
      }
      if (options.camera) {
        await r.localParticipant.setCameraEnabled(true)
        this.check(r, gen, 'connect')
      }
      this.state = 'connected'
      const result = this.getSnapshot()
      this.refreshVideos()
      if (this.current(r, gen)) this.emit('state')
      return result
    } catch (error) {
      if (this.room === r && !this.closing) {
        ++this.generation
        this.state = 'disconnecting'
        this.emit('state')
      }
      try {
        await this.release(r)
        if (this.room === r && !this.closing) {
          this.room = null
          this.state = 'idle'
          this.busy = false
          this.emit('state')
        }
      } catch {
        if (this.room === r) {
          this.state = 'disconnecting'
          this.emit('error', new ImMediaError('SDK_ERROR', 'disconnect'))
        }
      }
      throw error instanceof ImMediaError ? error : new ImMediaError('SDK_ERROR', 'connect')
    }
  }
  private async release(r: Room) {
    let failed = false
    const attempt = (fn: () => void) => {
      try {
        fn()
      } catch {
        failed = true
      }
    }
    const id = this.roomIds.get(r)
    for (const [host, tile] of this.videos)
      if (tile.id === id) attempt(() => this.detachVideo(host))
    for (const [track, entry] of this.audio)
      if (entry.room === r) {
        let detached = true
        try {
          track.detach(entry.element)
        } catch {
          failed = true
          detached = false
        }
        attempt(() => entry.element.remove())
        if (detached) this.audio.delete(track)
      }
    for (const publication of r.localParticipant.trackPublications.values())
      attempt(() => publication.track?.stop())
    try {
      await r.disconnect()
    } catch {
      failed = true
    }
    if (failed) throw new ImMediaError('SDK_ERROR', 'disconnect')
    r.removeAllListeners()
  }
  /** 退出先退役代次，释放完成前保持占用；失败可以按同一编号重试。 */
  async disconnect(id: string): Promise<ImMediaSnapshot> {
    if (!id || id !== this.id) throw new ImMediaError('STALE_CONNECTION', 'disconnect')
    if (this.closing) throw new ImMediaError('BUSY', 'disconnect')
    const r = this.room
    if (!r) return this.getSnapshot()
    ++this.generation
    this.state = 'disconnecting'
    this.closing = r
    this.emit('state')
    try {
      await this.release(r)
      if (this.room === r) {
        for (const host of this.videos.keys()) this.detachVideo(host)
        for (const entry of this.audio.values()) entry.element.remove()
        this.audio.clear()
        this.room = null
        this.state = 'idle'
        this.busy = false
        this.audioBlocked = false
      }
      const result = this.getSnapshot()
      if (this.closing === r) this.closing = null
      this.emit('state')
      return result
    } catch {
      const error = new ImMediaError('SDK_ERROR', 'disconnect')
      this.emit('error', error)
      throw error
    } finally {
      if (this.closing === r) this.closing = null
    }
  }
  private async action(
    id: string,
    operation: string,
    fn: (r: Room) => Promise<unknown>,
  ): Promise<ImMediaSnapshot> {
    const r = this.room,
      gen = this.generation
    if (!r || id !== this.id) throw new ImMediaError('STALE_CONNECTION', operation)
    if (this.state !== 'connected') throw new ImMediaError('NOT_CONNECTED', operation)
    if (this.busy) throw new ImMediaError('BUSY', operation)
    this.busy = true
    try {
      await fn(r)
      this.check(r, gen, operation)
      const result = this.getSnapshot()
      this.refreshVideos()
      if (this.current(r, gen)) this.emit('tracks')
      return result
    } catch (error) {
      if (!this.current(r, gen)) {
        await this.release(r).catch(() => undefined)
        throw new ImMediaError('CANCELLED', operation)
      }
      const controlled =
        error instanceof ImMediaError ? error : new ImMediaError('SDK_ERROR', operation)
      this.emit('error', controlled)
      throw controlled
    } finally {
      if (this.room === r) this.busy = false
    }
  }
  setMicrophoneEnabled(id: string, enabled: boolean) {
    return this.action(id, 'setMicrophoneEnabled', (r) =>
      r.localParticipant.setMicrophoneEnabled(enabled),
    )
  }
  setCameraEnabled(id: string, enabled: boolean) {
    return this.action(id, 'setCameraEnabled', (r) => r.localParticipant.setCameraEnabled(enabled))
  }
  switchCamera(id: string) {
    return this.action(id, 'switchCamera', async (r) => {
      const track = r.localParticipant.getTrackPublication(Track.Source.Camera)?.track as
        LocalVideoTrack | undefined
      if (!track || !r.localParticipant.isCameraEnabled)
        throw new ImMediaError('NO_CAMERA', 'switchCamera')
      const next = this.facing === 'user' ? 'environment' : 'user'
      await track.restartTrack({ facingMode: next })
      this.facing = next
    })
  }
  setSpeakerOutputPreferred(_id: string, _enabled: boolean): Promise<ImMediaSnapshot> {
    return Promise.reject(new ImMediaError('UNSUPPORTED', 'setSpeakerOutputPreferred'))
  }
  async startAudio() {
    const r = this.room,
      gen = this.generation
    if (!r) return
    try {
      await r.startAudio()
      this.check(r, gen, 'startAudio')
      this.audioBlocked = !r.canPlaybackAudio
      this.emit('audio-route')
    } catch {
      const error = new ImMediaError('SDK_ERROR', 'startAudio')
      if (this.current(r, gen)) this.emit('error', error)
      throw error
    }
  }
  /** 连接未完先保存视图意图，接通后跟随 SDK 的 camera publication 更新。 */
  attachVideo(host: HTMLElement, id: string, participant: string): () => void {
    try {
      this.detachVideo(host)
      this.videos.set(host, { id, participant })
      this.refreshVideos()
    } catch {
      this.emit('error', new ImMediaError('SDK_ERROR', 'bindVideoView'))
    }
    return () => {
      try {
        this.detachVideo(host)
      } catch {
        this.emit('error', new ImMediaError('SDK_ERROR', 'unbindVideoView'))
      }
    }
  }
  private detachVideo(host: HTMLElement) {
    const tile = this.videos.get(host)
    if (tile?.video) {
      let failed = false
      try {
        tile.track?.detach(tile.video)
      } catch {
        failed = true
      }
      try {
        tile.video.remove()
      } catch {
        failed = true
      }
      if (failed) throw new ImMediaError('SDK_ERROR', 'unbindVideoView')
    }
    this.videos.delete(host)
  }
  private refreshVideos() {
    const r = this.room
    if (!r || !['connected', 'reconnecting'].includes(this.state)) return
    for (const [host, tile] of this.videos) {
      if (tile.id !== this.id) continue
      try {
        const p =
          tile.participant === r.localParticipant.identity
            ? r.localParticipant
            : r.remoteParticipants.get(tile.participant)
        const track = p?.getTrackPublication(Track.Source.Camera)?.track as VideoTrack | undefined
        if (track === tile.track) continue
        if (tile.video) {
          tile.track?.detach(tile.video)
          tile.video.remove()
          tile.video = undefined
          tile.track = undefined
        }
        const video = track?.attach() as HTMLVideoElement | undefined
        tile.track = track
        tile.video = video
        if (tile.video) {
          tile.video.style.width = '100%'
          tile.video.style.height = '100%'
          tile.video.autoplay = true
          tile.video.muted = true
          host.append(tile.video)
        }
      } catch {
        this.emit('error', new ImMediaError('SDK_ERROR', 'bindVideoView'))
      }
    }
  }
}
export const createBrowserMediaPort = () => new BrowserMediaPort()
