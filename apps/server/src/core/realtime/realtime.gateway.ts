import type { IncomingMessage } from 'node:http'
import { Logger, type OnModuleDestroy } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from '@nestjs/websockets'
import {
  type Locale,
  LOCALES,
  REALTIME_EVENT,
  REALTIME_FORBIDDEN_ORIGIN,
  REALTIME_UNAUTHORIZED,
  type RealtimeAuth,
  type RealtimeMessage,
  RT,
} from '@qiwu/shared'
import type { Express, Request } from 'express'
import type { Server, Socket } from 'socket.io'
import { SessionCurrent } from '../auth/session-current.js'
import {
  isFirstParty,
  TENANT_UNAVAILABLE,
  TenantUnavailable,
  TokenService,
} from '../auth/token.service.js'
import { AppConfigService } from '../config/config.module.js'
import { tenantEntry, withTenant } from '../context/tenant.js'
import { originAllowed } from '../http/origin.js'
import { RealtimeService, rooms } from './realtime.service.js'
import { RedisIoAdapter } from './redis-io.adapter.js'

/** What the handshake proved, kept on `socket.data`. */
export interface SocketData {
  userId: number
  sid: string
  userType: string
  /** handshake `lang`, else the account's; for pushes the server translates */
  lang: Locale | null
  /** the session's absolute end (epoch ms): the socket is dropped then */
  endsAt: number
  /** the tenant the socket's work runs in: its session's */
  tenantId: number
}

/** Same shape AuthGuard accepts in the Authorization header. */
const TOKEN = /^[\w-]{1,128}$/

/**
 * Socket.IO on the HTTP server (path `/socket.io`, websocket only: no polling sessions to pin to one
 * instance). Every connection, reconnects included, passes the handshake middleware: a browser's
 * `Origin` must be the app's own or one of `CORS_ORIGIN` (as the refresh check; else `connect_error`
 * `forbidden_origin`: a foreign page cannot open a socket, CSWSH), and the access token in
 * `auth.token` must belong to a live first-party session (TokenService, reloaded by SessionCurrent,
 * as AuthGuard), else `connect_error` `unauthorized`. The socket then joins `user:{id}`, `sid:{sid}`,
 * `tenant:{tid}` and `type:{tid}:{userType}` (its session's tenant) and is dropped at the session's
 * `absoluteExpAt` at the latest (earlier ends go through SessionRevoker). Once a minute every local
 * socket's session is checked and reloaded the same way, so a session whose tenant or permissions
 * changed ends without any request. Clients only listen; there are no inbound handlers.
 */
@WebSocketGateway({ serveClient: false, transports: ['websocket'], maxHttpBufferSize: 16_384 })
export class RealtimeGateway
  implements OnGatewayInit<Server>, OnGatewayConnection<Socket>, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimeGateway.name)
  private recheckTimer?: ReturnType<typeof setInterval>
  private rechecking = false

  constructor(
    private readonly tokens: TokenService,
    private readonly sessions: SessionCurrent,
    private readonly realtime: RealtimeService,
    private readonly cfg: AppConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly redisAdapter: RedisIoAdapter,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      if (!this.originAllowed(socket.request)) return next(new Error(REALTIME_FORBIDDEN_ORIGIN))
      // the upgrade request never passed the HTTP context setup: an entry of its own, no tenant yet
      tenantEntry(() => this.authenticate(socket)).then(
        (ok) => next(ok ? undefined : new Error(REALTIME_UNAUTHORIZED)),
        (err: unknown) => {
          // a session that ended with its tenant is no failure of the handshake
          if (!(err instanceof TenantUnavailable)) this.logger.error(err, 'socket handshake failed')
          next(new Error(REALTIME_UNAUTHORIZED))
        },
      )
    })
    this.realtime.attach(server)
    // Pub/sub disconnects can be lost: recheck only this instance's sockets, once per minute.
    this.recheckTimer = setInterval(() => void this.recheckSessions(server), 60_000)
    this.recheckTimer.unref()
  }

  onModuleDestroy(): void {
    clearInterval(this.recheckTimer)
  }

  private async recheckSessions(server: Server): Promise<void> {
    if (this.rechecking) return
    this.rechecking = true
    try {
      for (const socket of server.of('/').sockets.values()) {
        try {
          const data = socket.data as SocketData
          const alive = await this.inSocket(data, () => this.alive(data.sid))
          if (alive === true) continue
          // the revocation's own message goes through Redis and this socket ends first: tell it here
          if (alive === TENANT_UNAVAILABLE)
            socket.emit(REALTIME_EVENT, {
              type: RT.sessionKicked,
              payload: { sid: data.sid, reason: TENANT_UNAVAILABLE },
            } satisfies RealtimeMessage)
          socket.disconnect(true)
        } catch (err: unknown) {
          this.logger.error(err, 'socket session recheck failed')
        }
      }
    } finally {
      this.rechecking = false
    }
  }

  /**
   * Whether the session is live once reloaded like a request's; TENANT_UNAVAILABLE: it just ended with
   * its tenant.
   */
  private async alive(sid: string): Promise<boolean | typeof TENANT_UNAVAILABLE> {
    const session = await this.tokens.live(sid)
    if (session === null || session === TENANT_UNAVAILABLE) return session ?? false
    try {
      return (await this.sessions.current(session)) !== null
    } catch (err) {
      if (err instanceof TenantUnavailable) return TENANT_UNAVAILABLE
      throw err
    }
  }

  handleConnection(socket: Socket): Promise<void> {
    const data = socket.data as SocketData
    return this.inSocket(data, () => this.connected(socket, data))
  }

  /**
   * Work for one socket runs as an entry of its own (cleared tenant keys, whatever context the
   * connection or the timer inherited) in the socket user's tenant.
   */
  private inSocket<T>(data: SocketData, fn: () => Promise<T>): Promise<T> {
    // qw:cross-tenant the tenant the handshake proved for this socket
    return tenantEntry(() => withTenant(data.tenantId, fn))
  }

  private async connected(socket: Socket, data: SocketData): Promise<void> {
    const joinedRooms = [
      rooms.user(data.userId),
      rooms.session(data.sid),
      rooms.tenant(data.tenantId),
      rooms.userType(data.tenantId, data.userType),
    ]
    await socket.join(joinedRooms)
    try {
      await this.redisAdapter.ready(joinedRooms)
    } catch {
      this.logger.error('Socket.IO Redis room subscription failed')
      return void socket.disconnect(true)
    }
    // a kick between the handshake and the joins found no socket in `sid:{sid}` to end: look again
    if (!(await this.tokens.load(data.sid))) return void socket.disconnect(true)
    if (!socket.connected) return
    // no request re-checks an idle socket: end it with the session (≤ 7 days, within setTimeout's range)
    const timer = setTimeout(() => socket.disconnect(true), data.endsAt - Date.now())
    socket.once('disconnect', () => clearTimeout(timer))
  }

  /**
   * No `Origin` (not a browser: the token alone decides) or an allowed one. The upgrade request never
   * went through Express: it is read with Express's own request logic (`trust proxy` decides whether
   * X-Forwarded-Proto / -Host count), exactly as the refresh check reads its request.
   */
  private originAllowed(raw: IncomingMessage): boolean {
    const origin = raw.headers.origin
    if (origin === undefined) return true
    const express = this.adapterHost.httpAdapter.getInstance<Express>()
    const req = Object.create(express.request, {
      headers: { value: raw.headers },
      socket: { value: raw.socket },
    }) as Request
    return originAllowed(origin, req, this.cfg.get('CORS_ORIGIN'))
  }

  private async authenticate(socket: Socket): Promise<boolean> {
    const { token, lang } = (socket.handshake.auth ?? {}) as Partial<RealtimeAuth>
    if (typeof token !== 'string' || !TOKEN.test(token)) return false
    const found = await this.tokens.authenticate(token)
    if (!found || found.userId === null || !isFirstParty(found.clientId)) return false
    // reloaded first: an older session names its tenant only then
    const session = await this.sessions.current(found)
    if (!session || session.tenantId === undefined) return false
    socket.data = {
      userId: found.userId,
      sid: session.sid,
      userType: session.userType,
      lang: LOCALES.includes(lang as Locale) ? (lang as Locale) : session.locale,
      endsAt: session.absoluteExpAt,
      tenantId: session.tenantId,
    } satisfies SocketData
    return true
  }
}
