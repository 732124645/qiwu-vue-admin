// WeChat one-time subscribe messages after inbox delivery, with a fake WeChat gateway
// (the real one's requests are checked on a stubbed https.request). A recipient's openid `o-<name>` picks
// WeChat's answers to the sends: errcodes queued in `answers` (default 0 = sent).
import https from 'node:https'
import { PassThrough } from 'node:stream'
import { Injectable, Logger } from '@nestjs/common'
import { Transactional } from '@nestjs-cls/transactional'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, WX_SUBSCRIBE_ENABLED_PARAM, WX_SUBSCRIBE_TEMPLATES_PARAM } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import type { AppConfigService } from '../../src/core/config/config.module.js'
import { Notifier, NotifyDispatcher, type NotifySend } from '../../src/core/notify/notify.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  parseSendErrcode,
  parseStableToken,
  WxMpGateway,
  type WxSubscribeSend,
} from '../../src/modules/platform/iam/social/wx-mp.gateway.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'wxsub-e2e.'
const CODE = `${PREFIX}todo`
const UNMAPPED = `${PREFIX}unmapped`
const APPID = 'wx00e2e000000000sub'
const TPL = 'tpl-todo-e2e'
const SECRET = 'wx-app-secret-must-never-leave'
const TOKEN = 'ACCESS-TOKEN-E2E-'
const PARAMS = [WX_SUBSCRIBE_ENABLED_PARAM, WX_SUBSCRIBE_TEMPLATES_PARAM] as const
const PAGE = 'pages-wf/detail/index?id={instanceId}&by={initiator}'
/** the mapping under test: CODE fills title, time and a name field; others share or lack an id */
const MAPPING = {
  [CODE]: {
    id: TPL,
    page: PAGE,
    data: { thing1: '{title}', time2: '{time}', name3: '{initiator}{initiator}{initiator}' },
  },
  [`${PREFIX}same`]: { id: TPL, data: {} },
  [`${PREFIX}other`]: { id: 'tpl-other-e2e', state: 'trial', data: {} },
  [`${PREFIX}off`]: { id: '', data: {} },
}
/** zh-CN title over 20 code points with an astral character before the cut (UTF-16 slicing differs) */
const ZH_TITLE = '{initiator}😀提交的出差申请需要你审批请尽快处理谢谢'

let tokenSeq = 0
const answers = new Map<string, number[]>()
const gateway = {
  appid: vi.fn((): string | null => APPID),
  code2Session: vi.fn(),
  stableToken: vi.fn(async () => ({ token: `${TOKEN}${++tokenSeq}`, expiresIn: 7200 })),
  subscribeSend: vi.fn(
    async (_token: string, body: WxSubscribeSend) => answers.get(body.touser)?.shift() ?? 0,
  ),
}

@Injectable()
class TxCalls {
  constructor(private readonly notifier: Notifier) {}

  @Transactional()
  async fails(input: NotifySend) {
    await this.notifier.send(input)
    throw new Error('rollback')
  }
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
let dispatcher: NotifyDispatcher
const original = new Map<string, string>()
const users = new Map<string, number>()
/** every log line and every response body: no secret, no token */
const seen: unknown[] = []

const tokenKey = redisKey('wxMp', 'token', APPID)
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await params.invalidate(key)
}
const on = async (mapping: object = MAPPING) => {
  await setParam(WX_SUBSCRIBE_ENABLED_PARAM, 'true')
  await setParam(WX_SUBSCRIBE_TEMPLATES_PARAM, JSON.stringify(mapping))
}
async function user(
  name: string,
  over: Record<string, unknown> = {},
  binding: Record<string, unknown> | null = {},
) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: `wxsub-e2e-${name}`,
    display_name: name,
    password_hash: 'unused',
    password_changed_at: new Date(),
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    ...over,
  })
  users.set(name, id)
  if (binding)
    await insertRow(ds.manager, 'iam_user_social', {
      provider: 'wx-mp',
      appid: APPID,
      openid: `o-${name}`,
      user_id: id,
      ...binding,
    })
  return id
}
/** Sends CODE (or `template`) to `name` outside a transaction (flushed at once), then waits for the pushes. */
const notify = async (name: string, template = CODE, initiator = 'Ada&Bo') => {
  await app.get(Notifier).send({
    template,
    to: [users.get(name)!],
    params: { instanceId: 7, initiator, model: { i18n: 'seed.unused' } },
    channels: ['inbox'],
  })
  await dispatcher.idle()
}
const inbox = (name: string) =>
  ds.query<{ id: number; status: string; title: string; created_at: Date }[]>(
    'SELECT id, status, title, created_at FROM msg_inbox WHERE user_id = ? AND template_code LIKE ? ORDER BY id',
    [users.get(name), `${PREFIX}%`],
  )
const lastInbox = async (name: string) => (await inbox(name)).at(-1)!
const sends = () => gateway.subscribeSend.mock.calls.map(([token, body]) => ({ token, body }))
const subscribeIds = async (name: string) => {
  const { accessToken } = await signIn(app, `wxsub-e2e-${name}`)
  const res = await request(app.getHttpServer())
    .get('/api/iam/profile/socials/wx-mp/subscribe')
    .set(bearer(accessToken))
  seen.push(res.body)
  expect(res.status).toBe(200)
  return res.body.data.templateIds as string[]
}
/** `YYYY-MM-DD HH:mm` of `date` shifted by `hours` (fixed-offset zones only) */
const wall = (date: Date, hours: number) =>
  new Date(date.getTime() + hours * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], providers: [TxCalls] })
    .overrideProvider(WxMpGateway)
    .useValue(gateway)
    .compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  params = app.get(ParamService)
  dispatcher = app.get(NotifyDispatcher)
  await cleanRedis(redis)
  for (const r of await ds.query<{ param_key: string; param_value: string }[]>(
    'SELECT param_key, param_value FROM cfg_param WHERE param_key IN (?)',
    [PARAMS],
  ))
    original.set(r.param_key, r.param_value)
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const)
    vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      seen.push(args)
    })
  for (const [code, locale, title] of [
    [CODE, 'zh-CN', ZH_TITLE],
    [CODE, 'en-US', 'To do from {initiator}'],
    [UNMAPPED, 'zh-CN', 'Unmapped {initiator}'],
  ] as const)
    await insertRow(ds.manager, 'msg_inbox_template', {
      code,
      locale,
      name: code,
      title,
      body: 'Body {initiator}',
      category: 'business',
    })
  await user('zh')
  await user('en', { locale: 'en-US', timezone: 'UTC' })
  await user('stale')
  await user('stale2')
  await user('quota')
  await user('race')
  await user('rollback')
  await user('none', {}, null)
  await user('gone', {}, { deleted_at: new Date() })
  await user('elsewhere', {}, { appid: 'wx00e2e0000000other' })
})

afterAll(async () => {
  if (ds) {
    await dispatcher.idle()
    for (const [key, value] of original) await setParam(key, value)
    const ids = [...users.values()]
    await ds.query('DELETE FROM msg_inbox WHERE template_code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM msg_inbox_template WHERE code LIKE ?', [`${PREFIX}%`])
    if (ids.length) {
      await ds.query('DELETE FROM iam_user_social WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    }
  }
  if (redis) await cleanRedis(redis)
  vi.restoreAllMocks()
  await app?.close()
})

afterEach(() => {
  gateway.subscribeSend.mockClear()
  gateway.stableToken.mockClear()
})

describe('switch off (the seeded default)', () => {
  it('the inbox delivers as before; WeChat is never called; no template ids', async () => {
    await setParam(WX_SUBSCRIBE_ENABLED_PARAM, 'false')
    await setParam(WX_SUBSCRIBE_TEMPLATES_PARAM, JSON.stringify(MAPPING))
    await notify('zh')
    expect((await lastInbox('zh')).status).toBe('delivered')
    expect(gateway.stableToken).not.toHaveBeenCalled()
    expect(gateway.subscribeSend).not.toHaveBeenCalled()
    expect(await subscribeIds('zh')).toEqual([])
  })
})

describe('switch on', () => {
  beforeAll(() => on())

  it('one send: openid, template, page and clipped values in the recipient zone and language', async () => {
    await redis.unlink(tokenKey)
    await notify('zh')
    const row = await lastInbox('zh')
    expect(row.status).toBe('delivered')
    expect(Array.from(row.title).length).toBeGreaterThan(20)
    expect(sends()).toEqual([
      {
        token: `${TOKEN}${tokenSeq}`,
        body: {
          touser: 'o-zh',
          template_id: TPL,
          page: 'pages-wf/detail/index?id=7&by=Ada%26Bo',
          data: {
            thing1: { value: Array.from(row.title).slice(0, 20).join('') },
            time2: { value: wall(row.created_at, 8) },
            name3: { value: 'Ada&BoAda&' },
          },
          miniprogram_state: 'formal',
          lang: 'zh_CN',
        },
      },
    ])
    await notify('en')
    const en = await lastInbox('en')
    expect(sends()[1]!.body).toMatchObject({
      touser: 'o-en',
      data: { thing1: { value: en.title }, time2: { value: wall(en.created_at, 0) } },
      lang: 'en_US',
    })
  })

  it('the access token is cached until 5 minutes before it expires', async () => {
    await redis.unlink(tokenKey)
    await notify('zh')
    await notify('zh')
    expect(gateway.stableToken).toHaveBeenCalledTimes(1)
    expect(sends().map((s) => s.token)).toEqual([`${TOKEN}${tokenSeq}`, `${TOKEN}${tokenSeq}`])
    expect(await redis.get(tokenKey)).toBe(`${TOKEN}${tokenSeq}`)
    const ttl = await redis.pTTL(tokenKey)
    expect(ttl).toBeGreaterThan(6_800_000)
    expect(ttl).toBeLessThanOrEqual(6_900_000)
  })

  it('a refused token: dropped, fetched again, sent once more — and only once', async () => {
    await redis.set(tokenKey, `${TOKEN}revoked`)
    answers.set('o-stale', [40001])
    await notify('stale')
    expect(gateway.stableToken).toHaveBeenCalledTimes(1)
    expect(sends().map((s) => s.token)).toEqual([`${TOKEN}revoked`, `${TOKEN}${tokenSeq}`])
    expect(await redis.get(tokenKey)).toBe(`${TOKEN}${tokenSeq}`)

    vi.mocked(Logger.prototype.warn).mockClear()
    gateway.subscribeSend.mockClear()
    answers.set('o-stale2', [42001, 40001, 40001])
    await notify('stale2')
    expect(gateway.subscribeSend).toHaveBeenCalledTimes(2)
    expect(answers.get('o-stale2')).toEqual([40001])
    expect(vi.mocked(Logger.prototype.warn).mock.calls.flat().join('\n')).toContain('errcode 40001')
  })

  it('no quota (43101): no retry, nothing warned, the inbox row stays delivered', async () => {
    vi.mocked(Logger.prototype.warn).mockClear()
    answers.set('o-quota', [43101, 0])
    await notify('quota')
    expect(gateway.subscribeSend).toHaveBeenCalledTimes(1)
    expect(answers.get('o-quota')).toEqual([0])
    expect(Logger.prototype.warn).not.toHaveBeenCalled()
    expect((await lastInbox('quota')).status).toBe('delivered')
  })

  it.each([
    ['no binding', 'none', CODE],
    ['an unbound (soft-deleted) binding', 'gone', CODE],
    ['a binding of another app', 'elsewhere', CODE],
    ['a code without a template', 'zh', UNMAPPED],
  ])('skips %s; the inbox delivers', async (_, name, template) => {
    await notify(name, template)
    expect((await lastInbox(name)).status).toBe('delivered')
    expect(gateway.subscribeSend).not.toHaveBeenCalled()
    expect(gateway.stableToken).not.toHaveBeenCalled()
  })

  it('skips a template without an id, an unconfigured app and an invalid mapping (warned once)', async () => {
    try {
      await on({ ...MAPPING, [CODE]: { ...MAPPING[CODE], id: '' } })
      await notify('zh')
      gateway.appid.mockReturnValue(null)
      await on()
      await notify('zh')
      gateway.appid.mockReturnValue(APPID)
      vi.mocked(Logger.prototype.warn).mockClear()
      for (const bad of ['{"broken', JSON.stringify({ [CODE]: { id: 'bad id!', data: {} } })]) {
        await setParam(WX_SUBSCRIBE_TEMPLATES_PARAM, bad)
        await notify('zh')
        await notify('zh')
      }
      expect(gateway.subscribeSend).not.toHaveBeenCalled()
      expect(gateway.stableToken).not.toHaveBeenCalled()
      expect((await inbox('zh')).slice(-6).map((r) => r.status)).toEqual(Array(6).fill('delivered'))
      const warned = vi.mocked(Logger.prototype.warn).mock.calls.flat().join('\n')
      expect(warned.split(WX_SUBSCRIBE_TEMPLATES_PARAM).length - 1).toBe(2)
    } finally {
      gateway.appid.mockReturnValue(APPID)
      await on()
    }
  })

  it('a rolled-back send writes no inbox row and calls no WeChat', async () => {
    await expect(
      app.get(TxCalls).fails({
        template: CODE,
        to: [users.get('rollback')!],
        params: { instanceId: 7 },
        channels: ['inbox'],
      }),
    ).rejects.toThrow('rollback')
    await dispatcher.idle()
    expect(await inbox('rollback')).toEqual([])
    expect(gateway.subscribeSend).not.toHaveBeenCalled()
  })

  it('a delivery whose claim was taken over does not send (the new claimer will)', async () => {
    const query = ds.query.bind(ds)
    const spy = vi.spyOn(ds, 'query').mockImplementation((async (sql: string, args?: unknown[]) => {
      if (sql.startsWith("UPDATE msg_inbox SET status = 'delivered'"))
        await query('UPDATE msg_inbox SET claimed_at = ? WHERE id = ?', [new Date(0), args![0]])
      return query(sql, args)
    }) as never)
    try {
      await notify('race')
    } finally {
      spy.mockRestore()
    }
    expect((await lastInbox('race')).status).toBe('sending')
    expect(gateway.subscribeSend).not.toHaveBeenCalled()
  })

  it('GET …/wx-mp/subscribe: 401 signed out; the distinct ids when bound; none when not', async () => {
    const res = await request(app.getHttpServer()).get('/api/iam/profile/socials/wx-mp/subscribe')
    expect(res.status).toBe(401)
    expect(await subscribeIds('zh')).toEqual([TPL, 'tpl-other-e2e'])
    expect(await subscribeIds('none')).toEqual([])
    expect(await subscribeIds('gone')).toEqual([])
    expect(await subscribeIds('elsewhere')).toEqual([])
  })
})

describe('the real gateway (https.request stubbed)', () => {
  const cfg = {
    get: (key: string) =>
      ({ WX_MP_APPID: APPID, WX_MP_SECRET: SECRET, ALLOW_PRIVATE_ENDPOINTS: false })[key],
  } as unknown as AppConfigService
  /** Answers every request with `status` + `answer`; returns what was sent. */
  function stubHttps(answer: string, status = 200) {
    const sent: { path: string; method: string; body: string }[] = []
    const spy = vi.spyOn(https, 'request').mockImplementation(((
      opts: https.RequestOptions,
      cb: (res: PassThrough & { statusCode: number }) => void,
    ) => {
      const req = new PassThrough()
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString()))
      req.on('finish', () => {
        sent.push({ path: String(opts.path), method: String(opts.method), body })
        const res = Object.assign(new PassThrough(), { statusCode: status })
        cb(res)
        res.end(answer)
      })
      return req
    }) as never)
    return { sent, spy }
  }

  it('stable_token: the secret only in the POST body; send: the token only in the URL', async () => {
    const real = new WxMpGateway(cfg)
    let { sent, spy } = stubHttps(`{"access_token":"${TOKEN}real","expires_in":7200}`)
    try {
      expect(await real.stableToken()).toEqual({ token: `${TOKEN}real`, expiresIn: 7200 })
    } finally {
      spy.mockRestore()
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ path: '/cgi-bin/stable_token', method: 'POST' })
    expect(sent[0]!.path).not.toContain(SECRET)
    expect(JSON.parse(sent[0]!.body)).toEqual({
      grant_type: 'client_credential',
      appid: APPID,
      secret: SECRET,
      force_refresh: false,
    })

    const body: WxSubscribeSend = {
      touser: 'o-x',
      template_id: TPL,
      data: { thing1: { value: 'x' } },
      miniprogram_state: 'formal',
      lang: 'zh_CN',
    }
    ;({ sent, spy } = stubHttps('{"errcode":43101,"errmsg":"user refuse to accept the msg"}'))
    try {
      expect(await real.subscribeSend(`${TOKEN}real`, body)).toBe(43101)
    } finally {
      spy.mockRestore()
    }
    expect(sent).toEqual([
      {
        path: `/cgi-bin/message/subscribe/send?access_token=${TOKEN}real`,
        method: 'POST',
        body: JSON.stringify(body),
      },
    ])
  })

  it('a failed exchange rejects with a bare error: no URL, secret or token in it', async () => {
    const real = new WxMpGateway(cfg)
    const { spy } = stubHttps('{"errcode":-1}', 502)
    try {
      for (const call of [
        () => real.stableToken(),
        () => real.subscribeSend(`${TOKEN}x`, {} as never),
      ]) {
        const error = await call().catch((e: unknown) => e)
        expect(error).toBeInstanceOf(Error)
        expect(String((error as Error).message)).toBe('wx upstream')
        expect(JSON.stringify(error)).not.toMatch(new RegExp(`${SECRET}|${TOKEN}`))
      }
      // code2Session (sign-in) shares the exchange: still its own 502 code
      await expect(real.code2Session('c-1')).rejects.toMatchObject({
        err: Err.AUTH_WX_MP_UPSTREAM,
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('code2Session still GETs jscode2session (the exchange shared with the new calls)', async () => {
    const { sent, spy } = stubHttps('{"openid":"o-1","session_key":"k"}')
    try {
      expect(await new WxMpGateway(cfg).code2Session('c-1')).toEqual({
        openid: 'o-1',
        unionid: null,
      })
    } finally {
      spy.mockRestore()
    }
    expect(sent).toEqual([
      {
        path: `/sns/jscode2session?appid=${APPID}&secret=${SECRET}&js_code=c-1&grant_type=authorization_code`,
        method: 'GET',
        body: '',
      },
    ])
  })

  it('parses the answers without echoing them', () => {
    expect(parseStableToken('{"access_token":"A-1_b","expires_in":7200}')).toEqual({
      token: 'A-1_b',
      expiresIn: 7200,
    })
    expect(parseStableToken('{"access_token":"A-2"}')).toEqual({ token: 'A-2', expiresIn: 7200 })
    for (const bad of [
      '{"errcode":40013,"errmsg":"invalid appid"}',
      '{"errcode":40001,"access_token":"A-3"}',
      '{"expires_in":7200}',
      '{"access_token":"has space","expires_in":7200}',
      'not json',
      'null',
    ])
      expect(() => parseStableToken(bad)).toThrow(/^wx token$/)
    expect(parseSendErrcode('{"errcode":0,"errmsg":"ok"}')).toBe(0)
    expect(parseSendErrcode('{"errcode":43101}')).toBe(43101)
    expect(parseSendErrcode('<html>')).toBe(-1)
    expect(parseSendErrcode('{"errmsg":"no code"}')).toBe(-1)
  })
})

it('no log line and no response of this spec carries the secret or a token', () => {
  expect(seen.length).toBeGreaterThan(0)
  const text = JSON.stringify(seen)
  expect(text).not.toContain(SECRET)
  expect(text).not.toContain(TOKEN)
})
