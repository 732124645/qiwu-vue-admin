import { getCurrentScope, onScopeDispose, shallowRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { io, type Socket } from 'socket.io-client'
import {
  REALTIME_EVENT,
  REALTIME_UNAUTHORIZED,
  RT,
  type RealtimeAuth,
  type RealtimeMessage,
  type RealtimePayloads,
  type RealtimeType,
} from '@qiwu/shared'
import { currentLocale, i18n } from '@/core/i18n'
import { accessToken, refreshAccessToken } from '@/core/request/http'
import router from '@/core/router'
import { useAuthStore } from '@/core/stores/auth'

type Handler = (payload: never) => void
const handlers = new Map<RealtimeType, Set<Handler>>()

/**
 * Subscribes to one envelope type (see docs/design-notes.md#layering): `fn` gets its payload. Returns the unsubscribe, which
 * also runs by itself when the calling component (effect scope) ends.
 */
export function onRealtime<T extends RealtimeType>(
  type: T,
  fn: (payload: RealtimePayloads[T]) => void,
): () => void {
  let set = handlers.get(type)
  if (!set) handlers.set(type, (set = new Set()))
  set.add(fn)
  const off = () => void set.delete(fn)
  if (getCurrentScope()) onScopeDispose(off)
  return off
}

function dispatch(msg: RealtimeMessage) {
  for (const fn of handlers.get(msg.type) ?? []) (fn as (p: unknown) => void)(msg.payload)
}

let socket: Socket | null = null
/** a handshake refusal was answered with a refresh; cleared once a socket connects */
let refreshed = false

/** Whether the socket is connected: pushes arrive; polling fallbacks (the header bell) rest meanwhile. */
export const realtimeUp = shallowRef(false)

/**
 * The connection as shown to people: `up`; `reconnecting` while a socket is opening or Socket.IO retries
 * by itself (a lost connection or a failed attempt); `down` when no socket will connect (signed out, or
 * the server refused or closed it: a token refresh may still open a new one).
 */
export type RealtimeStatus = 'up' | 'reconnecting' | 'down'
export const realtimeStatus = shallowRef<RealtimeStatus>('down')
function setStatus(status: RealtimeStatus) {
  realtimeStatus.value = status
  realtimeUp.value = status === 'up'
}

/** A new socket on the current access token (the previous one closes). */
function connect() {
  socket?.close()
  setStatus('reconnecting')
  const s = io({
    transports: ['websocket'],
    // read at every (re)connect attempt: the latest token and language
    auth: (cb) => cb({ token: accessToken.value, lang: currentLocale() } satisfies RealtimeAuth),
  })
  s.on(REALTIME_EVENT, dispatch)
  s.on('connect', () => {
    refreshed = false
    setStatus('up')
  })
  // `active`: Socket.IO will retry on its own
  s.on('disconnect', () => {
    if (s === socket) setStatus(s.active ? 'reconnecting' : 'down')
  })
  // refused (Socket.IO does not retry that by itself): the access token expired while the socket was
  // away. One refresh; its new token reconnects through the watch below. A failed refresh leaves the
  // socket down, the rest to the request layer (the session-expired dialog at the next call).
  s.on('connect_error', (err) => {
    if (s !== socket) return
    const refresh = err.message === REALTIME_UNAUTHORIZED && !refreshed
    setStatus(s.active || refresh ? 'reconnecting' : 'down')
    if (!refresh) return
    refreshed = true
    refreshAccessToken().catch(() => s === socket && setStatus('down'))
  })
  socket = s
}

function disconnect() {
  socket?.close()
  socket = null
  refreshed = false
  setStatus('down')
}

/**
 * An admin ended this session (iam/session kick): say so, drop the session, go to the sign-in page. The
 * refresh hint stays: it is shared with other tabs, which may hold another, live session.
 */
function kicked() {
  ElMessage.warning(i18n.global.t('common.session.kicked'))
  useAuthStore().clear()
  const { fullPath, meta } = router.currentRoute.value
  void router.push(meta.public ? '/login' : { path: '/login', query: { redirect: fullPath } })
}

/**
 * Once at start-up: one socket while signed in (see docs/design-notes.md#layering). It connects when an access token appears
 * (sign-in, page load), reconnects with each new one (a refresh may even belong to another session:
 * another tab signed in), and closes on sign-out. `session:kicked` ends the session here.
 */
export function startRealtime(): void {
  onRealtime(RT.sessionKicked, kicked)
  // sync: a sign-in's clear-then-set must close the old session's socket before the new one opens
  watch(accessToken, (token) => (token ? connect() : disconnect()), {
    immediate: true,
    flush: 'sync',
  })
}
