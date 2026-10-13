import { Injectable } from '@nestjs/common'
import { REALTIME_EVENT, type RealtimeMessage } from '@qiwu/shared'
import type { Server } from 'socket.io'
import { tenantId } from '../context/tenant.js'

/**
 * Rooms every authenticated socket joins (RealtimeGateway). User ids and sids are global; a tenant's
 * sockets and its user types are rooms of that tenant (no room spans tenants).
 */
export const rooms = {
  user: (userId: number) => `user:${userId}`,
  session: (sid: string) => `sid:${sid}`,
  tenant: (tid: number) => `tenant:${tid}`,
  userType: (tid: number, type: string) => `type:${tid}:${type}`,
}

/**
 * Server → web pushes (see docs/design-notes.md#layering): one `REALTIME_EVENT` emit of a `{type, payload}` envelope to the
 * sockets of a user, users, a user type of a tenant or everyone in a tenant; nothing reaches every
 * tenant. No deps, so SessionRevoker can use it without an injection cycle; the gateway hands it the
 * Socket.IO server once it is up. Before that (CLI contexts, no gateway) every call is a no-op.
 */
@Injectable()
export class RealtimeService {
  private server?: Server

  attach(server: Server): void {
    this.server = server
  }

  toUser(userId: number, msg: RealtimeMessage): void {
    this.server?.to(rooms.user(userId)).emit(REALTIME_EVENT, msg)
  }

  toUsers(userIds: readonly number[], msg: RealtimeMessage): void {
    if (userIds.length) this.server?.to(userIds.map(rooms.user)).emit(REALTIME_EVENT, msg)
  }

  toUserType(tid: number, userType: string, msg: RealtimeMessage): void {
    this.server?.to(rooms.userType(tid, userType)).emit(REALTIME_EVENT, msg)
  }

  /** Every signed-in socket of tenant `tid`. */
  toTenant(tid: number, msg: RealtimeMessage): void {
    this.server?.to(rooms.tenant(tid)).emit(REALTIME_EVENT, msg)
  }

  /**
   * How many distinct users have a socket across the deployment: among `userIds`, or anyone in the
   * context's tenant when omitted (what `toUsers` / `toTenant(tenantId())` reach right now).
   */
  async onlineUsers(userIds?: readonly number[]): Promise<number> {
    if (!this.server || userIds?.length === 0) return 0
    const sockets = await this.server
      .in(userIds ? userIds.map(rooms.user) : rooms.tenant(tenantId()))
      .fetchSockets()
    return new Set(sockets.map((s) => (s.data as { userId: number }).userId)).size
  }

  /**
   * Ends the sockets of sessions that were just revoked (SessionRevoker): each gets `last(sid)` first
   * when given, then is disconnected. A server-side disconnect is not retried by the client; a manual
   * reconnect fails the handshake, as the session is gone.
   */
  endSessions(sids: Iterable<string>, last?: (sid: string) => RealtimeMessage): void {
    const server = this.server
    if (!server) return
    for (const sid of sids) {
      const room = server.to(rooms.session(sid))
      if (last) room.emit(REALTIME_EVENT, last(sid))
      room.disconnectSockets(true)
    }
  }
}
