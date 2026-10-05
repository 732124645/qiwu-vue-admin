// Real AppModule routes, guards and stores (see docs/design-notes.md#security). Detailed race/fixture coverage stays
// in core-auth, core-token, oauth2, data-scope, profile, auth-extra and auth-wx-mp; this matrix checks
// the boundaries together, including state after a refused write and every credential after revoke.
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, REALTIME_UNAUTHORIZED, sessionPerms, userPerms } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import type { DataScope } from '../../src/core/auth/principal.js'
import { type Issued, REFRESH_GRACE_MS, TokenService } from '../../src/core/auth/token.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { secretDigest } from '../../src/modules/platform/oauth/provider/provider.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { closeSockets, connect, socketOf } from '../setup/socket.js'

const PREFIX = 'sec-auth-'
const PW = 'Security#Pass1'
const NEW_PW = 'Security#Pass2'
const CLIENT = 'sec-oauth-client'
const SECRET = 'sec-client-secret-0123456789abcdef'
const CALLBACK = 'https://security.example/cb'
const UA = 'sec-auth/1.0'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const created = { users: [] as number[], roles: [] as number[], depts: [] as number[] }
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: TokenService
let admin: Issued
let clientId = 0
let rootRole = 0
let pwHash = ''
let seq = 0
const unique = () => `${PREFIX}${++seq}`
const http = () => request(app.getHttpServer())
const me = (at: string) => http().get('/api/auth/me').set(bearer(at))
const origin = () => `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
const refresh = (rt: string, client = 'console', ua = UA) => {
  const call = http().post('/api/auth/refresh').set('User-Agent', ua)
  return client === 'mobile'
    ? call.send({ refreshToken: rt })
    : call.set('Origin', origin()).set('Cookie', `qw_rt=${rt}`).send({})
}
const cookieToken = (res: request.Response) =>
  (res.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!.slice('qw_rt='.length)
const oauthToken = (body: Record<string, string>) =>
  http()
    .post('/api/oauth2/token')
    .set('User-Agent', UA)
    .type('form')
    .send({
      client_id: CLIENT,
      client_secret: SECRET,
      ...body,
    })

async function user(extra: Record<string, unknown> = {}, roleIds: number[] = []) {
  const username = unique()
  const id = await insertRow(ds.manager, 'iam_user', {
    username,
    display_name: username,
    password_hash: pwHash,
    password_changed_at: new Date(),
    ...extra,
  })
  created.users.push(id)
  for (const roleId of roleIds)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, roleId])
  return { id, username }
}

async function role(scope: DataScope, perms: string[], picked: number[] = []) {
  const code = unique()
  const id = await insertRow(ds.manager, 'iam_role', { code, name: code, data_scope: scope })
  created.roles.push(id)
  for (const perm of perms) {
    const menuId = await findId(ds.manager, 'iam_menu', { perms: perm })
    if (!menuId) throw new Error(`Missing seeded permission: ${perm}`)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [id, menuId])
  }
  for (const deptId of picked)
    await ds.query('INSERT INTO iam_role_depts (role_id, dept_id) VALUES (?, ?)', [id, deptId])
  return id
}

async function dept(parentId = 0) {
  const id = await insertRow(ds.manager, 'iam_dept', {
    name: unique(),
    parent_id: parentId,
    tree_path: '/',
  })
  created.depts.push(id)
  const parent = parentId
    ? (await ds.query('SELECT tree_path FROM iam_dept WHERE id = ?', [parentId]))[0].tree_path
    : '/'
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`${parent}${id}/`, id])
  return id
}

/** Consent and code issuance go through HTTP too: no fake OAuth principal or bypassed scope guard. */
async function authorize(at: string, over: Record<string, string | undefined> = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const query = Object.fromEntries(
    Object.entries({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: CALLBACK,
      scope: 'user.read',
      state: 'sec-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...over,
    }).filter(([, value]) => value !== undefined),
  )
  const res = await http()
    .post('/api/oauth2/authorize')
    .query(query)
    .set(bearer(at))
    .send({ approve: true })
  return { res, verifier }
}

async function pendingCode(at: string) {
  const { res, verifier } = await authorize(at)
  expect(res.status).toBe(200)
  const redirect = new URL(res.body.data.redirectTo)
  expect(redirect.origin + redirect.pathname).toBe(CALLBACK)
  expect(redirect.searchParams.get('state')).toBe('sec-state')
  const code = redirect.searchParams.get('code')!
  expect(code).toEqual(expect.any(String))
  return { code, verifier }
}

const exchange = ({ code, verifier }: { code: string; verifier: string }) =>
  oauthToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: CALLBACK,
  })

async function oauthPair(at: string) {
  const res = await exchange(await pendingCode(at)).expect(200)
  return {
    accessToken: res.body.access_token as string,
    refreshToken: res.body.refresh_token as string,
  }
}

async function credentialKeys(sessions: Issued[], code: string) {
  const keys = [redisKey('oauth2Code', hash(code))]
  for (const session of sessions) {
    const members = await redis.sMembers(redisKey('authUser', session.session.userId!))
    for (const key of members) {
      const raw = await redis.get(key)
      if (raw && (JSON.parse(raw) as { sid: string }).sid === session.session.sid) keys.push(key)
    }
  }
  return [...new Set(keys)]
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  tokens = app.get(TokenService)
  await cleanRedis(redis)
  pwHash = await bcrypt.hash(PW, 4)
  admin = await signIn(app, 'admin', { ua: UA })
  rootRole = (await findId(ds.manager, 'iam_role', { code: 'root' }))!
  clientId = await insertRow(ds.manager, 'oauth_client', {
    client_id: CLIENT,
    secret_hash: secretDigest(SECRET),
    name: CLIENT,
    grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
    redirect_uris: [CALLBACK],
    scopes: ['user.read'],
    auto_approve_scopes: [],
    access_ttl_sec: 600,
    refresh_ttl_sec: 3600,
  })
})

afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  closeSockets()
  if (ds) {
    if (clientId) {
      await ds.query('DELETE FROM oauth_consent WHERE client_id = ?', [clientId])
      await ds.query('DELETE FROM oauth_client WHERE id = ?', [clientId])
    }
    if (created.users.length) {
      await ds.query('DELETE FROM msg_inbox WHERE user_id IN (?)', [created.users])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [created.users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [created.users])
    }
    if (created.roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role_depts WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [created.roles])
    }
    if (created.depts.length)
      await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [created.depts])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('Security auth matrix', () => {
  it('token mixing: first-party permissions work; OAuth/machine IAM and sockets fail; userinfo needs user and scope', async () => {
    for (const clientId of ['console', 'mobile'] as const) {
      const first = await signIn(app, 'admin', { clientId })
      await http().get('/api/iam/users').set(bearer(first.accessToken)).expect(200)
      await connect(socketOf(app, { token: first.accessToken }))
    }
    const delegated = await oauthPair(admin.accessToken)
    const machine = (
      await oauthToken({ grant_type: 'client_credentials', scope: 'user.read' }).expect(200)
    ).body.access_token as string
    for (const at of [delegated.accessToken, machine]) {
      const denied = await http().get('/api/iam/users').set(bearer(at)).expect(401)
      expect(denied.body.code).toBe(Err.UNAUTHENTICATED.code)
      await expect(connect(socketOf(app, { token: at }))).rejects.toThrow(REALTIME_UNAUTHORIZED)
      expect(await tokens.inspect(at)).not.toBeNull()
    }
    await http().get('/api/oauth2/userinfo').set(bearer(delegated.accessToken)).expect(200)
    const noUser = await http().get('/api/oauth2/userinfo').set(bearer(machine)).expect(403)
    expect(noUser.body.code).toBe(Err.OAUTH_INSUFFICIENT_SCOPE.code)
    const scoped = await signIn(app, 'admin', { clientId: CLIENT, scopes: [] })
    const noScope = await http()
      .get('/api/oauth2/userinfo')
      .set(bearer(scoped.accessToken))
      .expect(403)
    expect(noScope.body.code).toBe(Err.FORBIDDEN.code)
    expect(await tokens.inspect(scoped.accessToken)).not.toBeNull()
  })

  it.each(['password', 'reset', 'disable', 'delete', 'kick'] as const)(
    'session %s: every client loses access/refresh/grace/code; own password change keeps only exceptSid',
    async (action) => {
      const owner = await user()
      const console = await signIn(app, owner.username, { ua: UA })
      const mobile = await signIn(app, owner.username, { clientId: 'mobile', ua: UA })
      const delegated = await oauthPair(console.accessToken)
      const third = await tokens.inspect(delegated.accessToken)
      expect(third).not.toBeNull()
      const code = await pendingCode(console.accessToken)
      // Build grace entries for all three clients before the revocation.
      const pcRotated = await refresh(console.refreshToken).expect(200)
      const pcAt = pcRotated.body.data.accessToken as string
      const pcRt = cookieToken(pcRotated)
      const mobRotated = (await refresh(mobile.refreshToken, 'mobile').expect(200)).body.data
      const oauthRotated = (
        await oauthToken({
          grant_type: 'refresh_token',
          refresh_token: delegated.refreshToken,
        }).expect(200)
      ).body
      const sessions = [console, mobile, { ...console, session: third!.session }]
      const keys = await credentialKeys(sessions, code.code)
      const goneKeys =
        action === 'password' ? await credentialKeys(sessions.slice(1), code.code) : keys
      expect(keys.filter((key) => key.startsWith(redisKey('authRefreshGrace', '')))).toHaveLength(3)
      const passwordBefore = (
        await ds.query('SELECT password_hash FROM iam_user WHERE id = ?', [owner.id])
      )[0].password_hash
      if (action === 'password')
        await http()
          .put('/api/iam/profile/password')
          .set(bearer(pcAt))
          .send({ oldPassword: PW, newPassword: NEW_PW })
          .expect(200)
      else if (action === 'reset')
        await http()
          .put(`/api/iam/users/${owner.id}/password`)
          .set(bearer(admin.accessToken))
          .send({ password: NEW_PW })
          .expect(200)
      else if (action === 'disable')
        await http()
          .put(`/api/iam/users/${owner.id}/enabled`)
          .set(bearer(admin.accessToken))
          .send({ enabled: false })
          .expect(200)
      else if (action === 'delete')
        await http().delete(`/api/iam/users/${owner.id}`).set(bearer(admin.accessToken)).expect(200)
      else
        await http()
          .post('/api/iam/sessions/kick')
          .set(bearer(admin.accessToken))
          .send({ userId: owner.id })
          .expect(200)
      const after = (
        await ds.query('SELECT password_hash, enabled, deleted_at FROM iam_user WHERE id = ?', [
          owner.id,
        ])
      )[0]
      if (action === 'password' || action === 'reset') {
        expect(after.password_hash).not.toBe(passwordBefore)
        expect(await bcrypt.compare(NEW_PW, after.password_hash)).toBe(true)
      } else {
        expect(after.password_hash).toBe(passwordBefore)
        expect(Number(after.enabled)).toBe(action === 'disable' ? 0 : 1)
        expect(after.deleted_at === null).toBe(action !== 'delete')
      }
      expect(await redis.mGet(goneKeys)).toEqual(goneKeys.map(() => null))
      await me(mobRotated.accessToken).expect(401)
      await refresh(mobRotated.refreshToken, 'mobile').expect(401)
      await refresh(mobile.refreshToken, 'mobile').expect(401)
      for (const at of [delegated.accessToken, oauthRotated.access_token])
        await http().get('/api/oauth2/userinfo').set(bearer(at)).expect(401)
      for (const rt of [delegated.refreshToken, oauthRotated.refresh_token])
        expect(
          (await oauthToken({ grant_type: 'refresh_token', refresh_token: rt }).expect(400)).body
            .error,
        ).toBe('invalid_grant')
      expect((await exchange(code).expect(400)).body.error).toBe('invalid_grant')
      await me(pcAt).expect(action === 'password' ? 200 : 401)
      await refresh(pcRt).expect(action === 'password' ? 200 : 401)
      if (action !== 'password') await refresh(console.refreshToken).expect(401)
      await me(admin.accessToken).expect(200)
    },
  )

  it.each(['ua', 'outside-grace'] as const)(
    'refresh %s replay ends the chain after concurrent old refresh returned one pair',
    async (replay) => {
      const owner = await user()
      const first = await signIn(app, owner.username, { clientId: 'mobile', ua: UA })
      const [a, b] = await Promise.all([
        refresh(first.refreshToken, 'mobile'),
        refresh(first.refreshToken, 'mobile'),
      ])
      expect([a.status, b.status]).toEqual([200, 200])
      expect(a.body.data).toEqual(b.body.data)
      expect((await tokens.load(first.session.sid))?.absoluteExpAt).toBe(
        first.session.absoluteExpAt,
      )
      if (replay === 'outside-grace')
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + REFRESH_GRACE_MS + 1)
      await refresh(first.refreshToken, 'mobile', replay === 'ua' ? 'attacker' : UA).expect(401)
      expect(await tokens.load(first.session.sid)).toBeNull()
      await me(a.body.data.accessToken).expect(401)
      await refresh(a.body.data.refreshToken, 'mobile').expect(401)
    },
  )

  it('absolute expiry is fixed across rotation and capped TTLs, then HTTP access and refresh both fail', async () => {
    const owner = await user()
    const first = await signIn(app, owner.username, { clientId: 'mobile', ua: UA })
    const cap = first.session.absoluteExpAt
    vi.spyOn(Date, 'now').mockReturnValue(cap - 5000)
    const rotated = (await refresh(first.refreshToken, 'mobile').expect(200)).body.data
    expect(rotated.expiresIn).toBeLessThanOrEqual(5)
    expect(rotated.refreshExpiresIn).toBeLessThanOrEqual(5)
    expect((await tokens.load(first.session.sid))?.absoluteExpAt).toBe(cap)
    await me(rotated.accessToken).expect(200)
    vi.spyOn(Date, 'now').mockReturnValue(cap + 1)
    await me(rotated.accessToken).expect(401)
    await refresh(rotated.refreshToken, 'mobile').expect(401)
  })

  it.each(['mustChangePassword', 'passwordExpired'] as const)(
    'flags %s: only me/menus/password/logout; refused profile stays unchanged',
    async (flag) => {
      const owner = await user()
      const first = await signIn(app, owner.username, {
        flags: { mustChangePassword: false, passwordExpired: false, [flag]: true },
      })
      await me(first.accessToken).expect(200)
      await http().get('/api/auth/menus').set(bearer(first.accessToken)).expect(200)
      for (const denied of [
        await http().get('/api/iam/profile').set(bearer(first.accessToken)).expect(403),
        await http()
          .put('/api/iam/profile')
          .set(bearer(first.accessToken))
          .send({ displayName: 'forbidden' })
          .expect(403),
        await http()
          .post('/api/auth/verify-password')
          .set(bearer(first.accessToken))
          .send({ password: PW })
          .expect(403),
      ])
        expect(denied.body.code).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)
      expect(
        (await ds.query('SELECT display_name FROM iam_user WHERE id = ?', [owner.id]))[0]
          .display_name,
      ).toBe(owner.username)
      await http()
        .put('/api/iam/profile/password')
        .set(bearer(first.accessToken))
        .send({ oldPassword: PW, newPassword: NEW_PW })
        .expect(200)
      expect((await me(first.accessToken).expect(200)).body.data.flags).toEqual({
        mustChangePassword: false,
        passwordExpired: false,
      })
      await http().get('/api/iam/profile').set(bearer(first.accessToken)).expect(200)
      const logout = await signIn(app, owner.username, {
        flags: { mustChangePassword: true, passwordExpired: true },
      })
      await http().post('/api/auth/logout').set(bearer(logout.accessToken)).expect(200)
      await me(logout.accessToken).expect(401)
    },
  )

  it('current-password checks share one user counter across routes/IPs and revoke every client at the threshold', async () => {
    const owner = await user({ mobile: '13900009999' })
    const pc = await signIn(app, owner.username, { ua: UA })
    const mobile = await signIn(app, owner.username, { clientId: 'mobile', ua: UA })
    const delegated = await oauthPair(pc.accessToken)
    const wrong = 'Wrong#Pass1'
    await http()
      .post('/api/auth/verify-password')
      .set(bearer(pc.accessToken))
      .set('X-Forwarded-For', '198.51.100.21')
      .send({ password: wrong })
      .expect(400)
    await http()
      .put('/api/iam/profile/password')
      .set(bearer(pc.accessToken))
      .set('X-Forwarded-For', '198.51.100.22')
      .send({ oldPassword: wrong, newPassword: NEW_PW })
      .expect(400)
    await http()
      .put('/api/iam/profile')
      .set(bearer(mobile.accessToken))
      .set('X-Forwarded-For', '198.51.100.23')
      .send({ mobile: null, currentPassword: wrong })
      .expect(400)
    await http()
      .post('/api/auth/verify-password')
      .set(bearer(mobile.accessToken))
      .send({ password: wrong })
      .expect(400)
    const locked = await http()
      .post('/api/auth/verify-password')
      .set(bearer(pc.accessToken))
      .send({ password: wrong })
      .expect(401)
    expect(locked.body.code).toBe(Err.AUTH_SESSION_EXPIRED.code)
    expect(
      await ds.query('SELECT password_hash, mobile FROM iam_user WHERE id = ?', [owner.id]),
    ).toEqual([{ password_hash: pwHash, mobile: '13900009999' }])
    for (const at of [pc.accessToken, mobile.accessToken]) await me(at).expect(401)
    await refresh(pc.refreshToken).expect(401)
    await refresh(mobile.refreshToken, 'mobile').expect(401)
    await http().get('/api/oauth2/userinfo').set(bearer(delegated.accessToken)).expect(401)
    expect(
      (
        await oauthToken({
          grant_type: 'refresh_token',
          refresh_token: delegated.refreshToken,
        }).expect(400)
      ).body.error,
    ).toBe('invalid_grant')
  })

  it.each(['all', 'picked_depts', 'own_dept', 'own_dept_tree', 'own_rows'] as const)(
    'IDOR %s: list/get/update/delete/batch/export/options/create follow the same scope',
    async (scope) => {
      const ownDept = await dept()
      const child = await dept(ownDept)
      const farDept = await dept()
      const rid = await role(scope, Object.values(userPerms), [ownDept])
      const op = await user({ dept_id: ownDept }, [rid])
      const at = (await signIn(app, op.username)).accessToken
      const tag = unique()
      // iam_user's owner dimension is id, unlike business rows' created_by (see docs/design-notes.md#data-scope).
      const near =
        scope === 'own_rows' ? op : await user({ display_name: `${tag}-near`, dept_id: ownDept })
      if (scope === 'own_rows')
        await ds.query('UPDATE iam_user SET display_name = ? WHERE id = ?', [`${tag}-near`, op.id])
      const descendant = await user({ display_name: `${tag}-child`, dept_id: child })
      const far = await user({ display_name: `${tag}-far`, dept_id: farDept })
      const visible = [
        near.id,
        ...(scope === 'all' || scope === 'own_dept_tree' ? [descendant.id] : []),
        ...(scope === 'all' ? [far.id] : []),
      ]
      const rows = (
        await http()
          .get('/api/iam/users')
          .set(bearer(at))
          .query({ keyword: tag, pageSize: 200 })
          .expect(200)
      ).body.data.items as { id: number; username: string }[]
      expect(rows.map((row) => row.id).sort()).toEqual(visible.sort())
      const options = (
        await http()
          .get('/api/iam/users/options')
          .set(bearer(at))
          .query({ keyword: tag })
          .expect(200)
      ).body.data as { id: number }[]
      expect(options.map((row) => row.id).sort()).toEqual(visible.sort())
      const exported = await http()
        .get('/api/iam/users/export')
        .set(bearer(at))
        .query({ keyword: tag })
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => cb(null, Buffer.concat(chunks)))
        })
        .expect(200)
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(exported.body as unknown as Parameters<typeof workbook.xlsx.load>[0])
      const sheet = workbook.worksheets[0]!
      expect(
        Array.from(
          { length: sheet.rowCount - 1 },
          (_, i) => sheet.getRow(i + 2).getCell(1).value,
        ).sort(),
      ).toEqual(rows.map((row) => row.username).sort())
      await http().get(`/api/iam/users/${near.id}`).set(bearer(at)).expect(200)
      await http()
        .put(`/api/iam/users/${near.id}`)
        .set(bearer(at))
        .send({ displayName: `${tag}-changed` })
        .expect(200)
      if (scope !== 'all') {
        const before = await ds.query(
          'SELECT id, display_name, dept_id, deleted_at FROM iam_user WHERE id IN (?) ORDER BY id',
          [[near.id, far.id]],
        )
        await http().get(`/api/iam/users/${far.id}`).set(bearer(at)).expect(404)
        await http()
          .put(`/api/iam/users/${far.id}`)
          .set(bearer(at))
          .send({ displayName: 'intrusion' })
          .expect(404)
        await http().delete(`/api/iam/users/${far.id}`).set(bearer(at)).expect(404)
        await http()
          .post('/api/iam/users/batch-delete')
          .set(bearer(at))
          .send({ ids: [near.id, far.id] })
          .expect(404)
        expect(
          await ds.query(
            'SELECT id, display_name, dept_id, deleted_at FROM iam_user WHERE id IN (?) ORDER BY id',
            [[near.id, far.id]],
          ),
        ).toEqual(before)
        if (scope !== 'own_rows') {
          await http()
            .put(`/api/iam/users/${near.id}`)
            .set(bearer(at))
            .send({ deptId: farDept })
            .expect(404)
          const name = unique()
          await http()
            .post('/api/iam/users')
            .set(bearer(at))
            .send({ username: name, displayName: name, deptId: farDept, password: PW })
            .expect(404)
          expect(await ds.query('SELECT id FROM iam_user WHERE username = ?', [name])).toEqual([])
          expect(await ds.query('SELECT dept_id FROM iam_user WHERE id = ?', [near.id])).toEqual([
            { dept_id: ownDept },
          ])
        }
      } else await http().get(`/api/iam/users/${far.id}`).set(bearer(at)).expect(200)
      const name = unique()
      if (scope === 'own_rows') {
        await http()
          .post('/api/iam/users')
          .set(bearer(at))
          .send({ username: name, displayName: name, deptId: ownDept, password: PW })
          .expect(404)
        expect(await ds.query('SELECT id FROM iam_user WHERE username = ?', [name])).toEqual([])
        await http().delete(`/api/iam/users/${op.id}`).set(bearer(at)).expect(422)
        expect(
          (await ds.query('SELECT deleted_at FROM iam_user WHERE id = ?', [op.id]))[0].deleted_at,
        ).toBeNull()
        return
      }
      const inserted = (
        await http()
          .post('/api/iam/users')
          .set(bearer(at))
          .send({ username: name, displayName: name, deptId: ownDept, password: PW })
          .expect(201)
      ).body.data.id as number
      created.users.push(inserted)
      expect(await ds.query('SELECT created_by FROM iam_user WHERE id = ?', [inserted])).toEqual([
        { created_by: op.id },
      ])
      await http().delete(`/api/iam/users/${inserted}`).set(bearer(at)).expect(200)
      expect(
        (await ds.query('SELECT deleted_at FROM iam_user WHERE id = ?', [inserted]))[0].deleted_at,
      ).not.toBeNull()
    },
  )

  it('session/inbox ownership: mixed kicks roll back, root is protected, another inbox cannot be read or marked', async () => {
    const ownDept = await dept()
    const rid = await role('own_dept', Object.values(sessionPerms))
    const op = await user({ dept_id: ownDept }, [rid])
    const mate = await user({ dept_id: ownDept })
    const boss = await user({ dept_id: ownDept }, [rootRole])
    const far = await user()
    const [opSession, mateSession, bossSession, farSession] = await Promise.all(
      [op, mate, boss, far].map((u) => signIn(app, u.username)),
    )
    const at = opSession.accessToken
    const rows = (
      await http().get('/api/iam/sessions').set(bearer(at)).query({ pageSize: 200 }).expect(200)
    ).body.data.items as { sid: string }[]
    expect(rows.map((row) => row.sid)).toEqual(
      expect.arrayContaining([
        opSession.session.sid,
        mateSession.session.sid,
        bossSession.session.sid,
      ]),
    )
    expect(rows.map((row) => row.sid)).not.toContain(farSession.session.sid)
    await http()
      .post('/api/iam/sessions/kick')
      .set(bearer(at))
      .send({ sids: [mateSession.session.sid, farSession.session.sid] })
      .expect(404)
    const protectedRoot = await http()
      .delete(`/api/iam/sessions/${bossSession.session.sid}`)
      .set(bearer(at))
      .expect(422)
    expect(protectedRoot.body.code).toBe(Err.IAM_USER_PROTECTED.code)
    for (const session of [mateSession, bossSession, farSession])
      await me(session.accessToken).expect(200)
    const id = await insertRow(ds.manager, 'msg_inbox', {
      user_id: mate.id,
      template_code: unique(),
      locale: 'en-US',
      category: 'system',
      title: 'private',
      body: 'private',
    })
    const path = `/api/messaging/inboxes/mine/${id}`
    await http().get(path).set(bearer(at)).expect(404)
    await http().post(`${path}/read`).set(bearer(at)).expect(404)
    expect(await ds.query('SELECT read_at FROM msg_inbox WHERE id = ?', [id])).toEqual([
      { read_at: null },
    ])
    await http().get(path).set(bearer(mateSession.accessToken)).expect(200)
    await http().post(`${path}/read`).set(bearer(mateSession.accessToken)).expect(200)
    expect(
      (await ds.query('SELECT read_at FROM msg_inbox WHERE id = ?', [id]))[0].read_at,
    ).not.toBeNull()
  })

  it('grant subsets: non-root cannot grant root/wider roles; permission changes reach both existing clients immediately', async () => {
    const ownDept = await dept()
    const limited = await role('own_dept', Object.values(userPerms))
    const wider = await role('all', [userPerms.browse])
    const op = await user({ dept_id: ownDept }, [limited])
    const target = await user({ dept_id: ownDept }, [limited])
    const at = (await signIn(app, op.username)).accessToken
    for (const rid of [rootRole, wider]) {
      const rejected = await http()
        .put(`/api/iam/users/${target.id}/roles`)
        .set(bearer(at))
        .send({ roleIds: [rid] })
        .expect(403)
      expect(rejected.body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)
      expect(
        await ds.query(
          'SELECT role_id FROM iam_user_roles WHERE user_id = ? AND deleted_at IS NULL',
          [target.id],
        ),
      ).toEqual([{ role_id: limited }])
    }
    const pc = await signIn(app, target.username)
    const mobile = await signIn(app, target.username, { clientId: 'mobile' })
    const versions: string[] = []
    for (const session of [pc, mobile]) {
      const before = await http().get('/api/iam/users').set(bearer(session.accessToken)).expect(200)
      versions.push(before.headers['x-perm-ver'])
    }
    await http()
      .put(`/api/iam/users/${target.id}/roles`)
      .set(bearer(admin.accessToken))
      .send({ roleIds: [] })
      .expect(200)
    for (const [i, session] of [pc, mobile].entries()) {
      const denied = await http().get('/api/iam/users').set(bearer(session.accessToken)).expect(403)
      expect(denied.body.code).toBe(Err.FORBIDDEN.code)
      expect(denied.headers['x-perm-ver']).not.toBe(versions[i])
      expect((await me(session.accessToken).expect(200)).body.data.perms).toEqual([])
    }
  })

  it('brute-force/CSRF: unknown accounts answer alike, untrusted XFF cannot move counters, bad Origin cannot rotate', async () => {
    const owner = await user()
    app.set('trust proxy', false)
    try {
      const answers = []
      for (const [i, username] of [owner.username, unique()].entries()) {
        const spoof = `198.51.100.${10 + i}`
        const answer = await http()
          .post('/api/auth/login')
          .set('X-Forwarded-For', spoof)
          .send({ username, password: 'Wrong#Pass1' })
          .expect(401)
        answers.push({ code: answer.body.code, msg: answer.body.msg })
        expect(await redis.get(redisKey('authFail', 'ip', spoof))).toBeNull()
        expect(await redis.get(redisKey('authFail', 'p', username, '127.0.0.1'))).toBe('1')
      }
      expect(answers[0]).toEqual(answers[1])
      expect(
        Number(await redis.get(redisKey('authFail', 'ip', '127.0.0.1'))),
      ).toBeGreaterThanOrEqual(2)
    } finally {
      app.set('trust proxy', 'loopback')
    }
    const first = await signIn(app, owner.username, { ua: UA })
    for (const origin of [undefined, 'https://attacker.example']) {
      const call = http()
        .post('/api/auth/refresh')
        .set('Cookie', `qw_rt=${first.refreshToken}`)
        .send({})
      const rejected = await (origin ? call.set('Origin', origin) : call).expect(403)
      expect(rejected.body.code).toBe(Err.AUTH_ORIGIN_REJECTED.code)
      expect(await tokens.inspect(first.refreshToken)).not.toBeNull()
      await me(first.accessToken).expect(200)
    }
    await refresh(first.refreshToken).expect(200)
  })

  it('SQL/redirect/PKCE: invalid sort is refused, injection is data, callback exact match and S256 are required', async () => {
    const before = Number((await ds.query('SELECT COUNT(*) AS n FROM iam_user'))[0].n)
    await http()
      .get('/api/iam/users')
      .set(bearer(admin.accessToken))
      .query({ sort: 'id; DROP TABLE iam_user' })
      .expect(400)
    const injection = (
      await http()
        .get('/api/iam/users')
        .set(bearer(admin.accessToken))
        .query({ keyword: "' OR 1=1 --" })
        .expect(200)
    ).body.data
    expect(injection.items).toEqual([])
    expect(injection.total).toBe(0)
    for (const over of [
      { redirect_uri: `${CALLBACK}/evil` },
      { redirect_uri: 'https://attacker.example/cb' },
      { code_challenge_method: 'plain' },
      { code_challenge: undefined },
    ]) {
      const { res } = await authorize(admin.accessToken, over)
      expect(res.status).toBe(400)
      expect(res.body.data?.redirectTo).toBeUndefined()
    }
    const code = await pendingCode(admin.accessToken)
    expect(
      (await exchange({ ...code, verifier: randomBytes(32).toString('base64url') }).expect(400))
        .body.error,
    ).toBe('invalid_grant')
    expect((await exchange(code).expect(400)).body.error).toBe('invalid_grant')
    expect(await redis.get(redisKey('oauth2Code', hash(code.code)))).toBeNull()
    expect(Number((await ds.query('SELECT COUNT(*) AS n FROM iam_user'))[0].n)).toBe(before)
  })

  it('sensitive data: token/code keys use hashes, grace is encrypted, real user/session responses strip secrets', async () => {
    const owner = await user()
    const first = await signIn(app, owner.username, { ua: UA })
    const code = await pendingCode(first.accessToken)
    const rotated = await refresh(first.refreshToken).expect(200)
    const newAt = rotated.body.data.accessToken as string
    const newRt = cookieToken(rotated)
    const grace = await redis.get(redisKey('authRefreshGrace', hash(first.refreshToken)))
    expect(grace).not.toBeNull()
    const sealed = JSON.parse(grace!) as Record<string, unknown>
    expect(sealed).toMatchObject({
      sid: first.session.sid,
      ct: expect.any(String),
      iv: expect.any(String),
      tag: expect.any(String),
    })
    const secrets = [
      PW,
      pwHash,
      SECRET,
      code.code,
      first.accessToken,
      first.refreshToken,
      newAt,
      newRt,
    ]
    const keys = await redis.sMembers(redisKey('authUser', owner.id))
    expect(keys).toContain(redisKey('authAccess', hash(newAt)))
    expect(keys).toContain(redisKey('authRefresh', hash(newRt)))
    const stored = JSON.stringify([
      keys,
      await redis.mGet(keys),
      await redis.get(redisKey('oauth2Code', hash(code.code))),
    ])
    for (const secret of secrets) expect(stored).not.toContain(secret)
    for (const res of [
      await me(newAt).expect(200),
      await http().get(`/api/iam/users/${owner.id}`).set(bearer(admin.accessToken)).expect(200),
      await http()
        .get('/api/iam/sessions')
        .set(bearer(admin.accessToken))
        .query({ username: owner.username })
        .expect(200),
    ]) {
      const json = JSON.stringify(res.body)
      for (const secret of secrets) expect(json).not.toContain(secret)
      expect(json).not.toMatch(/passwordHash|password_hash|secret_hash|refreshToken|accessToken/)
    }
  })
})
