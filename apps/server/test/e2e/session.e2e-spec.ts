// iam/session: the online list (live sessions from Redis: filters username/IP/client,
// sort, paging, `current`, last-seen, never a token), kick one / batch kick / kick every session of a
// user → the sessions end (tokens 401), their sockets hear `session:kicked` and are disconnected, a
// reconnect is refused, and each ended session gets a `kicked` sign-in log row. 403 without the perms,
// 400 on bad input, 404 for an unknown session. Data scope: an own_dept operator lists and kicks
// only sessions of users in its dept (out of scope → 404, nothing ends), never a root user's (422).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, REALTIME_UNAUTHORIZED, RT, type SessionVo, sessionPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, disconnected, inbox, socketOf } from '../setup/socket.js'

const PREFIX = 'sess-e2e-'
const URL = '/api/iam/sessions'
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let admin = ''
let adminSid = ''
let nobody = ''
const userIds: number[] = []
let roleId = 0

const http = () => request(app.getHttpServer())
const list = (query: Record<string, unknown> = {}, token = admin) =>
  http().get(URL).query(query).set(bearer(token))
const kick = (body: object, token = admin) =>
  http().post(`${URL}/kick`).send(body).set(bearer(token))
const me = (token: string) => http().get('/api/auth/me').set(bearer(token))

async function user(name: string, deptId: number | null = null, roles: number[] = []) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: deptId,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  userIds.push(id)
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  return id
}

/** A new session of `name` with a connected socket and its inbox. */
async function online(name: string, ip = '127.0.0.1') {
  const s = await signIn(app, PREFIX + name, { ip, ua: CHROME })
  const socket = await connect(socketOf(app, { token: s.accessToken }))
  return { token: s.accessToken, sid: s.session.sid, socket, got: inbox(socket) }
}

interface KickedRow {
  user_id: number
  client_id: string
  ip: string
  ok: number
  msg_params: Record<string, unknown>
}
/** `kicked` sign-in rows of a username; the writer does not await, so poll for `count`. */
const kickedRows = (name: string, count: number) =>
  vi.waitFor(
    async () => {
      const rows = await ds.query<KickedRow[]>(
        "SELECT user_id, client_id, ip, ok, msg_params FROM aud_signin_log WHERE kind = 'kicked' AND username = ? ORDER BY id",
        [PREFIX + name],
      )
      if (rows.length < count) throw new Error(`${rows.length}/${count} kicked rows`)
      return rows
    },
    { timeout: 5000 },
  )

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  const root = await signIn(app)
  admin = root.accessToken
  adminSid = root.session.sid
  for (const n of ['a', 'b', 'c', 'nobody']) await user(n)
  nobody = (await signIn(app, `${PREFIX}nobody`)).accessToken
})

afterAll(async () => {
  closeSockets()
  if (ds && userIds.length) {
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
  }
  if (ds && roleId) {
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('list', () => {
  it('lists live sessions with the caller marked current, never a token; filters and sorts', async () => {
    const a = await online('a', '203.0.113.7')
    await signIn(app, `${PREFIX}a`, { clientId: 'probe-app', ip: '198.51.100.9' })
    const res = await list({ pageSize: 200 }).expect(200)
    const rows = res.body.data.items as SessionVo[]
    expect(res.body.data.total).toBe(rows.length)
    const mine = rows.find((r) => r.sid === adminSid)!
    expect(mine).toMatchObject({ username: 'admin', clientId: 'console', current: true })
    expect(mine.lastSeenAt).not.toBeNull()
    const row = rows.find((r) => r.sid === a.sid)!
    expect(row).toMatchObject({
      userId: userIds[0],
      username: `${PREFIX}a`,
      ip: '203.0.113.7',
      userType: 'admin',
      browser: 'Chrome 131.0.0.0',
      os: expect.stringMatching(/^macOS/),
      userAgent: CHROME,
      keepSignedIn: false,
      current: false,
    })
    expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.now())
    expect(Date.parse(row.loginAt)).toBeLessThanOrEqual(Date.now())
    // nothing token-like leaves the server
    expect(JSON.stringify(res.body)).not.toContain(a.token)
    expect(Object.keys(row).sort()).toEqual(
      [
        'sid',
        'userId',
        'username',
        'deptName',
        'userType',
        'clientId',
        'ip',
        'location',
        'browser',
        'os',
        'userAgent',
        'keepSignedIn',
        'loginAt',
        'lastSeenAt',
        'expiresAt',
        'current',
      ].sort(),
    )

    const byName = (await list({ username: `${PREFIX.toUpperCase()}A` }).expect(200)).body.data
    expect(byName.total).toBe(2)
    const byIp = (await list({ ip: '113.7' }).expect(200)).body.data
    expect(byIp.items.map((r: SessionVo) => r.sid)).toEqual([a.sid])
    const byClient = (await list({ clientId: 'probe-app' }).expect(200)).body.data
    expect(byClient.items).toHaveLength(1)
    expect(byClient.items[0].ip).toBe('198.51.100.9')

    const asc = (await list({ sort: 'loginAt', pageSize: 200 }).expect(200)).body.data.items
    const times = asc.map((r: SessionVo) => Date.parse(r.loginAt))
    expect(times).toEqual([...times].sort((x, y) => x - y))
    const page2 = (await list({ sort: 'loginAt', pageSize: 1, page: 2 }).expect(200)).body.data
    expect(page2.items.map((r: SessionVo) => r.sid)).toEqual([asc[1].sid])
    expect((await list({ sort: '-lastSeenAt' }).expect(200)).body.data.items[0].sid).toBe(adminSid)
  })

  it('400 on a sort outside the whitelist; 403 without iam.session.browse; 401 without a session', async () => {
    await list({ sort: 'ip' }).expect(400)
    await list({}, nobody).expect(403)
    await http().get(URL).expect(401)
  })
})

describe('kick', () => {
  it('batch kick of 2 sessions: tokens 401, sockets hear session:kicked and are dropped, reconnect refused', async () => {
    const b1 = await online('b')
    const b2 = await online('b')
    const keep = await online('b')
    const gone = [disconnected(b1.socket), disconnected(b2.socket)]

    const res = await kick({ sids: [b1.sid, b2.sid] }).expect(200)
    expect(res.body.data).toEqual({ kicked: 2 })

    await me(b1.token).expect(401)
    await me(b2.token).expect(401)
    expect(await Promise.all(gone)).toEqual(['io server disconnect', 'io server disconnect'])
    expect(b1.got).toEqual([{ type: RT.sessionKicked, payload: { sid: b1.sid } }])
    expect(b2.got).toEqual([{ type: RT.sessionKicked, payload: { sid: b2.sid } }])
    await expect(connect(b1.socket)).rejects.toThrow(REALTIME_UNAUTHORIZED)
    await expect(connect(b2.socket)).rejects.toThrow(REALTIME_UNAUTHORIZED)

    // the user's third session is untouched
    await me(keep.token).expect(200)
    expect(keep.socket.connected).toBe(true)
    expect(keep.got).toEqual([])

    const rows = await kickedRows('b', 2)
    expect(rows).toHaveLength(2)
    for (const r of rows)
      expect(r).toMatchObject({
        user_id: userIds[1],
        client_id: 'console',
        ok: 1,
        msg_params: { by: 'admin' },
      })
    const listed = (await list({ username: `${PREFIX}b` }).expect(200)).body.data.items
    expect(listed.map((r: SessionVo) => r.sid)).toEqual([keep.sid])
    // ended or unknown sids are skipped
    expect((await kick({ sids: [b1.sid, crypto.randomUUID()] }).expect(200)).body.data).toEqual({
      kicked: 0,
    })
  })

  it('kick by user ends every session of that user (all clients)', async () => {
    const c1 = await online('c')
    const c2 = await signIn(app, `${PREFIX}c`, { clientId: 'probe-app' })
    const gone = disconnected(c1.socket)
    expect((await kick({ userId: userIds[2] }).expect(200)).body.data).toEqual({ kicked: 2 })
    await me(c1.token).expect(401)
    expect(await gone).toBe('io server disconnect')
    expect(c1.got).toEqual([{ type: RT.sessionKicked, payload: { sid: c1.sid } }])
    expect((await list({ username: `${PREFIX}c` }).expect(200)).body.data.total).toBe(0)
    expect(await app.get(TokenService).load(c2.session.sid)).toBeNull()
    const rows = await kickedRows('c', 2)
    expect(rows.map((r) => r.client_id).sort()).toEqual(['console', 'probe-app'])
  })

  it('DELETE /:sid ends one session; unknown or ended → 404; not a UUID → 400', async () => {
    const a = await online('a')
    const gone = disconnected(a.socket)
    const res = await http().delete(`${URL}/${a.sid}`).set(bearer(admin)).expect(200)
    expect(res.body.data).toEqual({ kicked: 1 })
    await me(a.token).expect(401)
    expect(await gone).toBe('io server disconnect')
    expect(a.got).toEqual([{ type: RT.sessionKicked, payload: { sid: a.sid } }])
    await http().delete(`${URL}/${a.sid}`).set(bearer(admin)).expect(404)
    await http().delete(`${URL}/${crypto.randomUUID()}`).set(bearer(admin)).expect(404)
    await http().delete(`${URL}/not-a-sid`).set(bearer(admin)).expect(400)
  })

  it('400 on a bad body (both, neither, non-UUID sids, empty list); 403 without iam.session.kick', async () => {
    const sid = crypto.randomUUID()
    await kick({ sids: [sid], userId: userIds[0] }).expect(400)
    await kick({}).expect(400)
    await kick({ sids: ['x'] }).expect(400)
    await kick({ sids: [] }).expect(400)
    await kick({ userId: 0 }).expect(400)
    await kick({ sids: [sid] }, nobody).expect(403)
    await http().delete(`${URL}/${sid}`).set(bearer(nobody)).expect(403)
  })
})

describe('data scope', () => {
  // an own_dept operator in R&D with browse + kick; `mate` in R&D, `boss` (root) in R&D, `a` in no dept
  let op = ''
  let opSid = ''
  let mateId = 0
  let bossId = 0
  beforeAll(async () => {
    const rd = (await findId(ds.manager, 'iam_dept', { name: 'seed.dept.rd' }))!
    roleId = await insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}own-dept`,
      name: `${PREFIX}own-dept`,
      data_scope: 'own_dept',
    })
    for (const perm of [sessionPerms.browse, sessionPerms.kick])
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
        roleId,
        await findId(ds.manager, 'iam_menu', { perms: perm }),
      ])
    const rootRole = (await findId(ds.manager, 'iam_role', { code: 'root' }))!
    await user('op', rd, [roleId])
    mateId = await user('mate', rd)
    bossId = await user('boss', rd, [rootRole])
    const s = await signIn(app, `${PREFIX}op`)
    op = s.accessToken
    opSid = s.session.sid
  })
  const sidsOf = async (token: string) =>
    ((await list({ pageSize: 200 }, token).expect(200)).body.data.items as SessionVo[]).map(
      (r) => r.sid,
    )

  it('lists only the sessions of users in scope; root lists all', async () => {
    const mate = await online('mate')
    const boss = await online('boss')
    const far = await online('a')
    const mine = await sidsOf(op)
    expect(mine).toEqual(expect.arrayContaining([opSid, mate.sid, boss.sid]))
    expect(mine).not.toContain(far.sid)
    expect(mine).not.toContain(adminSid)
    const res = (await list({ pageSize: 200 }, op).expect(200)).body.data
    expect(res.total).toBe(mine.length)
    expect(await sidsOf(admin)).toEqual(expect.arrayContaining([far.sid, mate.sid, adminSid]))
  })

  it('kicks out of scope → 404 and nothing ends; in scope ends; root kicks anyone', async () => {
    const mate = await online('mate')
    const far = await online('a')
    await kick({ sids: [mate.sid, far.sid] }, op).expect(404)
    await http().delete(`${URL}/${far.sid}`).set(bearer(op)).expect(404)
    await kick({ userId: userIds[0] }, op).expect(404)
    await kick({ userId: 999_999 }, op).expect(404)
    await me(mate.token).expect(200)
    await me(far.token).expect(200)
    // an unknown sid next to an in-scope one is still skipped
    const res = await kick({ sids: [mate.sid, crypto.randomUUID()] }, op).expect(200)
    expect(res.body.data).toEqual({ kicked: 1 })
    await me(mate.token).expect(401)
    const mate2 = await online('mate')
    expect((await kick({ userId: mateId }, op).expect(200)).body.data.kicked).toBeGreaterThan(0)
    await me(mate2.token).expect(401)
    expect((await kick({ sids: [far.sid] }).expect(200)).body.data).toEqual({ kicked: 1 })
    await me(far.token).expect(401)
  })

  it("a non-root caller never kicks a root user's session (422); root does", async () => {
    const boss = await online('boss')
    const refused = await kick({ sids: [boss.sid] }, op).expect(422)
    expect(refused.body.code).toBe(Err.IAM_USER_PROTECTED.code)
    await http().delete(`${URL}/${boss.sid}`).set(bearer(op)).expect(422)
    await kick({ userId: bossId }, op).expect(422)
    await me(boss.token).expect(200)
    expect(boss.got).toEqual([])
    expect((await kick({ sids: [boss.sid] }).expect(200)).body.data).toEqual({ kicked: 1 })
    await me(boss.token).expect(401)
  })
})

describe('mobile client', () => {
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'

  it('a mobile session is listed and filtered as clientId mobile; its socket connects, and a kick ends it (logged as mobile)', async () => {
    const id = await user('mob')
    const m = await signIn(app, `${PREFIX}mob`, { clientId: 'mobile', ua: IPHONE })
    const pc = await online('mob')
    const socket = await connect(socketOf(app, { token: m.accessToken }))
    const got = inbox(socket)

    const all = (await list({ username: `${PREFIX}mob` }).expect(200)).body.data.items
    expect(all.map((r: SessionVo) => r.clientId).sort()).toEqual(['console', 'mobile'])
    const phones = (await list({ clientId: 'mobile' }).expect(200)).body.data.items
    expect(phones).toEqual([
      expect.objectContaining({ sid: m.session.sid, clientId: 'mobile', os: 'iOS 18.0' }),
    ])

    const gone = disconnected(socket)
    await http().delete(`${URL}/${m.session.sid}`).set(bearer(admin)).expect(200)
    expect(await gone).toBe('io server disconnect')
    expect(got).toEqual([{ type: RT.sessionKicked, payload: { sid: m.session.sid } }])
    await me(m.accessToken).expect(401)
    await me(pc.token).expect(200)
    expect(await kickedRows('mob', 1)).toEqual([
      expect.objectContaining({ user_id: id, client_id: 'mobile', ok: 1 }),
    ])
  })
})
