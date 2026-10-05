// core/guard @Idempotent (see docs/design-notes.md#security): the same submission (session + method + URL + canonical body)
// within ttl → 429 too_many_requests, translated; other bodies, sessions or URLs pass; the key expires
// after ttl and a failed request releases it.
import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { Public } from '../../src/core/auth/decorators.js'
import { canonicalJson, Idempotent } from '../../src/core/guard/idempotent.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { agentFor } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

let calls = 0
/** `X-Stall: 1` holds `/slow` until the test calls this, then it fails */
let unstall: () => void = () => undefined

@Controller('idem-probe')
class IdemProbeController {
  @Post('orders')
  @HttpCode(200)
  @Idempotent()
  order(@Body() body: unknown) {
    calls++
    return body
  }

  @Post('short')
  @HttpCode(200)
  // long enough that the second request lands inside it under load; the spec ends it early
  @Idempotent({ ttl: 2000 })
  short() {
    calls++
    return calls
  }

  @Post('reject')
  @HttpCode(200)
  @Idempotent()
  reject() {
    calls++
    throw new BizError(Err.UNPROCESSABLE)
  }

  @Post('slow')
  @HttpCode(200)
  @Idempotent({ ttl: 2000 })
  async slow(@Headers('x-stall') stall?: string) {
    calls++
    if (!stall) return calls
    await new Promise<void>((r) => (unstall = r))
    throw new BizError(Err.UNPROCESSABLE)
  }

  @Public()
  @Post('public')
  @HttpCode(200)
  @Idempotent()
  open() {
    calls++
    return calls
  }

  @Post('free')
  @HttpCode(200)
  free() {
    calls++
    return calls
  }
}

let app: NestExpressApplication
let redis: Redis
let agent: Awaited<ReturnType<typeof agentFor>>

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [IdemProbeController],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  redis = app.get(REDIS)
  await cleanRedis(redis)
  agent = await agentFor(app)
})

afterAll(async () => {
  if (redis) await cleanRedis(redis)
  await app?.close()
})

beforeEach(() => {
  calls = 0
})

const idemKeys = async () => {
  const keys: string[] = []
  for await (const batch of redis.scanIterator({ MATCH: keyPattern('idem') })) keys.push(...batch)
  return keys
}
/** Ends the ttl of every idempotency key now, instead of sleeping it out. */
async function expireIdemKeys() {
  const keys = await idemKeys()
  for (const key of keys) await redis.pExpire(key, 1)
  await vi.waitFor(async () => expect(keys.length && (await redis.exists(keys))).toBe(0), {
    timeout: 5000,
  })
}

it('canonical JSON sorts object keys at every level, keeps array order', () => {
  expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
    '{"a":{"c":null,"d":[2,1]},"b":1}',
  )
  expect(canonicalJson(undefined)).toBe('null')
})

it('the same body again within ttl → 429 TOO_MANY_REQUESTS; the handler ran once', async () => {
  await agent.post('/api/idem-probe/orders').send({ sku: 'a1', qty: 2 }).expect(200)
  const res = await agent.post('/api/idem-probe/orders').send({ qty: 2, sku: 'a1' })
  expect(res.status).toBe(429)
  expect(res.body).toMatchObject({
    code: Err.TOO_MANY_REQUESTS.code,
    msg: '请求过于频繁，请稍后再试',
    data: null,
  })
  expect(calls).toBe(1)
  const en = await agent.post('/api/idem-probe/orders?lang=en-US').send({ sku: 'en' })
  expect(en.status).toBe(200)
  const again = await agent.post('/api/idem-probe/orders?lang=en-US').send({ sku: 'en' })
  expect(again.body.msg).toBe('Too many requests. Please try again later')
})

it('another body, URL or session is no duplicate; unguarded routes never answer 429', async () => {
  await agent.post('/api/idem-probe/orders').send({ sku: 'b1' }).expect(200)
  await agent.post('/api/idem-probe/orders').send({ sku: 'b2' }).expect(200)
  await agent.post('/api/idem-probe/orders?draft=1').send({ sku: 'b1' }).expect(200)
  const other = await agentFor(app)
  await other.post('/api/idem-probe/orders').send({ sku: 'b1' }).expect(200)
  await agent.post('/api/idem-probe/free').expect(200)
  await agent.post('/api/idem-probe/free').expect(200)
  expect(calls).toBe(6)
})

it('keys are qw:idem:{sid}:{sha256(method url body)} with the ttl as PX; the url never leaks into the key', async () => {
  const old = await idemKeys()
  if (old.length) await redis.unlink(old)
  await agent
    .post('/api/idem-probe/orders?accessToken=s3cr3t-in-query')
    .send({ sku: 'k' })
    .expect(200)
  const [key, ...rest] = await idemKeys()
  expect(rest).toEqual([])
  expect(key).toMatch(/^qw:idem:[\w-]{36}:[0-9a-f]{64}$/)
  expect(key).not.toContain('s3cr3t')
  const ttl = await redis.pTTL(key!)
  expect(ttl).toBeGreaterThan(2000)
  expect(ttl).toBeLessThanOrEqual(3000)
})

it('passes again once the ttl is over', async () => {
  await agent.post('/api/idem-probe/short').expect(200)
  await agent.post('/api/idem-probe/short').expect(429)
  await expireIdemKeys()
  await agent.post('/api/idem-probe/short').expect(200)
  expect(calls).toBe(2)
})

it('a failed request releases its key: the retry reaches the handler', async () => {
  await agent.post('/api/idem-probe/reject').send({ n: 1 }).expect(422)
  await agent.post('/api/idem-probe/reject').send({ n: 1 }).expect(422)
  expect(calls).toBe(2)
})

it('a request failing after its ttl leaves the key a later request took alone', async () => {
  // the first request outlives its ttl; a second one takes the free key and succeeds
  const first = agent
    .post('/api/idem-probe/slow')
    .set('X-Stall', '1')
    .then((r) => r)
  await vi.waitFor(() => expect(calls).toBe(1), { timeout: 5000 })
  await expireIdemKeys()
  await agent.post('/api/idem-probe/slow').expect(200)
  // the first one fails now: releasing must not delete the second one's key
  unstall()
  expect((await first).status).toBe(422)
  await agent.post('/api/idem-probe/slow').expect(429)
  expect(calls).toBe(2)
})

it('callers without a session are keyed by IP', async () => {
  const http = () => request(app.getHttpServer())
  await http().post('/api/idem-probe/public').send({ x: 1 }).expect(200)
  await http().post('/api/idem-probe/public').send({ x: 1 }).expect(429)
  expect((await idemKeys()).some((k) => k.includes(':ip-'))).toBe(true)
})
