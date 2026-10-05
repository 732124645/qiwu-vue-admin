import type { IncomingMessage } from 'node:http'
import { Logger, type OnModuleDestroy } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { type OnGatewayConnection, type OnGatewayInit, WebSocketGateway } from '@nestjs/websockets'
import {
  type Locale,
  LOCALES,
  REALTIME_FORBIDDEN_ORIGIN,
  REALTIME_UNAUTHORIZED,
  type RealtimeAuth,
} from '@qiwu/shared'
import type { Express, Request } from 'express'
import type { Server, Socket } from 'socket.io'
import { isFirstParty, TokenService } from '../auth/token.service.js'
import { AppConfigService } from '../config/config.module.js'
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
}

/** Same shape AuthGuard accepts in the Authorization header. */
const TOKEN = /^[\w-]{1,128}$/

/**
 * Socket.IO on the HTTP server (path `/socket.io`, websocket only: no polling sessions to pin to one
 * instance). Every connection, reconnects included, passes the handshake middleware: a browser's
 * `Origin` must be the app's own or one of `CORS_ORIGIN` (as the refresh check; else `connect_error`
 * `forbidden_origin`: a foreign page cannot open a socket, CSWSH), and the access token
 * in `auth.token` must belong to a live first-party session (TokenService, as AuthGuard), else
 * `connect_error` `unauthorized`. The socket then joins `user:{id}`, `sid:{sid}` and `type:{userType}`
 * and is dropped at the session's `absoluteExpAt` at the latest (earlier ends go through SessionRevoker).
 * Clients only listen; there are no inbound handlers.
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
    private readonly realtime: RealtimeService,
    private readonly cfg: AppConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly redisAdapter: RedisIoAdapter,
  ) {}

  afterInit(server: Server): void {
    server.use((socket, next) => {
      if (!this.originAllowed(socket.request)) return next(new Error(REALTIME_FORBIDDEN_ORIGIN))
      this.authenticate(socket).then(
        (ok) => next(ok ? undefined : new Error(REALTIME_UNAUTHORIZED)),
        (err: unknown) => {
          this.logger.error(err, 'socket handshake failed')
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
          if (!(await this.tokens.load((socket.data as SocketData).sid))) socket.disconnect(true)
        } catch (err: unknown) {
          this.logger.error(err, 'socket session recheck failed')
        }
      }
    } finally {
      this.rechecking = false
    }
  }

  async handleConnection(socket: Socket): Promise<void> {
    const data = socket.data as SocketData
    const joinedRooms = [
      rooms.user(data.userId),
      rooms.session(data.sid),
      rooms.userType(data.userType),
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
    const session = await this.tokens.authenticate(token)
    if (!session || session.userId === null || !isFirstParty(session.clientId)) return false
    socket.data = {
      userId: session.userId,
      sid: session.sid,
      userType: session.userType,
      lang: LOCALES.includes(lang as Locale) ? (lang as Locale) : session.locale,
      endsAt: session.absoluteExpAt,
    } satisfies SocketData
    return true
  }
}
