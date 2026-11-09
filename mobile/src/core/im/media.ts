import type { ImMediaEvent, ImMediaPort, ImMediaSnapshot } from '@qiwu/shared/im-media'
import { shallowRef } from 'vue'
// #ifdef H5
import { createBrowserMediaPort } from '@qiwu/shared/im-media'
// #endif

let actual: ImMediaPort | null = null
/** 申请通话资格期间也占用麦克风意图，录音不能插入拿票据与设备连接之间。 */
export const imMediaReserved = shallowRef(false)
let issue: unknown
const listeners = new Set<(event: ImMediaEvent) => void>()
const empty = (): ImMediaSnapshot => ({
  connectionId: '',
  state: 'idle',
  localIdentity: '',
  microphone: false,
  camera: false,
  speakerPreferred: false,
  participants: [],
})

/** 按平台只创建一份真实媒体端口；没有插件的旧安装包返回受控失败。 */
export function ensureImMedia(): ImMediaPort {
  if (actual) return actual
  if (issue) throw issue
  try {
    // #ifdef H5
    if (process.env.UNI_PLATFORM === 'h5') actual = createBrowserMediaPort()
    // #endif
    if (!actual) throw { code: 'SDK_UNAVAILABLE', operation: 'initialize' }
    bindPort(actual)
    return actual
  } catch {
    issue = { code: 'SDK_UNAVAILABLE', operation: 'initialize' }
    throw issue
  }
}

function bindPort(port: ImMediaPort) {
  port.subscribe((event) => {
    for (const listener of listeners) listener(event)
  })
}
/** 原生模块只由 App 启动入口安装，nvue 和普通业务模块都不重复导入/登记它。 */
export function installImMedia(port: ImMediaPort): void {
  if (actual) return
  actual = port
  issue = null
  bindPort(port)
}
export function unavailableImMedia(): void {
  if (!actual) issue = { code: 'SDK_UNAVAILABLE', operation: 'initialize' }
}

/** App 启动只登记原生监听，不申请权限、不建立 Room。 */
export function initializeImMedia(): void {
  if (process.env.UNI_PLATFORM === 'mp-weixin') return
  try {
    ensureImMedia()
  } catch {
    /* 用户操作通话或录音时再显示不可用，启动不弹媒体错误。 */
  }
}

/** 控制器可在登录前订阅，真正端口就绪后复用同一个分发集合。 */
export const imMedia: ImMediaPort = {
  getSnapshot: () => actual?.getSnapshot() ?? empty(),
  subscribe(listener) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  connect: (options) => ensureImMedia().connect(options),
  disconnect: (id) => ensureImMedia().disconnect(id),
  setMicrophoneEnabled: (id, enabled) => ensureImMedia().setMicrophoneEnabled(id, enabled),
  setCameraEnabled: (id, enabled) => ensureImMedia().setCameraEnabled(id, enabled),
  switchCamera: (id) => ensureImMedia().switchCamera(id),
  setSpeakerOutputPreferred: (id, enabled) =>
    ensureImMedia().setSpeakerOutputPreferred(id, enabled),
}

/** 录音授权不创建 RTC Room；调用者授权后仍要复核自己的代次。 */
export function requestImMicrophonePermission(): Promise<boolean> {
  const port = ensureImMedia() as ImMediaPort & {
    requestMicrophonePermission?: () => Promise<boolean>
  }
  return (
    port.requestMicrophonePermission?.() ??
    Promise.reject({ code: 'SDK_UNAVAILABLE', operation: 'permission' })
  )
}

/** 仅 H5 页面使用的 DOM 能力，App 的画面始终由原生组件绑定。 */
export function imBrowserMedia() {
  return ensureImMedia() as ImMediaPort & {
    attachVideo(target: HTMLElement, connectionId: string, participantId: string): () => void
    startAudio(): Promise<void>
    readonly audioBlocked: boolean
  }
}
