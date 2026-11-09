import type { AgentEvent } from '../platform/agent/agent.schema.js'
import type { ImEntryHint, ImRoomHint } from '../platform/im/im.schema.js'
import type { ImCallHint } from '../platform/im/im-media.schema.js'
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
  /** an inbound Official Account message for the selected account; the web reloads its conversation */
  wxoaMessage: 'wxoa:message',
  /** an agent thread changed (an item, streamed text or the turn's status); to the thread owner only */
  agentEvent: 'agent:event',
  /** 即时通讯：会话里多了一条消息或事件（提交后发给当前全部成员，永不带正文） */
  imEntry: 'im:entry',
  /** 即时通讯：本人读位置变化（带 readSeq，只发本人）或成员/角色/群名/解散变化（不带，发受影响用户） */
  imRoom: 'im:room',
  /** 通话状态变化，只发编号与修订号，不携票据或参与者资料。 */
  imCall: 'im:call',
} as const
export type RealtimeType = (typeof RT)[keyof typeof RT]

/**
 * Why a session ended other than an administrator's kick (`session:kicked` `reason`; absent = a plain
 * kick): `tenant_unavailable` — its tenant was disabled, expired or multi-tenancy was turned off for it;
 * `app_replaced` — 同一账号在另一台设备的 App 登录，单 App 会话开关把旧的 App 会话结束了。
 */
export const SESSION_END_REASONS = ['tenant_unavailable', 'app_replaced'] as const
export type SessionEndReason = (typeof SESSION_END_REASONS)[number]

/** Payload of each envelope type. */
export interface RealtimePayloads {
  /** `reason` only when the session did not end by a plain kick */
  'session:kicked': { sid: string; reason?: SessionEndReason }
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
  /** ids only: never the content or the fan's openid */
  'wxoa:message': { accountId: number; messageId: number }
  'agent:event': AgentEvent
  /** 只有编号与类型（kind 含 `event`），客户端按需增量拉取 */
  'im:entry': ImEntryHint
  /** `readSeq` 存在 = 本人在别的设备读了；不存在 = 会话信息变化，客户端取该会话详情 */
  'im:room': ImRoomHint
  'im:call': ImCallHint
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
