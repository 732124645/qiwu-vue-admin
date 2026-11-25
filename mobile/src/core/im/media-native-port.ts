import type {
  ImMediaEvent,
  ImMediaFailure,
  ImMediaPort,
  ImMediaSnapshot,
} from '@qiwu/shared/im-media'

type Result = { success?: (value: ImMediaSnapshot) => void; fail?: (error: ImMediaFailure) => void }
/** 原生 SDK 的固定桥面；端口不接收业务权限或服务器密钥。 */
export interface NativeImSdk {
  getSnapshot(): ImMediaSnapshot
  onLiveKitEvent(callback: (event: ImMediaEvent) => void): void
  connect(
    options: Result & { url: string; token: string; microphone?: boolean; camera?: boolean },
  ): void
  disconnect(options: Result & { connectionId: string }): void
  setMicrophoneEnabled(options: Result & { connectionId: string; enabled: boolean }): void
  setCameraEnabled(options: Result & { connectionId: string; enabled: boolean }): void
  switchCamera(options: Result & { connectionId: string }): void
  setSpeakerOutputPreferred(options: Result & { connectionId: string; enabled: boolean }): void
  requestMicrophonePermission(callback: (granted: boolean) => void): void
}

const controlled = (operation: string): ImMediaFailure => ({ code: 'SDK_UNAVAILABLE', operation })

/** App 创建一次端口和原生订阅，页面只订阅普通 JS 分发。 */
export function createNativeImMediaPort(
  sdk: NativeImSdk,
): ImMediaPort & { requestMicrophonePermission(): Promise<boolean> } {
  const listeners = new Set<(event: ImMediaEvent) => void>()
  try {
    sdk.getSnapshot()
    sdk.onLiveKitEvent((event) => {
      for (const listener of listeners) listener(event)
    })
  } catch {
    throw controlled('initialize')
  }
  const invoke = (operation: string, call: (result: Result) => void) =>
    new Promise<ImMediaSnapshot>((resolve, reject) => {
      try {
        call({ success: resolve, fail: reject })
      } catch {
        reject(controlled(operation))
      }
    })
  return {
    getSnapshot() {
      try {
        return sdk.getSnapshot()
      } catch {
        throw controlled('getSnapshot')
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    connect: (options) => invoke('connect', (result) => sdk.connect({ ...options, ...result })),
    disconnect: (connectionId) =>
      invoke('disconnect', (result) => sdk.disconnect({ connectionId, ...result })),
    setMicrophoneEnabled: (connectionId, enabled) =>
      invoke('setMicrophoneEnabled', (result) =>
        sdk.setMicrophoneEnabled({ connectionId, enabled, ...result }),
      ),
    setCameraEnabled: (connectionId, enabled) =>
      invoke('setCameraEnabled', (result) =>
        sdk.setCameraEnabled({ connectionId, enabled, ...result }),
      ),
    switchCamera: (connectionId) =>
      invoke('switchCamera', (result) => sdk.switchCamera({ connectionId, ...result })),
    setSpeakerOutputPreferred: (connectionId, enabled) =>
      invoke('setSpeakerOutputPreferred', (result) =>
        sdk.setSpeakerOutputPreferred({ connectionId, enabled, ...result }),
      ),
    requestMicrophonePermission: () =>
      new Promise<boolean>((resolve, reject) => {
        try {
          sdk.requestMicrophonePermission(resolve)
        } catch {
          reject(controlled('permission'))
        }
      }),
  }
}
