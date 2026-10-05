// core/net SSRF guard (see docs/design-notes.md#security): blocked ranges (private, loopback, link-local, CGNAT, metadata,
// IPv4-mapped/embedding IPv6), port whitelist, 5 s DNS timeout, one generic error; the agents check
// the address really dialled (IP literals, names, DNS rebinding, a redirect's target) and
// ALLOW_PRIVATE_ENDPOINTS lifts the checks. No network: DNS answers are stubbed.
import dns from 'node:dns'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  assertPublicHost,
  guardedAgents,
  isBlockedAddress,
  isRefusedLiteral,
  NET_TIMEOUT_MS,
  OUTBOUND_PORTS,
  OutboundRefused,
  outboundRule,
} from '../../src/core/net/net-guard.js'

const S3 = { ports: OUTBOUND_PORTS.s3, allowPrivate: false }
const answer = (...addrs: string[]) =>
  vi
    .spyOn(dns.promises, 'lookup')
    .mockResolvedValue(
      addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as never,
    )

let server: http.Server
let port: number
let hits = 0
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits++
    if (req.url === '/silent') return // never answers
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end()
      return
    }
    res.end('inner secret')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

/** Status and body of a GET through `agent`, or the error it failed with. */
const get = (url: string, agent: http.Agent) =>
  new Promise<{ status: number; body: string } | Error>((resolve) => {
    http
      .get(url, { agent }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      .on('error', resolve)
  })

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.100.100.200',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.170',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    '::127.0.0.1',
    '64:ff9b::a00:1',
    '2002:a00:1::',
    '2001:0:4136:e378::1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'ff02::1',
    'not-an-ip',
    '',
  ])('%s is blocked', (ip) => expect(isBlockedAddress(ip)).toBe(true))

  it.each(['8.8.8.8', '1.1.1.1', '52.95.110.1', '172.32.0.1', '100.128.0.1', '2606:4700::1111'])(
    '%s is public',
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  )
})

describe('assertPublicHost', () => {
  it('a name resolving only to public addresses on a registered port passes with its addresses', async () => {
    answer('52.95.110.1', '2606:4700::1111')
    await expect(assertPublicHost('s3.example.com', 443, S3)).resolves.toHaveLength(2)
    await expect(assertPublicHost('52.95.110.1', 80, S3)).resolves.toEqual([
      { address: '52.95.110.1', family: 4 },
    ])
  })

  it('refuses inner answers (any of them), IP literals, IPv6 in brackets and unregistered ports alike', async () => {
    answer('52.95.110.1', '10.0.0.5')
    const refusals = [
      assertPublicHost('mixed.example.com', 443, S3),
      assertPublicHost('127.0.0.1', 443, S3),
      assertPublicHost('169.254.169.254', 80, S3),
      assertPublicHost('[::1]', 443, S3),
      assertPublicHost('[::ffff:127.0.0.1]', 443, S3),
      assertPublicHost('8.8.8.8', 6379, S3),
      assertPublicHost('8.8.8.8', 25, S3),
    ]
    for (const r of refusals) {
      const err = await r.catch((e: unknown) => e)
      expect(err).toBeInstanceOf(OutboundRefused)
      expect((err as Error).message).toBe('outbound target refused')
    }
    await expect(
      assertPublicHost('8.8.8.8', 587, { ...S3, ports: OUTBOUND_PORTS.smtp }),
    ).resolves.toBeTruthy()
  })

  it('an unknown name and a DNS answer slower than 5 s are the same generic refusal', async () => {
    vi.spyOn(dns.promises, 'lookup').mockRejectedValueOnce(
      Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.invalid'), { code: 'ENOTFOUND' }),
    )
    await expect(assertPublicHost('nowhere.invalid', 443, S3)).rejects.toThrow(
      /^outbound target refused$/,
    )
    vi.useFakeTimers()
    vi.spyOn(dns.promises, 'lookup').mockReturnValue(new Promise(() => {}) as never)
    const slow = assertPublicHost('slow.example.com', 443, S3).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(NET_TIMEOUT_MS - 1)
    let settled = false
    void slow.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await slow).toBeInstanceOf(OutboundRefused)
  })

  it('ALLOW_PRIVATE_ENDPOINTS lifts the address and port checks', async () => {
    await expect(
      assertPublicHost('127.0.0.1', 6379, { ...S3, allowPrivate: true }),
    ).resolves.toEqual([{ address: '127.0.0.1', family: 4 }])
  })
})

describe('outboundRule: deployer-registered ports (env), default-deny otherwise', () => {
  const env =
    (values: Record<string, unknown>) =>
    (key: string): unknown =>
      values[key] ?? { OUTBOUND_S3_PORTS: [], OUTBOUND_SMTP_PORTS: [] }[key] ?? false
  const ruleOf = (values: Record<string, unknown>, purpose: 's3' | 'smtp') =>
    outboundRule({ get: env(values) } as never, purpose)

  it('defaults only: S3 80/443, SMTP 25/465/587; the private flag passes through', () => {
    expect(ruleOf({}, 's3')).toEqual({ ports: [80, 443], allowPrivate: false })
    expect(ruleOf({ ALLOW_PRIVATE_ENDPOINTS: true }, 'smtp')).toEqual({
      ports: [25, 465, 587],
      allowPrivate: true,
    })
  })

  it('registered ports extend their own purpose only; every other port stays refused', async () => {
    const values = { OUTBOUND_S3_PORTS: [9000], OUTBOUND_SMTP_PORTS: [2525] }
    const s3 = ruleOf(values, 's3')
    const smtp = ruleOf(values, 'smtp')
    expect(s3.ports).toEqual([80, 443, 9000])
    expect(smtp.ports).toEqual([25, 465, 587, 2525])
    await expect(assertPublicHost('8.8.8.8', 9000, s3)).resolves.toBeTruthy()
    for (const [port, rule] of [
      [2525, s3],
      [6379, s3],
      [9000, smtp],
    ] as const)
      await expect(assertPublicHost('8.8.8.8', port, rule)).rejects.toBeInstanceOf(OutboundRefused)
    expect(isRefusedLiteral('s3.example.com', 9000, s3)).toBe(false)
    expect(isRefusedLiteral('s3.example.com', 9000, ruleOf({}, 's3'))).toBe(true)
    // a registered port never opens inner addresses
    expect(isRefusedLiteral('127.0.0.1', 9000, s3)).toBe(true)
  })
})

describe('guardedAgents', () => {
  it('refuses an inner IP literal and a name resolving inside; the server is never reached', async () => {
    const { httpAgent } = guardedAgents({ ports: [port], allowPrivate: false })
    hits = 0
    expect(await get(`http://127.0.0.1:${port}/`, httpAgent)).toBeInstanceOf(OutboundRefused)
    expect(await get(`http://localhost:${port}/`, httpAgent)).toBeInstanceOf(OutboundRefused)
    expect(hits).toBe(0)
    httpAgent.destroy()
  })

  it('checks the address it dials, not an earlier answer (DNS rebinding)', async () => {
    const lookup = answer('52.95.110.1')
    await expect(assertPublicHost('rebind.example.com', 443, S3)).resolves.toBeTruthy()
    lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)
    const { httpAgent } = guardedAgents({ ports: [port], allowPrivate: false })
    hits = 0
    expect(await get(`http://rebind.example.com:${port}/`, httpAgent)).toBeInstanceOf(
      OutboundRefused,
    )
    expect(hits).toBe(0)
    httpAgent.destroy()
  })

  it('an unregistered port is refused before any connection', async () => {
    const { httpAgent } = guardedAgents(S3)
    answer('52.95.110.1')
    expect(await get('http://s3.example.com:6379/', httpAgent)).toBeInstanceOf(OutboundRefused)
    httpAgent.destroy()
  })

  it("a redirect's target is dialled through the guard again (metadata refused)", async () => {
    const open = guardedAgents({ ports: [80, port], allowPrivate: true })
    const first = await get(`http://127.0.0.1:${port}/redirect`, open.httpAgent)
    const location = 'http://169.254.169.254/latest/meta-data/'
    expect(first).toMatchObject({ status: 302 })
    const strict = guardedAgents({ ports: [80, port], allowPrivate: false })
    expect(await get(location, strict.httpAgent)).toBeInstanceOf(OutboundRefused)
    open.httpAgent.destroy()
    strict.httpAgent.destroy()
  })

  it('a socket silent for the timeout ends the request with the generic refusal', async () => {
    const { httpAgent } = guardedAgents({ ports: [port], allowPrivate: true, timeoutMs: 200 })
    const started = Date.now()
    expect(await get(`http://127.0.0.1:${port}/silent`, httpAgent)).toBeInstanceOf(OutboundRefused)
    expect(Date.now() - started).toBeLessThan(2000)
    httpAgent.destroy()
  })

  it('ALLOW_PRIVATE_ENDPOINTS: the same agents reach a local service on any port', async () => {
    const { httpAgent, httpsAgent } = guardedAgents({
      ports: OUTBOUND_PORTS.s3,
      allowPrivate: true,
    })
    expect(await get(`http://127.0.0.1:${port}/`, httpAgent)).toEqual({
      status: 200,
      body: 'inner secret',
    })
    expect(await get(`http://localhost:${port}/`, httpAgent)).toMatchObject({ status: 200 })
    httpAgent.destroy()
    httpsAgent.destroy()
  })
})
