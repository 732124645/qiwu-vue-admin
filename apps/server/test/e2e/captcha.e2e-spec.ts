import { createHash } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  CAPTCHA_IMAGE_TYPE_PARAM,
  CAPTCHA_MODE_PARAM,
  Err,
  IP_BLACKLIST_PARAM,
  captchaChallengeVo,
  captchaTicketVo,
} from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import sharp from 'sharp'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AuthParams } from '../../src/core/auth/auth-params.js'
import {
  CAPTCHA_CHAR_ALPHABET,
  CAPTCHA_GLYPHS,
  makeMathChallenge,
  renderCaptchaSvg,
} from '../../src/core/captcha/captcha-image.js'
import { CaptchaTicketVerifier } from '../../src/core/captcha/captcha-ticket.js'
import { CaptchaService } from '../../src/core/captcha/captcha.service.js'
import { redisKey, keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { cleanRedis } from '../setup/redis.js'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
let verifier: CaptchaTicketVerifier
let service: CaptchaService
let authParams: AuthParams
let ipSeq = 0
let userSeq = 0
const userIds: number[] = []
const PREFIX = 'captcha-e2e-'
const PASSWORD = 'Captcha-e2e#2026'
const nextIp = () => {
  const n = ipSeq++ % 62_500
  return `198.18.${Math.floor(n / 250)}.${(n % 250) + 1}`
}
const http = () => request(app.getHttpServer())
const get = (ip: string, scene = 'signin') =>
  http().get('/api/auth/captcha').query({ scene }).set('X-Forwarded-For', ip)
const check = (ip: string, id: string, answer: unknown) =>
  http().post('/api/auth/captcha/check').set('X-Forwarded-For', ip).send({ id, answer })
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await params.invalidate(key)
}
const challenge = async (ip = nextIp(), scene = 'signin') => {
  const res = await get(ip, scene).expect(200)
  const data = captchaChallengeVo.parse(res.body.data)
  if (data.kind !== 'image') throw new Error('Expected image challenge')
  const stored = JSON.parse((await redis.get(redisKey('captcha', data.id)))!) as {
    scene: string
    kind: string
    answer: string
  }
  return { data, stored, ip }
}
const slider = async (ip = nextIp(), scene = 'signin') => {
  const res = await get(ip, scene).expect(200)
  const data = captchaChallengeVo.parse(res.body.data)
  if (data.kind !== 'slider') throw new Error('Expected slider challenge')
  const stored = JSON.parse((await redis.get(redisKey('captcha', data.id)))!) as {
    scene: string
    kind: string
    answer: { x: number; y: number }
  }
  return { data, stored, ip }
}
const ticketKey = (ticket: string) =>
  redisKey('captcha', 'ticket', createHash('sha256').update(ticket).digest('hex'))
const signin = (username: string, ip = nextIp(), password = PASSWORD, captchaTicket?: string) =>
  http()
    .post('/api/auth/login')
    .set('X-Forwarded-For', ip)
    .send({ username, password, ...(captchaTicket ? { captchaTicket } : {}) })
const solvedTicket = async (ip: string, scene = 'signin') => {
  const { data, stored } = await challenge(ip, scene)
  const res = await check(ip, data.id, stored.answer).expect(200)
  return captchaTicketVo.parse(res.body.data).captchaTicket
}
const user = async () => {
  const username = `${PREFIX}${++userSeq}`
  userIds.push(
    await insertRow(ds.manager, 'iam_user', {
      username,
      display_name: username,
      password_hash: bcrypt.hashSync(PASSWORD, 4),
      password_changed_at: new Date(),
    }),
  )
  return username
}
const failCount = async (...parts: string[]) =>
  Number(await redis.get(redisKey('authFail', ...parts)))

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get<Redis>(REDIS)
  params = app.get(ParamService)
  verifier = app.get(CaptchaTicketVerifier)
  service = app.get(CaptchaService)
  authParams = app.get(AuthParams)
  await cleanRedis(redis)
  await setParam(CAPTCHA_MODE_PARAM, 'image')
  await setParam(CAPTCHA_IMAGE_TYPE_PARAM, 'math')
})

afterAll(async () => {
  if (params) {
    await setParam(CAPTCHA_MODE_PARAM, 'off')
    await setParam(CAPTCHA_IMAGE_TYPE_PARAM, 'math')
  }
  if (ds) {
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [`${PREFIX}%`])
    if (userIds.length) await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('image', () => {
  it('serves a rasterizable SVG without text or active content, and validates scene', async () => {
    const { data } = await challenge()
    expect(data.id).toMatch(/^[\w-]{16,64}$/)
    expect(data.image).toMatch(/^data:image\/svg\+xml;base64,/)
    const svg = Buffer.from(data.image.split(',')[1]!, 'base64')
    expect(svg.toString()).not.toMatch(/<text|<script|transform|href/i)
    expect(await sharp(svg).metadata()).toMatchObject({ width: 130, height: 48 })
    expect((await sharp(svg).png().toBuffer()).length).toBeGreaterThan(100)
    expect(await redis.ttl(redisKey('captcha', data.id))).toBeGreaterThan(0)
    expect(await redis.ttl(redisKey('captcha', data.id))).toBeLessThanOrEqual(120)
    expect((await get(nextIp(), 'invalid').expect(400)).body.code).toBe(Err.VALIDATION_FAILED.code)
    await setParam(CAPTCHA_MODE_PARAM, 'off')
    try {
      expect((await challenge()).data.kind).toBe('image')
    } finally {
      await setParam(CAPTCHA_MODE_PARAM, 'image')
    }
  })

  it('format=png (mobile): the same kind of challenge as a 2x PNG, solved the same way; another format is a 400', async () => {
    const png = (ip: string, format: string) =>
      http().get('/api/auth/captcha').query({ scene: 'signin', format }).set('X-Forwarded-For', ip)
    const ip = nextIp()
    const data = captchaChallengeVo.parse((await png(ip, 'png').expect(200)).body.data)
    if (data.kind !== 'image') throw new Error('Expected image challenge')
    expect(data.image).toMatch(/^data:image\/png;base64,/)
    const image = Buffer.from(data.image.split(',')[1]!, 'base64')
    expect(await sharp(image).metadata()).toMatchObject({ format: 'png', width: 260, height: 96 })
    const stored = JSON.parse((await redis.get(redisKey('captcha', data.id)))!) as {
      answer: string
    }
    expect((await check(ip, data.id, stored.answer).expect(200)).body.data).toHaveProperty(
      'captchaTicket',
    )
    const svg = captchaChallengeVo.parse((await png(nextIp(), 'svg').expect(200)).body.data)
    expect(svg.image).toMatch(/^data:image\/svg\+xml;base64,/)
    const bad = await png(nextIp(), 'gif')
    expect(bad.status).toBe(400)
    expect(bad.body.code).toBe(Err.VALIDATION_FAILED.code)
  })

  it('makes one-digit math and switches to four unambiguous characters', async () => {
    expect((await challenge()).stored.answer).toMatch(/^\d+$/)
    for (let i = 0; i < 300; i++) {
      const { text, answer } = makeMathChallenge()
      expect(text).toMatch(/^[1-9] [+−×] [1-9] = \?$/)
      expect(Number(answer)).toBeGreaterThanOrEqual(0)
    }
    await setParam(CAPTCHA_IMAGE_TYPE_PARAM, 'chars')
    try {
      const { data, stored, ip } = await challenge()
      expect(stored.answer).toMatch(new RegExp(`^[${CAPTCHA_CHAR_ALPHABET}]{4}$`))
      expect(
        (await check(ip, data.id, ` ${stored.answer.toLowerCase()} `).expect(200)).body.data,
      ).toHaveProperty('captchaTicket')
    } finally {
      await setParam(CAPTCHA_IMAGE_TYPE_PARAM, 'math')
    }
  })

  it('falls back to protected mode and math for unknown parameter values', async () => {
    await setParam(CAPTCHA_MODE_PARAM, ' ')
    await setParam(CAPTCHA_IMAGE_TYPE_PARAM, 'unknown')
    try {
      expect(await service.mode()).toBe('slider')
      expect(captchaChallengeVo.parse((await get(nextIp()).expect(200)).body.data).kind).toBe(
        'slider',
      )
    } finally {
      await setParam(CAPTCHA_MODE_PARAM, 'image')
      await setParam(CAPTCHA_IMAGE_TYPE_PARAM, 'math')
    }
  })

  it('issues a hashed, scene/IP-bound ticket and consumes the solved challenge', async () => {
    const { data, stored, ip } = await challenge(nextIp(), 'signup')
    const res = await check(ip, data.id, stored.answer).expect(200)
    const { captchaTicket } = captchaTicketVo.parse(res.body.data)
    const key = ticketKey(captchaTicket)
    expect(JSON.parse((await redis.get(key))!)).toEqual({ scene: 'signup', ip })
    expect(await redis.ttl(key)).toBeGreaterThan(0)
    expect(await redis.ttl(key)).toBeLessThanOrEqual(120)
    expect(await redis.get(redisKey('captcha', data.id))).toBeNull()
    for await (const keys of redis.scanIterator({ MATCH: keyPattern('captcha') })) {
      for (const candidate of keys) {
        expect(candidate).not.toContain(captchaTicket)
        expect(await redis.get(candidate)).not.toContain(captchaTicket)
      }
    }
    expect(await verifier.verify('signup', ip, captchaTicket)).toBe(true)
    expect(await verifier.verify('signup', ip, captchaTicket)).toBe(false)
    expect((await check(ip, data.id, stored.answer).expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
  })

  it('consumes a wrong answer before a retry and rejects wrong shapes', async () => {
    const { data, stored, ip } = await challenge()
    expect((await check(ip, data.id, 'WRONG').expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
    expect((await check(ip, data.id, stored.answer).expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
    const other = await challenge()
    expect((await check(other.ip, other.data.id, { x: 1, y: 1 }).expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
    expect(await redis.get(redisKey('captcha', other.data.id))).toBeNull()
  })

  it('rejects unknown, expired and malformed challenges', async () => {
    const ip = nextIp()
    expect((await check(ip, 'a'.repeat(24), '1').expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
    const { data, stored } = await challenge(ip)
    await redis.pExpire(redisKey('captcha', data.id), 1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect((await check(ip, data.id, stored.answer).expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
    expect((await check(ip, 'short', '').expect(400)).body.code).toBe(Err.VALIDATION_FAILED.code)
  })

  it('consumes tickets on scene/IP mismatch, and rejects blanks and expiry', async () => {
    const sceneIp = nextIp()
    const sceneTicket = await verifier.issue('signin', sceneIp)
    expect(await verifier.verify('signup', sceneIp, sceneTicket)).toBe(false)
    expect(await verifier.verify('signin', sceneIp, sceneTicket)).toBe(false)
    const ip = nextIp()
    const ipTicket = await verifier.issue('signin', ip)
    expect(await verifier.verify('signin', nextIp(), ipTicket)).toBe(false)
    expect(await verifier.verify('signin', ip, ipTicket)).toBe(false)
    expect(await verifier.verify('signin', ip, '')).toBe(false)
    expect(await verifier.verify('signin', ip, undefined)).toBe(false)
    const expired = await verifier.issue('signin', ip)
    await redis.pExpire(ticketKey(expired), 1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(await verifier.verify('signin', ip, expired)).toBe(false)
    const malformed = await verifier.issue('signin', ip)
    await redis.set(ticketKey(malformed), '{broken', { EX: 120 })
    expect(await verifier.verify('signin', ip, malformed)).toBe(false)
  })

  it('limits the 31st GET from one IP', async () => {
    const ip = nextIp()
    for (let i = 0; i < 30; i++) await get(ip).expect(200)
    expect((await get(ip).expect(429)).body.code).toBe(Err.TOO_MANY_REQUESTS.code)
  })

  it('draws every glyph and varies geometry for the same text', () => {
    for (const char of '0123456789ACEFHKMNPRTWXY+−×=?') {
      expect(CAPTCHA_GLYPHS).toContain(char)
      expect(renderCaptchaSvg(char)).toContain('<path')
    }
    const paths = (svg: string) => [...svg.matchAll(/<path d="([^"]+)/g)].map((m) => m[1])
    expect(paths(renderCaptchaSvg('A2+?'))).not.toEqual(paths(renderCaptchaSvg('A2+?')))
    for (const text of ['A2+?', '9 − 3 = ?']) {
      const glyphPaths = paths(renderCaptchaSvg(text, () => 0.5)).filter(
        (path) => !/[Ql]/.test(path!),
      )
      expect(glyphPaths.length).toBeGreaterThan(0)
      const points = glyphPaths.flatMap((path) =>
        [...path!.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => [+x!, +y!]),
      )
      const xs = points.map(([x]) => x!)
      const ys = points.map(([, y]) => y!)
      // spread over the width, never touching (clipped by) an edge
      expect(Math.min(...xs)).toBeGreaterThan(3)
      expect(Math.max(...xs)).toBeLessThan(127)
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(90)
      expect(Math.min(...ys)).toBeGreaterThan(3)
      expect(Math.max(...ys)).toBeLessThan(45)
    }
  })
})

describe('slider', () => {
  beforeAll(async () => setParam(CAPTCHA_MODE_PARAM, 'slider'))
  afterAll(async () => setParam(CAPTCHA_MODE_PARAM, 'image'))

  it('serves a masked piece over its darkened hole without exposing the answer', async () => {
    const { data, stored } = await slider(nextIp(), 'signup')
    expect(stored).toMatchObject({ scene: 'signup', kind: 'slider' })
    expect(data).not.toHaveProperty('answer')
    expect(data.thumbX).toBe(0)
    expect(data.thumbY).toBe(stored.answer.y)
    expect(data.image).toMatch(/^data:image\/jpeg;base64,/)
    expect(data.thumb).toMatch(/^data:image\/png;base64,/)
    const image = Buffer.from(data.image.split(',')[1]!, 'base64')
    const thumb = Buffer.from(data.thumb.split(',')[1]!, 'base64')
    expect(await sharp(image).metadata()).toMatchObject({ width: 300, height: 220 })
    expect(await sharp(thumb).metadata()).toMatchObject({
      format: 'png',
      width: data.thumbWidth,
      height: data.thumbHeight,
      hasAlpha: true,
    })
    const thumbPixels = await sharp(thumb).ensureAlpha().raw().toBuffer()
    expect(thumbPixels[3]).toBe(0)
    // mean brightness of the image under the piece's opaque pixels, the piece box moved by dx
    const brightness = async (dx: number) => {
      const px = await sharp(image)
        .extract({
          left: stored.answer.x + dx,
          top: stored.answer.y,
          width: data.thumbWidth,
          height: data.thumbHeight,
        })
        .ensureAlpha()
        .raw()
        .toBuffer()
      let sum = 0
      let count = 0
      for (let i = 0; i < px.length; i += 4)
        if (thumbPixels[i + 3]! >= 240) {
          sum += px[i]! + px[i + 1]! + px[i + 2]!
          count++
        }
      expect(count).toBeGreaterThan(1000)
      return sum / (3 * count)
    }
    // the darkened hole sits exactly at the answer: 10 px to either side is brighter
    // (1000 samples: the smaller margin was never under 7)
    const [left, exact, right] = [await brightness(-10), await brightness(0), await brightness(10)]
    expect(left - exact).toBeGreaterThan(3)
    expect(right - exact).toBeGreaterThan(3)
    expect(await redis.ttl(redisKey('captcha', data.id))).toBeGreaterThan(0)
    expect(await redis.ttl(redisKey('captcha', data.id))).toBeLessThanOrEqual(120)
  })

  it('accepts exact and both 5 px edges, issuing the same scene/IP-bound ticket', async () => {
    for (const [dx, dy] of [
      [0, 0],
      [5, 0],
      [-5, 0],
      [0, 5],
    ]) {
      const { data, stored, ip } = await slider(nextIp(), 'signup')
      const answer = { x: stored.answer.x + dx!, y: stored.answer.y + dy! }
      const res = await check(ip, data.id, answer).expect(200)
      const { captchaTicket } = captchaTicketVo.parse(res.body.data)
      expect(JSON.parse((await redis.get(ticketKey(captchaTicket)))!)).toEqual({
        scene: 'signup',
        ip,
      })
      expect(await redis.get(redisKey('captcha', data.id))).toBeNull()
      expect((await check(ip, data.id, stored.answer).expect(400)).body.code).toBe(
        Err.AUTH_CAPTCHA_INVALID.code,
      )
    }
  })

  it('rejects x and y beyond 5 px and consumes each wrong attempt', async () => {
    for (const [dx, dy] of [
      [6, 0],
      [-6, 0],
      [0, 6],
    ]) {
      const { data, stored, ip } = await slider()
      expect(
        (
          await check(ip, data.id, { x: stored.answer.x + dx!, y: stored.answer.y + dy! }).expect(
            400,
          )
        ).body.code,
      ).toBe(Err.AUTH_CAPTCHA_INVALID.code)
      expect((await check(ip, data.id, stored.answer).expect(400)).body.code).toBe(
        Err.AUTH_CAPTCHA_INVALID.code,
      )
    }
  })

  it('rejects expired challenges and string answers', async () => {
    const expired = await slider()
    await redis.pExpire(redisKey('captcha', expired.data.id), 1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(
      (await check(expired.ip, expired.data.id, expired.stored.answer).expect(400)).body.code,
    ).toBe(Err.AUTH_CAPTCHA_INVALID.code)
    const wrongType = await slider()
    expect((await check(wrongType.ip, wrongType.data.id, '123').expect(400)).body.code).toBe(
      Err.AUTH_CAPTCHA_INVALID.code,
    )
    await setParam(CAPTCHA_MODE_PARAM, 'image')
    try {
      const image = await challenge()
      expect((await check(image.ip, image.data.id, { x: 1, y: 1 }).expect(400)).body.code).toBe(
        Err.AUTH_CAPTCHA_INVALID.code,
      )
    } finally {
      await setParam(CAPTCHA_MODE_PARAM, 'slider')
    }
  })

  it('lets a slider ticket satisfy sign-in from the same IP', async () => {
    const username = await user()
    const ip = nextIp()
    expect((await signin(username, ip).expect(403)).body.code).toBe(Err.AUTH_CAPTCHA_REQUIRED.code)
    const { data, stored } = await slider(ip)
    const checked = await check(ip, data.id, stored.answer).expect(200)
    const ticket = captchaTicketVo.parse(checked.body.data).captchaTicket
    await signin(username, ip, PASSWORD, ticket).expect(200)
  })
})

describe('signin', () => {
  it('requires a scene/IP-bound single-use ticket and does not count captcha refusals', async () => {
    const username = await user()
    const unknown = `${PREFIX}missing`
    const ip = nextIp()
    const counters = async () => [
      await failCount('p', username, ip),
      await failCount('u', username),
      await failCount('ip', ip),
    ]
    const before = await counters()
    const known = await signin(username, ip).expect(403)
    const missing = await signin(unknown, nextIp()).expect(403)
    const publicBody = (res: request.Response) => {
      const { traceId: _traceId, ...body } = res.body
      return body
    }
    expect(known.body.code).toBe(Err.AUTH_CAPTCHA_REQUIRED.code)
    expect(publicBody(known)).toEqual(publicBody(missing))
    expect(await counters()).toEqual(before)
    await vi.waitFor(
      async () => {
        const [row] = await ds.query<
          { kind: string; ok: number; user_id: number; msg_key: string }[]
        >(
          'SELECT kind, ok, user_id, msg_key FROM aud_signin_log WHERE username = ? AND msg_key = ? ORDER BY id DESC LIMIT 1',
          [username, 'signin.captcha_required'],
        )
        expect(row).toMatchObject({
          kind: 'password',
          ok: 0,
          user_id: userIds.at(-1),
          msg_key: 'signin.captcha_required',
        })
      },
      { timeout: 5000 },
    )

    const valid = await solvedTicket(ip)
    await signin(username, ip, PASSWORD, valid).expect(200)
    expect((await signin(username, ip, PASSWORD, valid).expect(403)).body.code).toBe(
      Err.AUTH_CAPTCHA_REQUIRED.code,
    )
    for (const scene of ['signup', 'sms_send']) {
      const ticket = await solvedTicket(ip, scene)
      expect((await signin(username, ip, PASSWORD, ticket).expect(403)).body.code).toBe(
        Err.AUTH_CAPTCHA_REQUIRED.code,
      )
      expect(await redis.get(ticketKey(ticket))).toBeNull()
    }
    const otherIp = nextIp()
    const otherTicket = await solvedTicket(otherIp)
    expect((await signin(username, ip, PASSWORD, otherTicket).expect(403)).body.code).toBe(
      Err.AUTH_CAPTCHA_REQUIRED.code,
    )
    expect(await redis.get(ticketKey(otherTicket))).toBeNull()

    const wrongTicket = await solvedTicket(ip)
    expect((await signin(username, ip, 'Wrong#pass1', wrongTicket).expect(401)).body.code).toBe(
      Err.AUTH_BAD_CREDENTIALS.code,
    )
    expect((await signin(username, ip, PASSWORD, wrongTicket).expect(403)).body.code).toBe(
      Err.AUTH_CAPTCHA_REQUIRED.code,
    )
  })

  it('checks the ticket before the IP blacklist', async () => {
    const username = await user()
    const ip = nextIp()
    const [{ param_value: previous }] = await ds.query<{ param_value: string }[]>(
      'SELECT param_value FROM cfg_param WHERE param_key = ?',
      [IP_BLACKLIST_PARAM],
    )
    await setParam(IP_BLACKLIST_PARAM, ip)
    try {
      expect((await signin(username, ip).expect(403)).body.code).toBe(
        Err.AUTH_CAPTCHA_REQUIRED.code,
      )
      const ticket = await solvedTicket(ip)
      expect((await signin(username, ip, PASSWORD, ticket).expect(403)).body.code).toBe(
        Err.AUTH_IP_BLOCKED.code,
      )
    } finally {
      await setParam(IP_BLACKLIST_PARAM, previous)
    }
  })

  it('allows ticketless sign-in below the threshold when mode is off and ignores a supplied ticket', async () => {
    const username = await user()
    const ip = nextIp()
    const ticket = await solvedTicket(ip)
    await setParam(CAPTCHA_MODE_PARAM, 'off')
    try {
      await signin(username, ip).expect(200)
      await signin(username, ip, PASSWORD, ticket).expect(200)
      expect(await redis.get(ticketKey(ticket))).not.toBeNull()
    } finally {
      await setParam(CAPTCHA_MODE_PARAM, 'image')
    }
  })

  it('escalates cross-IP failures even with mode off, shares known-user spelling, and clears on success', async () => {
    const username = await user()
    const unrelated = await user()
    const threshold = (await authParams.load()).security.crossIpThreshold
    await setParam(CAPTCHA_MODE_PARAM, 'off')
    try {
      for (let i = 0; i < threshold; i++) {
        expect((await signin(username, nextIp(), 'Wrong#pass1').expect(401)).body.code).toBe(
          Err.AUTH_BAD_CREDENTIALS.code,
        )
      }
      expect(await failCount('u', username)).toBe(threshold)
      const ip = nextIp()
      expect((await signin(username, ip).expect(403)).body.code).toBe(
        Err.AUTH_CAPTCHA_REQUIRED.code,
      )
      expect((await signin(username.toUpperCase(), nextIp()).expect(403)).body.code).toBe(
        Err.AUTH_CAPTCHA_REQUIRED.code,
      )
      await signin(unrelated, nextIp()).expect(200)
      await signin(username, ip, PASSWORD, await solvedTicket(ip)).expect(200)
      expect(await failCount('u', username)).toBe(0)
      await signin(username, nextIp()).expect(200)
    } finally {
      await setParam(CAPTCHA_MODE_PARAM, 'image')
    }
  })

  it('escalates an unknown username without revealing whether the account exists', async () => {
    const username = `${PREFIX}unknown`
    const threshold = (await authParams.load()).security.crossIpThreshold
    await setParam(CAPTCHA_MODE_PARAM, 'off')
    try {
      for (let i = 0; i < threshold; i++) {
        expect((await signin(username, nextIp(), 'Wrong#pass1').expect(401)).body.code).toBe(
          Err.AUTH_BAD_CREDENTIALS.code,
        )
      }
      expect(await failCount('u', username)).toBe(threshold)
      expect((await signin(username, nextIp()).expect(403)).body.code).toBe(
        Err.AUTH_CAPTCHA_REQUIRED.code,
      )
    } finally {
      await setParam(CAPTCHA_MODE_PARAM, 'image')
    }
  }, 20_000)
})
