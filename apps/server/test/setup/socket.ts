// Socket.IO clients for e2e specs (core/realtime): websocket only like the web, no auto-reconnect, so
// every (re)connect is a step the spec takes.
import type { AddressInfo } from 'node:net'
import type { INestApplication } from '@nestjs/common'
import { REALTIME_EVENT, type RealtimeMessage } from '@qiwu/shared'
import { io, type Socket } from 'socket.io-client'

const opened: Socket[] = []

/** A socket to the app with handshake `auth` (and an `Origin` header, like a browser), not connected yet. */
export function socketOf(
  app: INestApplication,
  auth: Record<string, unknown>,
  origin?: string,
): Socket {
  const { port } = app.getHttpServer().address() as AddressInfo
  const socket = io(`http://127.0.0.1:${port}`, {
    auth,
    extraHeaders: origin === undefined ? undefined : { Origin: origin },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    forceNew: true,
  })
  opened.push(socket)
  return socket
}

/** Connects: resolves once connected, rejects with the `connect_error`. */
export function connect(socket: Socket): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ok = () => {
      socket.off('connect_error', fail)
      resolve(socket)
    }
    const fail = (err: Error) => {
      socket.off('connect', ok)
      reject(err)
    }
    socket.once('connect', ok).once('connect_error', fail).connect()
  })
}

/** Resolves with the reason of the socket's next disconnect. */
export const disconnected = (socket: Socket) =>
  new Promise<string>((resolve) => socket.once('disconnect', (reason) => resolve(reason)))

/** The envelopes the socket receives from now on. */
export function inbox(socket: Socket): RealtimeMessage[] {
  const got: RealtimeMessage[] = []
  socket.on(REALTIME_EVENT, (msg: RealtimeMessage) => got.push(msg))
  return got
}

/** Closes every socket a spec opened (afterAll). */
export function closeSockets() {
  for (const s of opened.splice(0)) s.close()
}
