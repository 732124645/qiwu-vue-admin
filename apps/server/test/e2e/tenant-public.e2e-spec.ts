// Where a public route's tenant comes from (see docs/design-notes.md#tenancy). With multi-tenancy on a
// request has no tenant until the sign-in resolution, the session or the row it works on names one, so
// every `@Public()` route is listed here with that source, and a new one fails the walk until it is
// added. Platform-only routes answer as before without a tenant; one that reads a tenant table without
// naming its tenant is a 500, never the default tenant's rows; the SMS receipt (a batch may span
// tenants) updates every tenant's records.
import { Controller, Get, type Type } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ApiExcludeController } from '@nestjs/swagger'
import { getDataSourceToken, InjectDataSource } from '@nestjs/typeorm'
import { CAPTCHA_MODE_PARAM } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { IS_PUBLIC, Public } from '../../src/core/auth/decorators.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { User } from '../../src/modules/platform/iam/user/user.entity.js'
import { createTenant, bootApp, type TestTenant } from '../setup/tenants.js'

/** Where the tenant of a public route comes from while multi-tenancy is on. */
type Source =
  /** the sign-in resolution: the host's tenant, else the body's tenant code, else the default one */
  | 'sign-in'
  /** the session of the presented token */
  | 'session'
  /** the OAuth2 grant: the code's tenant, the refresh token's session, the default one for clients */
  | 'grant'
  /** the resource row: the binding of a WeChat identity */
  | 'row'
  /** a channel's credentials; the records it updates may belong to any tenant */
  | 'channel'
  /** platform data only: no tenant table is read */
  | 'platform'

const PUBLIC_ROUTES: Record<string, Source> = {
  'POST /auth/login': 'sign-in',
  // the host's tenant only (its brand); the logo is read in the default tenant
  'GET /auth/tenancy': 'sign-in',
  'POST /auth/sms/code': 'sign-in',
  'POST /auth/sms/login': 'sign-in',
  'POST /auth/password/reset-by-sms': 'sign-in',
  'POST /auth/wx-mp/bind': 'sign-in',
  // the default tenant only
  'POST /auth/signup': 'sign-in',
  'POST /auth/refresh': 'session',
  'POST /oauth2/introspect': 'session',
  'POST /oauth2/revoke': 'session',
  'POST /oauth2/token': 'grant',
  'POST /auth/wx-mp/login': 'row',
  'POST /messaging/sms/receipt/:channel': 'channel',
  'GET /health': 'platform',
  'GET /auth/captcha': 'platform',
  'POST /auth/captcha/check': 'platform',
  'GET /settings/params/public/:key': 'platform',
  'GET /settings/app-versions/latest': 'platform',
}

@Controller('tenant-public-fixture')
@ApiExcludeController()
class UndeclaredController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** a public route that reads a tenant table without naming a tenant */
  @Get()
  @Public()
  count() {
    return this.ds.getRepository(User).count()
  }
}

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let B: TestTenant
const channels: number[] = []
const records: number[] = []

const http = (app: NestExpressApplication) => request(app.getHttpServer())

beforeAll(async () => {
  on = await bootApp({ multiTenant: true, controllers: [UndeclaredController] })
  off = await bootApp({ multiTenant: false, controllers: [UndeclaredController] })
  ds = on.get<DataSource>(getDataSourceToken())
  B = await createTenant(on)
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    if (records.length) await ds.query('DELETE FROM msg_sms_record WHERE id IN (?)', [records])
    if (channels.length) await ds.query('DELETE FROM msg_sms_channel WHERE id IN (?)', [channels])
  }
  await on?.close()
  await off?.close()
})

it('every public route is listed with its tenant source, and every listed one is a route', () => {
  const reflector = on.get(Reflector)
  const scanner = new MetadataScanner()
  const found: string[] = []
  for (const { metatype } of new DiscoveryService(on.get(ModulesContainer)).getControllers()) {
    if (!metatype || metatype === UndeclaredController) continue
    const proto = (metatype as Type).prototype
    const base = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '')
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name]
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined
      if (method === undefined) continue
      if (!reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, metatype])) continue
      const path = [base, String(Reflect.getMetadata(PATH_METADATA, handler) ?? '')]
        .flatMap((p) => p.split('/'))
        .filter(Boolean)
        .join('/')
      found.push(`${['GET', 'POST', 'PUT', 'DELETE', 'PATCH'][method]} /${path}`)
    }
  }
  expect(found.sort()).toEqual(Object.keys(PUBLIC_ROUTES).sort())
})

it('platform routes answer as they do with multi-tenancy off, without any tenant', async () => {
  const challenge = (app: NestExpressApplication) =>
    http(app).get('/api/auth/captcha').query({ scene: 'signin' })
  const calls: ((app: NestExpressApplication) => request.Test)[] = [
    (app) => http(app).get('/api/health'),
    challenge,
    (app) =>
      http(app)
        .post('/api/auth/captcha/check')
        .send({ id: 'tenant-public-unknown-0001', answer: 'nope' }),
    (app) => http(app).get(`/api/settings/params/public/${CAPTCHA_MODE_PARAM}`),
    (app) =>
      http(app)
        .get('/api/settings/app-versions/latest')
        .query({ platform: 'android', version: '1.0.0', nativeVersion: '1.0.0' }),
  ]
  for (const call of calls) {
    const [a, b] = [await call(on), await call(off)]
    expect(a.status).toBeLessThan(500)
    expect([a.status, a.body.code]).toEqual([b.status, b.body.code])
  }
  expect((await challenge(on)).status).toBe(200)
})

it('a public route that reads a tenant table without naming its tenant is a 500, not the default tenant’s rows', async () => {
  expect((await http(on).get('/api/tenant-public-fixture')).status).toBe(500)
  await http(off).get('/api/tenant-public-fixture').expect(200)
})

it('an SMS receipt batch updates the records of every tenant in it', async () => {
  const secret = 'tenant-public-receipt-secret'
  const { insertId: channel } = await ds.query<{ insertId: number }>(
    `INSERT INTO msg_sms_channel (driver, name, enabled, receipt_secret_enc)
     VALUES ('debug', 'tenant-public', 1, ?)`,
    [on.get(SecretBox).encrypt(secret)],
  )
  channels.push(Number(channel))
  const ids = { a: `tp-a-${Date.now()}`, b: `tp-b-${Date.now()}` }
  const record = async (tenantId: number, providerMsgId: string) => {
    const { insertId } = await ds.query<{ insertId: number }>(
      `INSERT INTO msg_sms_record (channel_id, template_code, body, status, provider_msg_id, tenant_id)
       VALUES (?, 'tenant-public', 'x', 'sent', ?, ?)`,
      [channel, providerMsgId, tenantId],
    )
    return Number(insertId)
  }
  const a = await record(1, ids.a)
  records.push(a)
  const b = await record(B.id, ids.b)
  await http(on)
    .post(`/api/messaging/sms/receipt/${channel}`)
    .query({ token: secret })
    .send([
      { providerMsgId: ids.a, status: 'delivered' },
      { providerMsgId: ids.b, status: 'failed' },
    ])
    .expect(200)
  const rows = await ds.query<{ id: number; receipt_status: string | null }[]>(
    'SELECT id, receipt_status FROM msg_sms_record WHERE id IN (?) ORDER BY id',
    [[a, b]],
  )
  expect(rows.map((r) => [Number(r.id), r.receipt_status])).toEqual([
    [a, 'delivered'],
    [b, 'failed'],
  ])
})
