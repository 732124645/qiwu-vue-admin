import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { REALTIME_EVENT, RT, type RealtimeMessage, type SessionVo } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import { createClient } from 'redis'
import { io, type Socket } from 'socket.io-client'
import request from 'supertest'
import { DataSource } from 'typeorm'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import type { Redis } from '../../src/core/redis/redis.module.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'multi-instance-'
const PW = 'Multi-instance#2026'
const SEND = '/api/demo/realtime/send'
const runner = fileURLToPath(new URL('../fixtures/multi-instance/runner.mjs', import.meta.url))
const workers: { child: ChildProcess; exited: Promise<void> }[] = []
const sockets: Socket[] = []
const userIds: number[] = []
const tokens: Record<string, string> = {}
const ids: Record<string, number> = {}
let ds: DataSource
let redis: Redis
let urls: string[] = []
let seq = 0
const unique = () => `${PREFIX}${process.pid}-${++seq}`

const kill = () => {
  for (const { child } of workers) if (child.exitCode === null) child.kill('SIGKILL')
}
const interrupt = () => {
  kill()
  process.kill(process.pid, 'SIGINT')
}
const terminate = () => {
  kill()
  process.kill(process.pid, 'SIGTERM')
}

async function stop(worker: (typeof workers)[number]) {
  const { child, exited } = worker
  if (child.connected) child.send('stop', () => {})
  else if (child.exitCode === null) child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    await exited
  } finally {
    clearTimeout(force)
  }
}

async function cleanup() {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(workers.map(stop))
  workers.splice(0)
  process.off('exit', kill).off('SIGINT', interrupt).off('SIGTERM', terminate)
  if (ds?.isInitialized) {
    if (userIds.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    await ds.destroy()
  }
  if (redis?.isOpen) {
    await cleanRedis(redis)
    await redis.close()
  }
}

function boot(): Promise<string> {
  if (!existsSync(new URL('../../dist/app.module.js', import.meta.url)))
    throw new Error('Build first: pnpm --filter @qiwu/server build')
  const child = fork(runner, [], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, I18N_DIR: 'dist/i18n' },
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  workers.push({ child, exited })
  // Keep bounded diagnostics and redact actual inherited secret values before retaining any output.
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /pass|secret|token/i.test(name) && value)
    .map(([, value]) => value!)
  let stderr = ''
  child.stderr?.on('data', (data: Buffer) => {
    let line = data.toString()
    for (const secret of secrets) line = line.replaceAll(secret, '***')
    stderr = (stderr + line).slice(-2000)
  })
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, url?: string) => {
      clearTimeout(timer)
      child.off('message', ready).off('error', failed).off('exit', earlyExit)
      if (error) reject(error)
      else resolve(url!)
    }
    const ready = (value: unknown) => {
      const message = value as { url?: string; error?: string }
      if (message.error) finish(new Error(`${message.error}\n${stderr}`))
      else if (message.url) finish(undefined, message.url)
    }
    const failed = (error: Error) => finish(error)
    const earlyExit = () => finish(new Error(`Runner exited before ready\n${stderr}`))
    const timer = setTimeout(
      () => finish(new Error(`Runner startup exceeded 30s\n${stderr}`)),
      30_000,
    )
    child.on('message', ready).once('error', failed).once('exit', earlyExit)
  })
}

const http = (instance = 1) => request(urls[instance]!)
const send = (text = unique(), instance = 1, token = tokens.admin) =>
  http(instance)
    .post(SEND)
    .set(bearer(token!))
    .send({ target: 'user', userIds: [ids.recipient], text })
    .timeout(5000)

async function login(name: string, instance = 0) {
  const result = await http(instance)
    .post('/api/auth/login')
    .set('User-Agent', `${name}-${instance}`)
    .send({ username: PREFIX + name, password: PW })
    .timeout(5000)
    .expect(200)
  return result.body.data.accessToken as string
}

function open(token: string, instance = 0) {
  const socket = io(urls[instance]!, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    autoConnect: false,
    forceNew: true,
    timeout: 5000,
  })
  sockets.push(socket)
  const inbox: RealtimeMessage[] = []
  socket.on(REALTIME_EVENT, (message: RealtimeMessage) => inbox.push(message))
  return { socket, inbox }
}

function connect(socket: Socket) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      socket.off('connect', connected).off('connect_error', failed)
      if (error) reject(error)
      else resolve()
    }
    const connected = () => finish()
    const failed = (error: Error) => finish(error)
    const timer = setTimeout(() => finish(new Error('Socket connect exceeded 5s')), 5000)
    socket.once('connect', connected).once('connect_error', failed).connect()
  })
}

async function clearThrottle() {
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 100 }))
    if (keys.length) await redis.unlink(keys)
}

let target: ReturnType<typeof open>
let sibling: ReturnType<typeof open>
let other: ReturnType<typeof open>

beforeAll(async () => {
  process.once('exit', kill).once('SIGINT', interrupt).once('SIGTERM', terminate)
  try {
    if (!process.env.DB_NAME?.endsWith('_test') || Number(process.env.REDIS_DB) === 13)
      throw new Error('Multi-instance tests require the assigned test channel')
    ds = new DataSource(dataSourceOptions())
    await ds.initialize()
    redis = createClient({
      socket: { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) },
      username: process.env.REDIS_USERNAME,
      password: process.env.REDIS_PASSWORD,
      database: Number(process.env.REDIS_DB),
    })
    redis.on('error', () => {})
    await redis.connect()
    await cleanRedis(redis)
    // Test seed sets captcha=off; make the precondition explicit before either process caches it.
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      'off',
      'captcha.mode',
    ])
    const passwordHash = bcrypt.hashSync(PW, 4)
    for (const name of ['recipient', 'other']) {
      ids[name] = await insertRow(ds.manager, 'iam_user', {
        username: PREFIX + name,
        display_name: name,
        password_hash: passwordHash,
        password_changed_at: new Date(),
      })
      userIds.push(ids[name]!)
    }
    urls = await Promise.all([boot(), boot()])
    const admin = await http()
      .post('/api/auth/login')
      .send({
        username: 'admin',
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .timeout(5000)
      .expect(200)
    tokens.admin = admin.body.data.accessToken
    tokens.recipient = await login('recipient')
    tokens.sibling = await login('recipient', 1)
    tokens.other = await login('other')
    target = open(tokens.recipient!)
    sibling = open(tokens.sibling!)
    other = open(tokens.other!)
    await Promise.all([target, sibling, other].map(({ socket }) => connect(socket)))
    // Real send -> onlineUsers -> fetchSockets on instance 2 waits for remote room joins.
    await vi.waitFor(
      async () => {
        if ((await send().expect(200)).body.data.delivered !== 1)
          throw new Error('Remote recipient room is not ready')
      },
      { timeout: 5000 },
    )
  } catch (error) {
    await cleanup()
    throw error
  }
}, 60_000)

afterAll(cleanup, 15_000)

it('instance 2 pushes to both sessions on instance 1 and counts distinct remote users', async () => {
  const text = unique()
  expect((await send(text).expect(200)).body.data).toEqual({ delivered: 1 })
  await vi.waitFor(
    () => {
      for (const peer of [target, sibling])
        expect(peer.inbox).toContainEqual({
          type: RT.demoMessage,
          payload: {
            from: { id: expect.any(Number), name: expect.any(String) },
            text,
            at: expect.any(String),
          },
        })
    },
    { timeout: 5000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(other.inbox.filter((m) => m.type === RT.demoMessage && m.payload.text === text)).toEqual(
    [],
  )
  await send(unique(), 1, tokens.other).expect(403)
  await http()
    .post('/api/iam/sessions/kick')
    .set(bearer(tokens.other!))
    .send({ sids: ['00000000-0000-4000-8000-000000000000'] })
    .timeout(5000)
    .expect(403)
  await http()
    .post(SEND)
    .set(bearer(tokens.admin!))
    .send({ target: 'user' })
    .timeout(5000)
    .expect(400)
})

it('instance 2 kicks precisely one remote sid: last event precedes disconnect, REST and reconnect fail', async () => {
  const list = await http()
    .get('/api/iam/sessions')
    .set(bearer(tokens.admin!))
    .query({ username: PREFIX + 'recipient', pageSize: 100 })
    .timeout(5000)
    .expect(200)
  const sessions = list.body.data.items as SessionVo[]
  expect(sessions).toHaveLength(2)
  // Match the unique login marker rather than a timestamp or an old session of the same user.
  const selected = sessions.find(
    (s) => s.userId === ids.recipient && s.userAgent === 'recipient-0',
  )!
  expect(selected).toBeDefined()
  const events: string[] = []
  target.socket.on(REALTIME_EVENT, (message: RealtimeMessage) => {
    if (message.type === RT.sessionKicked) events.push(message.payload.sid)
  })
  target.socket.once('disconnect', (reason) => events.push(reason))
  expect(
    (
      await http()
        .post('/api/iam/sessions/kick')
        .set(bearer(tokens.admin!))
        .send({ sids: [selected.sid] })
        .timeout(5000)
        .expect(200)
    ).body.data.kicked,
  ).toBe(1)
  await vi.waitFor(() => expect(events).toEqual([selected.sid, 'io server disconnect']), {
    timeout: 5000,
  })
  expect(sibling.socket.connected).toBe(true)
  await http(0).get('/api/auth/me').set(bearer(tokens.recipient!)).timeout(5000).expect(401)
  await http(1).get('/api/auth/me').set(bearer(tokens.sibling!)).timeout(5000).expect(200)
  await expect(connect(target.socket)).rejects.toThrow('unauthorized')
})

it('shares route/IP counts: alternating instances accept 30 sends, the 31st gets A0429', async () => {
  await clearThrottle()
  for (let i = 0; i < 30; i++) {
    const result = await send(unique(), i % 2).expect(200)
    expect(result.headers['x-ratelimit-limit']).toBe('30')
    expect(result.headers['x-ratelimit-remaining']).toBe(String(29 - i))
    expect(Number(result.headers['x-ratelimit-reset'])).toBeGreaterThan(0)
    expect(Number(result.headers['x-ratelimit-reset'])).toBeLessThanOrEqual(60)
  }
  const result = await send(unique(), 0).expect(429)
  expect(result.body.code).toBe('A0429')
  expect(Number(result.headers['retry-after'])).toBe(60)
})

it('restarts one process and rejoins subscriptions: fresh connections receive remote pushes', async () => {
  await stop(workers[0]!)
  urls[0] = await boot()
  const fresh = open(tokens.sibling!)
  await connect(fresh.socket)
  await clearThrottle()
  const text = unique()
  await vi.waitFor(async () => expect((await send().expect(200)).body.data.delivered).toBe(1), {
    timeout: 5000,
  })
  await send(text).expect(200)
  await vi.waitFor(
    () =>
      expect(fresh.inbox.some((m) => m.type === RT.demoMessage && m.payload.text === text)).toBe(
        true,
      ),
    { timeout: 5000 },
  )
}, 40_000)
