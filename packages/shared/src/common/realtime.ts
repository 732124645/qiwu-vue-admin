import type { Locale } from './locale.js'

/**
 * Realtime contract (`core/realtime`; see docs/design-notes.md#layering): one Socket.IO connection per signed-in tab (path
 * `/socket.io`) with handshake `auth: RealtimeAuth`. The server checks the session on every connection
 * and joins the socket to the rooms `user:{id}` and `sid:{sid}`. Every push is one `REALTIME_EVENT` emit
 * carrying a `RealtimeMessage` envelope `{type, payload}`; the web routes it on `type`.
 */

/** The single Socket.IO event name every envelope travels on (`socket.send()` / `socket.on('message')`). */
export const REALTIME_EVENT = 'message'

/** Envelope types. */
export const RT = {
  /** an admin ended this session (iam/session kick); the server disconnects the socket right after */
  sessionKicked: 'session:kicked',
  /** a new inbox row for the header bell */
  notifyNew: 'notify:new',
  /** readers' bulletin feed changed (published, withdrawn or deleted): the header bell reloads it */
  notifyBulletin: 'notify:bulletin',
  /** the realtime demo page (`POST /api/demo/realtime/send`) */
  demoMessage: 'demo:message',
  /**
   * the recipient's approval to-dos changed (a task assigned to, handled by or taken from them; see docs/design-notes.md#workflow): sent to those users after the action's transaction commits; the web reloads its to-do count and lists
   */
  wfTask: 'wf:task',
} as const
export type RealtimeType = (typeof RT)[keyof typeof RT]

/** Payload of each envelope type. */
export interface RealtimePayloads {
  'session:kicked': { sid: string }
  /** the inbox row id and rendered title, sent to `user:{id}` after its transaction commits */
  'notify:new': { id: number; title: string }
  /** to every signed-in socket; never the body */
  'notify:bulletin': { action: 'published' | 'withdrawn' | 'deleted'; ids: number[] }
  /**
   * the sender (user id, display name), the text as it was sent (plain text: never render it as HTML)
   * and the server's send time (ISO 8601)
   */
  'demo:message': { from: { id: number; name: string }; text: string; at: string }
  /** the instance whose tasks changed for the recipient; details come from the approval center API */
  'wf:task': { instanceId: number }
}

/** `{type, payload}`; narrowing on `type` types the payload. */
export type RealtimeMessage<T extends RealtimeType = RealtimeType> = {
  [K in T]: { type: K; payload: RealtimePayloads[K] }
}[T]

/** Socket.IO handshake `auth` (the access token; reconnect with the new one after a refresh). */
export interface RealtimeAuth {
  token: string
  lang?: Locale
}

/**
 * `connect_error` message when the handshake finds no live console session (missing, expired or
 * revoked token, e.g. a kicked socket reconnecting). Socket.IO does not retry it by itself.
 */
export const REALTIME_UNAUTHORIZED = 'unauthorized'

/**
 * `connect_error` message when a browser opens the socket from a foreign page: its `Origin` is neither
 * the app's own nor one of the server's `CORS_ORIGIN` (clients without an Origin header are not
 * browsers and only need the token). No refresh helps; the web client leaves it to polling.
 */
export const REALTIME_FORBIDDEN_ORIGIN = 'forbidden_origin'
