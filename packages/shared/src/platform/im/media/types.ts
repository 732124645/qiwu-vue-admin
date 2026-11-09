/** 媒体端口只传快照；票据和 SDK 对象不进入消息缓存或事件。 */
export interface ImMediaSnapshot {
  connectionId: string
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting'
  localIdentity: string
  microphone: boolean
  camera: boolean
  speakerPreferred: boolean
  participants: {
    identity: string
    name: string
    local: boolean
    microphone: boolean
    camera: boolean
  }[]
}
export interface ImMediaFailure {
  code: string
  operation: string
}
export interface ImMediaEvent {
  type: 'state' | 'participants' | 'tracks' | 'audio-route' | 'error'
  snapshot: ImMediaSnapshot
  error: ImMediaFailure | null
}
export interface ImMediaPort {
  getSnapshot(): ImMediaSnapshot
  connect(options: {
    url: string
    token: string
    microphone?: boolean
    camera?: boolean
  }): Promise<ImMediaSnapshot>
  disconnect(connectionId: string): Promise<ImMediaSnapshot>
  setMicrophoneEnabled(connectionId: string, enabled: boolean): Promise<ImMediaSnapshot>
  setCameraEnabled(connectionId: string, enabled: boolean): Promise<ImMediaSnapshot>
  switchCamera(connectionId: string): Promise<ImMediaSnapshot>
  setSpeakerOutputPreferred(connectionId: string, enabled: boolean): Promise<ImMediaSnapshot>
  subscribe(listener: (event: ImMediaEvent) => void): () => void
}
/** 受控错误不携原始 SDK 异常，避免媒体凭据进入日志或界面。 */
export class ImMediaError extends Error implements ImMediaFailure {
  constructor(
    readonly code: string,
    readonly operation: string,
  ) {
    super(code)
  }
}
