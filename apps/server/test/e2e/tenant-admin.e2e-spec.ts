// Tenant management through /api/iam/tenants (see docs/design-notes.md#tenancy), multi-tenancy on. Opening
// a tenant is one transaction: its row, an enabled package, its host names, its logo, its seeds and its
// administrator, or none of it. A host name belongs to one live tenant: binding one another tenant holds is
// a 409, a name dropped is free at once; the platform's own host names are never bound. Disabling a
// tenant or moving its end into the past ends its sessions and sockets at once and signs nobody in (by
// password, WeChat, an OAuth code or a bind ticket), the background scans pass it by; a later end caps
// the sessions, a new package reloads them. The default tenant keeps no package, no end and stays enabled.
// A tenant is never deleted. Platform users only, each route behind its perm; no route while it is off.
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, RT, tenantPerms, userPerms, WX_MP_ENABLED_PARAM } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import {
  type Session,
  TENANT_UNAVAILABLE,
  TokenService,
} from '../../src/core/auth/token.service.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import type { Env } from '../../src/core/config/env.schema.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  WxMpGateway,
  type WxMpIdentity,
} from '../../src/modules/platform/iam/social/wx-mp.gateway.js'
import { secretDigest } from '../../src/modules/platform/oauth/provider/provider.service.js'
import { WfRemind } from '../../src/modules/workflow/runtime/wf-remind.js'
import { bearer, signIn } from '../setup/auth.js'
import { logOf } from '../setup/audit.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, inbox, socketOf } from '../setup/socket.js'
import {
  addRow,
  addUser,
  bootApp,
  createPackage,
  disposeTenant,
  signInDirect,
  TENANT_PASSWORD,
  type TestPackage,
} from '../setup/tenants.js'

const HB1 = 'b1.tenant-admin.test'
const HB2 = 'b2.tenant-admin.test'
const HC = 'c.tenant-admin.test'
const HA = 'a.tenant-admin.test'
const PLATFORM_HOST = 'platform.tenant-admin.test'
const CORS_HOST = 'web.tenant-admin.test'
const APPID = 'wx00tenant0admin00a'
const CLIENT = 'ta-crm'
const CB = 'https://crm.tenant-admin.example/cb'
const SECRET = 'tenant-admin-secret-0123456789abcdef'
const PARAMS = [WX_MP_ENABLED_PARAM, 'captcha.mode'] as const
const job = { signal: new AbortController().signal, log: () => {} }
const LOGO_URL = '/uploads/public/tenant-admin-logo.png'
let objectSeq = 0
let storageId = 0

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let root = ''
let rootId = 0
let pkg: TestPackage
let pkg2: TestPackage
let disabledPkg: TestPackage
let deletedPkg: TestPackage
/** tenant B, opened through the API in the first test */
const B = { id: 0, code: 'ta-b', ownerId: 0, initialPassword: '', alice: 0 }
const opened: number[] = []
/** default-tenant rows this spec inserted: [table, id] */
const mine: [string, number][] = []
let clientPk = 0
const before = { action: 0 }
const original = new Map<string, string>()

const http = () => request(on.getHttpServer())
let ipSeq = 0
const nextIp = () => `198.18.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`
const asRoot = {
  get: (path: string) => http().get(`/api/iam/tenants${path}`).set(bearer(root)),
  post: (path: string, body?: object) =>
    http().post(`/api/iam/tenants${path}`).set(bearer(root)).send(body),
  put: (path: string, body: object) =>
    http().put(`/api/iam/tenants${path}`).set(bearer(root)).send(body),
}
const expectErr = (res: request.Response, err: { code: string; status: number }) =>
  expect([res.status, res.body.code]).toEqual([err.status, err.code])
const admin = (username = 'owner') => ({ username, displayName: username })
/** A POST / body for code `code` with B's package; `over` on top. */
const openBody = (code: string, over: Record<string, unknown> = {}) => ({
  code,
  name: code,
  packageId: pkg.id,
  admin: admin(),
  ...over,
})
/** Opens a tenant through the API (disposed of in afterAll); the answer's data. */
async function open(body: Record<string, unknown>) {
  const res = await asRoot.post('', body).expect(201)
  opened.push(res.body.data.id)
  return res.body.data as { id: number; ownerUserId: number; initialPassword: string }
}
/** POST /api/auth/login from an address of its own, on `host` when given. */
const login = (
  body: { username: string; password: string; tenantCode?: string },
  host?: string,
) => {
  const req = http().post('/api/auth/login').set('X-Forwarded-For', nextIp())
  return (host ? req.set('Host', host) : req).send(body)
}
const tenancyOn = async (host: string) =>
  (await http().get('/api/auth/tenancy').set('Host', host).expect(200)).body.data.tenant?.code ??
  null
const me = (token: string) => http().get('/api/auth/me').set(bearer(token))
const stored = async (sid: string) =>
  JSON.parse((await redis.get(redisKey('authSession', sid)))!) as Session
const tenantRow = async (id: number) =>
  (
    await ds.query<Record<string, unknown>[]>(
      'SELECT code, enabled, expires_at, package_id, brand_name, logo_object_id FROM iam_tenant WHERE id = ?',
      [id],
    )
  )[0]
const insertMine = async (table: string, row: Record<string, unknown>) => {
  const id = await insertRow(ds.manager, table, { ...row, tenant_id: 1 })
  mine.push([table, id])
  return id
}
/** Row counts of what opening a tenant writes (no other spec runs meanwhile). */
const counts = async () =>
  Object.fromEntries(
    await Promise.all(
      ['iam_tenant', 'iam_tenant_domain', 'iam_dept', 'iam_role', 'iam_user', 'wf_model'].map(
        async (t) => [
          t,
          // table names are this spec's own constants
          Number((await ds.query(`SELECT COUNT(*) AS n FROM ${t}`))[0].n),
        ],
      ),
    ),
  )
const setParam = async (key: string, value: string) => {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await on.get(ParamService).invalidate(key)
}

beforeAll(async () => {
  // only the periodic socket recheck is advanced by hand; everything else keeps real time
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  on = await bootApp({
    multiTenant: true,
    env: { CORS_ORIGIN: `http://${CORS_HOST}:5173,not an origin` },
  })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  before.action = Number(
    (await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM aud_action_log'))[0].n,
  )
  const session = await signIn(on)
  root = session.accessToken
  rootId = session.session.userId!
  pkg = await createPackage(on)
  pkg2 = await createPackage(on)
  disabledPkg = await createPackage(on, { enabled: false })
  deletedPkg = await createPackage(on)
  await ds.query('UPDATE iam_tenant_package SET deleted_at = NOW(3) WHERE id = ?', [deletedPkg.id])
  ;[{ id: storageId }] = await ds.query(
    "SELECT id FROM fs_storage WHERE name = 'seed.storage.local' AND deleted_at IS NULL",
  )
  // the WeChat gateway: an AppID configured, a code `<openid>~<n>` answering that openid
  const gateway = on.get(WxMpGateway)
  vi.spyOn(gateway, 'appid').mockReturnValue(APPID)
  vi.spyOn(gateway, 'code2Session').mockImplementation(
    async (c: string) => ({ openid: c.split('~')[0]!, unionid: null }) as WxMpIdentity,
  )
  for (const r of await ds.query<{ param_key: string; param_value: string }[]>(
    'SELECT param_key, param_value FROM cfg_param WHERE param_key IN (?)',
    [PARAMS],
  ))
    original.set(r.param_key, r.param_value)
  await setParam('captcha.mode', 'off')
  await setParam(WX_MP_ENABLED_PARAM, 'true')
  clientPk = await insertRow(ds.manager, 'oauth_client', {
    client_id: CLIENT,
    secret_hash: secretDigest(SECRET),
    name: CLIENT,
    grant_types: ['authorization_code', 'refresh_token'],
    redirect_uris: [CB],
    scopes: ['user.read'],
    auto_approve_scopes: [],
    access_ttl_sec: 600,
    refresh_ttl_sec: 3600,
  })
})

afterAll(async () => {
  try {
    closeSockets()
    if (ds) {
      await on.get(NotifyDispatcher).idle()
      // action log rows are written without awaiting
      await sleep(200)
      for (const id of opened) await disposeTenant(on, id)
      for (const p of [pkg, pkg2, disabledPkg, deletedPkg]) await p?.dispose()
      // the link rows of this spec's roles and users first
      const idsOf = (table: string) => mine.filter(([t]) => t === table).map(([, id]) => id)
      for (const [link, column, table] of [
        ['iam_role_menus', 'role_id', 'iam_role'],
        ['iam_user_roles', 'user_id', 'iam_user'],
      ] as const)
        if (idsOf(table).length)
          await ds.query(`DELETE FROM ${link} WHERE ${column} IN (?)`, [idsOf(table)])
      for (const [table, id] of mine.reverse())
        // table names are this spec's own constants
        await ds.query(`DELETE FROM ${table} WHERE id = ?`, [id])
      await ds.query('DELETE FROM iam_tenant_domain WHERE tenant_id = 1')
      await ds.query('UPDATE iam_tenant SET brand_name = NULL WHERE id = 1')
      if (clientPk) {
        await ds.query('DELETE FROM oauth_consent WHERE client_id = ?', [clientPk])
        await ds.query('DELETE FROM oauth_client WHERE id = ?', [clientPk])
      }
      await ds.query('DELETE FROM aud_action_log WHERE id > ?', [before.action])
      for (const [key, value] of original) await setParam(key, value)
    }
    if (redis) await cleanRedis(redis)
    await on?.close()
  } finally {
    vi.useRealTimers()
  }
})

describe('opening a tenant', () => {
  it('opens B with its package, host names, brand and administrator in one go; the initial password is answered once and logged nowhere', async () => {
    const traceId = `ta-${process.pid}-open`
    // looked up before it is bound: the answer "no tenant" is remembered, and forgotten on opening
    expect(await tenancyOn(HB1)).toBeNull()
    const res = await http()
      .post('/api/iam/tenants')
      .set(bearer(root))
      .set('X-Request-Id', traceId)
      .send(
        openBody(B.code, {
          name: 'Tenant B',
          domains: [HB1, HB2.toUpperCase()],
          userQuota: 5,
          brandName: 'B Brand',
          note: 'opened by a spec',
          admin: { ...admin(), mobile: '13900007001', email: 'owner@b.tenant-admin.test' },
        }),
      )
      .expect(201)
    const data = res.body.data
    opened.push(data.id)
    Object.assign(B, {
      id: data.id,
      ownerId: data.ownerUserId,
      initialPassword: data.initialPassword,
    })
    expect(data).toMatchObject({
      code: B.code,
      name: 'Tenant B',
      packageId: pkg.id,
      packageName: pkg.name,
      enabled: true,
      expiresAt: null,
      userQuota: 5,
      userCount: 1,
      domains: [HB1, HB2],
      brandName: 'B Brand',
      logoObjectId: null,
      note: 'opened by a spec',
      createdBy: rootId,
    })
    expect(B.initialPassword).toEqual(expect.any(String))
    const view = (await asRoot.get(`/${B.id}`).expect(200)).body.data
    expect(view).toEqual({ ...data, initialPassword: undefined, updatedAt: view.updatedAt })
    expect(view).not.toHaveProperty('initialPassword')
    expect(
      await ds.query('SELECT username, mobile, email FROM iam_user WHERE id = ?', [B.ownerId]),
    ).toEqual([{ username: 'owner', mobile: '13900007001', email: 'owner@b.tenant-admin.test' }])
    const log = await logOf(ds, traceId)
    expect(log).toMatchObject({ domain: 'iam.tenant', verb: 'create', biz_id: String(B.id) })
    expect(JSON.stringify(log)).not.toContain(B.initialPassword)
    // both host names resolve to B: the sign-in pages and the sign-in
    for (const host of [HB1, HB2]) {
      expect(await tenancyOn(host)).toBe(B.code)
      const signed = await login({ username: 'owner', password: B.initialPassword }, host).expect(
        200,
      )
      const session = await on.get(TokenService).authenticate(signed.body.data.accessToken)
      expect(session?.tenantId).toBe(B.id)
    }
    B.alice = await addUser(on, B.id, 'alice')
  })

  it('is all or nothing: a host name another tenant holds (409), a package not enabled (404) or a refused logo (400) leaves no row', async () => {
    const was = await counts()
    const code = 'ta-none'
    expectErr(
      await asRoot.post('', openBody(code, { domains: ['fresh.tenant-admin.test', HB1] })),
      Err.DUPLICATE,
    )
    for (const packageId of [disabledPkg.id, deletedPkg.id, 999_999_999])
      expectErr(await asRoot.post('', openBody(code, { packageId })), Err.NOT_FOUND)
    // the host names are written before the logo is refused: rolled back with the rest
    const other = await addRow(on, B.id, 'fs_object', objectRow(B.ownerId))
    expectErr(
      await asRoot.post(
        '',
        openBody(code, { domains: ['fresh.tenant-admin.test'], logoObjectId: other }),
      ),
      Err.STORAGE_REF_INVALID,
    )
    expect(await counts()).toEqual(was)
    expect(await ds.query('SELECT id FROM iam_tenant WHERE code = ?', [code])).toEqual([])
    expect(await tenancyOn(HB1)).toBe(B.code)
  })

  it('counts the administrator against the user quota', async () => {
    const q = await open(openBody('ta-quota', { userQuota: 1 }))
    expect((await asRoot.get(`/${q.id}`).expect(200)).body.data).toMatchObject({
      userQuota: 1,
      userCount: 1,
    })
    await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE id = ?', [q.ownerUserId])
    const owner = (await signInDirect(on, q.ownerUserId))!
    expectErr(
      await http()
        .post('/api/iam/users')
        .set(bearer(owner.accessToken))
        .send({ username: 'second', displayName: 'second' }),
      Err.IAM_TENANT_USER_QUOTA,
    )
  })

  it('refuses a bad host name, more than 20, one twice (400) and the platform’s own: the request’s host or one of CORS_ORIGIN (422)', async () => {
    for (const domains of [
      ['bad_host.test'],
      ['b.tenant-admin.test:8080'],
      ['*.tenant-admin.test'],
      ['https://x.tenant-admin.test'],
      Array.from({ length: 21 }, (_, i) => `d${i}.tenant-admin.test`),
      ['twice.tenant-admin.test', 'TWICE.tenant-admin.test'],
    ])
      expectErr(await asRoot.post('', openBody('ta-bad', { domains })), Err.VALIDATION_FAILED)
    const onPlatform = (body: object) =>
      http().post('/api/iam/tenants').set(bearer(root)).set('Host', PLATFORM_HOST).send(body)
    expectErr(
      await onPlatform(openBody('ta-bad', { domains: [PLATFORM_HOST] })),
      Err.IAM_TENANT_DOMAIN_RESERVED,
    )
    expectErr(
      await asRoot.post('', openBody('ta-bad', { domains: ['ok.tenant-admin.test', CORS_HOST] })),
      Err.IAM_TENANT_DOMAIN_RESERVED,
    )
    expect(await ds.query("SELECT id FROM iam_tenant WHERE code = 'ta-bad'")).toEqual([])
    // the same on an edit, the host names left as they were
    expectErr(
      await http()
        .put(`/api/iam/tenants/${B.id}`)
        .set(bearer(root))
        .set('Host', PLATFORM_HOST)
        .send({ domains: [HB1, PLATFORM_HOST] }),
      Err.IAM_TENANT_DOMAIN_RESERVED,
    )
    expectErr(
      await asRoot.put(`/${B.id}`, { domains: [CORS_HOST] }),
      Err.IAM_TENANT_DOMAIN_RESERVED,
    )
    expect((await asRoot.get(`/${B.id}`).expect(200)).body.data.domains).toEqual([HB1, HB2])
  })
})

describe('changing a tenant', () => {
  it('a host name another tenant holds is a 409 (nothing bound); dropped, it resolves to nobody and another tenant may take it', async () => {
    const C = await open(openBody('ta-c', { domains: [HC] }))
    expectErr(await asRoot.put(`/${C.id}`, { domains: [HC, HB1] }), Err.DUPLICATE)
    expect((await asRoot.get(`/${C.id}`).expect(200)).body.data.domains).toEqual([HC])
    expect(await tenancyOn(HB1)).toBe(B.code)

    await asRoot.put(`/${B.id}`, { domains: [HB2] }).expect(200)
    expect(await tenancyOn(HB1)).toBeNull()
    expect(await tenancyOn(HB2)).toBe(B.code)
    await asRoot.put(`/${C.id}`, { domains: [HC, HB1] }).expect(200)
    expect(await tenancyOn(HB1)).toBe('ta-c')
    expect((await asRoot.get(`/${C.id}`).expect(200)).body.data.domains).toEqual([HC, HB1])
    expect((await asRoot.get(`/${B.id}`).expect(200)).body.data.domains).toEqual([HB2])
    // B's dropped row stays, deleted: never revived, the new binding is a row of its own
    expect(
      await ds.query(
        'SELECT tenant_id, deleted_at IS NULL AS live FROM iam_tenant_domain WHERE domain = ? ORDER BY id',
        [HB1],
      ),
    ).toEqual([
      { tenant_id: B.id, live: 0 },
      { tenant_id: C.id, live: 1 },
    ])
  })

  it('never takes a code (400), and the default tenant keeps no package, no end and stays enabled (422); its brand and host names change', async () => {
    expectErr(await asRoot.put(`/${B.id}`, { code: 'ta-renamed' }), Err.VALIDATION_FAILED)
    expectErr(await asRoot.put('/1', { code: 'ta-renamed' }), Err.VALIDATION_FAILED)
    const end = new Date(Date.now() + 86_400_000).toISOString()
    expectErr(await asRoot.put('/1/enabled', { enabled: false }), Err.IAM_TENANT_DEFAULT_FIXED)
    expectErr(await asRoot.put('/1', { expiresAt: end }), Err.IAM_TENANT_DEFAULT_FIXED)
    expectErr(await asRoot.put('/1', { packageId: pkg.id }), Err.IAM_TENANT_DEFAULT_FIXED)
    expectErr(await asRoot.post('/1/initial-password'), Err.IAM_TENANT_DEFAULT_FIXED)
    expect(await tenantRow(1)).toMatchObject({
      code: 'default',
      enabled: 1,
      expires_at: null,
      package_id: null,
    })
    expect((await tenantRow(B.id))!.code).toBe(B.code)
    await asRoot.put('/1/enabled', { enabled: true }).expect(200)
    await asRoot.put('/1', { brandName: 'Platform', domains: [HA], expiresAt: null }).expect(200)
    expect((await asRoot.get('/1').expect(200)).body.data).toMatchObject({
      brandName: 'Platform',
      domains: [HA],
      enabled: true,
      packageId: null,
    })
    await asRoot.put('/1', { brandName: null, domains: [] }).expect(200)
  })

  it('takes an enabled package only (404, the package kept); a new one makes B’s sessions reload', async () => {
    for (const packageId of [disabledPkg.id, deletedPkg.id])
      expectErr(await asRoot.put(`/${B.id}`, { packageId }), Err.NOT_FOUND)
    expect((await tenantRow(B.id))!.package_id).toBe(pkg.id)
    const b = (await signInDirect(on, B.alice))!
    await me(b.accessToken).expect(200)
    const was = (await stored(b.session.sid)).permVer
    await asRoot.put(`/${B.id}`, { packageId: pkg2.id }).expect(200)
    expect((await tenantRow(B.id))!.package_id).toBe(pkg2.id)
    await me(b.accessToken).expect(200)
    const now = (await stored(b.session.sid)).permVer
    expect(now).not.toBe(was)
    expect(now).toBe(await on.get(PermVersion).current(B.alice))
  })

  it('takes as logo only a live public cover object of the default tenant (400 otherwise); saved, it is bound', async () => {
    const good = await insertMine('fs_object', objectRow(rootId, { public_url: LOGO_URL }))
    const wrong = [
      await addRow(on, B.id, 'fs_object', objectRow(B.ownerId)),
      await insertMine('fs_object', objectRow(rootId, { is_public: 0, biz_tag: 'attachment' })),
      await insertMine('fs_object', objectRow(rootId, { deleted_at: new Date() })),
      999_999_999,
    ]
    for (const logoObjectId of wrong)
      expectErr(await asRoot.put(`/${B.id}`, { logoObjectId }), Err.STORAGE_REF_INVALID)
    expect((await tenantRow(B.id))!.logo_object_id).toBeNull()
    await asRoot.put(`/${B.id}`, { logoObjectId: good }).expect(200)
    expect((await asRoot.get(`/${B.id}`).expect(200)).body.data).toMatchObject({
      logoObjectId: good,
      logoUrl: LOGO_URL,
    })
    const bound = () =>
      ds.query('SELECT biz_ref, deleted_at FROM fs_object WHERE id = ?', [good]) as Promise<
        unknown[]
      >
    expect(await bound()).toEqual([{ biz_ref: `iam.tenant:${B.id}`, deleted_at: null }])
    // sent again unchanged: nothing to bind
    await asRoot.put(`/${B.id}`, { logoObjectId: good }).expect(200)
    // replaced, then cleared: the logo it no longer shows is deleted, so no public object stays behind
    const next = await insertMine(
      'fs_object',
      objectRow(rootId, { public_url: `${LOGO_URL}?next` }),
    )
    const deleted = async (id: number) =>
      Number(
        (
          await ds.query<{ d: number }[]>(
            'SELECT deleted_at IS NOT NULL AS d FROM fs_object WHERE id = ?',
            [id],
          )
        )[0]!.d,
      ) === 1
    await asRoot.put(`/${B.id}`, { logoObjectId: next }).expect(200)
    expect([await deleted(good), await deleted(next)]).toEqual([true, false])
    await asRoot.put(`/${B.id}`, { logoObjectId: null }).expect(200)
    expect(await deleted(next)).toBe(true)
    expect((await tenantRow(B.id))!.logo_object_id).toBeNull()
  })

  it('resets the initial password for the tenant’s new users only, answered once and logged nowhere', async () => {
    const traceId = `ta-${process.pid}-reset`
    const res = await http()
      .post(`/api/iam/tenants/${B.id}/initial-password`)
      .set(bearer(root))
      .set('X-Request-Id', traceId)
      .expect(200)
    const fresh = res.body.data.initialPassword as string
    expect(fresh).not.toBe(B.initialPassword)
    const [{ enc }] = await ds.query<{ enc: string }[]>(
      'SELECT initial_password_enc AS enc FROM iam_tenant WHERE id = ?',
      [B.id],
    )
    expect(on.get(SecretBox).decrypt(enc)).toBe(fresh)
    // the owner keeps the password it has
    await login({ tenantCode: B.code, username: 'owner', password: B.initialPassword }).expect(200)
    const log = await logOf(ds, traceId)
    expect(log).toMatchObject({ domain: 'iam.tenant', verb: 'reset-password', ok: 1 })
    expect(JSON.stringify(log)).not.toContain(fresh)
    expectErr(await asRoot.post('/999999999/initial-password'), Err.NOT_FOUND)
    expectErr(await asRoot.get('/999999999'), Err.NOT_FOUND)
    expectErr(await asRoot.put('/999999999', { note: 'n' }), Err.NOT_FOUND)
    expectErr(await asRoot.put('/999999999/enabled', { enabled: false }), Err.NOT_FOUND)
  })
})

describe('taking a tenant out of service', () => {
  const socketKicked = (sid: string) => ({
    type: RT.sessionKicked,
    payload: { sid, reason: TENANT_UNAVAILABLE },
  })

  it.each<[string, () => object, () => object, string]>([
    ['disabling it', () => ({ enabled: false }), () => ({ enabled: true }), '/enabled'],
    [
      'an end in the past',
      () => ({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      () => ({ expiresAt: null }),
      '',
    ],
  ])(
    '%s ends B’s sessions and sockets at once and signs nobody in; back in service, its users sign in',
    async (_, out, back, path) => {
      const tokens = on.get(TokenService)
      const b1 = (await signInDirect(on, B.alice))!
      const b2 = (await signInDirect(on, B.alice, { clientId: 'mobile' }))!
      const a = await signIn(on)
      const bSocket = await connect(socketOf(on, { token: b1.accessToken }))
      const aSocket = await connect(socketOf(on, { token: a.accessToken }))
      const got = inbox(bSocket)
      const permVerAll = async () => (await redis.get(redisKey('authPermVer', 'all'))) ?? '0'
      const ver = await permVerAll()
      await asRoot.put(`/${B.id}${path}`, out()).expect(200)
      // and every session is reloaded at its next request
      expect(await permVerAll()).not.toBe(ver)
      // no request of B and no recheck needed
      expect(await tokens.load(b1.session.sid)).toBeNull()
      expect(await tokens.load(b2.session.sid)).toBeNull()
      await vi.waitFor(() => expect(bSocket.connected).toBe(false), { timeout: 3_000 })
      expect(got).toEqual([socketKicked(b1.session.sid)])
      expect(aSocket.connected).toBe(true)
      expect(
        (await login({ tenantCode: B.code, username: 'alice', password: TENANT_PASSWORD })).status,
      ).toBe(401)
      expect(await signInDirect(on, B.alice)).toBeNull()
      await asRoot.put(`/${B.id}${path}`, back()).expect(200)
      await login({ tenantCode: B.code, username: 'alice', password: TENANT_PASSWORD }).expect(200)
    },
  )

  it.each<[string, object, object, string]>([
    ['disabling it', { enabled: false }, { enabled: true }, '/enabled'],
    ['an end in the past', { expiresAt: '2020-01-01T00:00:00.000Z' }, { expiresAt: null }, ''],
  ])(
    '%s while ending the sessions fails still makes every session reload: B’s end at their next request',
    async (_, out, back, path) => {
      const b = (await signInDirect(on, B.alice))!
      await me(b.accessToken).expect(200)
      const revoke = vi
        .spyOn(on.get(SessionRevoker), 'revokeTenant')
        .mockRejectedValueOnce(new Error('revoke failed'))
      try {
        expect((await asRoot.put(`/${B.id}${path}`, out)).status).toBe(500)
        expect(revoke).toHaveBeenCalledOnce()
        expectErr(await me(b.accessToken), Err.AUTH_TENANT_INACTIVE)
      } finally {
        revoke.mockRestore()
        await asRoot.put(`/${B.id}${path}`, back).expect(200)
      }
    },
  )

  it('an end set later (none before) caps the sessions at it; then they end, an idle socket at the next recheck', async () => {
    const d = (await signInDirect(on, B.alice, { keepSignedIn: true }))!
    const idle = (await signInDirect(on, B.alice, { keepSignedIn: true }))!
    const socket = await connect(socketOf(on, { token: idle.accessToken }))
    const got = inbox(socket)
    const end = new Date(Date.now() + 3_000)
    try {
      await asRoot.put(`/${B.id}`, { expiresAt: end.toISOString() }).expect(200)
      await me(d.accessToken).expect(200)
      expect((await stored(d.session.sid)).absoluteExpAt).toBe(end.getTime())
      // the idle socket's session is reloaded by the recheck: capped, still alive
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(async () =>
        expect((await stored(idle.session.sid)).tenantExpAt).toBe(end.getTime()),
      )
      expect(socket.connected).toBe(true)
      await sleep(end.getTime() - Date.now() + 50)
      expectErr(await me(d.accessToken), Err.AUTH_TENANT_INACTIVE)
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(socket.connected).toBe(false), { timeout: 3_000 })
      expect(got).toEqual([socketKicked(idle.session.sid)])
    } finally {
      await asRoot.put(`/${B.id}`, { expiresAt: null }).expect(200)
    }
  })

  describe('signs nobody in through WeChat, an OAuth code or a bind ticket obtained before', () => {
    let codeSeq = 0
    const wxCode = (openid: string) => `${openid}~${++codeSeq}`
    const pkce = () => {
      const verifier = randomBytes(32).toString('base64url')
      return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
    }
    const at = nextIp()
    let code = { code: '', verifier: '' }
    let ticket = ''
    /** a ticket for C issued before B's user bound its openid: the only way to C with it */
    const held = { ip: nextIp(), ticket: '', code: 'ta-held', id: 0, carol: 0 }

    beforeAll(async () => {
      await ds.query(
        `INSERT INTO iam_user_social (provider, appid, openid, user_id, created_by, updated_by, tenant_id)
         VALUES ('wx-mp', ?, 'o-ta-alice', ?, ?, ?, ?)`,
        [APPID, B.alice, B.alice, B.alice, B.id],
      )
      // obtained while B is in service
      await http()
        .post('/api/auth/wx-mp/login')
        .set('X-Forwarded-For', nextIp())
        .send({ code: wxCode('o-ta-alice') })
        .expect(200)
      const { verifier, challenge } = pkce()
      const approved = await http()
        .post('/api/oauth2/authorize')
        .query({
          response_type: 'code',
          client_id: CLIENT,
          redirect_uri: CB,
          scope: 'user.read',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })
        .set(bearer((await signInDirect(on, B.alice))!.accessToken))
        .send({ approve: true })
        .expect(200)
      code = {
        code: new URL(approved.body.data.redirectTo as string).searchParams.get('code')!,
        verifier,
      }
      const issued = await http()
        .post('/api/auth/wx-mp/login')
        .set('X-Forwarded-For', at)
        .send({ code: wxCode('o-ta-new') })
        .expect(200)
      ticket = issued.body.data.bindTicket
      if (typeof ticket !== 'string') throw new Error('no bind ticket issued')
      held.id = (await open(openBody(held.code))).id
      held.carol = await addUser(on, held.id, 'carol')
      held.ticket = (
        await http()
          .post('/api/auth/wx-mp/login')
          .set('X-Forwarded-For', held.ip)
          .send({ code: wxCode('o-ta-held') })
          .expect(200)
      ).body.data.bindTicket
      await ds.query(
        `INSERT INTO iam_user_social (provider, appid, openid, user_id, created_by, updated_by, tenant_id)
         VALUES ('wx-mp', ?, 'o-ta-held', ?, ?, ?, ?)`,
        [APPID, B.ownerId, B.ownerId, B.ownerId, B.id],
      )
      await asRoot.put(`/${B.id}/enabled`, { enabled: false }).expect(200)
    })

    afterAll(async () => {
      await asRoot.put(`/${B.id}/enabled`, { enabled: true }).expect(200)
    })

    it('a WeChat sign-in of a binding in B is refused', async () => {
      expectErr(
        await http()
          .post('/api/auth/wx-mp/login')
          .set('X-Forwarded-For', nextIp())
          .send({ code: wxCode('o-ta-alice') }),
        Err.AUTH_WX_MP_REFUSED,
      )
    })

    it('a code approved before redeems nothing', async () => {
      const res = await http().post('/api/oauth2/token').type('form').send({
        client_id: CLIENT,
        client_secret: SECRET,
        grant_type: 'authorization_code',
        code: code.code,
        redirect_uri: CB,
        code_verifier: code.verifier,
      })
      expect([res.status, res.body.error]).toEqual([400, 'invalid_grant'])
    })

    it('a bind ticket issued before binds nothing in B', async () => {
      expectErr(
        await http()
          .post('/api/auth/wx-mp/bind')
          .set('X-Forwarded-For', at)
          .send({ ticket, username: 'alice', password: TENANT_PASSWORD, tenantCode: B.code }),
        Err.AUTH_BAD_CREDENTIALS,
      )
      expect(await ds.query("SELECT id FROM iam_user_social WHERE openid = 'o-ta-new'")).toEqual([])
    })

    it('B still holds the openid its user bound: another tenant cannot bind it (409)', async () => {
      expectErr(
        await http().post('/api/auth/wx-mp/bind').set('X-Forwarded-For', held.ip).send({
          ticket: held.ticket,
          username: 'carol',
          password: TENANT_PASSWORD,
          tenantCode: held.code,
        }),
        Err.AUTH_WX_MP_BOUND,
      )
      expect(
        await ds.query("SELECT user_id FROM iam_user_social WHERE openid = 'o-ta-held'"),
      ).toEqual([{ user_id: B.ownerId }])
    })

    it('a platform user who enters B releases it: not the owner’s by a password reset (422, still bound), root does; a plain user’s by deleting the user; then C binds it', async () => {
      const roleId = await insertMine('iam_role', {
        code: 'ta-enterer',
        name: 'ta-enterer',
        data_scope: 'all',
      })
      await ds.query(
        `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
         SELECT ?, id, 1 FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
        [roleId, [tenantPerms.enter, userPerms['reset-password'], userPerms.remove]],
      )
      const enterer = await addUser(on, 1, 'ta-enterer', { roleId })
      mine.push(['iam_user', enterer])
      const dave = await addUser(on, B.id, 'dave')
      await ds.query(
        `INSERT INTO iam_user_social (provider, appid, openid, user_id, created_by, updated_by, tenant_id)
         VALUES ('wx-mp', ?, 'o-ta-dave', ?, ?, ?, ?)`,
        [APPID, dave, dave, dave, B.id],
      )
      const erin = await addUser(on, held.id, 'erin')
      const bound = (openid: string) =>
        ds.query('SELECT user_id FROM iam_user_social WHERE openid = ? AND deleted_at IS NULL', [
          openid,
        ])
      const inB = async (token: string, work: () => Promise<void>) => {
        await http()
          .post(`/api/iam/tenants/${B.id}/enter`)
          .set(bearer(token))
          .send({ reason: 'release an openid' })
          .expect(200)
        await work()
        await http().post('/api/iam/tenants/leave').set(bearer(token)).send().expect(200)
      }
      const resetOwner = (token: string) =>
        http()
          .put(`/api/iam/users/${B.ownerId}/password`)
          .set(bearer(token))
          .send({ password: 'Reset#2026-pass' })
      /** binds `openid` to C's user `username` through a fresh ticket */
      const bindInC = async (openid: string, username: string) => {
        const ip = nextIp()
        const issued = await http()
          .post('/api/auth/wx-mp/login')
          .set('X-Forwarded-For', ip)
          .send({ code: wxCode(openid) })
          .expect(200)
        return http().post('/api/auth/wx-mp/bind').set('X-Forwarded-For', ip).send({
          ticket: issued.body.data.bindTicket,
          username,
          password: TENANT_PASSWORD,
          tenantCode: held.code,
        })
      }

      const staff = (await signInDirect(on, enterer))!.accessToken
      await inB(staff, async () => expectErr(await resetOwner(staff), Err.IAM_USER_PROTECTED))
      expect(await bound('o-ta-held')).toEqual([{ user_id: B.ownerId }])
      const rootInB = (await signIn(on)).accessToken
      await inB(rootInB, async () => void (await resetOwner(rootInB).expect(200)))
      expect(await bound('o-ta-held')).toEqual([])
      await bindInC('o-ta-held', 'carol').then((r) => expect(r.status).toBe(200))
      expect(await bound('o-ta-held')).toEqual([{ user_id: held.carol }])

      await inB(staff, async () => {
        await http().delete(`/api/iam/users/${dave}`).set(bearer(staff)).expect(200)
      })
      expect(await bound('o-ta-dave')).toEqual([])
      await bindInC('o-ta-dave', 'erin').then((r) => expect(r.status).toBe(200))
      expect(await bound('o-ta-dave')).toEqual([{ user_id: erin }])
    })
  })

  it.each<[string, () => object, () => object, string]>([
    ['disabled', () => ({ enabled: false }), () => ({ enabled: true }), '/enabled'],
    [
      'past its end',
      () => ({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      () => ({ expiresAt: null }),
      '',
    ],
  ])(
    '%s through the API: reminders, timeout handling and inbox delivery pass B by, its rows untouched, the default tenant’s go on; back in service, B’s rows are taken up',
    async (_, out, back, path) => {
      const inboxRow = (userId: number) => ({
        user_id: userId,
        template_code: 'tenant-admin',
        locale: 'en-US',
        category: 'system',
        title: 'Tenant admin',
        body: 'Tenant admin',
      })
      const instanceRow = {
        version_id: 0,
        model_key: 'tenant-admin',
        form_values: '{}',
        initiator_picks: '{}',
        initiator_ctx: '{}',
        active_node_ids: '[]',
      }
      const taskRow = (instanceId: number, assigneeId: number) => ({
        instance_id: instanceId,
        node_id: 'n1',
        node_name: 'n1',
        assignee_id: assigneeId,
        state: 'pending',
        due_at: new Date(Date.now() - 3_600_000),
      })
      const bInbox = await addRow(on, B.id, 'msg_inbox', inboxRow(B.alice))
      const bTask = await addRow(
        on,
        B.id,
        'wf_task',
        taskRow(
          await addRow(on, B.id, 'wf_instance', { ...instanceRow, initiator_id: B.alice }),
          B.alice,
        ),
      )
      const aInbox = await insertMine('msg_inbox', inboxRow(rootId))
      const aTask = await insertMine(
        'wf_task',
        taskRow(await insertMine('wf_instance', { ...instanceRow, initiator_id: rootId }), rootId),
      )
      const attempts = async (id: number) =>
        Number(
          (
            await ds.query<{ n: number }[]>('SELECT attempts AS n FROM msg_inbox WHERE id = ?', [
              id,
            ])
          )[0]!.n,
        )
      const candidates = async () => {
        const remind = on.get(WfRemind, { strict: false })
        const one = vi.spyOn(remind, 'remindOne').mockResolvedValue(false)
        try {
          await remind.remind({}, job)
          return one.mock.calls.map(([id]) => id)
        } finally {
          one.mockRestore()
        }
      }
      const bTaskRow = () =>
        ds.query('SELECT state, reminded_at FROM wf_task WHERE id = ?', [bTask])
      await asRoot.put(`/${B.id}${path}`, out()).expect(200)
      try {
        await on.get(NotifyDispatcher).dispatch({}, job)
        expect(await attempts(bInbox)).toBe(0)
        expect(await attempts(aInbox)).toBe(1)
        const due = await candidates()
        expect(due).toContain(aTask)
        expect(due).not.toContain(bTask)
        expect(await bTaskRow()).toEqual([{ state: 'pending', reminded_at: null }])
      } finally {
        await asRoot.put(`/${B.id}${path}`, back()).expect(200)
      }
      expect(await candidates()).toContain(bTask)
      await on.get(NotifyDispatcher).dispatch({}, job)
      expect(await attempts(bInbox)).toBe(1)
    },
  )
})

describe('who may', () => {
  it('B’s users, its tenant_admin too, get 403 on every route; a platform user without the perm 403', async () => {
    await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE id = ?', [B.ownerId])
    const roleId = await insertMine('iam_role', {
      code: 'ta-viewer',
      name: 'ta-viewer',
      data_scope: 'all',
    })
    for (const { id } of await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
      [tenantPerms.browse],
    ))
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
        roleId,
        id,
      ])
    const viewer = await addUser(on, 1, 'ta-viewer', { roleId })
    mine.push(['iam_user', viewer])
    const routes: [string, string, object?][] = [
      ['get', ''],
      ['get', '/options'],
      ['get', `/${B.id}`],
      ['post', '', openBody('ta-never')],
      ['put', `/${B.id}`, { name: 'never' }],
      ['put', `/${B.id}/enabled`, { enabled: false }],
      ['post', `/${B.id}/initial-password`],
    ]
    const call = (token: string, [method, path, body]: [string, string, object?]) =>
      (
        http()
          [method as 'get' | 'post' | 'put'](`/api/iam/tenants${path}`)
          .set(bearer(token)) as request.Test
      ).send(body)
    for (const userId of [B.alice, B.ownerId]) {
      const token = (await signInDirect(on, userId))!.accessToken
      for (const route of routes) expect((await call(token, route)).status).toBe(403)
    }
    const token = (await signInDirect(on, viewer))!.accessToken
    for (const route of routes)
      expect((await call(token, route)).status).toBe(
        route[0] === 'get' && route[1] !== `/${B.id}` ? 200 : 403,
      )
    expect(await tenantRow(B.id)).toMatchObject({ enabled: 1 })
    expect(await ds.query("SELECT id FROM iam_tenant WHERE code = 'ta-never'")).toEqual([])
  })

  it('no route while multi-tenancy is off (404), and none deletes a tenant', async () => {
    expect((await http().delete(`/api/iam/tenants/${B.id}`).set(bearer(root))).status).toBe(404)
    const cfg = on.get(AppConfigService)
    const get = cfg.get.bind(cfg)
    const spy = vi
      .spyOn(cfg, 'get')
      .mockImplementation(((key: keyof Env) =>
        key === 'APP_MULTI_TENANT' ? false : get(key)) as AppConfigService['get'])
    try {
      expectErr(await asRoot.get(''), Err.NOT_FOUND)
      expectErr(await asRoot.post('', openBody('ta-off')), Err.NOT_FOUND)
      expectErr(await asRoot.put(`/${B.id}/enabled`, { enabled: false }), Err.NOT_FOUND)
    } finally {
      spy.mockRestore()
    }
    expect(await tenantRow(B.id)).toMatchObject({ enabled: 1 })
  })
})

describe('the list', () => {
  it('pages, filters and sorts; options name every tenant', async () => {
    const page = (query: Record<string, unknown>) =>
      asRoot
        .get('')
        .query(query)
        .expect(200)
        .then((r) => r.body.data)
    const all = await page({ pageSize: 200 })
    expect(all.total).toBe(all.items.length)
    expect(all.items.map((t: { id: number }) => t.id)).toEqual(expect.arrayContaining([1, B.id]))
    expect((await page({ code: 'ta-b' })).items.map((t: { code: string }) => t.code)).toEqual([
      B.code,
    ])
    // the default tenant's name is a key: found by the text users see
    expect((await page({ name: 'Default tenant' })).items.map((t: { id: number }) => t.id)).toEqual(
      [1],
    )
    expect((await page({ packageId: pkg2.id })).items.map((t: { id: number }) => t.id)).toEqual([
      B.id,
    ])
    expect(
      (await page({ sort: 'code', pageSize: 200 })).items.map((t: { code: string }) => t.code),
    ).toEqual(all.items.map((t: { code: string }) => t.code).sort())
    expect(
      (await page({ enabled: 'false' })).items.filter((t: { id: number }) => t.id === B.id),
    ).toEqual([])
    const options = (await asRoot.get('/options').expect(200)).body.data
    expect(options).toEqual(expect.arrayContaining([{ id: B.id, code: B.code, name: 'Tenant B' }]))
    expect(options[0]).toEqual({ id: 1, code: 'default', name: 'seed.tenant.default' })
  })
})

/** A row only, of a public `cover` object uploaded by `uploaderId` (no body); `over` on top. */
function objectRow(uploaderId: number, over: Record<string, unknown> = {}) {
  const n = ++objectSeq
  return {
    storage_id: storageId,
    object_key: `public/ta-${process.pid}-${n}.png`,
    original_name: 'logo.png',
    mime: 'image/png',
    size: 1,
    is_public: 1,
    public_url: null,
    biz_tag: 'cover',
    uploader_id: uploaderId,
    ...over,
  }
}
