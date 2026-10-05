// core/realtime (see docs/design-notes.md#layering): the Socket.IO handshake accepts only a live console session's access
// token (every connection, reconnects included), sockets join user:{id} / sid:{sid} / type:{userType},
// RealtimeService.toUser/toUsers/toUserType/broadcast deliver {type, payload} envelopes to exactly those
// rooms, and SessionRevoker ends the sockets of the sessions it revokes (and only those).
import {
  connect as tcpConnect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket as TcpSocket,
} from 'node:net'
import { createServer } from 'node:http'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  REALTIME_EVENT,
  REALTIME_FORBIDDEN_ORIGIN,
  REALTIME_UNAUTHORIZED,
  RT,
  type RealtimeMessage,
} from '@qiwu/shared'
import type { Socket } from 'socket.io-client'
import type { Socket as ServerSocket } from 'socket.io'
import type { DataSource } from 'typeorm'
import { createClient } from 'redis'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { RealtimeGateway } from '../../src/core/realtime/realtime.gateway.js'
import { RedisIoAdapter } from '../../src/core/realtime/redis-io.adapter.js'
import { redisChannel } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, disconnected, inbox, socketOf } from '../setup/socket.js'

const PREFIX = 'rt-e2e-'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let realtime: RealtimeService
let revoker: SessionRevoker
const userIds: number[] = []

const msg = (id: number): RealtimeMessage => ({
  type: RT.notifyNew,
  payload: { id, title: 'New message' },
})

async function user(name: string, extra: Record<string, unknown> = {}) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
    ...extra,
  })
  userIds.push(id)
  return id
}

/** A connected socket of a new session of `username`, and what it receives. */
async function online(username: string) {
  const s = await signIn(app, username)
  const socket = await connect(socketOf(app, { token: s.accessToken, lang: 'en-US' }))
  return { ...s, socket, got: inbox(socket) }
}

/** Lets in-flight emits land (same process, loopback). */
const settle = () => new Promise((r) => setTimeout(r, 150))

const refused = (socket: Socket) => expect(connect(socket)).rejects.toThrow(REALTIME_UNAUTHORIZED)

beforeAll(async () => {
  // Advance only periodic timers; Redis, sockets and the per-socket absolute-end timer stay real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  realtime = app.get(RealtimeService)
  revoker = app.get(SessionRevoker)
  await cleanRedis(redis)
  await user('a')
  await user('b')
  await user('m', { user_type: 'member' })
  await user('c')
})

afterAll(async () => {
  try {
    closeSockets()
    if (ds && userIds.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    if (redis) await cleanRedis(redis)
    await app?.close()
    if (vi.getTimerCount() !== 0) throw new Error('App close left periodic timers running')
  } finally {
    vi.useRealTimers()
  }
})

/** Own adapter and ephemeral HTTP listener, with no extra application or database reset. */
async function roomServer(base = redis) {
  const adapter = await RedisIoAdapter.connect(base)
  const http = createServer()
  adapter.bindApp({ getHttpServer: () => http } as NestExpressApplication)
  try {
    const server = adapter.createIOServer(0)
    await adapter.onApplicationBootstrap()
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    const socket = socketOf({ getHttpServer: () => http } as NestExpressApplication, {}).connect()
    await vi.waitFor(() => expect(socket.connected).toBe(true), { timeout: 5_000 })
    await vi.waitFor(() => expect(server.of('/').sockets.has(socket.id!)).toBe(true))
    return { adapter, server, socket, local: server.of('/').sockets.get(socket.id!)! }
  } catch (error) {
    await adapter.dispose()
    throw error
  }
}

describe('Redis room lifecycle', () => {
  it('leave then immediately join keeps the real Redis subscription and cross-instance delivery', async () => {
    let receiver: Awaited<ReturnType<typeof roomServer>> | undefined
    let sender: RedisIoAdapter | undefined
    const room = 'user:rt-race'
    const channel = `${redisChannel('socketIo')}#/#${room}#`
    try {
      sender = await RedisIoAdapter.connect(redis)
      sender.bindApp({ getHttpServer: () => createServer() } as NestExpressApplication)
      receiver = await roomServer()
      const remote = sender.createIOServer(0)
      await sender.onApplicationBootstrap()
      const got = inbox(receiver.socket)
      await receiver.local.join(room)
      await receiver.adapter.ready([room])
      for (let i = 0; i < 5; i++) {
        await receiver.local.leave(room)
        await receiver.local.join(room)
        await receiver.adapter.ready([room])
        expect(await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])).toEqual([channel, 1])
        remote.to(room).emit(REALTIME_EVENT, msg(100 + i))
        await vi.waitFor(() => expect(got.at(-1)).toEqual(msg(100 + i)))
      }
    } finally {
      receiver?.socket.close()
      await Promise.all([receiver?.adapter.dispose(), sender?.dispose()])
    }
    expect(await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])).toEqual([channel, 0])
  })

  it('resubscribes the failed channel after a real Redis network disconnect and accepts later joins', async () => {
    const peers = new Set<TcpSocket>()
    let hold = false
    let heldReplies = 0
    const proxy = createTcpServer((downstream) => {
      const upstream = tcpConnect(Number(process.env.REDIS_PORT), process.env.REDIS_HOST)
      peers.add(downstream).add(upstream)
      downstream.pipe(upstream)
      upstream.on('data', (data) => {
        if (hold) heldReplies++
        else downstream.write(data)
      })
      const end = () => {
        downstream.destroy()
        upstream.destroy()
        peers.delete(downstream)
        peers.delete(upstream)
      }
      downstream.on('error', end).on('close', end)
      upstream.on('error', end).on('close', end)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const base = createClient({
      socket: {
        host: '127.0.0.1',
        port: (proxy.address() as AddressInfo).port,
        reconnectStrategy: () => 20,
      },
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      database: Number(process.env.REDIS_DB),
    })
    const duplicates = vi.spyOn(base, 'duplicate')
    let receiver: Awaited<ReturnType<typeof roomServer>> | undefined
    let sender: RedisIoAdapter | undefined
    const room = 'user:rt-blip'
    const channel = `${redisChannel('socketIo')}#/#${room}#`
    try {
      sender = await RedisIoAdapter.connect(redis)
      sender.bindApp({ getHttpServer: () => createServer() } as NestExpressApplication)
      receiver = await roomServer(base)
      const remote = sender.createIOServer(0)
      await sender.onApplicationBootstrap()
      const got = inbox(receiver.socket)
      hold = true
      await receiver.local.join(room)
      // Wait until Redis sent the actual subscription reply, but the subscriber has not seen it.
      await vi.waitFor(() => expect(heldReplies).toBeGreaterThan(0))
      let ready = false
      const waiting = receiver.adapter.ready([room]).then(() => {
        ready = true
      })
      void waiting.catch(() => {})
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(ready).toBe(false)
      for (const peer of peers) peer.destroy()
      await expect(waiting).rejects.toThrow('subscription failed')
      hold = false
      await vi.waitFor(
        () => expect((duplicates.mock.results[1].value as Redis).isReady).toBe(true),
        { timeout: 5_000 },
      )
      await receiver.adapter.ready([room])
      expect(await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])).toEqual([channel, 1])
      remote.to(room).emit(REALTIME_EVENT, msg(110))
      await vi.waitFor(() => expect(got).toEqual([msg(110)]))
      await receiver.local.join('user:rt-after-blip')
      await receiver.adapter.ready(['user:rt-after-blip'])
      remote.to('user:rt-after-blip').emit(REALTIME_EVENT, msg(111))
      await vi.waitFor(() => expect(got.at(-1)).toEqual(msg(111)))
      expect(receiver.socket.connected).toBe(true)
    } finally {
      hold = false
      receiver?.socket.close()
      try {
        await Promise.all([receiver?.adapter.dispose(), sender?.dispose()])
      } finally {
        for (const peer of peers) peer.destroy()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
        vi.restoreAllMocks()
      }
    }
  })
})

describe('handshake', () => {
  it('closes real adapter subscriptions and keeps the business Redis connection usable', async () => {
    const adapter = await RedisIoAdapter.connect(redis)
    adapter.bindApp({ getHttpServer: () => createServer() } as NestExpressApplication)
    const channel = `${redisChannel('socketIo')}#/#`
    try {
      adapter.createIOServer(0)
      await adapter.onApplicationBootstrap()
      expect(await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])).toEqual([channel, 2])
    } finally {
      await adapter.dispose()
    }
    expect(await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])).toEqual([channel, 1])
    expect(redis.isReady).toBe(true)
  })

  it('setupApp installs the sharded adapter and waits for real subscriptions', async () => {
    expect(app.get(RedisIoAdapter)).toBeDefined()
    expect(
      await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', `${redisChannel('socketIo')}#/#`]),
    ).toEqual([`${redisChannel('socketIo')}#/#`, 1])
    const a = await online(`${PREFIX}a`)
    await app.get(RedisIoAdapter).ready()
    const channel = `${redisChannel('socketIo')}#/#user:${a.session.userId}#`
    expect(await redis.sendCommand(['PUBSUB', 'SHARDNUMSUB', channel])).toEqual([channel, 1])
  })

  it('refuses a missing, malformed or unknown token with connect_error unauthorized', async () => {
    await refused(socketOf(app, {}))
    await refused(socketOf(app, { token: 42 }))
    await refused(socketOf(app, { token: 'not a token!' }))
    await refused(socketOf(app, { token: 'x'.repeat(43) }))
  })

  it('refuses a third-party (non-console) session', async () => {
    const s = await signIn(app, `${PREFIX}a`, { clientId: 'probe-app' })
    await refused(socketOf(app, { token: s.accessToken }))
  })

  it('refuses a browser Origin other than the app’s own (a foreign page); none (not a browser) or its own is fine', async () => {
    const s = await signIn(app, `${PREFIX}a`)
    const { port } = app.getHttpServer().address() as AddressInfo
    for (const foreign of ['http://evil.example', `https://127.0.0.1:${port}`, 'null'])
      await expect(connect(socketOf(app, { token: s.accessToken }, foreign))).rejects.toThrow(
        REALTIME_FORBIDDEN_ORIGIN,
      )
    const own = await connect(socketOf(app, { token: s.accessToken }, `http://127.0.0.1:${port}`))
    expect(own.connected).toBe(true)
    const none = await connect(socketOf(app, { token: s.accessToken }))
    expect(none.connected).toBe(true)
    // the Origin check comes first: a foreign page learns nothing about the token
    await expect(connect(socketOf(app, {}, 'http://evil.example'))).rejects.toThrow(
      REALTIME_FORBIDDEN_ORIGIN,
    )
  })

  it('accepts a live console session, and refuses it again once the session ended', async () => {
    const a = await online(`${PREFIX}a`)
    expect(a.socket.connected).toBe(true)
    const gone = disconnected(a.socket)
    await revoker.revokeSession(a.session.sid, 'signout')
    expect(await gone).toBe('io server disconnect')
    await refused(a.socket)
  })
})

describe('session end', () => {
  it('rechecks idle local sockets within 60s when the revocation disconnect message is lost', async () => {
    const a = await online(`${PREFIX}a`)
    const keep = await online(`${PREFIX}b`)
    // Both connections have completed the post-join check before their session is revoked.
    await settle()
    const endSessions = vi.spyOn(realtime, 'endSessions').mockImplementation(() => {})
    try {
      const gone = disconnected(a.socket)
      await revoker.revokeSession(a.session.sid, 'kicked')
      expect(endSessions).toHaveBeenCalled()
      expect(await app.get(TokenService).load(a.session.sid)).toBeNull()
      await vi.advanceTimersByTimeAsync(59_999)
      expect(a.socket.connected).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(a.socket.connected).toBe(false), { timeout: 2_000 })
      expect(await gone).toBe('io server disconnect')
      expect(keep.socket.connected).toBe(true)
      expect(a.got).toEqual([])
      await refused(a.socket)
    } finally {
      endSessions.mockRestore()
    }
  })

  it('disconnects a socket whose dynamic room subscription failed before accepting its session', async () => {
    const ready = vi.spyOn(app.get(RedisIoAdapter), 'ready').mockRejectedValue(new Error('NOPERM'))
    const load = vi.spyOn(app.get(TokenService), 'load')
    const socket = {
      data: { userId: 7, sid: 'subscription-failure', userType: 'admin' },
      join: vi.fn(async () => {}),
      disconnect: vi.fn(),
    }
    try {
      await app.get(RealtimeGateway).handleConnection(socket as unknown as ServerSocket)
      expect(socket.disconnect).toHaveBeenCalledWith(true)
      expect(load).not.toHaveBeenCalled()
    } finally {
      ready.mockRestore()
      load.mockRestore()
    }
  })

  it('does not accept a session while its actual user room subscribe reply is held', async () => {
    const duplicates = vi.spyOn(redis, 'duplicate')
    const adapter = await RedisIoAdapter.connect(redis)
    const sub = duplicates.mock.results[1].value as Redis
    duplicates.mockRestore()
    adapter.bindApp({ getHttpServer: () => createServer() } as NestExpressApplication)
    const server = adapter.createIOServer(0)
    await adapter.onApplicationBootstrap()
    const subscribe = sub.sSubscribe.bind(sub)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let replyHeld = false
    const subscribing = vi.spyOn(sub, 'sSubscribe').mockImplementation(async (...args) => {
      const reply = await subscribe(...args)
      if (args[0] === `${redisChannel('socketIo')}#/#user:7#`) {
        replyHeld = true
        await held
      }
      return reply
    })
    const ready = vi
      .spyOn(app.get(RedisIoAdapter), 'ready')
      .mockImplementation((rooms) => adapter.ready(rooms))
    const load = vi.spyOn(app.get(TokenService), 'load')
    const socket = {
      data: { userId: 7, sid: 'held-subscription', userType: 'admin' },
      join: async (rooms: string[]) => server.of('/').adapter.addAll('held-socket', new Set(rooms)),
      disconnect: vi.fn(),
    }
    const connecting = app.get(RealtimeGateway).handleConnection(socket as unknown as ServerSocket)
    try {
      await vi.waitFor(() => expect(replyHeld).toBe(true))
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(load).not.toHaveBeenCalled()
      expect(socket.disconnect).not.toHaveBeenCalled()
      release()
      await connecting
      expect(load).toHaveBeenCalledWith('held-subscription')
    } finally {
      release()
      await connecting
      subscribing.mockRestore()
      ready.mockRestore()
      load.mockRestore()
      await adapter.dispose()
    }
  })

  it('an idle socket is dropped when its session reaches its absolute end', async () => {
    const s = await signIn(app, `${PREFIX}a`)
    await app.get(TokenService).save({ ...s.session, absoluteExpAt: Date.now() + 400 })
    const socket = await connect(socketOf(app, { token: s.accessToken }))
    expect(await disconnected(socket)).toBe('io server disconnect')
    await refused(socket)
  })
})

describe('RealtimeService', () => {
  it('toUser reaches every session of that user and nobody else; toUsers several users', async () => {
    const a1 = await online(`${PREFIX}a`)
    const a2 = await online(`${PREFIX}a`)
    const b = await online(`${PREFIX}b`)
    realtime.toUser(a1.session.userId!, msg(1))
    realtime.toUsers([b.session.userId!], msg(2))
    realtime.toUsers([], msg(3))
    await settle()
    expect(a1.got).toEqual([msg(1)])
    expect(a2.got).toEqual([msg(1)])
    expect(b.got).toEqual([msg(2)])
    realtime.toUsers([a1.session.userId!, b.session.userId!], msg(4))
    await settle()
    expect(a1.got.at(-1)).toEqual(msg(4))
    expect(b.got.at(-1)).toEqual(msg(4))
  })

  it('toUserType reaches that user type only; broadcast reaches everyone', async () => {
    const a = await online(`${PREFIX}a`)
    const m = await online(`${PREFIX}m`)
    realtime.toUserType('member', msg(5))
    await settle()
    expect(m.got).toEqual([msg(5)])
    expect(a.got).toEqual([])
    realtime.broadcast(msg(6))
    await settle()
    expect(m.got.at(-1)).toEqual(msg(6))
    expect(a.got).toEqual([msg(6)])
  })
})

describe('SessionRevoker ends sockets', () => {
  it('revokeSession ends that session only, without a session:kicked unless kicked', async () => {
    const a1 = await online(`${PREFIX}a`)
    const a2 = await online(`${PREFIX}a`)
    const gone = disconnected(a1.socket)
    expect((await revoker.revokeSession(a1.session.sid, 'signout'))?.sid).toBe(a1.session.sid)
    expect(await revoker.revokeSession(a1.session.sid, 'signout')).toBeNull()
    expect(await gone).toBe('io server disconnect')
    expect(a1.got).toEqual([])
    expect(a2.socket.connected).toBe(true)
  })

  it('revokeUser ends every other session of the user; kicked ones hear session:kicked first', async () => {
    const keep = await online(`${PREFIX}c`)
    const k1 = await online(`${PREFIX}c`)
    const k2 = await online(`${PREFIX}c`)
    const gone = [disconnected(k1.socket), disconnected(k2.socket)]
    const ended = await revoker.revokeUser(keep.session.userId!, 'kicked', {
      exceptSid: keep.session.sid,
    })
    expect(ended.map((s) => s.sid).sort()).toEqual([k1.session.sid, k2.session.sid].sort())
    expect(await Promise.all(gone)).toEqual(['io server disconnect', 'io server disconnect'])
    expect(k1.got).toEqual([{ type: RT.sessionKicked, payload: { sid: k1.session.sid } }])
    expect(k2.got).toEqual([{ type: RT.sessionKicked, payload: { sid: k2.session.sid } }])
    await settle()
    expect(keep.socket.connected).toBe(true)
    expect(keep.got).toEqual([])
  })
})
