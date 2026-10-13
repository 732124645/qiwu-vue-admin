// Realtime pushes per tenant (see docs/design-notes.md#tenancy), multi-tenancy on, with tenant B whose
// users share the default tenant's names: every socket joins its session's `tenant:{tid}` and
// `type:{tid}:{userType}` rooms. A bulletin B publishes and the demo page's "everyone" of B reach B's
// sockets only; a push to the default tenant reaches none of B's; a user type room stays in its tenant;
// onlineUsers counts the context's tenant only. Off again (as after a restart with it), B's sockets end
// at the next minute recheck while the default tenant's stay.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { bulletinPerms, demoRealtimePerms, type RealtimeMessage, RT } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { TENANT_UNAVAILABLE, TokenService } from '../../src/core/auth/token.service.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import type { Env } from '../../src/core/config/env.schema.js'
import { DEFAULT_TENANT_ID, withTenant } from '../../src/core/context/tenant.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, inbox, socketOf } from '../setup/socket.js'
import { bootApp, createTenant, type PeopledTenant, signInDirect } from '../setup/tenants.js'

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let realtime: RealtimeService
let B: PeopledTenant

const http = () => request(on.getHttpServer())
const msg = (id: number): RealtimeMessage => ({
  type: RT.notifyNew,
  payload: { id, title: 'New message' },
})
/** Lets in-flight emits land (same process, loopback, through Redis). */
const settle = () => new Promise((r) => setTimeout(r, 200))
/** A connected socket of a new session (a user of B: minted directly), and what it receives. */
async function online(who: number | 'root') {
  const s = who === 'root' ? await signIn(on) : (await signInDirect(on, who))!
  const socket = await connect(socketOf(on, { token: s.accessToken }))
  return { ...s, socket, got: inbox(socket) }
}
type Online = Awaited<ReturnType<typeof online>>
/** Runs `fn` with the app reading multi-tenancy as `value` (as after a restart with it). */
async function switched<T>(value: boolean, fn: () => Promise<T>) {
  const cfg = on.get(AppConfigService)
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

/** the default tenant's root, B's admin, and two tabs of B's alice */
let a: Online
let bAdmin: Online
let bAlice: Online
let bAlice2: Online

beforeAll(async () => {
  // only the periodic socket recheck is advanced by hand; everything else keeps real time
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  realtime = on.get(RealtimeService)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  // B's role may publish bulletins and push to everyone on the demo page
  for (const perm of [
    bulletinPerms.create,
    bulletinPerms.publish,
    demoRealtimePerms.send,
    demoRealtimePerms.broadcast,
  ])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
      B.roleId,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
      B.id,
    ])
  a = await online('root')
  bAdmin = await online(B.users.admin)
  bAlice = await online(B.users.alice)
  bAlice2 = await online(B.users.alice)
})

afterAll(async () => {
  try {
    closeSockets()
    if (ds) await B?.dispose()
    if (redis) await cleanRedis(redis)
    await on?.close()
  } finally {
    vi.useRealTimers()
  }
})

const bSockets = () => [bAdmin, bAlice, bAlice2]

it('a bulletin B publishes reaches B’s sockets only', async () => {
  const created = await http()
    .post('/api/messaging/bulletins')
    .set(bearer(bAdmin.accessToken))
    .send({ title: 'B maintenance', kind: 'notice', body: '<p>Tonight.</p>' })
    .expect(201)
  const id = created.body.data.id as number
  await http()
    .put(`/api/messaging/bulletins/${id}/published`)
    .set(bearer(bAdmin.accessToken))
    .send({ published: true })
    .expect(200)
  const pushed = { type: RT.notifyBulletin, payload: { action: 'published', ids: [id] } }
  for (const b of bSockets()) await vi.waitFor(() => expect(b.got).toContainEqual(pushed))
  await settle()
  expect(a.got).toEqual([])
})

it('toTenant reaches that tenant’s sockets only, the default tenant’s as well', async () => {
  realtime.toTenant(DEFAULT_TENANT_ID, msg(1))
  realtime.toTenant(B.id, msg(2))
  await vi.waitFor(() => expect(a.got).toContainEqual(msg(1)))
  for (const b of bSockets()) await vi.waitFor(() => expect(b.got).toContainEqual(msg(2)))
  await settle()
  expect(a.got).not.toContainEqual(msg(2))
  for (const b of bSockets()) expect(b.got).not.toContainEqual(msg(1))
})

it('type:{tid}:admin reaches that tenant’s admin-type users only', async () => {
  realtime.toUserType(B.id, 'admin', msg(3))
  for (const b of bSockets()) await vi.waitFor(() => expect(b.got).toContainEqual(msg(3)))
  realtime.toUserType(DEFAULT_TENANT_ID, 'admin', msg(4))
  await vi.waitFor(() => expect(a.got).toContainEqual(msg(4)))
  await settle()
  expect(a.got).not.toContainEqual(msg(3))
  for (const b of bSockets()) expect(b.got).not.toContainEqual(msg(4))
})

it('onlineUsers counts the distinct online users of the context’s tenant', async () => {
  expect(await withTenant(B.id, () => realtime.onlineUsers())).toBe(2)
  expect(await withTenant(DEFAULT_TENANT_ID, () => realtime.onlineUsers())).toBe(1)
})

it('the demo page’s everyone of B: B’s sockets only, delivered counts B’s online users', async () => {
  const text = 'hello B'
  const res = await http()
    .post('/api/demo/realtime/send')
    .set(bearer(bAdmin.accessToken))
    .send({ target: 'all', text })
    .expect(200)
  expect(res.body.data).toEqual({ delivered: 2 })
  const heard = (o: Online) =>
    o.got.some((m) => m.type === RT.demoMessage && m.payload.text === text)
  for (const b of bSockets()) await vi.waitFor(() => expect(heard(b)).toBe(true))
  await settle()
  expect(heard(a)).toBe(false)
})

it('off again, B’s sockets end within one minute recheck, told why; the default tenant’s stay', async () => {
  await switched(false, async () => {
    await vi.advanceTimersByTimeAsync(60_000)
    for (const b of bSockets())
      await vi.waitFor(() => expect(b.socket.connected).toBe(false), { timeout: 3_000 })
  })
  for (const b of bSockets())
    expect(b.got.at(-1)).toEqual({
      type: RT.sessionKicked,
      payload: { sid: b.session.sid, reason: TENANT_UNAVAILABLE },
    })
  expect(a.socket.connected).toBe(true)
  expect(await on.get(TokenService).load(bAlice.session.sid)).toBeNull()
})
