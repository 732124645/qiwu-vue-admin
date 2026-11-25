import { disconnect, getSnapshot, onLiveKitEvent } from '@/uni_modules/qw-livekit'

const listeners = new Set()
let started = false

function publish(event) {
  for (const listener of listeners) listener(event)
}

/** 常驻原生事件只由 App 注册，页面退出不移除 App 的桥回调。 */
export function startEvents() {
  if (started) return
  started = true
  onLiveKitEvent(publish)
}

/** 页面仅持有普通 JS 订阅，隐藏或卸载时调用返回的取消函数。 */
export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 显式重试或退入后台时可再次请求清理，原生负责拦截仍在进行的释放。 */
export function stopMedia(retry = false) {
  const snapshot = getSnapshot()
  if (
    !snapshot.connectionId ||
    snapshot.state === 'idle' ||
    (snapshot.state === 'disconnecting' && !retry)
  )
    return
  disconnect({
    connectionId: snapshot.connectionId,
    fail: (error) => publish({ type: 'error', snapshot: getSnapshot(), error }),
  })
}
