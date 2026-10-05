// Realtime on the app, the server's Socket.IO gateway (websocket only, the
// session's access token in the handshake; see docs/design-notes.md#layering). Official socket.io-client over uni.connectSocket: one code path on
// H5, mini program and App. Pushes are hints that reload the counts over REST, as on the web; while no socket
// is connected the tab pages keep the 60 s poll (pollCounts).
import { ref } from 'vue'
import { io, WebSocket as WsTransport, type Socket } from 'socket.io-client'
import {
  REALTIME_EVENT,
  REALTIME_UNAUTHORIZED,
  RT,
  type RealtimeAuth,
  type RealtimeMessage,
} from '@qiwu/shared'
import { locale, t } from './i18n'
import {
  LOGIN_PAGE,
  ORIGIN,
  currentAccessToken,
  hasSession,
  refreshAccessToken,
  setSession,
} from './request'
import { useCountsStore } from './stores/counts'

/** engine.io's websocket transport over uni.connectSocket: it needs only a WebSocket-like object. */
export class UniSocketTransport extends WsTransport {
  override createSocket(url: string) {
    const ws: Record<string, ((e?: unknown) => void) | undefined> = {}
    // a callback makes uni return the SocketTask (not a Promise); an early failure (mini program: a domain
    // not allowed) reaches engine.io as an error, which retries with backoff
    const task = uni.connectSocket({ url, fail: (e) => ws.onerror?.(e) })
    task.onOpen(() => ws.onopen?.())
    task.onMessage(({ data }) => ws.onmessage?.({ data }))
    task.onClose((e) => ws.onclose?.(e))
    task.onError((e) => ws.onerror?.(e))
    ws.send = (data) => task.send({ data: data as string | ArrayBuffer })
    ws.close = () => task.close({})
    return ws
  }
}

let socket: Socket | null = null
/** a handshake refusal was answered with a refresh; cleared once a socket connects */
let refreshed = false

/** Whether the socket is connected: pushes arrive, the counts' poll rests. */
export const realtimeUp = ref(false)

/** The tab pages' fallback poll: the counts reload only while no socket brings the changes. */
export function pollCounts() {
  if (!realtimeUp.value) useCountsStore().load()
}

/** An admin ended this session (iam/session kick): sign-in page, then say why. */
function kicked() {
  stopRealtime()
  setSession(null)
  uni.reLaunch({
    url: LOGIN_PAGE,
    complete: () => uni.showToast({ title: t('common.error.kicked'), icon: 'none' }),
  })
}

function onMessage(msg: RealtimeMessage) {
  if (msg.type === RT.wfTask || msg.type === RT.notifyNew) useCountsStore().load()
  else if (msg.type === RT.sessionKicked) kicked()
}

/**
 * One socket while signed in (tab pages on show; the app back in the foreground). No-op without a session or
 * while a socket exists. The handshake reads the current access token and language at every (re)connect.
 */
export function startRealtime(): void {
  if (socket || !hasSession()) return
  const s = io(ORIGIN || undefined, {
    transports: [UniSocketTransport],
    auth: (cb) => cb({ token: currentAccessToken(), lang: locale() } satisfies RealtimeAuth),
  })
  s.on(REALTIME_EVENT, onMessage)
  s.on('connect', () => {
    refreshed = false
    realtimeUp.value = true
    // catch up on what changed while away
    useCountsStore().load()
  })
  s.on('disconnect', () => {
    if (s === socket) realtimeUp.value = false
  })
  // refused (Socket.IO does not retry that by itself): no or an expired access token (the first connect after
  // launch has none: it lives in memory). One refresh, then connect again; refused again, or a foreign origin:
  // the socket stays down and the poll covers.
  s.on('connect_error', (err) => {
    if (s !== socket || err.message !== REALTIME_UNAUTHORIZED || refreshed) return
    refreshed = true
    refreshAccessToken().then(
      () => s === socket && s.connect(),
      () => {},
    )
  })
  socket = s
}

/** Closes and forgets the socket: sign-in, sign-out, a kick, the app going to the background. */
export function stopRealtime(): void {
  const s = socket
  socket = null
  refreshed = false
  realtimeUp.value = false
  s?.close()
}
