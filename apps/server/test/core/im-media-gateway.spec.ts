import http from 'node:http'
import { ConfigService } from '@nestjs/config'
import { TokenVerifier } from 'livekit-server-sdk'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { ImMediaGateway } from '../../src/modules/platform/im/im-media-gateway.js'

let server: http.Server
let origin = ''
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void
const made: ImMediaGateway[] = []
const requests: { path: string; authorization: string; body: unknown }[] = []
const fixtureKey = 'gateway-key'
const fixtureSecret = 'gateway-secret'
function gateway(overrides: Record<string, unknown> = {}) {
  const service = new ImMediaGateway(
    new AppConfigService(
      new ConfigService({
        NODE_ENV: 'test',
        ALLOW_PRIVATE_ENDPOINTS: true,
        OUTBOUND_LIVEKIT_PORTS: [],
        IM_LIVEKIT_URL: 'wss://media.example.test',
        IM_LIVEKIT_API_URL: origin,
        IM_LIVEKIT_API_KEY: fixtureKey,
        IM_LIVEKIT_API_SECRET: fixtureSecret,
        ...overrides,
      }),
    ),
  )
  made.push(service)
  return service
}
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        path: req.url!,
        authorization: req.headers.authorization ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
      })
      respond(req, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
beforeEach(() => {
  requests.length = 0
  respond = (_req, res) => res.end('{}')
})
afterEach(() => {
  for (const service of made.splice(0)) service.onModuleDestroy()
})
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
)

it('uses exact fixed control methods, signed management scopes and the unique room filter', async () => {
  const api = gateway()
  respond = (req, res) =>
    res.end(
      req.url!.endsWith('CreateRoom')
        ? '{"name":"unique-room"}'
        : req.url!.endsWith('ListRooms')
          ? '{"rooms":[{"name":"unique-room"}]}'
          : '{}',
    )
  await api.createRoom('unique-room')
  expect(await api.hasRoom('unique-room')).toBe(true)
  await api.deleteRoom('unique-room')
  expect(requests.map((r) => r.path)).toEqual(
    ['CreateRoom', 'ListRooms', 'DeleteRoom'].map((m) => `/twirp/livekit.RoomService/${m}`),
  )
  expect(requests[1].body).toEqual({ names: ['unique-room'] })
  const verifier = new TokenVerifier(fixtureKey, fixtureSecret)
  const claims = await Promise.all(requests.map((r) => verifier.verify(r.authorization.slice(7))))
  expect(claims[0].video?.roomCreate).toBe(true)
  expect(claims[1].video?.roomList).toBe(true)
  expect(claims[2].video).toMatchObject({ roomAdmin: true, room: 'unique-room' })
})

it('keeps unconfigured and malformed origins completely offline', async () => {
  for (const overrides of [
    { IM_LIVEKIT_API_SECRET: '' },
    { IM_LIVEKIT_API_URL: `${origin}/path` },
    { IM_LIVEKIT_URL: 'wss://user:secret@media.example.test' },
    { IM_LIVEKIT_URL: 'wss://media.example.test/?token=secret' },
  ]) {
    const api = gateway(overrides)
    expect(api.configured()).toBe(false)
    await expect(api.createRoom('private')).rejects.toMatchObject({ mayHaveCreated: false })
  }
  expect(requests).toEqual([])
})

it('accepts omitted protobuf repeated rooms as an empty observation and refuses malformed lists', async () => {
  const api = gateway()
  respond = (_req, res) => res.end('{}')
  expect(await api.hasRoom('absent')).toBe(false)
  respond = (_req, res) => res.end('{"rooms":false}')
  await expect(api.hasRoom('absent')).rejects.toMatchObject({ mayHaveCreated: true })
})

it('rejects a valid JSON control response that exceeds one MiB', async () => {
  const api = gateway()
  respond = (_req, res) => res.end(JSON.stringify({ rooms: [], padding: 'x'.repeat(1024 * 1024) }))
  await expect(api.hasRoom('room')).rejects.toMatchObject({
    message: 'media control request failed',
  })
})

it('refuses a valid JSON 404 with a different error code as proof of deletion', async () => {
  const api = gateway()
  respond = (_req, res) => {
    res.statusCode = 404
    res.end('{"code":"permission_denied"}')
  }
  await expect(api.deleteRoom('room')).rejects.toMatchObject({
    message: 'media control request failed',
  })
})

it('keeps the absolute two-second deadline while the upstream continuously trickles bytes', async () => {
  const api = gateway()
  respond = (_req, res) => {
    res.write('{"rooms":[')
    const heartbeat = setInterval(() => res.write(' '), 200)
    res.once('close', () => clearInterval(heartbeat))
  }
  const start = Date.now()
  await expect(api.hasRoom('slow-drip')).rejects.toMatchObject({
    message: 'media control request failed',
  })
  expect(Date.now() - start).toBeLessThan(2800)
})

it('does not follow redirects or return upstream errors and rejects oversized responses', async () => {
  const api = gateway()
  respond = (_req, res) => {
    res.statusCode = 302
    res.setHeader('Location', '/redirected-with-credentials')
    res.end('{}')
  }
  await expect(api.createRoom('room')).rejects.toMatchObject({
    message: 'media control request failed',
  })
  expect(requests).toHaveLength(1)
  respond = (_req, res) => res.end('x'.repeat(1024 * 1024 + 1))
  await expect(api.hasRoom('room')).rejects.toMatchObject({
    message: 'media control request failed',
  })
  respond = (_req, res) => {
    res.statusCode = 500
    res.end('{"message":"private-secret"}')
  }
  await expect(api.deleteRoom('room')).rejects.not.toHaveProperty('cause')
})

it('only accepts explicit remote not-found as a successful delete and obeys caller abort', async () => {
  const api = gateway()
  respond = (_req, res) => {
    res.statusCode = 404
    res.end('{"code":"not_found"}')
  }
  await api.deleteRoom('gone')
  respond = (_req, res) => {
    res.statusCode = 404
    res.end('<html>missing proxy route</html>')
  }
  await expect(api.deleteRoom('not-the-api')).rejects.toThrow('media control request failed')
  const signal = AbortSignal.abort()
  const before = requests.length
  await expect(api.createRoom('aborted', signal)).rejects.toMatchObject({ mayHaveCreated: false })
  expect(requests).toHaveLength(before)
})

it('bounds a silent upstream and rejects private addresses without explicit private-endpoint policy', async () => {
  respond = () => {}
  const started = Date.now()
  await expect(gateway().hasRoom('slow')).rejects.toThrow('media control request failed')
  expect(Date.now() - started).toBeLessThan(3000)
  const blocked = gateway({
    IM_LIVEKIT_API_URL: 'https://127.0.0.1',
    ALLOW_PRIVATE_ENDPOINTS: false,
  })
  await expect(blocked.hasRoom('private')).rejects.toThrow('media control request failed')
})
