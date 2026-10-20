// The WeChat Official Account gateway on a stubbed https.request: where the AppSecret and the access
// token go, the fixed hosts, answer caps, errcode mapping, the one retry after a refused token, multipart
// and binary answers, and demo mode sending nothing. Tokens come from a stub here; the real token
// service is wxoa-token.e2e.
import https from 'node:https'
import { PassThrough } from 'node:stream'
import { inspect } from 'node:util'
import { Logger } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import type { AppConfigService } from '../../src/core/config/config.module.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { NET_TIMEOUT_MS, OutboundRefused } from '../../src/core/net/net-guard.js'
import {
  upstreamError,
  WXOA_STABLE_TOKEN,
  WxoaGateway,
  type WxoaCaller,
} from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'

const APPID = 'wx0123456789abcdef'
const SECRET = '0123456789abcdef0123456789abcdef'
const TOKEN = 'TOKEN-UNIT-'
// 单元测试不经过 HTTP 租户上下文，显式携带账号租户与生产回调/后台流程保持一致。
const ACCOUNT: WxoaCaller = { id: 7, appId: APPID, accountKind: 'service', tenantId: 1 }
const MIB = 1024 * 1024
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1])

interface Sent {
  host: string
  port: number
  path: string
  method: string
  headers: Record<string, string | number>
  agent: unknown
  body: Buffer
  req: PassThrough
}
interface Reply {
  status?: number
  headers?: Record<string, string>
  body?: string | Buffer
  /** the request fails instead (connect error, reset) */
  error?: Error
}

const box = new SecretBox({ get: () => 'unit-only-app-secret-0001' } as unknown as AppConfigService)
let demo = false
const cfg = {
  get: (key: string) => ({ ALLOW_PRIVATE_ENDPOINTS: false, APP_DEMO_MODE: demo })[key],
} as unknown as AppConfigService
const ds = { query: vi.fn<(sql: string, args: unknown[]) => Promise<unknown>>() }
let tokenSeq = 0
const tokens = {
  get: vi.fn<() => Promise<string>>(async () => `${TOKEN}${++tokenSeq}`),
  drop: vi.fn<(accountId: number) => Promise<void>>(async () => {}),
}
const gateway = new WxoaGateway(cfg, ds as unknown as DataSource, box, tokens)

let sent: Sent[] = []
/** every log line: none may carry the secret or a token */
const logged: unknown[] = []

/** Answers the requests with `replies` in order (the last one repeating). */
function stub(...replies: (Reply | ((s: Sent) => Reply))[]) {
  return vi.spyOn(https, 'request').mockImplementation(((
    opts: https.RequestOptions,
    cb: (res: PassThrough) => void,
  ) => {
    // not destroyed by itself when done: `destroyed` tells whether the gateway ended the request
    const req = new PassThrough({ autoDestroy: false })
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('finish', () => {
      const s: Sent = {
        host: String(opts.host),
        port: Number(opts.port),
        path: String(opts.path),
        method: String(opts.method),
        headers: (opts.headers ?? {}) as Sent['headers'],
        agent: opts.agent,
        body: Buffer.concat(chunks),
        req,
      }
      sent.push(s)
      const next = replies.length > 1 ? replies.shift()! : replies[0]!
      const reply = typeof next === 'function' ? next(s) : next
      if (reply.error) return void req.emit('error', reply.error)
      const res = Object.assign(new PassThrough(), {
        statusCode: reply.status ?? 200,
        headers: reply.headers ?? { 'content-type': 'application/json' },
      })
      cb(res)
      res.end(reply.body ?? '{"errcode":0,"errmsg":"ok"}')
    })
    return req
  }) as never)
}
const json = (v: object): Reply => ({ body: JSON.stringify(v) })
/** the rejection of `p` (fails when it resolves) */
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('resolved')
    },
    (err: unknown) => err,
  )
/** What the agent's connect gives for `host:port` at once: its refusal, or 'connected' (closed again). */
function connectOutcome(agent: unknown, host: string, port: number): unknown {
  let outcome: unknown = 'no answer'
  const socket = (
    agent as {
      createConnection: (
        o: object,
        cb: (err: Error | null) => void,
      ) => { destroy(): void } | undefined
    }
  ).createConnection({ host, port }, (err) => (outcome = err))
  if (!socket) return outcome
  socket.destroy()
  return 'connected'
}
const codeOf = async (p: Promise<unknown>) => ((await rejection(p)) as BizError).err?.code

beforeAll(() => {
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const)
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      logged.push(args)
    })
})

beforeEach(() => {
  sent = []
  demo = false
  ds.query.mockReset().mockResolvedValue([{ app_secret_enc: box.encrypt(SECRET) }])
  tokens.get.mockClear()
  tokens.drop.mockClear()
})

afterEach(() => vi.mocked(https.request).mockRestore?.())

afterAll(() => vi.restoreAllMocks())

describe('where the secret and the token go', () => {
  it('stable_token: POST to api.weixin.qq.com:443 through the guarded agent, the secret only in the body, never force_refresh', async () => {
    stub(json({ access_token: 'T', expires_in: 7200 }))
    // the caller cannot add to or change a secret-signed call
    const answer = await gateway.json(ACCOUNT, WXOA_STABLE_TOKEN, {
      query: { force_refresh: 'true' },
      body: { force_refresh: true },
    })
    expect(answer).toEqual({ access_token: 'T', expires_in: 7200 })
    expect(sent).toHaveLength(1)
    const [s] = sent
    expect(s).toMatchObject({ host: 'api.weixin.qq.com', port: 443, method: 'POST' })
    expect(s!.agent).toBeInstanceOf(https.Agent)
    // the guard: silence ends the request, inner addresses and other ports are refused
    expect((s!.agent as https.Agent).options.timeout).toBe(NET_TIMEOUT_MS)
    expect(connectOutcome(s!.agent, '127.0.0.1', 443)).toBeInstanceOf(OutboundRefused)
    expect(connectOutcome(s!.agent, 'api.weixin.qq.com', 80)).toBeInstanceOf(OutboundRefused)
    expect(s!.path).toBe('/cgi-bin/stable_token')
    expect(JSON.parse(s!.body.toString())).toEqual({
      grant_type: 'client_credential',
      appid: APPID,
      secret: SECRET,
      force_refresh: false,
    })
    expect(tokens.get).not.toHaveBeenCalled()
    // the secret of this account, looked up by its id and AppID among live rows
    expect(ds.query).toHaveBeenCalledWith(expect.stringContaining('deleted_at IS NULL'), [
      ACCOUNT.id,
      APPID,
      ACCOUNT.tenantId,
    ])
  })

  it('clear_quota/v2: appid and appsecret in the query and the body, no token', async () => {
    stub(json({ errcode: 0, errmsg: 'ok' }))
    await gateway.json(ACCOUNT, '/cgi-bin/clear_quota/v2', { query: { x: 1 }, body: { y: 2 } })
    const [s] = sent
    expect(s!.method).toBe('POST')
    expect(s!.path).toBe(`/cgi-bin/clear_quota/v2?appid=${APPID}&appsecret=${SECRET}`)
    expect(JSON.parse(s!.body.toString())).toEqual({ appid: APPID, appsecret: SECRET })
    expect(tokens.get).not.toHaveBeenCalled()
  })

  it('every other call: the token in the URL only, the secret nowhere', async () => {
    stub(json({ errcode: 0, errmsg: 'ok' }))
    await gateway.json(ACCOUNT, '/cgi-bin/menu/create', {
      query: { lang: 'zh_CN' },
      body: { button: [{ type: 'click', name: '菜单', key: 'k' }] },
    })
    await gateway.json(ACCOUNT, '/cgi-bin/get_api_domain_ip')
    expect(sent.map((s) => [s.method, s.path])).toEqual([
      ['POST', `/cgi-bin/menu/create?lang=zh_CN&access_token=${TOKEN}${tokenSeq - 1}`],
      ['GET', `/cgi-bin/get_api_domain_ip?access_token=${TOKEN}${tokenSeq}`],
    ])
    const body = sent[0]!.body
    expect(JSON.parse(body.toString())).toEqual({
      button: [{ type: 'click', name: '菜单', key: 'k' }],
    })
    expect(sent[0]!.headers).toEqual({
      'content-type': 'application/json',
      'content-length': body.length,
    })
    expect(sent[1]!.body.length).toBe(0)
    for (const s of sent) {
      expect(s.host).toBe('api.weixin.qq.com')
      expect(`${s.path}${s.body}`).not.toContain(SECRET)
      expect(s.body.toString()).not.toContain(TOKEN)
    }
    expect(ds.query).not.toHaveBeenCalled()
  })

  it('a path is an API path only: no query, host or dot segment can ride in it', async () => {
    const spy = stub(json({}))
    for (const path of [
      '/cgi-bin/x?access_token=other',
      '//evil.example/x',
      'https://evil.example/x',
      '/cgi-bin/../x',
      '/cgi-bin/x#y',
      '',
    ]) {
      await expect(gateway.json(ACCOUNT, path)).rejects.toThrow('not an API path')
      await expect(gateway.download(ACCOUNT, path)).rejects.toThrow('not an API path')
      await expect(
        gateway.upload(ACCOUNT, path, { name: 'a.jpg', mime: 'image/jpeg', data: JPEG }),
      ).rejects.toThrow('not an API path')
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('no secret of a deleted account or another AppID: 404, nothing sent', async () => {
    const spy = stub(json({ access_token: 'T' }))
    ds.query.mockResolvedValue([])
    expect(await codeOf(gateway.json(ACCOUNT, WXOA_STABLE_TOKEN))).toBe(Err.NOT_FOUND.code)
    // a box that does not open (another APP_SECRET): the secret must be entered again
    ds.query.mockResolvedValue([{ app_secret_enc: 'v1:not-a-box' }])
    expect(await codeOf(gateway.json(ACCOUNT, WXOA_STABLE_TOKEN))).toBe(
      Err.WXOA_CREDENTIAL_INVALID.code,
    )
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('answers', () => {
  it('64-bit integers stay exact as their digits; others stay numbers', async () => {
    stub({
      body: '{"errcode":0,"msgid":18446744073709551615,"n":-9007199254740993,"ok":7,"f":1.5}',
    })
    expect(await gateway.json(ACCOUNT, '/cgi-bin/message/template/send', { body: {} })).toEqual({
      errcode: 0,
      msgid: '18446744073709551615',
      n: '-9007199254740993',
      ok: 7,
      f: 1.5,
    })
  })

  it.each([
    [40013, 'invalid appid', Err.WXOA_CREDENTIAL_INVALID, {}],
    [40125, 'invalid appsecret', Err.WXOA_CREDENTIAL_INVALID, {}],
    [48001, 'api unauthorized', Err.WXOA_API_UNAUTHORIZED, {}],
    [45009, 'reach max api daily quota limit', Err.WXOA_QUOTA_EXCEEDED, {}],
    [45047, 'out of response count limit', Err.WXOA_SEND_WINDOW, {}],
    [45015, 'response out of time limit', Err.WXOA_SEND_WINDOW, {}],
    [
      40164,
      'invalid ip 203.0.113.9 ipv6 ::ffff:203.0.113.9, not in whitelist rid: x',
      Err.WXOA_IP_NOT_ALLOWED,
      { ip: '203.0.113.9' },
    ],
    [
      61004,
      'access clientip <b>1.2.3.4</b> is not registered',
      Err.WXOA_IP_NOT_ALLOWED,
      { ip: '' },
    ],
    [-1, 'system error', Err.WXOA_UPSTREAM_REFUSED, { errcode: -1 }],
    [87014, 'risky content', Err.WXOA_UPSTREAM_REFUSED, { errcode: 87014 }],
  ])(
    'errcode %i → its own error, nothing of errmsg but an IP',
    async (errcode, errmsg, def, params) => {
      stub(json({ errcode, errmsg }))
      const err = await rejection(
        gateway.json(ACCOUNT, '/cgi-bin/user/info', { query: { openid: 'o' } }),
      )
      expect(err).toBeInstanceOf(BizError)
      expect(err).toMatchObject({ err: def, params })
      expect(inspect(err)).not.toContain(errmsg)
    },
  )

  it('45065 (clientmsgid already taken) answers with the earlier msg_id; without one it is refused', async () => {
    stub(json({ errcode: 45065, errmsg: 'clientmsgid exist', msg_id: 1000001700 }))
    expect(
      await gateway.json(ACCOUNT, '/cgi-bin/message/mass/sendall', { body: {} }),
    ).toMatchObject({ errcode: 45065, msg_id: 1000001700 })
    stub(json({ errcode: 45065, errmsg: 'clientmsgid exist' }))
    expect(
      await rejection(gateway.json(ACCOUNT, '/cgi-bin/message/mass/sendall', { body: {} })),
    ).toMatchObject({ err: Err.WXOA_UPSTREAM_REFUSED, params: { errcode: 45065 } })
  })

  it('a failed exchange is B6001 (no redirect followed); no error holds the URL, the secret or the token', async () => {
    const failures: Reply[] = [
      { status: 302, headers: { location: 'https://evil.example/' }, body: '' },
      { status: 502, body: '{"errcode":0}' },
      { body: '<html>busy</html>' },
      { body: '[1,2]' },
      { body: '{"errcode":"x"}' },
      { error: new Error(`connect ECONNRESET /cgi-bin/x?access_token=${TOKEN}0 ${SECRET}`) },
    ]
    for (const reply of failures) {
      stub(reply)
      for (const call of [
        () => gateway.json(ACCOUNT, '/cgi-bin/user/info'),
        () => gateway.json(ACCOUNT, '/cgi-bin/clear_quota/v2'),
        () => gateway.json(ACCOUNT, WXOA_STABLE_TOKEN),
      ]) {
        sent = []
        const err = await rejection(call())
        expect(err).toMatchObject({ err: Err.WXOA_UPSTREAM, params: {} })
        expect(sent).toHaveLength(1)
        const text = `${inspect(err, { depth: 9 })}${JSON.stringify(err)}${(err as Error).message}`
        expect(text).not.toMatch(new RegExp(`${SECRET}|${TOKEN}|access_token|cgi-bin`))
      }
      vi.mocked(https.request).mockRestore()
    }
  })

  it('clear_quota/v2 refused: the error and the logs carry no appsecret', async () => {
    stub(json({ errcode: 40164, errmsg: `invalid ip 198.51.100.7, appsecret ${SECRET}` }))
    const err = await rejection(gateway.json(ACCOUNT, '/cgi-bin/clear_quota/v2'))
    expect(err).toMatchObject({ err: Err.WXOA_IP_NOT_ALLOWED, params: { ip: '198.51.100.7' } })
    expect(`${inspect(err, { depth: 9 })}${JSON.stringify(err)}`).not.toContain(SECRET)
    expect(JSON.stringify(logged)).not.toContain(SECRET)
  })

  it('JSON answers are capped: 1 MiB unless given, at most 10 MiB, the request ended past it', async () => {
    const answer = (bytes: number) => `{"errcode":0,"pad":"${'x'.repeat(bytes - 22)}"}`
    const twoMib = answer(2 * MIB)
    stub({ body: twoMib })
    const err = await rejection(gateway.json(ACCOUNT, '/cgi-bin/draft/get', { body: {} }))
    expect(err).toMatchObject({ err: Err.PAYLOAD_TOO_LARGE })
    expect(sent[0]!.req.destroyed).toBe(true)
    // the same answer within a cap given for the call
    const got = await gateway.json(ACCOUNT, '/cgi-bin/draft/get', { body: {}, maxBytes: 10 * MIB })
    expect(String(got.pad)).toHaveLength(2 * MIB - 22)
    // a cap that is no number is the default
    expect(
      await codeOf(gateway.json(ACCOUNT, '/cgi-bin/draft/get', { body: {}, maxBytes: NaN })),
    ).toBe(Err.PAYLOAD_TOO_LARGE.code)
    // a larger cap counts as 10 MiB
    vi.mocked(https.request).mockRestore()
    stub({ body: answer(10 * MIB + 1) })
    expect(
      await codeOf(gateway.json(ACCOUNT, '/cgi-bin/draft/get', { body: {}, maxBytes: 64 * MIB })),
    ).toBe(Err.PAYLOAD_TOO_LARGE.code)
  })
})

describe('a refused token', () => {
  it.each([40001, 42001, 40014])(
    '%i: dropped, a new one fetched, the call made once more',
    async (code) => {
      stub(json({ errcode: code, errmsg: 'invalid credential' }), json({ errcode: 0, n: 1 }))
      expect(await gateway.json(ACCOUNT, '/cgi-bin/user/info')).toEqual({ errcode: 0, n: 1 })
      expect(tokens.drop).toHaveBeenCalledExactlyOnceWith(ACCOUNT.id)
      expect(sent.map((s) => s.path)).toEqual([
        `/cgi-bin/user/info?access_token=${TOKEN}${tokenSeq - 1}`,
        `/cgi-bin/user/info?access_token=${TOKEN}${tokenSeq}`,
      ])
    },
  )

  it('refused again: B6006 after two calls, never a third', async () => {
    // a third call would be answered: only a loop gets past the second refusal
    stub(json({ errcode: 42001 }), json({ errcode: 40001 }), json({ errcode: 0 }))
    expect(await codeOf(gateway.json(ACCOUNT, '/cgi-bin/user/info'))).toBe(
      Err.WXOA_CREDENTIAL_INVALID.code,
    )
    expect(sent).toHaveLength(2)
    expect(tokens.get).toHaveBeenCalledTimes(2)
    expect(tokens.drop).toHaveBeenCalledTimes(1)
  })

  it('upload and download retry the same way', async () => {
    stub(json({ errcode: 40001 }), json({ errcode: 0, media_id: 'm' }))
    const file = { name: 'a.jpg', mime: 'image/jpeg', data: JPEG }
    expect(await gateway.upload(ACCOUNT, '/cgi-bin/material/add_material', file)).toEqual({
      errcode: 0,
      media_id: 'm',
    })
    expect(sent).toHaveLength(2)
    vi.mocked(https.request).mockRestore()
    sent = []
    stub(json({ errcode: 40001 }), { headers: { 'content-type': 'image/jpeg' }, body: JPEG })
    expect((await gateway.download(ACCOUNT, '/cgi-bin/media/get')).mime).toBe('image/jpeg')
    expect(sent).toHaveLength(2)
    expect(tokens.drop).toHaveBeenCalledTimes(2)
  })

  it('a secret-signed call is not retried: 40001 there is a wrong AppSecret', async () => {
    stub(json({ errcode: 40001 }), json({ access_token: 'T' }))
    expect(await codeOf(gateway.json(ACCOUNT, WXOA_STABLE_TOKEN))).toBe(
      Err.WXOA_CREDENTIAL_INVALID.code,
    )
    expect(sent).toHaveLength(1)
    expect(tokens.drop).not.toHaveBeenCalled()
  })
})

describe('multipart and binary', () => {
  it('upload: the file as `media`, the fields after it; names cannot break a header', async () => {
    stub(json({ media_id: 'm', url: 'http://mmbiz.qpic.cn/x' }))
    await gateway.upload(
      ACCOUNT,
      '/cgi-bin/material/add_material',
      { name: 'a"b\r\nX-Evil: 1.jpg', mime: 'image/jpeg\r\nX-Evil: 1', data: JPEG },
      {
        query: { type: 'video' },
        fields: { description: '{"title":"t","introduction":"line1\r\nline2"}' },
      },
    )
    const [s] = sent
    expect(s!.path).toBe(
      `/cgi-bin/material/add_material?type=video&access_token=${TOKEN}${tokenSeq}`,
    )
    const type = String(s!.headers['content-type'])
    const boundary = /^multipart\/form-data; boundary=(qw-[0-9a-f]{32})$/.exec(type)?.[1]
    expect(boundary).toBeDefined()
    expect(s!.headers['content-length']).toBe(s!.body.length)
    expect(s!.body).toEqual(
      Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="a_b__X-Evil: 1.jpg"\r\n` +
            'Content-Type: application/octet-stream\r\n\r\n',
        ),
        JPEG,
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="description"\r\n\r\n` +
            '{"title":"t","introduction":"line1\r\nline2"}' +
            `\r\n--${boundary}--\r\n`,
        ),
      ]),
    )
  })

  it('download: the sniffed type and the file name; GET, or POST with a JSON body', async () => {
    stub({
      headers: {
        'content-type': 'image/jpeg',
        'content-disposition': 'attachment; filename="../m-1.jpg"',
      },
      body: JPEG,
    })
    expect(
      await gateway.download(ACCOUNT, '/cgi-bin/media/get', { query: { media_id: 'm-1' } }),
    ).toEqual({ data: JPEG, mime: 'image/jpeg', fileName: '.._m-1.jpg' })
    await gateway.download(ACCOUNT, '/cgi-bin/material/get_material', { body: { media_id: 'm' } })
    expect(sent.map((s) => s.method)).toEqual(['GET', 'POST'])
    expect(JSON.parse(sent[1]!.body.toString())).toEqual({ media_id: 'm' })
  })

  it.each([
    ['a declared type other than the bytes', 'image/png', JPEG],
    ['bytes that are no media', 'application/octet-stream', Buffer.from('%PDF-1.4\n%xx\n')],
    ['bytes of no known type', 'image/jpeg', Buffer.from('plain text')],
    ['a JSON answer without an errcode', 'application/json', Buffer.from('{"down_url":"x"}')],
  ])('download refuses %s (C1002)', async (_, type, body) => {
    stub({ headers: { 'content-type': type }, body })
    expect(await codeOf(gateway.download(ACCOUNT, '/cgi-bin/media/get'))).toBe(
      Err.STORAGE_TYPE_REJECTED.code,
    )
  })

  it('download: an errcode answer is its error; past 10 MiB is A0413 whatever the cap asked', async () => {
    stub({ headers: { 'content-type': 'text/plain' }, body: '{"errcode":40007,"errmsg":"x"}' })
    expect(await rejection(gateway.download(ACCOUNT, '/cgi-bin/media/get'))).toMatchObject({
      err: Err.WXOA_UPSTREAM_REFUSED,
      params: { errcode: 40007 },
    })
    vi.mocked(https.request).mockRestore()
    stub({
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.concat([JPEG, Buffer.alloc(10 * MIB)]),
    })
    expect(
      await codeOf(gateway.download(ACCOUNT, '/cgi-bin/media/get', { maxBytes: 64 * MIB })),
    ).toBe(Err.PAYLOAD_TOO_LARGE.code)
    // a smaller cap for the call holds too
    expect(await codeOf(gateway.download(ACCOUNT, '/cgi-bin/media/get', { maxBytes: 8 }))).toBe(
      Err.PAYLOAD_TOO_LARGE.code,
    )
  })

  it('qrImage: GET from mp.weixin.qq.com with the ticket only (image/jpg as WeChat writes it)', async () => {
    stub({ headers: { 'content-type': 'image/jpg' }, body: JPEG })
    const ticket =
      'gQH47joAAAAAAAAAASxodHRwOi8vd2VpeGluLnFxLmNvbS9xL2taZ2Z3TVRtNzJXV1Brb3ZhYmJJAAIEZ23sUwMEmm3sUw=='
    expect(await gateway.qrImage(ticket)).toEqual({
      data: JPEG,
      mime: 'image/jpeg',
      fileName: null,
    })
    expect(sent[0]).toMatchObject({
      host: 'mp.weixin.qq.com',
      port: 443,
      method: 'GET',
      path: `/cgi-bin/showqrcode?${new URLSearchParams({ ticket })}`,
    })
    expect(tokens.get).not.toHaveBeenCalled()
  })
})

it('demo mode: A0431 before anything is sent', async () => {
  const spy = stub(json({ access_token: 'T' }))
  demo = true
  const file = { name: 'a.jpg', mime: 'image/jpeg', data: JPEG }
  for (const call of [
    () => gateway.json(ACCOUNT, '/cgi-bin/user/info'),
    () => gateway.json(ACCOUNT, WXOA_STABLE_TOKEN),
    () => gateway.json(ACCOUNT, '/cgi-bin/clear_quota/v2'),
    () => gateway.upload(ACCOUNT, '/cgi-bin/material/add_material', file),
    () => gateway.download(ACCOUNT, '/cgi-bin/media/get'),
    () => gateway.qrImage('t'),
  ])
    expect(await codeOf(call())).toBe(Err.DEMO_READ_ONLY.code)
  expect(spy).not.toHaveBeenCalled()
})

it('upstreamError: only a well-formed IP leaves errmsg', () => {
  expect(upstreamError(40164, 'invalid ip 2001:db8::1, not in whitelist').params).toEqual({
    ip: '2001:db8::1',
  })
  expect(upstreamError(40164, 'invalid ip 999.1.1.1 x').params).toEqual({ ip: '' })
  expect(upstreamError(40164).params).toEqual({ ip: '' })
})

it('no log line of this spec carries the secret or a token', () => {
  const text = JSON.stringify(logged)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(TOKEN)
})
