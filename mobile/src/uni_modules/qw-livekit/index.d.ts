export type QwLiveKitState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnecting'
export type QwLiveKitFailure = { code: string; operation: string }
export type QwLiveKitParticipant = {
  identity: string
  name: string
  local: boolean
  microphone: boolean
  camera: boolean
}
export type QwLiveKitSnapshot = {
  connectionId: string
  state: QwLiveKitState
  localIdentity: string
  microphone: boolean
  camera: boolean
  speakerPreferred: boolean
  participants: QwLiveKitParticipant[]
}
export type QwLiveKitEvent = {
  type: 'state' | 'participants' | 'tracks' | 'audio-route' | 'error'
  snapshot: QwLiveKitSnapshot
  error: QwLiveKitFailure | null
}
export type QwLiveKitConnectOptions = {
  url: string
  token: string
  microphone?: boolean
  camera?: boolean
  success?: (snapshot: QwLiveKitSnapshot) => void
  fail?: (error: QwLiveKitFailure) => void
}
export type QwLiveKitActionOptions = {
  connectionId: string
  success?: (snapshot: QwLiveKitSnapshot) => void
  fail?: (error: QwLiveKitFailure) => void
}
export type QwLiveKitToggleOptions = QwLiveKitActionOptions & { enabled: boolean }
export type QwLiveKitConnect = (options: QwLiveKitConnectOptions) => void
export type QwLiveKitAction = (options: QwLiveKitActionOptions) => void
export type QwLiveKitToggle = (options: QwLiveKitToggleOptions) => void
export type QwLiveKitEventCallback = (event: QwLiveKitEvent) => void
export type QwLiveKitMicrophonePermission = (callback: (granted: boolean) => void) => void

/** 连接并按用户选择发布本地媒体；成功快照携带不可复用的连接编号。 */
export declare const connect: QwLiveKitConnect
/** 停止采集并释放当前连接；旧连接编号不得结束后来创建的连接。 */
export declare const disconnect: QwLiveKitAction
export declare const setMicrophoneEnabled: QwLiveKitToggle
export declare const setCameraEnabled: QwLiveKitToggle
export declare const switchCamera: QwLiveKitAction
export declare const setSpeakerOutputPreferred: QwLiveKitToggle
/** App 级只注册一次，页面使用宿主的普通 JS 订阅分发。 */
export declare function onLiveKitEvent(callback: QwLiveKitEventCallback): void
export declare function offLiveKitEvent(): void
export declare function getSnapshot(): QwLiveKitSnapshot
/** 只申请系统麦克风授权，不建立 Room、不开始采集；宿主在授权返回后仍须复查当前录音任务。 */
export declare function requestMicrophonePermission(callback: (granted: boolean) => void): void
