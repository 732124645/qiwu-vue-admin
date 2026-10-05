import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createShardedAdapter } from '@socket.io/redis-adapter'
import type { Server, ServerOptions } from 'socket.io'
import { redisChannel } from '../redis/cache-namespaces.js'
import type { Redis } from '../redis/redis.module.js'

const BUDGET_MS = 5_000

interface ChannelState {
  pending?: Promise<void>
  work: () => Promise<unknown>
  remove: boolean
  failure?: Error
}

const bounded = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Socket.IO Redis operation timed out')), BUDGET_MS)
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}

/** Owns only the two adapter connections; the business REDIS client belongs to CoreRedisModule. */
export class RedisIoAdapter
  extends IoAdapter
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  protected override logger = new Logger(RedisIoAdapter.name)
  protected override httpServer: Server['httpServer'] | undefined = undefined
  private readonly channels = new Map<string, ChannelState>()
  private readonly baseChannels = new Set<string>()
  private readonly servers = new Set<Server>()
  private closing = false

  private constructor(
    private readonly pub: Redis,
    private readonly sub: Redis,
  ) {
    super()
  }

  static async connect(redis: Redis): Promise<RedisIoAdapter> {
    const adapter = new RedisIoAdapter(redis.duplicate(), redis.duplicate())
    for (const client of [adapter.pub, adapter.sub])
      client.on('error', (error: unknown) => adapter.logger.error(error))
    adapter.sub.on('ready', () => {
      if (!adapter.closing)
        for (const [channel, state] of adapter.channels)
          if (state.failure) adapter.track(channel, state.work, state.remove)
    })
    try {
      await bounded(Promise.all([adapter.pub.connect(), adapter.sub.connect()]))
      return adapter
    } catch (error) {
      adapter.destroyClients()
      throw error
    }
  }

  bindApp(app: NestExpressApplication): void {
    this.httpServer = app.getHttpServer()
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options)
    this.servers.add(server)
    // 8.3.0 ignores these promises. Serialize each channel so a join cannot race SUNSUBSCRIBE.
    const sub = {
      sSubscribe: (
        channel: string,
        listener: Parameters<Redis['sSubscribe']>[1],
        buffers: boolean,
      ) => this.track(channel, () => this.sub.sSubscribe(channel, listener, buffers)),
      sUnsubscribe: (channel: string) =>
        this.track(channel, () => this.sub.sUnsubscribe(channel), true),
    }
    const factory = createShardedAdapter(this.pub, sub, {
      channelPrefix: redisChannel('socketIo'),
      subscriptionMode: 'dynamic',
    })
    const { channels, baseChannels } = this
    server.adapter(function (nsp) {
      const before = new Set(channels.keys())
      const adapter = factory(nsp)
      for (const channel of channels.keys()) if (!before.has(channel)) baseChannels.add(channel)
      return adapter
    })
    return server
  }

  private track(channel: string, work: () => Promise<unknown>, remove = false): Promise<void> {
    const state = this.channels.get(channel) ?? { work, remove }
    state.work = work
    state.remove = remove
    const settled = (state.pending ?? Promise.resolve()).then(work).then(
      () => {
        state.failure = undefined
        if (remove && state.pending === settled) this.channels.delete(channel)
      },
      (cause: unknown) => {
        state.failure = new Error(`Socket.IO Redis subscription failed: ${channel}`, { cause })
        this.logger.error(state.failure)
      },
    )
    state.pending = settled
    this.channels.set(channel, state)
    void settled.then(() => {
      if (state.pending === settled) state.pending = undefined
    })
    return settled
  }

  /** Room joins wait only for the shared channels and their own user/sid/type subscriptions. */
  async ready(rooms?: readonly string[]): Promise<void> {
    const selected = () =>
      [...this.channels].filter(
        ([channel]) =>
          !rooms ||
          this.baseChannels.has(channel) ||
          rooms.some((room) => channel === `${redisChannel('socketIo')}#/#${room}#`),
      )
    await bounded(this.drain(selected))
    for (const [, state] of selected()) if (state.failure) throw state.failure
  }

  private async drain(selected = () => [...this.channels]): Promise<void> {
    for (;;) {
      const pending = selected().flatMap(([, state]) => (state.pending ? [state.pending] : []))
      if (!pending.length) return
      await Promise.all(pending)
    }
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.ready()
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  override async close(server: Server): Promise<void> {
    try {
      await super.close(server)
    } finally {
      this.servers.delete(server)
    }
  }

  override async dispose(): Promise<void> {
    this.closing = true
    try {
      await Promise.all([...this.servers].map((server) => this.close(server)))
      await bounded(this.drain())
      await bounded(Promise.all([this.pub, this.sub].filter((c) => c.isOpen).map((c) => c.close())))
    } finally {
      this.destroyClients()
    }
  }

  private destroyClients(): void {
    for (const client of [this.pub, this.sub]) if (client.isOpen) client.destroy()
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispose()
  }
}
