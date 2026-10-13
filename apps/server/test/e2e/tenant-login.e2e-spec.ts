// Password sign-in with tenants (see docs/design-notes.md#tenancy), with two apps on one database: `on`
// (APP_MULTI_TENANT=true) and `off`, and tenant B bound to two host names. The sign-in's tenant is the
// host's, else the typed code, else the default tenant; it only says where the credentials are checked.
// An unknown code, a disabled and an expired tenant answer exactly like a wrong password (same body,
// same full bcrypt, same failure sequence), logged under no tenant (unknown code) or that tenant. Failure
// counters of a code other than `default` live under their own `tp:`/`tu:` segments, so B's guesses lock
// no one elsewhere and each tenant unlocks only its own; the cache monitor shows those keys to root only.
// GET /auth/tenancy tells the sign-in pages whether to ask for a code. A public route's action log row
// needs the resolved tenant: none resolved, no row.
import { setTimeout as sleep } from 'node:timers/promises'
import { Controller, HttpCode, Logger, Post, Req } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ApiExcludeController } from '@nestjs/swagger'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ClsService } from 'nestjs-cls'
import { Err, monitorPerms } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import type { Request } from 'express'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { ActionLog } from '../../src/core/audit/action-log.js'
import { AuthService } from '../../src/core/auth/auth.service.js'
import { Public } from '../../src/core/auth/decorators.js'
import { LoginTenantResolver } from '../../src/core/auth/login-tenant.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { clsGet, clsSet } from '../../src/core/context/cls.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { keyPattern, keyPrefix, redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { agentFor, bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createTenant,
  type TestTenant,
  TENANT_PASSWORD,
} from '../setup/tenants.js'

const HOST_B = 'b.tenant-login.test'
const HOST_B2 = 'portal.b-tenant-login.test'
/** the same username in the default tenant and in B, with different passwords */
const NAME = 'tl-alice'
const PW_A = 'TenantLogin#A-2026'
const UNKNOWN = 'zz-no-such-tenant'
const PREFIX = 'tl-'

@Controller('tenant-login-fixture')
@ApiExcludeController()
class ResolveController {
  constructor(private readonly tenants: LoginTenantResolver) {}

  /** a public write that resolves its sign-in tenant like the SMS and sign-up routes */
  @Post()
  @Public()
  @HttpCode(200)
  @ActionLog({ domain: 'tenantLogin.fixture', verb: 'create', bizId: (req) => req.body?.tag })
  async resolve(@Req() req: Request) {
    const body = req.body as { tenantCode?: string; tag: string }
    return { tenantId: (await this.tenants.resolveLoginTenant(req, body.tenantCode)).tenantId }
  }
}

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: TestTenant
const users: number[] = []
let roleId = 0

const http = (app: NestExpressApplication) => request(app.getHttpServer())
let ip = 0
const nextIp = () => `198.18.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`

interface LoginBody {
  username: string
  password: string
  tenantCode?: string
}
/** POST /api/auth/login from `ip` (default: a fresh one) on `host` (default: none bound). */
function login(
  app: NestExpressApplication,
  body: LoginBody,
  o: { host?: string; ip?: string } = {},
) {
  const req = http(app)
    .post('/api/auth/login')
    .set('X-Forwarded-For', o.ip ?? nextIp())
  return (o.host ? req.set('Host', o.host) : req).send(body)
}
/** The tenant of the session a successful sign-in started. */
const tenantOf = async (res: request.Response) =>
  (await on.get(TokenService).authenticate(res.body.data.accessToken as string))?.tenantId
/** What a client sees of an answer (the trace id aside). */
const answer = (res: request.Response) => {
  const body = { ...(res.body as Record<string, unknown>) }
  delete body.traceId
  return { status: res.status, body }
}
const count = async (...parts: string[]) => redis.get(redisKey('authFail', ...parts))
const signinRows = (username: string) =>
  ds.query<{ tenant_id: number | null; msg_key: string; kind: string }[]>(
    'SELECT tenant_id, msg_key, kind FROM aud_signin_log WHERE username = ? ORDER BY id',
    [username],
  )
const unlinkAll = async (pattern: string) => {
  for await (const keys of redis.scanIterator({ MATCH: pattern, COUNT: 500 }))
    if (keys.length) await redis.unlink(keys)
}
const setB = (col: 'enabled' | 'expires_at', value: unknown) =>
  // column names are this spec's own constants
  ds.query(`UPDATE iam_tenant SET ${col} = ? WHERE id = ?`, [value, B.id])

beforeAll(async () => {
  on = await bootApp({ multiTenant: true, controllers: [ResolveController] })
  off = await bootApp({ multiTenant: false, controllers: [ResolveController] })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { domains: [HOST_B, HOST_B2] })
  await addUser(on, B.id, NAME)
  const a = await addUser(on, 1, NAME)
  users.push(a)
  await ds.query('UPDATE iam_user SET password_hash = ? WHERE id = ?', [
    bcrypt.hashSync(PW_A, 4),
    a,
  ])
})

// every test starts with no failure counters and no rate limit hits
afterEach(async () => {
  vi.restoreAllMocks()
  if (redis) {
    await unlinkAll(keyPattern('authFail'))
    await unlinkAll(keyPattern('throttle'))
  }
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    if (users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ? OR username = ?', [
      `${PREFIX}%`,
      B?.code ?? '',
    ])
    await ds.query("DELETE FROM aud_action_log WHERE domain = 'tenantLogin.fixture'")
    await ds.query(
      "DELETE FROM aud_action_log WHERE domain = 'monitor.cache' AND username LIKE ?",
      [`${PREFIX}%`],
    )
    await ds.query(
      "DELETE FROM aud_action_log WHERE domain = 'audit.signinLog' AND verb = 'unlock' AND biz_id IN (?)",
      [[NAME, B?.code ?? '']],
    )
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
})

describe('which tenant a sign-in checks', () => {
  it('each tenant’s user signs in to its own tenant only; no code = the default tenant; codes ignore case', async () => {
    const a = await login(on, { username: NAME, password: PW_A }).expect(200)
    expect(await tenantOf(a)).toBe(1)
    expect(
      await tenantOf(
        await login(on, { username: NAME, password: PW_A, tenantCode: 'default' }).expect(200),
      ),
    ).toBe(1)
    await login(on, { username: NAME, password: TENANT_PASSWORD }).expect(401)

    const b = await login(on, { username: NAME, password: TENANT_PASSWORD, tenantCode: B.code })
    expect(b.status).toBe(200)
    expect(await tenantOf(b)).toBe(B.id)
    const upper = { username: NAME, password: TENANT_PASSWORD, tenantCode: B.code.toUpperCase() }
    expect(await tenantOf(await login(on, upper).expect(200))).toBe(B.id)
    await login(on, { username: NAME, password: PW_A, tenantCode: B.code }).expect(401)
  })

  it('a host bound to B (either of its two) signs in to B; a code contradicting it is 400 A1041, its own is fine', async () => {
    for (const host of [HOST_B, HOST_B2]) {
      const res = await login(on, { username: NAME, password: TENANT_PASSWORD }, { host })
      expect(res.status).toBe(200)
      expect(await tenantOf(res)).toBe(B.id)
    }
    const typed = { username: NAME, password: TENANT_PASSWORD, tenantCode: B.code }
    expect(await tenantOf(await login(on, typed, { host: HOST_B }).expect(200))).toBe(B.id)
    for (const tenantCode of ['default', UNKNOWN]) {
      const res = await login(on, { username: NAME, password: PW_A, tenantCode }, { host: HOST_B })
      expect(res.status).toBe(400)
      expect(res.body.code).toBe(Err.AUTH_TENANT_HOST_MISMATCH.code)
    }
  })

  it('never on a signed-in request: its tenant stays the session’s', async () => {
    const resolver = on.get(LoginTenantResolver)
    await on.get(ClsService).run(async () => {
      clsSet('principal', { userId: 1 } as Principal)
      await withTenant(1, async () => {
        await expect(resolver.resolveLoginTenant({}, B.code)).rejects.toThrow(/signed-in/)
        expect(clsGet('tenantId')).toBe(1)
      })
    })
  })

  it('with multi-tenancy off the code and the host are ignored: always the default tenant', async () => {
    const typed = { username: NAME, password: PW_A, tenantCode: B.code }
    expect(await tenantOf(await login(off, typed, { host: HOST_B }).expect(200))).toBe(1)
    await login(off, { username: NAME, password: TENANT_PASSWORD }, { host: HOST_B }).expect(401)
  })
})

describe('a code that does not resolve', () => {
  it('an unknown code, a disabled and an expired tenant answer exactly like a wrong password', async () => {
    const wrong = answer(
      await login(on, { username: NAME, password: 'Wrong#2026', tenantCode: B.code }),
    )
    expect(wrong.status).toBe(401)
    expect(wrong.body.code).toBe(Err.AUTH_BAD_CREDENTIALS.code)
    const right = { username: NAME, password: TENANT_PASSWORD }
    expect(answer(await login(on, { ...right, tenantCode: UNKNOWN }))).toEqual(wrong)
    try {
      await setB('enabled', 0)
      expect(answer(await login(on, { ...right, tenantCode: B.code }))).toEqual(wrong)
      expect(answer(await login(on, right, { host: HOST_B })).body.code).toBe(
        Err.AUTH_BAD_CREDENTIALS.code,
      )
      await setB('enabled', 1)
      await setB('expires_at', new Date(Date.now() - 60_000))
      expect(answer(await login(on, { ...right, tenantCode: B.code }))).toEqual(wrong)
    } finally {
      await setB('enabled', 1)
      await setB('expires_at', null)
    }
    // typed codes get a message naming the code; a bound host and multi-tenancy off keep the old one
    const plain = answer(
      await login(on, { username: NAME, password: 'Wrong#2026' }, { host: HOST_B }),
    )
    const old = answer(await login(off, { username: NAME, password: 'Wrong#2026' }))
    expect(plain).toEqual(old)
    expect(plain.body.code).toBe(wrong.body.code)
    expect(plain.body.msg).not.toBe(wrong.body.msg)
  })

  it('an unknown code costs a full bcrypt like an unknown user', async () => {
    const timed = async (body: LoginBody) => {
      const started = performance.now()
      await login(on, body).expect(401)
      return performance.now() - started
    }
    const byCode: number[] = []
    const byUser: number[] = []
    for (let i = 0; i < 3; i++) {
      byCode.push(await timed({ username: NAME, password: 'Wrong#2026', tenantCode: UNKNOWN }))
      byUser.push(await timed({ username: `${PREFIX}nobody`, password: 'Wrong#2026' }))
    }
    expect(Math.min(...byCode)).toBeGreaterThan(Math.min(...byUser) / 2)
  })

  it('repeated failures answer the same sequence for an existing and an unknown code', async () => {
    const sequence = async (tenantCode: string) => {
      const out: string[] = []
      for (const at of [nextIp(), nextIp()])
        for (let i = 0; i < 6; i++) {
          const res = await login(
            on,
            { username: NAME, password: 'Wrong#2026', tenantCode },
            { ip: at },
          )
          out.push(`${res.status} ${res.body.code} ${res.body.msg}`)
        }
      return out
    }
    const existing = await sequence(B.code)
    expect(new Set(existing.map((s) => s.split(' ')[1]))).toEqual(
      new Set([
        Err.AUTH_BAD_CREDENTIALS.code,
        Err.AUTH_LOCKED.code,
        Err.AUTH_CAPTCHA_REQUIRED.code,
      ]),
    )
    expect(await sequence(UNKNOWN)).toEqual(existing)
    // a disabled tenant's failures count as well: it locks like any other, its code tells nothing
    await unlinkAll(keyPattern('authFail'))
    try {
      await setB('enabled', 0)
      expect(await sequence(B.code)).toEqual(existing)
    } finally {
      await setB('enabled', 1)
    }
  })

  it('sign-in log: an unknown code under no tenant (the default tenant’s admins never see it), a disabled tenant under itself', async () => {
    const probe = `${PREFIX}probe`
    await login(on, { username: probe, password: 'Wrong#2026', tenantCode: UNKNOWN }).expect(401)
    try {
      await setB('enabled', 0)
      await login(on, { username: probe, password: 'Wrong#2026', tenantCode: B.code }).expect(401)
    } finally {
      await setB('enabled', 1)
    }
    await vi.waitFor(async () => expect(await signinRows(probe)).toHaveLength(2))
    expect(await signinRows(probe)).toEqual([
      { tenant_id: null, msg_key: 'signin.tenant_unavailable', kind: 'password' },
      { tenant_id: B.id, msg_key: 'signin.tenant_unavailable', kind: 'password' },
    ])
    const admin = await agentFor(on)
    const listed = await admin.get('/api/audit/signin-logs').query({ username: probe }).expect(200)
    expect(listed.body.data.total).toBe(0)
  })
})

describe('failure counters', () => {
  it('B’s failures count under tp:/tu: and lock no one in the default tenant; blank and `default` keep p:/u:', async () => {
    const at = nextIp()
    const codes: string[] = []
    for (let i = 0; i < 5; i++)
      codes.push(
        (
          await login(
            on,
            { username: NAME, password: 'Wrong#2026', tenantCode: B.code },
            { ip: at },
          )
        ).body.code,
      )
    expect(codes.at(-1)).toBe(Err.AUTH_LOCKED.code)
    expect(await count('tp', B.code, NAME, at)).toBe('5')
    expect(await count('tu', B.code, NAME)).toBe('5')
    expect(await count('p', NAME, at)).toBeNull()
    expect(await count('u', NAME)).toBeNull()
    // the default tenant's user with the same name on the same IP
    await login(on, { username: NAME, password: PW_A }, { ip: at }).expect(200)

    const other = nextIp()
    await login(on, { username: NAME, password: 'Wrong#2026' }, { ip: other }).expect(401)
    const typed = { username: NAME, password: 'Wrong#2026', tenantCode: 'DEFAULT' }
    await login(on, typed, { ip: other }).expect(401)
    expect(await count('p', NAME, other)).toBe('2')
    expect(await count('u', NAME)).toBe('2')
    // an unknown code counts too, under its own segment
    await login(on, { ...typed, tenantCode: UNKNOWN }, { ip: other }).expect(401)
    expect(await count('tp', UNKNOWN, NAME, other)).toBe('1')
    expect(await count('p', NAME, other)).toBe('2')
  })

  it('an unlock reaches only its own tenant’s counters', async () => {
    const at = nextIp()
    await login(on, { username: NAME, password: 'Wrong#2026' }, { ip: at }).expect(401)
    await login(
      on,
      { username: NAME, password: 'Wrong#2026', tenantCode: B.code },
      { ip: at },
    ).expect(401)
    // the default tenant's admin, through the sign-in log page
    const admin = await agentFor(on)
    await admin.post('/api/audit/signin-logs/unlock').send({ username: NAME }).expect(200)
    expect(await count('p', NAME, at)).toBeNull()
    expect(await count('u', NAME)).toBeNull()
    expect(await count('tp', B.code, NAME, at)).toBe('1')
    expect(await count('tu', B.code, NAME)).toBe('1')

    await login(on, { username: NAME, password: 'Wrong#2026' }, { ip: at }).expect(401)
    // as B's sign-in log page runs it (its users hold no unlock perm here)
    await withTenant(B.id, () => on.get(AuthService).unlock(NAME))
    expect(await count('tp', B.code, NAME, at)).toBeNull()
    expect(await count('tu', B.code, NAME)).toBeNull()
    expect(await count('p', NAME, at)).toBe('1')
  })

  it('unlocking a default-tenant username spelled like B’s code leaves B’s counters alone', async () => {
    const at = nextIp()
    await login(
      on,
      { username: NAME, password: 'Wrong#2026', tenantCode: B.code },
      { ip: at },
    ).expect(401)
    const admin = await agentFor(on)
    await admin.post('/api/audit/signin-logs/unlock').send({ username: B.code }).expect(200)
    expect(await count('tp', B.code, NAME, at)).toBe('1')
  })

  it('B’s counters left behind with multi-tenancy off: a non-root cache reader sees none of them, root does', async () => {
    const at = nextIp()
    await login(
      on,
      { username: NAME, password: 'Wrong#2026', tenantCode: B.code },
      { ip: at },
    ).expect(401)
    await login(off, { username: NAME, password: 'Wrong#2026' }, { ip: at }).expect(401)
    const bare = (...parts: string[]) => redisKey('authFail', ...parts).slice(keyPrefix().length)
    const theirs = [bare('tp', B.code, NAME, at), bare('tu', B.code, NAME)]
    const ours = [bare('p', NAME, at), bare('u', NAME), bare('ip', at)]

    const { insertId } = await ds.query<{ insertId: number }>(
      "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES ('tl-cache', 'tl-cache', 'all', 1)",
    )
    roleId = Number(insertId)
    const menus = await ds.query<{ id: number }[]>(
      "SELECT id FROM iam_menu WHERE kind = 'action' AND perms IN (?) AND deleted_at IS NULL",
      [[monitorPerms.cache, monitorPerms.cacheClear]],
    )
    expect(menus).toHaveLength(2)
    for (const menu of menus)
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
        roleId,
        menu.id,
      ])
    users.push(await addUser(off, 1, `${PREFIX}cache-reader`, { roleId }))
    const reader = (await signIn(off, `${PREFIX}cache-reader`)).accessToken
    const root = (await signIn(off)).accessToken
    const keys = async (token: string) =>
      (
        await http(off)
          .get('/api/monitor/cache/keys')
          .query({ ns: 'authFail' })
          .set(bearer(token))
          .expect(200)
      ).body.data.keys as string[]
    const value = (token: string, key: string) =>
      http(off).get('/api/monitor/cache/value').query({ key }).set(bearer(token))
    const remove = (token: string, key: string) =>
      http(off).delete('/api/monitor/cache/keys').query({ key }).set(bearer(token))

    const seen = await keys(reader)
    expect(seen).toEqual(expect.arrayContaining(ours))
    expect(seen.filter((k) => theirs.includes(k))).toEqual([])
    for (const key of theirs) expect((await value(reader, key)).status).toBe(404)
    expect((await value(reader, ours[0]!)).status).toBe(200)
    // deleting one: another tenant's is not found (404), the reader's own is not clearable (422)
    for (const key of theirs) expect((await remove(reader, key)).status).toBe(404)
    expect((await remove(reader, ours[0]!)).status).toBe(422)

    expect(await keys(root)).toEqual(expect.arrayContaining([...ours, ...theirs]))
    for (const key of theirs) expect((await value(root, key)).body.data.value).toBe('1')
  })
})

describe('GET /auth/tenancy', () => {
  it('on: the host’s tenant only on a bound host; off: just that it is off', async () => {
    const get = (app: NestExpressApplication, host?: string) => {
      const req = http(app).get('/api/auth/tenancy').set('X-Forwarded-For', nextIp())
      return (host ? req.set('Host', host) : req).expect(200)
    }
    expect((await get(on)).body.data).toEqual({ enabled: true })
    expect((await get(on, HOST_B2)).body.data).toEqual({
      enabled: true,
      tenant: { code: B.code, name: B.code, brandName: null, logoUrl: null },
    })
    expect((await get(off, HOST_B)).body.data).toEqual({ enabled: false })
  })

  it('is rate limited per IP', async () => {
    const at = nextIp()
    const get = () => http(on).get('/api/auth/tenancy').set('X-Forwarded-For', at)
    for (let i = 0; i < 60; i++) await get().expect(200)
    const res = await get()
    expect(res.status).toBe(429)
    expect(res.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
  })
})

describe('the action log of a public route', () => {
  it('no row and no error when the sign-in tenant did not resolve; the resolved tenant acts in its own', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const resolve = (tenantCode: string, tag: string) =>
      http(on).post('/api/tenant-login-fixture').send({ tenantCode, tag }).expect(200)
    expect((await resolve(UNKNOWN, 'tl-unknown')).body.data).toEqual({ tenantId: null })
    expect((await resolve(B.code, 'tl-b')).body.data).toEqual({ tenantId: B.id })
    const rows = () =>
      ds.query<{ biz_id: string; tenant_id: number; actor_tenant_id: number }[]>(
        "SELECT biz_id, tenant_id, actor_tenant_id FROM aud_action_log WHERE domain = 'tenantLogin.fixture'",
      )
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1))
    await sleep(200)
    expect(await rows()).toEqual([{ biz_id: 'tl-b', tenant_id: B.id, actor_tenant_id: B.id }])
    expect(error).not.toHaveBeenCalled()
  })
})
