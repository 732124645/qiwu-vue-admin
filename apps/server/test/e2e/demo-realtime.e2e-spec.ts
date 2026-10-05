// demo/realtime: POST /api/demo/realtime/send pushes a `demo:message` envelope
// through RealtimeService. 403 without demo.realtime.send; `all` needs demo.realtime.broadcast (root
// passes); user/role targets reach only the enabled users of the caller's iam_user scope (a disabled
// role has no members), the rest are dropped without an error and `delivered` counts the online
// recipients (users, not sockets); the text arrives exactly as
// sent; 400, @Idempotent, @RateLimit, @ActionLog, Swagger.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { demoRealtimePerms, RT, type RealtimeMessage } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, inbox, socketOf } from '../setup/socket.js'

const PREFIX = 'e2e-rtdemo-'
const URL = '/api/demo/realtime/send'
const MISSING = 999_999

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const userIds: number[] = []
const roleIds: number[] = []
const DEPT = { mine: 0, other: 0 }
/** user ids and access tokens by short name */
const id: Record<string, number> = {}
const token: Record<string, string> = {}
/** what the online users' sockets receive */
const got: Record<string, RealtimeMessage[]> = {}
/** members of this role, nothing granted */
let groupId: number
/** a disabled role held by an online, in-scope user */
let shutId: number

async function role(name: string, perms: string[]) {
  const rid = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + name,
    name: PREFIX + name,
    data_scope: 'own_dept',
  })
  roleIds.push(rid)
  for (const p of perms)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      rid,
      await findId(ds.manager, 'iam_menu', { perms: p }),
    ])
  return rid
}

async function user(name: string, roles: number[], deptId: number | null, live = false) {
  id[name] = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
    dept_id: deptId,
  })
  userIds.push(id[name])
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id[name], r])
  token[name] = (await signIn(app, PREFIX + name)).accessToken
  if (live) got[name] = inbox(await connect(socketOf(app, { token: token[name] })))
}

let seq = 0
const unique = () => `${PREFIX}${process.pid}-${++seq}`
const send = (who: string, body: object, ip = '198.51.100.1') =>
  request(app.getHttpServer())
    .post(URL)
    .set(bearer(token[who]))
    .set('X-Forwarded-For', ip)
    .send(body)
/** The demo texts `name`'s socket received. */
const texts = (name: string) =>
  got[name].flatMap((m) => (m.type === RT.demoMessage ? [m.payload.text] : []))
/** Lets in-flight emits land (same process, loopback). */
const settle = () => new Promise((r) => setTimeout(r, 150))
/** Who of the online users received `text`. */
const receivers = async (text: string) => {
  await settle()
  return Object.keys(got)
    .filter((name) => texts(name).includes(text))
    .sort()
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  for (const k of ['mine', 'other'] as const) {
    DEPT[k] = await insertRow(ds.manager, 'iam_dept', { tree_path: '/', name: `${PREFIX}${k}` })
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`/${DEPT[k]}/`, DEPT[k]])
  }
  const sendRole = await role('send', [demoRealtimePerms.send])
  const castRole = await role('cast', [demoRealtimePerms.send, demoRealtimePerms.broadcast])
  groupId = await role('group', [])
  shutId = await role('shut', [])
  await ds.query('UPDATE iam_role SET enabled = 0 WHERE id = ?', [shutId])
  token.admin = (await signIn(app)).accessToken
  // online, in the senders' dept, holds no role
  await user('plain', [], DEPT.mine, true)
  await user('sender', [sendRole], DEPT.mine)
  await user('caster', [castRole], DEPT.mine)
  // the online receivers: in the senders' dept, outside it, and in it but disabled after signing in
  await user('mate', [groupId, shutId], DEPT.mine, true)
  // a second tab: `delivered` counts users, not sockets
  await connect(socketOf(app, { token: token.mate }))
  await user('far', [groupId], DEPT.other, true)
  await user('off', [groupId], DEPT.mine, true)
  await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [id.off])
  // in scope, never online
  await user('idle', [groupId], DEPT.mine)
})

afterAll(async () => {
  closeSockets()
  if (ds) {
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
    await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [Object.values(DEPT)])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('permissions', () => {
  it('403 without demo.realtime.send; nothing is pushed', async () => {
    const text = unique()
    await send('plain', { target: 'user', userIds: [id.mate], text }).expect(403)
    await send('plain', { target: 'all', text: unique() }).expect(403)
    expect(await receivers(text)).toEqual([])
  })

  it('all: 403 for a non-root caller without demo.realtime.broadcast; with it, or root, every socket gets it', async () => {
    const denied = unique()
    await send('sender', { target: 'all', text: denied }).expect(403)
    expect(await receivers(denied)).toEqual([])
    for (const who of ['caster', 'admin']) {
      const text = unique()
      const res = await send(who, { target: 'all', text }).expect(200)
      expect(res.body.data).toEqual({ delivered: 4 })
      expect(await receivers(text)).toEqual(['far', 'mate', 'off', 'plain'])
    }
  })
})

describe('recipients', () => {
  it('user: only enabled users in the caller’s scope get it, the rest are dropped silently; delivered counts the online ones', async () => {
    const text = unique()
    const res = await send('sender', {
      target: 'user',
      userIds: [id.mate, id.far, id.off, id.idle, MISSING],
      text,
    }).expect(200)
    expect(res.body.data).toEqual({ delivered: 1 })
    expect(await receivers(text)).toEqual(['mate'])
  })

  it('role: the role’s enabled members in the caller’s scope; root reaches members in every dept', async () => {
    const text = unique()
    const res = await send('sender', { target: 'role', roleIds: [groupId, MISSING], text }).expect(
      200,
    )
    expect(res.body.data).toEqual({ delivered: 1 })
    expect(await receivers(text)).toEqual(['mate'])
    const rooted = unique()
    const all = await send('admin', { target: 'role', roleIds: [groupId], text: rooted }).expect(
      200,
    )
    expect(all.body.data).toEqual({ delivered: 2 })
    expect(await receivers(rooted)).toEqual(['far', 'mate'])
  })

  it('role: a disabled role has no members → 200 with delivered 0', async () => {
    const text = unique()
    const res = await send('sender', { target: 'role', roleIds: [shutId], text }).expect(200)
    expect(res.body.data).toEqual({ delivered: 0 })
    expect(await receivers(text)).toEqual([])
  })

  it('nobody in scope → 200 with delivered 0', async () => {
    const text = unique()
    const res = await send('sender', { target: 'user', userIds: [id.far], text }).expect(200)
    expect(res.body.data).toEqual({ delivered: 0 })
    expect(await receivers(text)).toEqual([])
  })
})

describe('message', () => {
  it('a demo:message envelope {from, text, at}; the text travels exactly as sent', async () => {
    const text = `  <img src=x onerror=alert(1)> & "q"\n\t${unique()} 你好 🎉  `
    const before = Date.now()
    await send('sender', { target: 'user', userIds: [id.mate], text }).expect(200)
    await settle()
    const msg = got.mate.findLast((m) => m.type === RT.demoMessage)
    expect(msg).toEqual({
      type: RT.demoMessage,
      payload: { from: { id: id.sender, name: 'sender' }, text, at: expect.any(String) },
    })
    const at = Date.parse((msg as RealtimeMessage<'demo:message'>).payload.at)
    expect(new Date(at).toISOString()).toBe((msg as RealtimeMessage<'demo:message'>).payload.at)
    expect(at).toBeGreaterThanOrEqual(before - 1000)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('400 for an invalid body; nothing is pushed', async () => {
    await send('sender', { target: 'user', text: unique() }).expect(400)
    await send('sender', { target: 'user', userIds: [id.mate], text: ' \n ' }).expect(400)
    await send('sender', { target: 'user', userIds: [id.mate], text: 'x'.repeat(501) }).expect(400)
    await send('sender', { target: 'room', text: unique() }).expect(400)
    expect(texts('mate').some((t) => t.trim() === '' || t.length > 500)).toBe(false)
  })
})

describe('guards', () => {
  it('the same send twice within 3 s → 429 (@Idempotent), pushed once', async () => {
    const body = { target: 'user', userIds: [id.mate], text: unique() }
    await send('sender', body).expect(200)
    await send('sender', body).expect(429)
    await settle()
    expect(texts('mate').filter((t) => t === body.text)).toHaveLength(1)
  })

  it('action-logged', async () => {
    const traceId = `${PREFIX}${process.pid}-log`
    await send('sender', { target: 'user', userIds: [id.mate], text: unique() })
      .set('X-Request-Id', traceId)
      .expect(200)
    expect(await logOf(ds, traceId)).toMatchObject({
      domain: 'demo.realtime',
      verb: 'send',
      ok: 1,
      username: `${PREFIX}sender`,
    })
  })

  it('at most 30 sends a minute per client IP; the next one → 429 (@RateLimit)', async () => {
    const ip = '198.51.100.77'
    for (let i = 0; i < 30; i++)
      await send('sender', { target: 'user', userIds: [id.mate], text: unique() }, ip).expect(200)
    const text = unique()
    await send('sender', { target: 'user', userIds: [id.mate], text }, ip).expect(429)
    expect(await receivers(text)).toEqual([])
  })
})

it('Swagger documents the route and its result', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  expect(Object.keys(doc.paths).filter((p) => p.startsWith('/api/demo/realtime'))).toEqual([URL])
  expect(
    doc.paths[URL].post.responses['200'].content['application/json'].schema.properties.data,
  ).toMatchObject({ properties: { delivered: { type: 'integer' } } })
})
