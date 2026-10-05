// platform/geo: the division tree for any signed-in user, IP → location (`geo.area.browse`;
// 403 without it, 400 on a bad address), and the location that sign-in logs, action logs and the online
// session list carry. Passes with or without apps/server/data/ip2region_v4.xdb: without it every
// location is unknown (one warning), with it a public address resolves.
import { existsSync } from 'node:fs'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { GeoAreaNode, SessionVo } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AuditWriter } from '../../src/core/audit/audit-writer.js'
import { IpLocator, ipLocator, locationText, placeOf } from '../../src/core/audit/ip-location.js'
import { ip2regionFile } from '../../src/core/paths.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'geo-e2e-'
const URL = '/api/geo/areas'
const UNKNOWN = { country: null, province: null, city: null, isp: null }
const HAS_XDB = existsSync(ip2regionFile())

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let admin = ''
let nobody = ''
let nobodyId = 0

const http = () => request(app.getHttpServer())
const byIp = (ip: string | undefined, token = admin) =>
  http()
    .get(`${URL}/by-ip`)
    .query(ip === undefined ? {} : { ip })
    .set(bearer(token))

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  admin = (await signIn(app)).accessToken
  nobodyId = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}nobody`,
    display_name: 'nobody',
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  nobody = (await signIn(app, `${PREFIX}nobody`)).accessToken
})

afterEach(() => vi.restoreAllMocks())

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [`${PREFIX}%`])
    await ds.query("DELETE FROM aud_action_log WHERE domain = 'test.geo'")
    if (nobodyId) await ds.query('DELETE FROM iam_user WHERE id = ?', [nobodyId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('area tree', () => {
  it('any signed-in user gets province → city → county (leaves without children); 401 without a session', async () => {
    const res = await http().get(`${URL}/tree`).set(bearer(nobody)).expect(200)
    const tree = res.body.data as GeoAreaNode[]
    expect(tree).toHaveLength(34)
    const beijing = tree.find((p) => p.code === '110000')!
    expect(beijing.name).toBe('北京市')
    const city = beijing.children!.find((c) => c.code === '110100')!
    expect(city.children).toContainEqual({ code: '110101', name: '东城区' })
    const counties = tree.flatMap((p) => p.children!.flatMap((c) => c.children!))
    expect(counties.length).toBeGreaterThan(3000)
    expect(counties.every((c) => c.children === undefined && /^\d{6}$/.test(c.code))).toBe(true)
    await http().get(`${URL}/tree`).expect(401)
  })
})

describe('by ip', () => {
  it('a public IPv4 resolves with the data file, is unknown without it', async () => {
    const res = await byIp('8.8.8.8').expect(200)
    expect(res.body.data.ip).toBe('8.8.8.8')
    if (HAS_XDB) expect(res.body.data.country).toEqual(expect.any(String))
    else expect(res.body.data).toEqual({ ip: '8.8.8.8', ...UNKNOWN })
  })

  it('private, loopback and IPv6 addresses are unknown', async () => {
    for (const ip of ['192.168.1.10', '10.1.2.3', '127.0.0.1', '2001:4860:4860::8888'])
      expect((await byIp(ip).expect(200)).body.data).toEqual({ ip, ...UNKNOWN })
  })

  it('403 without geo.area.browse; 400 on a missing or malformed address', async () => {
    await byIp('8.8.8.8', nobody).expect(403)
    for (const ip of [undefined, 'not-an-ip', '1.2.3.256']) {
      const res = await byIp(ip).expect(400)
      expect(res.body.errors[0].path).toBe('ip')
    }
  })

  it('is in the API docs', async () => {
    const doc = (await http().get('/api/docs-json').expect(200)).body
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/geo/areas/tree', '/api/geo/areas/by-ip']),
    )
  })
})

describe('locator', () => {
  it('a missing data file: every lookup unknown, one warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const locator = new IpLocator(() => '/nonexistent/ip2region_v4.xdb')
    expect(await locator.locate('8.8.8.8')).toEqual(UNKNOWN)
    expect(await locator.location('1.2.4.8')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('fetch-ip2region')
  })

  it('xdb regions: `0` is unknown; the location text skips unknown and repeated parts', () => {
    const cn = placeOf('中国|广东省|深圳市|电信|CN')
    expect(cn).toEqual({ country: '中国', province: '广东省', city: '深圳市', isp: '电信' })
    expect(locationText(cn)).toBe('中国 广东省 深圳市')
    const au = placeOf('Australia|Queensland|0|0|AU')
    expect(au).toEqual({ country: 'Australia', province: 'Queensland', city: null, isp: null })
    expect(locationText(au)).toBe('Australia Queensland')
    expect(locationText(placeOf('中国|上海|上海|联通|CN'))).toBe('中国 上海')
    expect(locationText(placeOf(''))).toBeNull()
  })
})

describe('location in logs and sessions', () => {
  it('sign-in and action log rows and the online list carry the location of their IP', async () => {
    const at = vi.spyOn(ipLocator, 'location').mockResolvedValue('中国 广东省 深圳市')
    const audit = app.get(AuditWriter)
    audit.signin({
      kind: 'password',
      userType: 'admin',
      userId: nobodyId,
      username: `${PREFIX}nobody`,
      clientId: 'console',
      ip: '203.0.113.77',
      ua: 'vitest',
      ok: true,
      msgKey: 'signin.ok',
    })
    audit.action({
      domain: 'test.geo',
      verb: 'probe',
      bizId: null,
      method: 'POST',
      url: '/api/test/geo',
      ip: '203.0.113.77',
      ua: 'vitest',
      params: {},
      result: null,
      costMs: 1,
    })
    // the writer does not await: poll
    const row = (sql: string, params: unknown[]) =>
      vi.waitFor(
        async () => {
          const [r] = await ds.query<{ location: string | null }[]>(sql, params)
          if (!r) throw new Error('not written yet')
          return r
        },
        { timeout: 5000 },
      )
    expect(
      await row('SELECT location FROM aud_signin_log WHERE username = ?', [`${PREFIX}nobody`]),
    ).toEqual({ location: '中国 广东省 深圳市' })
    expect(await row('SELECT location FROM aud_action_log WHERE domain = ?', ['test.geo'])).toEqual(
      { location: '中国 广东省 深圳市' },
    )
    expect(at).toHaveBeenCalledWith('203.0.113.77')

    await signIn(app, `${PREFIX}nobody`, { ip: '203.0.113.77' })
    const list = await http()
      .get('/api/iam/sessions')
      .query({ username: PREFIX, pageSize: 200 })
      .set(bearer(admin))
      .expect(200)
    const rows = list.body.data.items as SessionVo[]
    expect(rows.find((r) => r.ip === '203.0.113.77')?.location).toBe('中国 广东省 深圳市')
  })
})
