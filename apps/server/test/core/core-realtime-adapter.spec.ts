import { createServer } from 'node:http'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { redisChannel } from '../../src/core/redis/cache-namespaces.js'
import type { Redis } from '../../src/core/redis/redis.module.js'
import { RedisIoAdapter } from '../../src/core/realtime/redis-io.adapter.js'

function client() {
  const c = {
    isOpen: false,
    on: vi.fn<() => void>(),
    connect: vi.fn<() => Promise<void>>(async () => {
      c.isOpen = true
    }),
    close: vi.fn<() => Promise<void>>(async () => {
      c.isOpen = false
    }),
    destroy: vi.fn<() => void>(() => {
      c.isOpen = false
    }),
    sSubscribe: vi.fn<(...args: Parameters<Redis['sSubscribe']>) => Promise<void>>(async () => {}),
    sUnsubscribe: vi.fn<(...args: Parameters<Redis['sUnsubscribe']>) => Promise<void>>(
      async () => {},
    ),
  }
  return c
}

async function fixture() {
  const pub = client()
  const sub = client()
  const duplicate = vi
    .fn<() => ReturnType<typeof client>>()
    .mockReturnValueOnce(pub)
    .mockReturnValueOnce(sub)
  const adapter = await RedisIoAdapter.connect({ duplicate } as unknown as Redis)
  adapter.bindApp({ getHttpServer: () => createServer() } as NestExpressApplication)
  return { adapter, pub, sub }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('isolates Socket.IO and scheduler channels by database without touching other databases', () => {
  vi.stubEnv('REDIS_DB', '12')
  expect(redisChannel('socketIo')).toBe('qw:socket.io:12')
  expect(redisChannel('jobSync')).toBe('qw:job:sync:12')
  vi.stubEnv('REDIS_DB', '012')
  expect(redisChannel('socketIo')).toBe('qw:socket.io:12')
  expect(redisChannel('jobSync')).toBe('qw:job:sync:12')
  vi.stubEnv('REDIS_DB', '11')
  expect(redisChannel('socketIo')).toBe('qw:socket.io:11')
  expect(redisChannel('jobSync')).toBe('qw:job:sync:11')
})

it('waits for the actual adapter listeners and dynamic user room before declaring ready', async () => {
  const { adapter, sub } = await fixture()
  let subscribed!: () => void
  // Both base subscriptions must settle, not just one unrelated probe listener.
  const releases: (() => void)[] = []
  sub.sSubscribe.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve)
      }),
  )
  const server = adapter.createIOServer(0)
  try {
    let ready = false
    const boot = adapter.onApplicationBootstrap().then(() => {
      ready = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(ready).toBe(false)
    expect(sub.sSubscribe).toHaveBeenCalledTimes(2)
    const [channel, handler, buffers] = sub.sSubscribe.mock.calls[0]
    expect(channel).toBe(`${redisChannel('socketIo')}#/#`)
    expect(handler).toBeTypeOf('function')
    expect(buffers).toBe(true)
    releases[0]()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(ready).toBe(false)
    releases[1]()
    await boot
    expect(ready).toBe(true)

    sub.sSubscribe.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          subscribed = resolve
        }),
    )
    server.of('/').adapter.addAll('socket-id', new Set(['user:7']))
    let joined = false
    const join = adapter.ready().then(() => {
      joined = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(joined).toBe(false)
    expect(sub.sSubscribe.mock.calls.at(-1)?.[0]).toBe(`${channel}user:7#`)
    subscribed()
    await join
    expect(joined).toBe(true)
  } finally {
    await adapter.dispose()
  }
})

it('refuses bootstrap on subscription rejection and closes both duplicates, without an unhandled rejection', async () => {
  const { adapter, pub, sub } = await fixture()
  sub.sSubscribe.mockRejectedValue(new Error('NOPERM'))
  adapter.createIOServer(0)
  const boot = adapter.onApplicationBootstrap()
  await expect(boot).rejects.toThrow('subscription failed')
  await expect(boot).rejects.toMatchObject({ cause: { message: 'NOPERM' } })
  expect(pub.isOpen).toBe(false)
  expect(sub.isOpen).toBe(false)
  expect(sub.sUnsubscribe).toHaveBeenCalledTimes(2)
})

it('bounds connection startup and destroys every opened duplicate on failure', async () => {
  vi.useFakeTimers()
  const pub = client()
  const sub = client()
  sub.connect.mockImplementation(() => {
    sub.isOpen = true
    return new Promise(() => {})
  })
  const duplicate = vi
    .fn<() => ReturnType<typeof client>>()
    .mockReturnValueOnce(pub)
    .mockReturnValueOnce(sub)
  const boot = RedisIoAdapter.connect({ duplicate } as unknown as Redis)
  void boot.catch(() => {})
  await vi.advanceTimersByTimeAsync(5_000)
  await expect(boot).rejects.toThrow('timed out')
  expect(pub.destroy).toHaveBeenCalledOnce()
  expect(sub.destroy).toHaveBeenCalledOnce()
})

it('bounds subscription readiness and destroys the adapter connections when it times out', async () => {
  const { adapter, pub, sub } = await fixture()
  sub.sSubscribe.mockImplementation(() => new Promise(() => {}))
  adapter.createIOServer(0)
  vi.useFakeTimers()
  const boot = adapter.onApplicationBootstrap()
  void boot.catch(() => {})
  // readiness and cleanup each have a budget; neither may leave a reconnecting client behind.
  await vi.advanceTimersByTimeAsync(10_000)
  await expect(boot).rejects.toThrow('timed out')
  expect(pub.isOpen).toBe(false)
  expect(sub.isOpen).toBe(false)
})

it('unsubscribes before closing its own clients and leaves the business client alone', async () => {
  const { adapter, pub, sub } = await fixture()
  const server = adapter.createIOServer(0)
  await adapter.ready()
  await adapter.close(server)
  await adapter.dispose()
  expect(sub.sUnsubscribe).toHaveBeenCalledTimes(2)
  expect(sub.sUnsubscribe.mock.invocationCallOrder[0]).toBeLessThan(
    sub.close.mock.invocationCallOrder[0],
  )
  expect(pub.close).toHaveBeenCalledOnce()
  expect(sub.close).toHaveBeenCalledOnce()
  await adapter.onApplicationShutdown()
  expect(pub.close).toHaveBeenCalledOnce()
})

it('serializes a room subscribe after its pending unsubscribe without blocking unrelated rooms', async () => {
  const { adapter, sub } = await fixture()
  const server = adapter.createIOServer(0)
  const room = 'user:race'
  const channel = `${redisChannel('socketIo')}#/#${room}#`
  let release!: () => void
  try {
    const nsp = server.of('/').adapter
    nsp.addAll('socket-old', new Set([room]))
    await adapter.ready()
    sub.sUnsubscribe.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    nsp.del('socket-old', room)
    nsp.addAll('socket-new', new Set([room]))
    let ready = false
    const joining = adapter.ready([room]).then(() => {
      ready = true
    })
    await new Promise<void>((r) => setImmediate(r))
    expect(ready).toBe(false)
    expect(sub.sSubscribe.mock.calls.filter(([c]) => c === channel)).toHaveLength(1)
    nsp.addAll('socket-other', new Set(['user:other']))
    await adapter.ready(['user:other'])
    release()
    await joining
    expect(sub.sSubscribe.mock.calls.filter(([c]) => c === channel)).toHaveLength(2)
  } finally {
    release?.()
    await adapter.dispose()
  }
})

it('lets HTTP requests drain beyond the Redis budget during close', async () => {
  const { adapter, pub, sub } = await fixture()
  const server = adapter.createIOServer(0)
  await adapter.ready()
  let release!: () => void
  vi.spyOn(server, 'close').mockImplementation((callback) => {
    return new Promise<void>((resolve) => {
      release = () => {
        callback?.()
        resolve()
      }
    })
  })
  vi.useFakeTimers()
  const closing = adapter.close(server)
  void closing.catch(() => {})
  try {
    await vi.advanceTimersByTimeAsync(6_000)
    expect(pub.isOpen).toBe(true)
    expect(sub.isOpen).toBe(true)
    release()
    await expect(closing).resolves.toBeUndefined()
  } finally {
    release?.()
    vi.useRealTimers()
    await adapter.dispose()
  }
})

it('scopes a failed subscription to its channel instead of poisoning unrelated user rooms', async () => {
  const { adapter, sub } = await fixture()
  const server = adapter.createIOServer(0)
  await adapter.ready()
  const channel = `${redisChannel('socketIo')}#/#user:failed#`
  sub.sSubscribe.mockImplementation(async (name) => {
    if (name === channel) throw new Error('NOPERM')
  })
  try {
    server.of('/').adapter.addAll('failed-socket', new Set(['user:failed']))
    await expect(adapter.ready(['user:failed'])).rejects.toMatchObject({
      cause: { message: 'NOPERM' },
    })
    server.of('/').adapter.addAll('healthy-socket', new Set(['user:healthy']))
    await expect(adapter.ready(['user:healthy'])).resolves.toBeUndefined()
  } finally {
    await adapter.dispose()
  }
})
