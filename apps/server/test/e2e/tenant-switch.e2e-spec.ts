// The multi-tenancy switch and a tenant's end (see docs/design-notes.md#tenancy), with two apps on one
// database: `on` (APP_MULTI_TENANT=true) and `off`, and tenant B (bound to its own host) whose users
// share the default tenant's names. Off, B is unavailable: its users cannot sign in, its sessions end on
// their next request, refresh or socket recheck (401 A1042), the online list leaves them out, and the
// background scans (notification outbox, approval reminders) leave its rows alone without holding back
// the default tenant's. A session that does not name its tenant is reloaded, never taken for the
// default tenant's. On, a disabled or expired tenant signs nobody in and the scans pass it by;
// revokeTenant ends its sessions and sockets; a tenant end set later caps the sessions (a refresh
// alone too, and idle sockets through the minute recheck). The host's tenant refuses another tenant's
// token (request and refresh) without ending it. A replayed refresh token is logged in its session's
// tenant.
// A platform user inside B when the switch goes off leaves it on its next request, recorded in the default
// tenant, and works in its own tenant again.
// The startup check (production with multi-tenancy on needs hardened tenant columns) and the
// tenant-disable command.
import { setTimeout as sleep } from 'node:timers/promises'
import { Controller, Get, Logger } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ApiExcludeController } from '@nestjs/swagger'
import { Err, RT } from '@qiwu/shared'
import type { Server } from 'socket.io'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { TENANT_LOOKUP, type TenantLookup } from '../../src/core/auth/tenant-lookup.js'
import {
  REFRESH_GRACE_MS,
  type Session,
  TENANT_UNAVAILABLE,
  TokenService,
} from '../../src/core/auth/token.service.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import type { Env } from '../../src/core/config/env.schema.js'
import { clsGet } from '../../src/core/context/cls.js'
import { tenantId, withTenant } from '../../src/core/context/tenant.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { RealtimeService, rooms } from '../../src/core/realtime/realtime.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { hardenTenancy } from '../../src/db/tenancy-harden.js'
import { disableTenants } from '../../src/db/tenant-disable.js'
import { TenancyStartup } from '../../src/modules/platform/iam/tenant/tenancy-startup.js'
import { WfRemind } from '../../src/modules/workflow/runtime/wf-remind.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, inbox, socketOf } from '../setup/socket.js'
import {
  bootApp,
  createTenant,
  loginAs,
  type PeopledTenant,
  signInDirect,
  TENANT_PASSWORD,
} from '../setup/tenants.js'

const HOST_B = 'b.tenant-switch.test'
/** `X-Request-Id` prefix of this spec's requests whose audit rows it deletes */
const TRACE = `tenant-switch-${process.pid}-`

@Controller('tenant-switch-fixture')
@ApiExcludeController()
class WhereController {
  /** the tenant a signed-in request runs in, and its actor's */
  @Get()
  where() {
    return { tenantId: tenantId(), actorTenantId: clsGet('actorTenantId') ?? null }
  }
}
const UA = 'vitest'

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
/** default-tenant rows this spec inserted: [table, id] */
const mine: [string, number][] = []

const http = (app: NestExpressApplication) => request(app.getHttpServer())
const me = (app: NestExpressApplication, token: string, host?: string) => {
  const req = http(app).get('/api/auth/me').set(bearer(token))
  return host ? req.set('Host', host) : req
}
/** A mobile session's refresh (body token: no cookie, no Origin), on `host` when given. */
const refresh = (app: NestExpressApplication, refreshToken: string, host?: string) => {
  const req = http(app).post('/api/auth/refresh').set('User-Agent', UA)
  return (host ? req.set('Host', host) : req).send({ refreshToken })
}
const mobile = async (userId: number) => (await signInDirect(on, userId, { clientId: 'mobile' }))!
const stored = async (sid: string) =>
  JSON.parse((await redis.get(redisKey('authSession', sid)))!) as Session
const job = { signal: new AbortController().signal, log: () => {} }
/** Runs `fn` with `app` reading multi-tenancy as `value` (as after a restart with it). */
async function switched<T>(app: NestExpressApplication, value: boolean, fn: () => Promise<T>) {
  const cfg = app.get(AppConfigService)
  const get = cfg.get.bind(cfg)
  const spy = vi
    .spyOn(cfg, 'get')
    .mockImplementation(((key: keyof Env) =>
      key === 'APP_MULTI_TENANT' ? value : get(key)) as AppConfigService['get'])
  try {
    return await fn()
  } finally {
    spy.mockRestore()
  }
}
const setTenant = async (row: { enabled?: 0 | 1; expires_at?: Date | null }) => {
  if (row.enabled !== undefined)
    await ds.query('UPDATE iam_tenant SET enabled = ? WHERE id = ?', [row.enabled, B.id])
  if (row.expires_at !== undefined)
    await ds.query('UPDATE iam_tenant SET expires_at = ? WHERE id = ?', [row.expires_at, B.id])
}
/** As the tenant page will do once tenants are managed: commit the row, end its sessions, reload all. */
async function endTenant(row: { enabled?: 0 | 1; expires_at?: Date | null }) {
  await setTenant(row)
  await on.get(SessionRevoker).revokeTenant(B.id, TENANT_UNAVAILABLE)
  await on.get(PermVersion).bumpAll()
}
const restoreTenant = async () => {
  await setTenant({ enabled: 1, expires_at: null })
  await on.get(PermVersion).bumpAll()
}
const insertMine = async (table: string, row: Record<string, unknown>) => {
  const id = await insertRow(ds.manager, table, { ...row, tenant_id: 1 })
  mine.push([table, id])
  return id
}

beforeAll(async () => {
  // only the periodic socket recheck is advanced by hand; everything else keeps real time
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  on = await bootApp({ multiTenant: true, controllers: [WhereController] })
  off = await bootApp({ multiTenant: false, controllers: [WhereController] })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true, domains: [HOST_B] })
})

afterAll(async () => {
  try {
    closeSockets()
    if (ds) {
      await B?.dispose()
      for (const table of ['aud_action_log', 'aud_http_trace'])
        // table names from the list above
        await ds.query(`DELETE FROM ${table} WHERE trace_id LIKE ?`, [`${TRACE}%`])
      for (const [table, id] of mine)
        // table names are this spec's own constants
        await ds.query(`DELETE FROM ${table} WHERE id = ?`, [id])
    }
    if (redis) await cleanRedis(redis)
    await on?.close()
    await off?.close()
  } finally {
    vi.useRealTimers()
  }
})

describe('multi-tenancy off', () => {
  it('B’s users cannot sign in, even with its code and their password', async () => {
    for (const username of ['admin', 'alice']) {
      const res = await loginAs(off, {
        tenantCode: B.code,
        username,
        password: TENANT_PASSWORD,
      })
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.AUTH_BAD_CREDENTIALS.code)
    }
    // off, the code in the body is ignored (credentials are checked in the default tenant): the paths
    // that issue from a user id (SMS, mini program, OAuth code) are held by the identity load alone
    expect(await off.get(PermVersion).load(B.users.alice)).toBeNull()
    expect(await signInDirect(off, B.users.alice)).toBeNull()
    expect(await signInDirect(on, B.users.alice)).not.toBeNull()
  })

  it('a session of B ends on its next request (401 A1042) and is gone', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    await me(on, b.accessToken).expect(200)
    const res = await me(off, b.accessToken)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.AUTH_TENANT_INACTIVE.code)
    expect(await on.get(TokenService).load(b.session.sid)).toBeNull()
    expect((await me(on, b.accessToken)).status).toBe(401)
  })

  it('a refresh of B’s session ends it (401 A1042), untouched by rotation', async () => {
    const b = await mobile(B.users.admin)
    const res = await refresh(off, b.refreshToken)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.AUTH_TENANT_INACTIVE.code)
    expect(await on.get(TokenService).load(b.session.sid)).toBeNull()
    // the default tenant's still refresh
    const a = await signIn(off, 'admin', { clientId: 'mobile', ua: UA })
    await refresh(off, a.refreshToken).expect(200)
  })

  it('an idle socket of B ends at the next minute recheck, told why', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    const a = await signIn(on)
    const bSocket = await connect(socketOf(on, { token: b.accessToken }))
    const aSocket = await connect(socketOf(on, { token: a.accessToken }))
    const got = inbox(bSocket)
    await switched(on, false, async () => {
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(bSocket.connected).toBe(false), { timeout: 3_000 })
    })
    expect(got).toEqual([
      { type: RT.sessionKicked, payload: { sid: b.session.sid, reason: TENANT_UNAVAILABLE } },
    ])
    expect(aSocket.connected).toBe(true)
    expect(await on.get(TokenService).load(b.session.sid)).toBeNull()
  })

  it('a platform user inside B leaves it on its next request, logged in the default tenant (the switch is off), and works in its own tenant again', async () => {
    const s = await signIn(on)
    const call = (app: NestExpressApplication, trace: string) =>
      http(app)
        .get('/api/tenant-switch-fixture')
        .set(bearer(s.accessToken))
        .set('X-Request-Id', TRACE + trace)
    await http(on)
      .post(`/api/iam/tenants/${B.id}/enter`)
      .set(bearer(s.accessToken))
      .set('X-Request-Id', `${TRACE}enter`)
      .send({ reason: 'switch check' })
      .expect(200)
    expect((await call(on, 'inside').expect(200)).body.data).toEqual({
      tenantId: B.id,
      actorTenantId: 1,
    })
    expect((await call(off, 'off').expect(200)).body.data).toEqual({
      tenantId: 1,
      actorTenantId: 1,
    })
    const left = await logOf(ds, `${TRACE}off`)
    expect(left).toMatchObject({
      domain: 'iam.tenant',
      verb: 'leave',
      biz_id: String(B.id),
      user_id: s.session.userId,
      tenant_id: 1,
      actor_tenant_id: 1,
    })
    expect(JSON.parse(left.params)).toMatchObject({ reason: 'tenancy_off' })
    expect((await on.get(TokenService).load(s.session.sid))?.actingTenantId).toBeUndefined()
    // back on, it stays in its own tenant
    expect((await call(on, 'after').expect(200)).body.data).toEqual({
      tenantId: 1,
      actorTenantId: 1,
    })
  })

  it('the online list leaves B’s sessions out', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    const a = await signIn(on)
    const sids = async (app: NestExpressApplication) =>
      (await app.get(TokenService).online()).map((s) => s.sid)
    expect(await sids(on)).toEqual(expect.arrayContaining([b.session.sid, a.session.sid]))
    const offList = await sids(off)
    expect(offList).toContain(a.session.sid)
    expect(offList).not.toContain(b.session.sid)
  })
})

describe.each<[string, 'on' | 'off', { enabled?: 0 | 1; expires_at?: Date | null }]>([
  ['multi-tenancy off', 'off', {}],
  ['multi-tenancy on, B disabled', 'on', { enabled: 0 }],
  ['multi-tenancy on, B past its end', 'on', { expires_at: new Date(Date.now() - 1000) }],
])('the background scans, %s', (_, which, row) => {
  const app = () => (which === 'on' ? on : off)
  beforeEach(() => setTenant(row))
  afterEach(restoreTenant)

  it('the outbox and the approval reminders leave B’s rows alone, going on with the default tenant’s', async () => {
    const inboxRow = (userId: number) => ({
      user_id: userId,
      template_code: 'tenant-switch',
      locale: 'en-US',
      category: 'system',
      title: 'Tenant switch',
      body: 'Tenant switch',
    })
    const bRow = await withTenant(B.id, () =>
      insertRow(ds.manager, 'msg_inbox', { ...inboxRow(B.users.alice), tenant_id: B.id }),
    )
    const aRow = await insertMine('msg_inbox', inboxRow(1))
    const attempts = async (table: string, ids: number[]) =>
      (
        await ds.query<{ attempts: number }[]>(
          // table names are this spec's own constants
          `SELECT attempts FROM ${table} WHERE id IN (?) ORDER BY id`,
          [ids],
        )
      ).map((r) => Number(r.attempts))
    await app().get(NotifyDispatcher).dispatch({}, job)
    expect(await attempts('msg_inbox', [bRow])).toEqual([0])
    expect(await attempts('msg_inbox', [aRow])).toEqual([1])

    const instanceRow = {
      version_id: 0,
      model_key: 'tenant-switch',
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
    const task = await withTenant(B.id, async () => {
      const instance = await insertRow(ds.manager, 'wf_instance', {
        ...instanceRow,
        initiator_id: B.users.alice,
        tenant_id: B.id,
      })
      return insertRow(ds.manager, 'wf_task', {
        ...taskRow(instance, B.users.admin),
        tenant_id: B.id,
      })
    })
    const aInstance = await insertMine('wf_instance', { ...instanceRow, initiator_id: 1 })
    const aTask = await insertMine('wf_task', taskRow(aInstance, 1))
    const reminded = async (target: NestExpressApplication) => {
      const remind = target.get(WfRemind, { strict: false })
      const one = vi.spyOn(remind, 'remindOne').mockResolvedValue(false)
      try {
        await remind.remind({}, job)
        return one.mock.calls.map(([id]) => id)
      } finally {
        one.mockRestore()
      }
    }
    const candidates = await reminded(app())
    expect(candidates).not.toContain(task)
    expect(candidates).toContain(aTask)
    // B is available again with multi-tenancy on: the same task is a candidate there
    await restoreTenant()
    expect(await reminded(on)).toContain(task)
  })

  it.each<[string, (tenantId: number) => Record<string, unknown>]>([
    [
      'msg_mail_record',
      () => ({
        to_list: JSON.stringify(['someone@example.test']),
        locale: 'en-US',
        subject: 'Tenant switch',
      }),
    ],
    ['msg_sms_record', () => ({ mobile: '13800138000' })],
    [
      'msg_inbox',
      (tenantId) => ({
        user_id: tenantId === B.id ? B.users.alice : 1,
        locale: 'en-US',
        category: 'system',
        title: 'Tenant switch',
      }),
    ],
  ])(
    'more than a batch (100) of B’s due %s never holds back the default tenant’s',
    async (table, extra) => {
      const row = (tenantId: number, createdAt: Date) => ({
        ...extra(tenantId),
        template_code: 'tenant-switch',
        body: 'Tenant switch',
        created_at: createdAt,
        tenant_id: tenantId,
      })
      const old = new Date(Date.now() - 86_400_000)
      const bIds: number[] = []
      await withTenant(B.id, async () => {
        for (let i = 0; i < 101; i++) bIds.push(await insertRow(ds.manager, table, row(B.id, old)))
      })
      const aId = await insertMine(table, row(1, new Date()))
      await app().get(NotifyDispatcher).dispatch({}, job)
      const rows = await ds.query<{ id: number; attempts: number }[]>(
        // table names are this spec's own constants
        `SELECT id, attempts FROM ${table} WHERE id IN (?)`,
        [[...bIds, aId]],
      )
      const attemptsOf = new Map(rows.map((r) => [Number(r.id), Number(r.attempts)]))
      expect(attemptsOf.get(aId)).toBe(1)
      expect(bIds.filter((id) => attemptsOf.get(id) !== 0)).toEqual([])
    },
  )
})

describe('a session that does not name its tenant (signed before it was recorded)', () => {
  it('is reloaded from its user: another tenant’s user is ended (401), never taken for the default tenant', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    const key = redisKey('authSession', b.session.sid)
    const { tenantId: _, ...older } = await stored(b.session.sid)
    await redis.set(key, JSON.stringify(older), { KEEPTTL: true })
    expect((await me(on, b.accessToken)).status).toBe(401)
    expect(await redis.exists(key)).toBe(0)
  })

  it('a default-tenant user’s is written back with its tenant and goes on', async () => {
    const a = await signIn(on)
    const key = redisKey('authSession', a.session.sid)
    const { tenantId: _, ...older } = await stored(a.session.sid)
    await redis.set(key, JSON.stringify(older), { KEEPTTL: true })
    await me(on, a.accessToken).expect(200)
    expect((await stored(a.session.sid)).tenantId).toBe(1)
  })

  it('a refresh alone reloads it the same way: another tenant’s user is ended (401), a default-tenant user’s rotates with its tenant written back', async () => {
    const strip = async (sid: string) => {
      const { tenantId: _, ...older } = await stored(sid)
      await redis.set(redisKey('authSession', sid), JSON.stringify(older), { KEEPTTL: true })
    }
    const b = await mobile(B.users.alice)
    await strip(b.session.sid)
    expect((await refresh(on, b.refreshToken)).status).toBe(401)
    expect(await redis.exists(redisKey('authSession', b.session.sid))).toBe(0)
    const a = await signIn(on, 'admin', { clientId: 'mobile', ua: UA })
    await strip(a.session.sid)
    await refresh(on, a.refreshToken).expect(200)
    expect((await stored(a.session.sid)).tenantId).toBe(1)
  })

  it('a user session without its tenant is never issued', async () => {
    const user = (await on.get(PermVersion).load(B.users.alice))!
    const { tenantId: _, ...nameless } = user
    await expect(
      on.get(TokenService).issue(nameless, { keepSignedIn: false, ip: '127.0.0.1', ua: UA }),
    ).rejects.toThrow(/tenant/)
  })
})

describe('multi-tenancy on: a tenant that ends', () => {
  afterEach(restoreTenant)

  it('disabled or expired, it signs nobody in', async () => {
    expect(await signInDirect(on, B.users.alice)).not.toBeNull()
    await endTenant({ enabled: 0 })
    expect(await signInDirect(on, B.users.alice)).toBeNull()
    await restoreTenant()
    await endTenant({ expires_at: new Date(Date.now() - 1000) })
    expect(await signInDirect(on, B.users.alice)).toBeNull()
  })

  it('a refresh alone (no other request) reloads a session whose permVer moved: capped at the tenant’s end', async () => {
    const b = await mobile(B.users.alice)
    const end = new Date(Date.now() + 3_600_000)
    await setTenant({ expires_at: end })
    await on.get(PermVersion).bumpAll()
    const before = Date.now()
    const res = await refresh(on, b.refreshToken).expect(200)
    expect((await stored(b.session.sid)).absoluteExpAt).toBe(end.getTime())
    expect(res.body.data.refreshExpiresIn).toBeLessThanOrEqual(
      Math.ceil((end.getTime() - before) / 1000),
    )
  })

  it('revokeTenant ends every session and socket of it, told why; other tenants keep theirs', async () => {
    const b1 = (await signInDirect(on, B.users.alice))!
    const b2 = await mobile(B.users.admin)
    const a = await signIn(on)
    const bSocket = await connect(socketOf(on, { token: b1.accessToken }))
    const aSocket = await connect(socketOf(on, { token: a.accessToken }))
    const got = inbox(bSocket)
    const aGot = inbox(aSocket)
    const ended = await on.get(SessionRevoker).revokeTenant(B.id, TENANT_UNAVAILABLE)
    expect(ended).toBeGreaterThanOrEqual(2)
    await vi.waitFor(() => expect(bSocket.connected).toBe(false), { timeout: 3_000 })
    expect(got).toEqual([
      { type: RT.sessionKicked, payload: { sid: b1.session.sid, reason: TENANT_UNAVAILABLE } },
    ])
    const tokens = on.get(TokenService)
    expect(await tokens.load(b1.session.sid)).toBeNull()
    expect(await tokens.load(b2.session.sid)).toBeNull()
    expect(aSocket.connected).toBe(true)
    expect(aGot).toEqual([])
    await me(on, a.accessToken).expect(200)
  })

  it('an end set later caps every session at it (sign-in and reload); then they end, idle sockets at the next recheck', async () => {
    const b = (await signInDirect(on, B.users.alice, { keepSignedIn: true }))!
    const socket = await connect(socketOf(on, { token: b.accessToken }))
    const got = inbox(socket)
    const d = (await signInDirect(on, B.users.admin, { keepSignedIn: true }))!
    const end = new Date(Date.now() + 3_000)
    await setTenant({ expires_at: end })
    await on.get(PermVersion).bumpAll()
    // a request reloads its session: capped at the tenant's end
    await me(on, d.accessToken).expect(200)
    expect((await stored(d.session.sid)).absoluteExpAt).toBe(end.getTime())
    // a sign-in now ends with the tenant, not 7 days later
    const c = (await signInDirect(on, B.users.admin, { keepSignedIn: true }))!
    expect(c.session.absoluteExpAt).toBe(end.getTime())
    expect(c.session.tenantExpAt).toBe(end.getTime())
    // the idle socket's session is reloaded by the recheck: capped, still alive
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(async () =>
      expect((await stored(b.session.sid)).tenantExpAt).toBe(end.getTime()),
    )
    expect((await stored(b.session.sid)).absoluteExpAt).toBe(end.getTime())
    expect(socket.connected).toBe(true)
    await sleep(end.getTime() - Date.now() + 50)
    // its access token outlived the end (issued before it): the session ends with its tenant
    const res = await me(on, d.accessToken)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.AUTH_TENANT_INACTIVE.code)
    // one issued with the end in view has no token left
    expect((await me(on, c.accessToken)).status).toBe(401)
    expect(socket.connected).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(socket.connected).toBe(false), { timeout: 3_000 })
    expect(got).toEqual([
      { type: RT.sessionKicked, payload: { sid: b.session.sid, reason: TENANT_UNAVAILABLE } },
    ])
  })

  it('disabled without revokeTenant: a request ends its session (401 A1042), an idle socket the recheck, told why', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    const idle = (await signInDirect(on, B.users.admin))!
    const socket = await connect(socketOf(on, { token: idle.accessToken }))
    const got = inbox(socket)
    await setTenant({ enabled: 0 })
    await on.get(PermVersion).bumpAll()
    const res = await me(on, b.accessToken)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.AUTH_TENANT_INACTIVE.code)
    expect(await on.get(TokenService).load(b.session.sid)).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(socket.connected).toBe(false), { timeout: 3_000 })
    expect(got).toContainEqual({
      type: RT.sessionKicked,
      payload: { sid: idle.session.sid, reason: TENANT_UNAVAILABLE },
    })
    expect(await on.get(TokenService).load(idle.session.sid)).toBeNull()
  })

  it('a socket handshake reloads its session: capped at an end set later, the socket too', async () => {
    const b = (await signInDirect(on, B.users.alice, { keepSignedIn: true }))!
    const end = new Date(Date.now() + 3_600_000)
    await setTenant({ expires_at: end })
    await on.get(PermVersion).bumpAll()
    await connect(socketOf(on, { token: b.accessToken }))
    expect((await stored(b.session.sid)).absoluteExpAt).toBe(end.getTime())
    const server = (on.get(RealtimeService) as unknown as { server: Server }).server
    const [socket] = await server.in(rooms.session(b.session.sid)).fetchSockets()
    expect(socket?.data.endsAt).toBe(end.getTime())
  })
})

describe('a replayed refresh token (multi-tenancy on)', () => {
  it('is logged as refresh_reuse in its session’s tenant', async () => {
    const b = await mobile(B.users.alice)
    await refresh(on, b.refreshToken).expect(200)
    // past the grace window; only Date.now moves: the socket recheck's fake interval stays installed
    const later = Date.now() + REFRESH_GRACE_MS + 1000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later)
    try {
      expect((await refresh(on, b.refreshToken)).status).toBe(401)
    } finally {
      clock.mockRestore()
    }
    await vi.waitFor(async () =>
      expect(
        (
          await ds.query<{ tenant_id: number }[]>(
            "SELECT tenant_id FROM aud_signin_log WHERE kind = 'refresh_reuse' AND user_id = ?",
            [B.users.alice],
          )
        ).map((r) => Number(r.tenant_id)),
      ).toEqual([B.id]),
    )
  })
})

describe('a signed-in request (multi-tenancy on)', () => {
  it('runs in its session’s tenant, the actor’s too', async () => {
    const where = async (token: string) =>
      (await http(on).get('/api/tenant-switch-fixture').set(bearer(token)).expect(200)).body.data
    const b = (await signInDirect(on, B.users.alice))!
    expect(await where(b.accessToken)).toEqual({ tenantId: B.id, actorTenantId: B.id })
    expect(await where((await signIn(on)).accessToken)).toEqual({ tenantId: 1, actorTenantId: 1 })
  })

  it('a socket runs in its session’s tenant', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    await connect(socketOf(on, { token: b.accessToken }))
    const server = (on.get(RealtimeService) as unknown as { server: Server }).server
    const [socket] = await server.in(rooms.session(b.session.sid)).fetchSockets()
    expect(socket?.data).toMatchObject({ userId: B.users.alice, tenantId: B.id })
  })
})

describe('the host’s tenant (multi-tenancy on)', () => {
  it('a token of another tenant on a host bound to B answers 401 and the session stays', async () => {
    const a = await signIn(on)
    expect((await me(on, a.accessToken, HOST_B)).status).toBe(401)
    await me(on, a.accessToken).expect(200)
    const b = (await signInDirect(on, B.users.alice))!
    await me(on, b.accessToken, HOST_B).expect(200)
    // off, no host counts
    const a2 = await signIn(off)
    await me(off, a2.accessToken, HOST_B).expect(200)
  })

  it('a refresh on B’s host refuses another tenant’s token untouched; on its own host it still rotates', async () => {
    const a = await signIn(on, 'admin', { clientId: 'mobile', ua: UA })
    const res = await refresh(on, a.refreshToken, HOST_B)
    expect(res.status).toBe(401)
    expect(res.body.code).toBe(Err.AUTH_REFRESH_REJECTED.code)
    await refresh(on, a.refreshToken).expect(200)
    const b = await mobile(B.users.alice)
    await refresh(on, b.refreshToken, HOST_B).expect(200)
  })

  it('a made-up refresh token is refused before the host is looked up', async () => {
    const byHost = vi.spyOn(on.get<TenantLookup>(TENANT_LOOKUP), 'byHost')
    try {
      const res = await refresh(on, 'A'.repeat(43), 'unbound.tenant-switch.test')
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.AUTH_REFRESH_REJECTED.code)
      expect(byHost).not.toHaveBeenCalled()
    } finally {
      byHost.mockRestore()
    }
  })

  it('the refresh cookie stays host-only (no Domain)', async () => {
    const a = await signIn(on, 'admin', { ua: UA })
    const { port } = on.getHttpServer().address() as { port: number }
    const res = await http(on)
      .post('/api/auth/refresh')
      .set('User-Agent', UA)
      .set('Origin', `http://127.0.0.1:${port}`)
      .set('Cookie', `qw_rt=${a.refreshToken}`)
      .expect(200)
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? [])
    const rt = cookies.find((c) => c.startsWith('qw_rt='))
    expect(rt).toBeDefined()
    expect(rt).not.toMatch(/domain=/i)
  })
})

describe('startup', () => {
  /** The startup check against `query` (a watched data source) with this env. */
  const check = (
    env: Partial<Env>,
    query: (sql: string) => Promise<unknown> = vi.fn(async () => []),
  ) => ({
    query,
    run: () =>
      new TenancyStartup(
        { query } as unknown as DataSource,
        { get: (key: keyof Env) => env[key] } as unknown as AppConfigService,
      ).onModuleInit(),
  })

  it('production with multi-tenancy on starts on hardened tenant columns, is refused while one has its default back, until hardened again; tests and production off start', async () => {
    expect(on.get(TenancyStartup, { strict: false })).toBeInstanceOf(TenancyStartup)
    const prodOn = () =>
      check({ NODE_ENV: 'production', APP_MULTI_TENANT: true }, vi.fn(ds.query.bind(ds))).run()
    await expect(prodOn()).resolves.toBeUndefined()
    try {
      await ds.query('ALTER TABLE demo_book ALTER COLUMN tenant_id SET DEFAULT 1')
      await ds.query('ALTER TABLE aud_action_log ALTER COLUMN actor_tenant_id SET DEFAULT 1')
      await expect(prodOn()).rejects.toThrow(
        /\(aud_action_log\.actor_tenant_id demo_book\.tenant_id\).*tenancy-harden/,
      )
      // outside production nothing is asked; off, the defaults do not matter
      const test = check({ NODE_ENV: 'test', APP_MULTI_TENANT: true })
      await expect(test.run()).resolves.toBeUndefined()
      expect(test.query).not.toHaveBeenCalled()
      const prodOff = check(
        { NODE_ENV: 'production', APP_MULTI_TENANT: false },
        vi.fn(ds.query.bind(ds)),
      )
      await expect(prodOff.run()).resolves.toBeUndefined()
    } finally {
      await hardenTenancy(ds)
    }
    await expect(prodOn()).resolves.toBeUndefined()
  })

  it('off, enabled tenants besides the default one are named in a warning pointing to tenant-disable; once disabled, none', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const run = () =>
      check({ NODE_ENV: 'test', APP_MULTI_TENANT: false }, vi.fn(ds.query.bind(ds))).run()
    try {
      await run()
      const said = warn.mock.calls.map(([m]) => String(m))
      expect(said.some((m) => m.includes(B.code) && m.includes('tenant-disable.js'))).toBe(true)
      expect(await disableTenants(ds, [B.code.toUpperCase()], false)).toEqual([B.code])
      expect(
        Number((await ds.query('SELECT enabled FROM iam_tenant WHERE id = ?', [B.id]))[0].enabled),
      ).toBe(0)
      warn.mockClear()
      await run()
      expect(warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes(B.code))).toEqual([])
    } finally {
      warn.mockRestore()
      await restoreTenant()
    }
  })

  it('tenant-disable refuses the default tenant, unknown codes and multi-tenancy on, changing nothing', async () => {
    const enabled = async () =>
      (await ds.query<{ id: number; enabled: number }[]>('SELECT id, enabled FROM iam_tenant')).map(
        (r) => [Number(r.id), Number(r.enabled)],
      )
    const before = await enabled()
    await expect(disableTenants(ds, ['default'], false)).rejects.toThrow(/default/)
    await expect(disableTenants(ds, [B.code, 'no-such-tenant'], false)).rejects.toThrow(
      /no-such-tenant/,
    )
    await expect(disableTenants(ds, [], false)).rejects.toThrow(/usage/)
    await expect(disableTenants(ds, [B.code], true)).rejects.toThrow(/tenant management/)
    expect(await enabled()).toEqual(before)
  })
})
