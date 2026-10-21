// SafeFetcher (SSRF, see docs/design-notes.md#security): blocked ranges and host tricks refused before any
// connection, names answering inner addresses, redirects re-checked, the connection pinned to the checked
// address (rebinding), time, size and type limits, no credentials sent. Only a local server; DNS is stubbed.
import type { LookupAddress } from 'node:dns'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { Err } from '@qiwu/shared'
import { isBlockedAddress } from '../../net/net-guard.js'
import {
  SafeFetcher,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_USER_AGENT,
} from './safe-fetcher.js'

const MB = 1024 * 1024
let server: http.Server
let port: number
let hits: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    hits.push(url.pathname)
    const send = (
      type: string | null,
      body: string | Buffer,
      extra: http.OutgoingHttpHeaders = {},
    ) => {
      res.writeHead(200, { ...(type ? { 'content-type': type } : {}), ...extra }).end(body)
    }
    switch (url.pathname) {
      case '/page':
        return send('text/html; charset=utf-8', '<title>Hi</title><p>hello</p>')
      case '/echo':
        return send('application/json', JSON.stringify(req.headers))
      case '/image':
        return send('image/png', Buffer.alloc(10))
      case '/untyped':
        return send(null, 'x')
      case '/missing':
        return res.writeHead(404, { 'content-type': 'text/html' }).end('gone')
      case '/big':
        return send('text/plain', 'a'.repeat(3 * MB))
      case '/bomb':
        return send('text/plain', zlib.gzipSync(Buffer.alloc(20 * MB, 'z')), {
          'content-encoding': 'gzip',
        })
      case '/gzip':
        return send('text/plain', zlib.gzipSync('packed text'), { 'content-encoding': 'gzip' })
      case '/gbk':
        return send('text/plain; charset=gbk', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
      case '/meta-gbk':
        return send(
          'text/html',
          Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), Buffer.from([0xd6, 0xd0])]),
        )
      case '/slow':
        return // never answers
      case '/redirect':
        return res.writeHead(302, { location: url.searchParams.get('to') ?? '/' }).end()
      case '/chain': {
        const n = Number(url.searchParams.get('n'))
        return n > 0
          ? res.writeHead(301, { location: `/chain?n=${n - 1}` }).end()
          : send('text/plain', 'end of chain')
      }
      default:
        res.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  hits = []
})

const v = (address: string): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })
/** Stub DNS: names → addresses; anything else does not resolve. */
const NAMES: Record<string, string[]> = {
  'site.test': ['127.0.0.1'],
  'inner.test': ['10.0.0.5'],
  'meta.test': ['169.254.169.254'],
  'mixed.test': ['127.0.0.1', '192.168.0.1'],
  'mapped.test': ['::ffff:7f00:1'],
  'ula.test': ['fd00::1'],
}
const resolve = vi.fn<(host: string) => Promise<LookupAddress[]>>(async (host) => {
  const addrs = NAMES[host]
  if (!addrs) throw new Error('ENOTFOUND')
  return addrs.map(v)
})
afterEach(() => resolve.mockClear())

/** The real rule; the local server's 127.0.0.1 stands in for a public address only where noted. */
const strict = new SafeFetcher({ resolve })
const local = new SafeFetcher({
  resolve,
  isBlocked: (a) => a !== '127.0.0.1' && isBlockedAddress(a),
})

const refused = { err: Err.AGENT_URL_NOT_ALLOWED }
const failed = (reason: string) => ({ err: Err.AGENT_WEB_FAILED, params: { reason } })

describe('SafeFetcher address checks', () => {
  it('keeps the documented limits', () => {
    expect([WEB_FETCH_TIMEOUT_MS, WEB_FETCH_MAX_BYTES, WEB_FETCH_MAX_REDIRECTS]).toEqual([
      15_000,
      2 * MB,
      5,
    ])
  })

  it.each([
    '127.0.0.1',
    '127.1',
    '2130706433', // decimal 127.0.0.1
    '0177.0.0.1', // octal
    '0x7f.0.0.1', // hex
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '[::1]',
    '[::]',
    '[fc00::1]',
    '[fd00:ec2::254]',
    '[fe80::1]',
    '[ff02::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:169.254.169.254]',
    '[::ffff:10.0.0.1]',
  ])('refuses the inner literal %s before connecting', async (host) => {
    await expect(strict.fetch(`http://${host}:${port}/page`)).rejects.toMatchObject(refused)
    expect(hits).toEqual([])
  })

  it.each(['inner.test', 'meta.test', 'mixed.test', 'mapped.test', 'ula.test', 'nowhere.test'])(
    'refuses %s (answers an inner address or nothing)',
    async (host) => {
      await expect(local.fetch(`http://${host}:${port}/page`)).rejects.toMatchObject(refused)
      expect(hits).toEqual([])
    },
  )

  it.each([
    'file:///etc/passwd',
    'ftp://site.test/x',
    'gopher://site.test/x',
    'data:text/plain,hi',
    'not a url',
  ])('refuses %s (http and https only)', async (url) => {
    await expect(local.fetch(url)).rejects.toMatchObject(refused)
  })

  it('refuses credentials in the URL (they would go out as Basic auth)', async () => {
    await expect(local.fetch(`http://user:pw@site.test:${port}/echo`)).rejects.toMatchObject(
      refused,
    )
    expect(hits).toEqual([])
  })

  it('reads a public page and sends no cookie or credential, only its own user agent', async () => {
    const res = await local.fetch(`http://site.test:${port}/echo`)
    const headers = JSON.parse(res.body) as Record<string, string>
    expect(headers['user-agent']).toBe(WEB_FETCH_USER_AGENT)
    expect(headers).not.toHaveProperty('cookie')
    expect(headers).not.toHaveProperty('authorization')
    expect(headers).not.toHaveProperty('proxy-authorization')
  })

  it('connects to the checked address only: a rebinding DNS is asked once', async () => {
    const rebinding = vi
      .fn<(host: string) => Promise<LookupAddress[]>>()
      .mockResolvedValueOnce([v('127.0.0.1')])
      .mockResolvedValue([v('10.0.0.9')])
    const fetcher = new SafeFetcher({
      resolve: rebinding,
      isBlocked: (a) => a !== '127.0.0.1' && isBlockedAddress(a),
    })
    const res = await fetcher.fetch(`http://rebind.test:${port}/page`)
    expect(res.status).toBe(200)
    expect(rebinding).toHaveBeenCalledTimes(1)
  })

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://inner.test/',
    `http://[::1]:PORT/page`,
    'http://167772161/', // decimal 10.0.0.1
    'file:///etc/passwd',
  ])('checks a redirect to %s again and refuses it', async (to) => {
    const target = encodeURIComponent(to.replace('PORT', String(port)))
    // the strict rule refuses 127.0.0.1 too, so the local server stands in as public here
    await expect(
      local.fetch(`http://site.test:${port}/redirect?to=${target}`),
    ).rejects.toMatchObject(refused)
    expect(hits).toEqual(['/redirect'])
  })

  it('follows at most five redirects', async () => {
    const res = await local.fetch(`http://site.test:${port}/chain?n=5`)
    expect(res.body).toBe('end of chain')
    expect(res.url).toBe(`http://site.test:${port}/chain?n=0`)
    await expect(local.fetch(`http://site.test:${port}/chain?n=6`)).rejects.toMatchObject(
      failed('too_many_redirects'),
    )
  })

  it('lets allowPrivate reach an inner address', async () => {
    const res = await strict.fetch(`http://127.0.0.1:${port}/page`, { allowPrivate: true })
    expect(res.body).toContain('hello')
  })
})

describe('SafeFetcher limits', () => {
  it('ends a page that never answers at the time limit', async () => {
    const quick = new SafeFetcher({ resolve, isBlocked: () => false, timeoutMs: 300 })
    const started = Date.now()
    await expect(quick.fetch(`http://site.test:${port}/slow`)).rejects.toMatchObject(
      failed('timeout'),
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('ends a DNS answer that never comes at the time limit', async () => {
    const quick = new SafeFetcher({ resolve: () => new Promise(() => {}), timeoutMs: 300 })
    await expect(quick.fetch('http://hang.test/')).rejects.toMatchObject(failed('timeout'))
  })

  it('stops reading at 2 MB and marks the page truncated', async () => {
    const res = await local.fetch(`http://site.test:${port}/big`)
    expect(res.body.length).toBe(2 * MB)
    expect(res.truncated).toBe(true)
  })

  it('counts the cap after decompression (a gzip bomb stops at 2 MB)', async () => {
    const res = await local.fetch(`http://site.test:${port}/bomb`)
    expect(res.body.length).toBe(2 * MB)
    expect(res.truncated).toBe(true)
    expect((await local.fetch(`http://site.test:${port}/gzip`)).body).toBe('packed text')
  })

  it.each(['/image', '/untyped'])('refuses the content type of %s', async (path) => {
    await expect(local.fetch(`http://site.test:${port}${path}`)).rejects.toMatchObject(
      failed('content_type'),
    )
  })

  it('fails on a non-2xx status', async () => {
    await expect(local.fetch(`http://site.test:${port}/missing`)).rejects.toMatchObject(
      failed('status'),
    )
  })

  it('decodes the charset of the header or the page', async () => {
    expect((await local.fetch(`http://site.test:${port}/gbk`)).body).toBe('中文')
    expect((await local.fetch(`http://site.test:${port}/meta-gbk`)).body).toContain('中')
  })
})
