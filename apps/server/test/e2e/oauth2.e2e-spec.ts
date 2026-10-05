// OAuth2 provider (see docs/design-notes.md#auth-sessions). token: authorization_code with PKCE S256 (codes minted
// through OAuthProvider.issueCode, as the consent page will), refresh rotation on TokenService's path
// (grace window, replay → session revoked, bound to its client), client_credentials without a user;
// confidential clients only, first-party ids refused, raw RFC JSON errors; introspection and revocation
// of the caller's own tokens; third-party tokens never reach first-party routes; password change,
// disable, delete and user kick end OAuth sessions and pending codes; a client disabled or deleted
// during issuance. sessions: the online list shows and kicks them (client_credentials
// ones: root only); revokeClient ends a client's sessions. authorize: the consent page's GET/POST (exact
// redirect URIs, S256 only, scopes within the client's, first-party sessions only), remembered consents
// (oauth.consent_ttl_days; going with their user or client), userinfo by scope, the code masked in the
// action log, and a client registered through the client pages working end to end.
import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, oauthParams, type SessionVo, sessionPerms } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { type Issued, TokenService } from '../../src/core/auth/token.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import {
  OAuthProvider,
  secretDigest,
} from '../../src/modules/platform/oauth/provider/provider.service.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'oauth2-e2e-'
const PW = 'Oauth2#Pass1'
const SECRET = 'crm-secret-0123456789abcdefghij'
const CB = 'https://crm.example/cb'
const UA = 'crm-backend/1.0'
const ALL = ['authorization_code', 'refresh_token', 'client_credentials']

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let provider: OAuthProvider
let tokens: TokenService
let admin = ''
const userIds: number[] = []
const clientRows: number[] = []
let roleId = 0
let ann = 0
let bob = 0

const http = () => request(app.getHttpServer())
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

async function user(name: string, roles: number[] = []) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: await bcrypt.hash(PW, 4),
    password_changed_at: new Date(),
  })
  userIds.push(id)
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  return id
}

/** A third-party client with secret {@link SECRET}. */
async function client(clientId: string, row: Record<string, unknown> = {}) {
  const id = await insertRow(ds.manager, 'oauth_client', {
    client_id: clientId,
    secret_hash: secretDigest(SECRET),
    name: clientId,
    grant_types: ALL,
    redirect_uris: [CB],
    scopes: ['user.read'],
    auto_approve_scopes: [],
    access_ttl_sec: 600,
    refresh_ttl_sec: 3600,
    ...row,
  })
  clientRows.push(id)
  return id
}

/** POST /token as a third-party back end; `basic` = HTTP Basic credentials instead of form fields. */
const token = (form: Record<string, string>, basic?: [string, string], ua = UA) => {
  const req = http().post('/api/oauth2/token').type('form').set('User-Agent', ua)
  return (basic ? req.auth(...basic) : req).send(form)
}
const creds = (clientId: string, secret = SECRET) => ({
  client_id: clientId,
  client_secret: secret,
})

/** A code of `userId` for `clientId`, as the consent page's approve will mint it. */
async function mint(clientId: string, userId: number, scopes = ['user.read']) {
  const { verifier, challenge } = pkce()
  const c = await provider.client(clientId)
  if (!c) throw new Error(`mint: no client ${clientId}`)
  const code = await provider.issueCode(userId, c, { redirectUri: CB, scopes, challenge })
  return { code, verifier }
}
const exchange = (clientId: string, code: string, verifier: string, extra = {}) =>
  token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CB,
    code_verifier: verifier,
    ...creds(clientId),
    ...extra,
  })

interface Pair {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
}
/** A fresh code session of `userId` on `clientId`. */
async function pair(clientId: string, userId: number): Promise<Pair> {
  const { code, verifier } = await mint(clientId, userId)
  return (await exchange(clientId, code, verifier).expect(200)).body as Pair
}
const refresh = (clientId: string, rt: string, extra = {}, ua = UA) =>
  token(
    { grant_type: 'refresh_token', refresh_token: rt, ...creds(clientId), ...extra },
    undefined,
    ua,
  )
const cc = (clientId: string, extra = {}) =>
  token({ grant_type: 'client_credentials', ...creds(clientId), ...extra })
const introspect = (t: string, clientId = 'crm') =>
  http().post('/api/oauth2/introspect').type('form').auth(clientId, SECRET).send({ token: t })
const active = async (t: string, clientId = 'crm') =>
  (await introspect(t, clientId).expect(200)).body.active as boolean
const revoke = (t: string, clientId = 'crm') =>
  http().post('/api/oauth2/revoke').type('form').auth(clientId, SECRET).send({ token: t })
const sidOf = async (accessToken: string) => (await tokens.inspect(accessToken))?.session.sid

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  provider = app.get(OAuthProvider)
  tokens = app.get(TokenService)
  await cleanRedis(redis)
  admin = (await signIn(app)).accessToken
  ann = await user('ann')
  bob = await user('bob')
  await client('crm')
  await client('erp')
  await client('nocc', { grant_types: ['authorization_code'] })
  await client('off', { enabled: 0 })
  // a third-party row under a first-party id: its sessions would pass AuthGuard as first-party
  await client('mobile')
  await client('greedy', { grant_types: [...ALL, 'password', 'implicit'] })
})

afterAll(async () => {
  if (ds && clientRows.length)
    await ds.query('DELETE FROM oauth_client WHERE id IN (?)', [clientRows])
  if (ds && userIds.length) {
    await ds.query('DELETE FROM oauth_consent WHERE user_id IN (?)', [userIds])
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

describe('token', () => {
  it.each([
    ['disable', 'authorization_code'],
    ['disable', 'client_credentials'],
    ['delete', 'authorization_code'],
    ['delete', 'client_credentials'],
  ])(
    'client %s during %s issuance: the new session is revoked, invalid_client',
    async (action, grant) => {
      const id = `race-${action}-${grant}`
      const pk = await client(id)
      const pending = grant === 'authorization_code' ? await mint(id, ann) : null
      const original = tokens.issue.bind(tokens)
      const issued: { value: Issued | null } = { value: null }
      const spy = vi.spyOn(tokens, 'issue').mockImplementationOnce(async (u, opts) => {
        // getClient already read enabled=1. The admin revokes before the new session exists.
        if (action === 'disable')
          await http()
            .put(`/api/oauth/clients/${pk}/enabled`)
            .set(bearer(admin))
            .send({ enabled: false })
            .expect(200)
        else {
          await http().delete(`/api/oauth/clients/${pk}`).set(bearer(admin)).expect(200)
          // Reuse the public id: only a re-read by primary key refuses the old authenticated row.
          await client(id)
        }
        issued.value = await original(u, opts)
        return issued.value
      })
      try {
        const res = await (pending ? exchange(id, pending.code, pending.verifier) : cc(id))
        expect([400, 401]).toContain(res.status)
        expect(res.body.error).toBe('invalid_client')
      } finally {
        spy.mockRestore()
      }
      expect(issued.value).not.toBeNull()
      const t = issued.value!
      expect(await tokens.inspect(t.accessToken)).toBeNull()
      expect(await redis.zScore(redisKey('authOnline'), t.session.sid)).toBeNull()
      expect((await tokens.online()).some((s) => s.clientId === id)).toBe(false)
      // re-enabled so introspection judges the issued token, not the caller's client
      if (action === 'disable')
        await http()
          .put(`/api/oauth/clients/${pk}/enabled`)
          .set(bearer(admin))
          .send({ enabled: true })
          .expect(200)
      expect(await active(t.accessToken, id)).toBe(false)
    },
  )

  it('authorization_code + PKCE S256 + secret → RFC answer at the client’s lifetimes; the code is single use', async () => {
    const { code, verifier } = await mint('crm', ann)
    const res = await exchange('crm', code, verifier).expect(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers.pragma).toBe('no-cache')
    expect(Object.keys(res.body).sort()).toEqual(
      ['access_token', 'token_type', 'expires_in', 'refresh_token', 'scope'].sort(),
    )
    expect(res.body).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'user.read' })
    const s = (await tokens.inspect(res.body.access_token))!.session
    expect(s).toMatchObject({
      userId: ann,
      username: `${PREFIX}ann`,
      clientId: 'crm',
      scopes: ['user.read'],
      ttl: { accessMs: 600_000, refreshMs: 3_600_000 },
    })
    expect(s.absoluteExpAt - s.loginAt).toBe(3_600_000)
    const again = await exchange('crm', code, verifier).expect(400)
    expect(again.body).toMatchObject({ error: 'invalid_grant' })
  })

  it('HTTP Basic client authentication; a code redeemed by another client → invalid_grant, and burnt', async () => {
    const a = await mint('crm', ann)
    const res = await token(
      {
        grant_type: 'authorization_code',
        code: a.code,
        redirect_uri: CB,
        code_verifier: a.verifier,
      },
      ['crm', SECRET],
    ).expect(200)
    expect(res.body.refresh_token).toEqual(expect.any(String))
    const b = await mint('crm', ann)
    expect((await exchange('erp', b.code, b.verifier).expect(400)).body.error).toBe('invalid_grant')
    expect((await exchange('crm', b.code, b.verifier).expect(400)).body.error).toBe('invalid_grant')
  })

  it('a wrong code_verifier burns the code; a missing one fails', async () => {
    const a = await mint('crm', ann)
    expect((await exchange('crm', a.code, pkce().verifier).expect(400)).body.error).toBe(
      'invalid_grant',
    )
    expect((await exchange('crm', a.code, a.verifier).expect(400)).body.error).toBe('invalid_grant')
    const b = await mint('crm', ann)
    const res = await token({
      grant_type: 'authorization_code',
      code: b.code,
      redirect_uri: CB,
      ...creds('crm'),
    }).expect(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('a code stored without a PKCE challenge never redeems (the library would skip PKCE)', async () => {
    const c = (await provider.client('crm'))!
    const code = randomBytes(32).toString('base64url')
    await tokens.saveCode(
      code,
      {
        client: 'crm',
        clientPk: c.id,
        userId: ann,
        redirectUri: CB,
        scopes: ['user.read'],
        challenge: '',
        credVer: await tokens.credVersion(ann),
        exp: Date.now() + 60_000,
      },
      60_000,
    )
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CB,
      ...creds('crm'),
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('redirect_uri other than the authorization request’s, or missing → invalid_request; one the client no longer lists → invalid_grant', async () => {
    for (const redirect_uri of [`${CB}/`, 'https://CRM.example/cb', `${CB}?x=1`, undefined]) {
      const a = await mint('crm', ann)
      const form = { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier }
      const res = await token({ ...form, ...creds('crm'), ...(redirect_uri && { redirect_uri }) })
      expect([redirect_uri, res.status, res.body.error]).toEqual([
        redirect_uri,
        400,
        'invalid_request',
      ])
    }
    const moved = await client('crm-moved')
    const a = await mint('crm-moved', ann)
    await ds.query('UPDATE oauth_client SET redirect_uris = ? WHERE id = ?', [
      JSON.stringify(['https://crm.example/new']),
      moved,
    ])
    expect((await exchange('crm-moved', a.code, a.verifier).expect(400)).body.error).toBe(
      'invalid_grant',
    )
  })

  it('confidential clients only: no secret (with PKCE too), a wrong one, a disabled client, first-party ids → invalid_client', async () => {
    const a = await mint('crm', ann)
    const noSecret = await token({
      grant_type: 'authorization_code',
      code: a.code,
      redirect_uri: CB,
      code_verifier: a.verifier,
      client_id: 'crm',
    }).expect(400)
    expect(noSecret.body.error).toBe('invalid_client')
    expect((await cc('crm', { client_secret: 'wrong' }).expect(400)).body.error).toBe(
      'invalid_client',
    )
    const basic = await token({ grant_type: 'client_credentials' }, ['crm', 'wrong']).expect(401)
    expect(basic.body.error).toBe('invalid_client')
    expect(basic.headers['www-authenticate']).toMatch(/^Basic/)
    for (const id of ['off', 'console', 'mobile', 'nobody'])
      expect([id, (await cc(id).expect(400)).body.error]).toEqual([id, 'invalid_client'])
  })

  it('a client registered again under a deleted one’s client_id cannot redeem the old codes', async () => {
    const old = await client('reborn')
    const a = await mint('reborn', ann)
    await ds.query('UPDATE oauth_client SET deleted_at = NOW(3) WHERE id = ?', [old])
    await client('reborn')
    expect((await exchange('reborn', a.code, a.verifier).expect(400)).body.error).toBe(
      'invalid_grant',
    )
  })

  it('concurrent exchanges of one code: exactly one gets tokens', async () => {
    const a = await mint('crm', ann)
    const res = await Promise.all([1, 2].map(() => exchange('crm', a.code, a.verifier)))
    expect(res.map((r) => r.status).sort()).toEqual([200, 400])
    expect(res.find((r) => r.status === 400)!.body.error).toBe('invalid_grant')
  })

  it('unsupported grants and malformed requests: password (even when listed), implicit, unknown → unsupported_grant_type; JSON or array fields → invalid_request', async () => {
    for (const grant_type of ['password', 'implicit', 'foo']) {
      const res = await token({ grant_type, username: 'admin', password: 'x', ...creds('greedy') })
      expect([grant_type, res.status, res.body.error]).toEqual([
        grant_type,
        400,
        'unsupported_grant_type',
      ])
    }
    const a = await mint('crm', ann)
    const json = await http()
      .post('/api/oauth2/token')
      .send({ grant_type: 'authorization_code', code: a.code, redirect_uri: CB, ...creds('crm') })
      .expect(400)
    expect(json.body).toMatchObject({ error: 'invalid_request' })
    const arr = await http()
      .post('/api/oauth2/token')
      .type('form')
      .send(`grant_type=authorization_code&code[]=x&client_id=crm&client_secret=${SECRET}`)
      .expect(400)
    expect(arr.body).toEqual({ error: 'invalid_request' })
  })

  it('an internal failure answers the generic 500 envelope, never the inner message', async () => {
    const a = await mint('crm', ann)
    const spy = vi.spyOn(tokens, 'takeCode').mockRejectedValueOnce(new Error('inner-detail-x'))
    try {
      const res = await exchange('crm', a.code, a.verifier).expect(500)
      expect(res.body).toMatchObject({ code: Err.INTERNAL.code, data: null })
      expect(res.text).not.toContain('inner-detail-x')
    } finally {
      spy.mockRestore()
    }
  })

  it('refresh rotates within the session at the client’s lifetimes; a replay later or from another UA revokes the session', async () => {
    const p = await pair('crm', ann)
    const sid = await sidOf(p.access_token)
    const r = await refresh('crm', p.refresh_token!).expect(200)
    expect(r.body).toMatchObject({ token_type: 'Bearer', expires_in: 600, scope: 'user.read' })
    expect(r.body.refresh_token).not.toBe(p.refresh_token)
    expect(await sidOf(r.body.access_token)).toBe(sid)
    expect(await active(p.access_token)).toBe(false)
    // within the grace window from the same UA: the same pair again (a retry), not a replay
    expect((await refresh('crm', p.refresh_token!).expect(200)).body).toEqual(r.body)

    const replay = await refresh('crm', p.refresh_token!, {}, 'stolen-ua/1.0').expect(400)
    expect(replay.body.error).toBe('invalid_grant')
    expect(await active(r.body.access_token)).toBe(false)
    expect((await refresh('crm', r.body.refresh_token).expect(400)).body.error).toBe(
      'invalid_grant',
    )
  })

  it('a refresh widening the scope fails after the rotation; the plain retry within the grace window still gets tokens', async () => {
    const p = await pair('crm', ann)
    const wide = await refresh('crm', p.refresh_token!, { scope: 'user.read admin' }).expect(400)
    expect(wide.body.error).toBe('invalid_scope')
    const retry = await refresh('crm', p.refresh_token!).expect(200)
    expect(await active(retry.body.access_token)).toBe(true)
  })

  it('a refresh token works only for its client; past the session’s absolute limit it is dead', async () => {
    const p = await pair('crm', ann)
    expect((await refresh('erp', p.refresh_token!).expect(400)).body.error).toBe('invalid_grant')
    expect(await active(p.access_token)).toBe(true)
    const r = await refresh('crm', p.refresh_token!).expect(200)
    const s = (await tokens.inspect(r.body.access_token))!.session
    await tokens.save({ ...s, absoluteExpAt: Date.now() - 1 })
    expect((await refresh('crm', r.body.refresh_token).expect(400)).body.error).toBe(
      'invalid_grant',
    )
  })

  it('a disabled or deleted client can no longer refresh, introspect or revoke', async () => {
    const id = await client('crm-k2')
    const p = await pair('crm-k2', ann)
    await ds.query('UPDATE oauth_client SET enabled = 0 WHERE id = ?', [id])
    expect((await refresh('crm-k2', p.refresh_token!).expect(400)).body.error).toBe(
      'invalid_client',
    )
    await introspect(p.access_token, 'crm-k2').expect(401)
    await ds.query('UPDATE oauth_client SET enabled = 1, deleted_at = NOW(3) WHERE id = ?', [id])
    expect((await refresh('crm-k2', p.refresh_token!).expect(400)).body.error).toBe(
      'invalid_client',
    )
    await revoke(p.access_token, 'crm-k2').expect(401)
  })

  it('client_credentials: no refresh token, a session without a user; scope outside the client’s → invalid_scope; without the grant → unauthorized_client', async () => {
    const res = await cc('crm').expect(200)
    expect(Object.keys(res.body).sort()).toEqual(
      ['access_token', 'token_type', 'expires_in', 'scope'].sort(),
    )
    expect(res.body).toMatchObject({ expires_in: 600, scope: 'user.read' })
    const s = (await tokens.inspect(res.body.access_token))!.session
    expect(s).toMatchObject({ userId: null, userType: 'client', clientId: 'crm', perms: [] })
    expect(s.absoluteExpAt - s.loginAt).toBe(600_000)
    expect((await cc('crm', { scope: 'admin' }).expect(400)).body.error).toBe('invalid_scope')
    expect((await cc('nocc').expect(400)).body.error).toBe('unauthorized_client')
    // a code answer without the refresh_token grant has no refresh token; the session lives one access TTL
    const p = await pair('nocc', ann)
    expect(p.refresh_token).toBeUndefined()
    const n = (await tokens.inspect(p.access_token))!.session
    expect(n.absoluteExpAt - n.loginAt).toBe(600_000)
  })

  it('introspect: the caller’s own live tokens are active; another client’s, unknown or first-party ones are not', async () => {
    const p = await pair('crm', ann)
    const res = await introspect(p.access_token).expect(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const now = Math.floor(Date.now() / 1000)
    expect(res.body).toEqual({
      active: true,
      client_id: 'crm',
      scope: 'user.read',
      token_type: 'Bearer',
      exp: expect.any(Number),
      sub: String(ann),
      username: `${PREFIX}ann`,
    })
    expect(res.body.exp).toBeGreaterThanOrEqual(now + 598)
    expect(res.body.exp).toBeLessThanOrEqual(now + 600)
    expect((await introspect(p.refresh_token!).expect(200)).body).toMatchObject({
      active: true,
      client_id: 'crm',
      sub: String(ann),
    })
    const machine = (await cc('crm').expect(200)).body.access_token as string
    const m = (await introspect(machine).expect(200)).body
    expect(m).toMatchObject({ active: true, client_id: 'crm' })
    expect(m).not.toHaveProperty('sub')
    for (const t of [p.access_token, p.refresh_token!])
      expect((await introspect(t, 'erp').expect(200)).body).toEqual({ active: false })
    for (const t of ['not-a-token', admin])
      expect((await introspect(t).expect(200)).body).toEqual({ active: false })
  })

  it('introspect and revoke need client authentication (401 invalid_client) and a token (400)', async () => {
    const p = await pair('crm', ann)
    for (const path of ['introspect', 'revoke']) {
      const url = `/api/oauth2/${path}`
      const none = await http().post(url).type('form').send({ token: p.access_token }).expect(401)
      expect(none.body).toEqual({ error: 'invalid_client' })
      expect(none.headers['www-authenticate']).toMatch(/^Basic/)
      await http()
        .post(url)
        .type('form')
        .send({ token: p.access_token, ...creds('crm', 'wrong') })
        .expect(401)
      await http().post(url).type('form').send(creds('crm')).expect(400)
      // a non-ASCII client id is a miss, never a MySQL conversion error on the ascii_bin column (500)
      await http()
        .post(url)
        .type('form')
        .send({ token: p.access_token, client_id: '\u4e2d\u6587', client_secret: 'x' })
        .expect(401)
      await http().post(url).type('form').auth('cr\u00e9', 'x').send({ token: 'x' }).expect(401)
      // body credentials work like HTTP Basic
      await http()
        .post(url)
        .type('form')
        .send({ token: 'x', ...creds('crm') })
        .expect(200)
    }
    expect(await active(p.access_token)).toBe(true)
  })

  it('revoke: an own access or refresh token ends its whole session; another client’s stays; always 200', async () => {
    const p = await pair('crm', ann)
    await revoke(p.access_token, 'erp').expect(200)
    expect(await active(p.access_token)).toBe(true)
    const res = await revoke(p.access_token).expect(200)
    expect(res.text).toBe('')
    expect(await active(p.access_token)).toBe(false)
    expect((await refresh('crm', p.refresh_token!).expect(400)).body.error).toBe('invalid_grant')
    const q = await pair('crm', ann)
    await revoke(q.refresh_token!).expect(200)
    expect(await active(q.access_token)).toBe(false)
    await revoke('not-a-token').expect(200)
  })

  it('OAuth tokens never reach first-party routes; /api/auth/refresh refuses an OAuth refresh token and the session lives on', async () => {
    const p = await pair('crm', ann)
    const machine = (await cc('crm').expect(200)).body.access_token as string
    for (const t of [p.access_token, machine])
      for (const url of ['/api/iam/users', '/api/auth/me'])
        await http().get(url).set(bearer(t)).expect(401)
    const origin = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`
    await http()
      .post('/api/auth/refresh')
      .set('Origin', origin)
      .set('Cookie', `qw_rt=${p.refresh_token}`)
      .send({})
      .expect(401)
    await http().post('/api/auth/refresh').send({ refreshToken: p.refresh_token }).expect(401)
    expect(await active(p.access_token)).toBe(true)
    expect((await refresh('crm', p.refresh_token!).expect(200)).body.access_token).toEqual(
      expect.any(String),
    )
  })

  it('a password change ends the user’s OAuth sessions and pending codes', async () => {
    const console = await signIn(app, `${PREFIX}bob`)
    const p = await pair('crm', bob)
    const pending = await mint('crm', bob)
    await http()
      .put('/api/iam/profile/password')
      .set(bearer(console.accessToken))
      .send({ oldPassword: PW, newPassword: 'Changed#Pass2' })
      .expect(200)
    expect(await active(p.access_token)).toBe(false)
    expect((await refresh('crm', p.refresh_token!).expect(400)).body.error).toBe('invalid_grant')
    expect((await exchange('crm', pending.code, pending.verifier).expect(400)).body.error).toBe(
      'invalid_grant',
    )
  })

  it('a code minted before a revocation that left it in place is refused at the exchange (credver)', async () => {
    const a = await mint('crm', bob)
    // what a revocation racing issueCode leaves behind: the code saved, the user's credver moved
    await redis.incr(redisKey('authCredVer', bob))
    expect((await exchange('crm', a.code, a.verifier).expect(400)).body.error).toBe('invalid_grant')
    await pair('crm', bob)
  })

  it('Swagger documents the three RFC endpoints: form bodies, raw RFC answers and errors', async () => {
    const doc = (await http().get('/api/docs-json').expect(200)).body
    for (const path of ['token', 'introspect', 'revoke']) {
      const op = doc.paths[`/api/oauth2/${path}`].post
      expect(op.tags).toEqual(['oauth2'])
      expect(Object.keys(op.requestBody.content)).toEqual(['application/x-www-form-urlencoded'])
      expect(Object.keys(op.responses).sort()).toEqual(['200', '400', '401'])
    }
    const token = doc.paths['/api/oauth2/token'].post
    expect(
      token.requestBody.content['application/x-www-form-urlencoded'].schema.properties,
    ).toHaveProperty('code_verifier')
    expect(token.responses['200'].content['application/json'].schema.properties).toHaveProperty(
      'access_token',
    )
  })

  // Every call fails client authentication: a slow hash (bcrypt ≈ 0.4 s a compare) would time this out.
  it('rate limits per IP: /token 600, /introspect and /revoke 1200 a minute, then 429', async () => {
    const bad = { client_id: 'nobody', client_secret: 'x' }
    const routes = [
      ['token', 600, { grant_type: 'client_credentials', ...bad }, 400],
      ['introspect', 1200, { token: 'x', ...bad }, 401],
      ['revoke', 1200, { token: 'x', ...bad }, 401],
    ] as const
    for (const [i, [path, limit, form, status]] of routes.entries()) {
      const call = () =>
        http()
          .post(`/api/oauth2/${path}`)
          .type('form')
          .set('X-Forwarded-For', `198.51.100.${i + 1}`)
          .send(form)
      for (let n = 0; n < limit; n += 50) {
        const res = await Promise.all(Array.from({ length: 50 }, call))
        expect([path, res.filter((r) => r.status !== status).length]).toEqual([path, 0])
      }
      const over = await call()
      expect([path, over.status, over.body.code]).toEqual([path, 429, Err.TOO_MANY_REQUESTS.code])
    }
  }, 60_000)
})

describe('sessions', () => {
  const list = (token: string) =>
    http().get('/api/iam/sessions').query({ clientId: 'crm', pageSize: 200 }).set(bearer(token))

  it.each(['disable', 'delete', 'kick'])(
    'user %s invalidates OAuth tokens, userinfo and pending codes',
    async (action) => {
      const id = await user(`revoke-${action}`)
      const pending = await mint('crm', id)
      const p = await pair('crm', id)
      expect(await active(p.access_token)).toBe(true)
      await http().get('/api/oauth2/userinfo').set(bearer(p.access_token)).expect(200)
      if (action === 'disable')
        await http()
          .put(`/api/iam/users/${id}/enabled`)
          .set(bearer(admin))
          .send({ enabled: false })
          .expect(200)
      else if (action === 'delete')
        await http().delete(`/api/iam/users/${id}`).set(bearer(admin)).expect(200)
      else
        await http()
          .post('/api/iam/sessions/kick')
          .set(bearer(admin))
          .send({ userId: id })
          .expect(200)
      expect(await active(p.access_token)).toBe(false)
      expect(await active(p.refresh_token!)).toBe(false)
      expect((await refresh('crm', p.refresh_token!).expect(400)).body.error).toBe('invalid_grant')
      await http().get('/api/oauth2/userinfo').set(bearer(p.access_token)).expect(401)
      expect(
        await redis.exists(
          redisKey('oauth2Code', createHash('sha256').update(pending.code).digest('hex')),
        ),
      ).toBe(0)
      expect((await exchange('crm', pending.code, pending.verifier).expect(400)).body.error).toBe(
        'invalid_grant',
      )
    },
  )

  it('root lists OAuth sessions (code and client_credentials) and kicks them; a user kick ends them too', async () => {
    const p = await pair('crm', ann)
    const machine = (await cc('crm').expect(200)).body.access_token as string
    const [sid, msid] = [await sidOf(p.access_token), await sidOf(machine)]
    const rows = (await list(admin).expect(200)).body.data.items as SessionVo[]
    expect(rows.every((r) => r.clientId === 'crm')).toBe(true)
    expect(rows.find((r) => r.sid === sid)).toMatchObject({
      userId: ann,
      username: `${PREFIX}ann`,
      clientId: 'crm',
      userAgent: UA,
    })
    expect(rows.find((r) => r.sid === msid)).toMatchObject({ userId: null, userType: 'client' })
    expect(JSON.stringify(rows)).not.toContain(p.access_token)

    await http().delete(`/api/iam/sessions/${sid}`).set(bearer(admin)).expect(200)
    expect(await active(p.access_token)).toBe(false)
    expect((await refresh('crm', p.refresh_token!).expect(400)).body.error).toBe('invalid_grant')
    await http().delete(`/api/iam/sessions/${msid}`).set(bearer(admin)).expect(200)
    expect(await active(machine)).toBe(false)

    const q = await pair('crm', ann)
    await http().post('/api/iam/sessions/kick').set(bearer(admin)).send({ userId: ann }).expect(200)
    expect(await active(q.access_token)).toBe(false)
  })

  it('a non-root operator neither lists nor kicks a client_credentials session (404)', async () => {
    roleId = await insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}ops`,
      name: `${PREFIX}ops`,
      data_scope: 'all',
    })
    for (const perm of [sessionPerms.browse, sessionPerms.kick])
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
        roleId,
        await findId(ds.manager, 'iam_menu', { perms: perm }),
      ])
    await user('op', [roleId])
    const op = (await signIn(app, `${PREFIX}op`)).accessToken
    const machine = (await cc('crm').expect(200)).body.access_token as string
    const msid = await sidOf(machine)
    const p = await pair('crm', ann)
    const sids = ((await list(op).expect(200)).body.data.items as SessionVo[]).map((r) => r.sid)
    expect(sids).toContain(await sidOf(p.access_token))
    expect(sids).not.toContain(msid)
    await http().delete(`/api/iam/sessions/${msid}`).set(bearer(op)).expect(404)
    expect(await active(machine)).toBe(true)
  })

  it('revokeClient ends every session of the client (code and client_credentials), only its own; console is refused', async () => {
    await client('crm-gone')
    const p = await pair('crm-gone', ann)
    const machine = (await cc('crm-gone').expect(200)).body.access_token as string
    const other = await pair('crm', ann)
    const revoker = app.get(SessionRevoker)
    expect(await revoker.revokeClient('crm-gone', 'client_disabled')).toBe(2)
    for (const t of [p.access_token, machine]) expect(await active(t, 'crm-gone')).toBe(false)
    expect(await active(other.access_token)).toBe(true)
    await expect(revoker.revokeClient('console', 'client_disabled')).rejects.toThrow('first-party')
    expect((await http().get('/api/auth/me').set(bearer(admin))).status).toBe(200)
  })
})

describe('authorize', () => {
  const QCB = 'https://q.example/cb?tenant=7'
  let cat = 0
  let catConsole = ''

  /** An authorization request (the /sso page's query string) and its PKCE verifier. */
  const ask = (over: Record<string, string | undefined> = {}) => {
    const { verifier, challenge } = pkce()
    const query = Object.fromEntries(
      Object.entries({
        response_type: 'code',
        client_id: 'crm',
        redirect_uri: CB,
        scope: 'user.read',
        state: 'st-1',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...over,
      }).filter(([, v]) => v !== undefined),
    )
    return { verifier, query }
  }
  const view = (token: string, query: object) =>
    http().get('/api/oauth2/authorize').query(query).set(bearer(token))
  const answer = (token: string, query: object, approve = true) =>
    http().post('/api/oauth2/authorize').query(query).set(bearer(token)).send({ approve })
  const consents = async (userId: number) =>
    (
      await ds.query<{ scope: string; client_id: string; deleted_at: Date | null }[]>(
        'SELECT scope, client_id, deleted_at FROM oauth_consent WHERE user_id = ?',
        [userId],
      )
    ).map((r) => ({ ...r, client_id: Number(r.client_id) }))
  /** A console session of a new user. */
  const someone = async (name: string) => {
    const id = await user(name)
    return { id, token: (await signIn(app, PREFIX + name)).accessToken }
  }
  const setDays = async (days: number) => {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      String(days),
      oauthParams.consentTtlDays,
    ])
    await app.get(ParamService).invalidate(oauthParams.consentTtlDays)
  }
  /** The code and the rest of the query of an approve's `redirectTo`. */
  const parsed = (redirectTo: string) => new URL(redirectTo)

  beforeAll(async () => {
    ;({ id: cat, token: catConsole } = await someone('cat'))
    await client('auto', { auto_approve_scopes: ['user.read'] })
    await client('q', { redirect_uris: [QCB] })
    await client('cconly', { grant_types: ['client_credentials'] })
  })

  it.each(['get', 'post'] as const)(
    '%s /authorize rate limits an IP at 120 requests a minute',
    async (method) => {
      const ip = method === 'get' ? '198.51.100.10' : '198.51.100.11'
      const { query } = ask({ client_id: 'nobody' })
      const call = () =>
        (method === 'get' ? view(admin, query) : answer(admin, query)).set('X-Forwarded-For', ip)
      for (let n = 0; n < 120; n += 30) {
        const replies = await Promise.all(Array.from({ length: 30 }, call))
        expect(replies.map((r) => r.status)).toEqual(Array(30).fill(400))
      }
      const over = await call()
      expect([over.status, over.body.code]).toEqual([429, Err.TOO_MANY_REQUESTS.code])
    },
  )

  it('full flow: consent page → approve → code + state → token → userinfo (the user’s public profile only)', async () => {
    const { verifier, query } = ask()
    const page = await view(catConsole, query).expect(200)
    expect(page.body.data).toEqual({
      client: { clientId: 'crm', name: 'crm', logoUrl: null },
      scopes: ['user.read'],
      pending: ['user.read'],
    })
    const res = await answer(catConsole, query).expect(200)
    const to = parsed(res.body.data.redirectTo)
    expect(`${to.origin}${to.pathname}`).toBe(CB)
    expect([...to.searchParams.keys()]).toEqual(['code', 'state'])
    expect(to.searchParams.get('state')).toBe('st-1')
    const t = await exchange('crm', to.searchParams.get('code')!, verifier).expect(200)
    expect(t.body).toMatchObject({ expires_in: 600, scope: 'user.read' })
    const me = await http().get('/api/oauth2/userinfo').set(bearer(t.body.access_token)).expect(200)
    expect(me.body.data).toEqual({
      sub: String(cat),
      username: `${PREFIX}cat`,
      name: 'cat',
      avatarUrl: null,
      locale: null,
    })
    // a console session reads its own
    const own = await http().get('/api/oauth2/userinfo').set(bearer(catConsole)).expect(200)
    expect(own.body.data.sub).toBe(String(cat))
  })

  it('consent is remembered: approved scopes are no longer pending; an expired consent asks again', async () => {
    const { id, token } = await someone('dora')
    await answer(token, ask().query).expect(200)
    expect(await consents(id)).toEqual([
      {
        scope: 'user.read',
        client_id: await findId(ds.manager, 'oauth_client', { client_id: 'crm' }),
        deleted_at: null,
      },
    ])
    expect((await view(token, ask().query).expect(200)).body.data.pending).toEqual([])
    // another client is asked separately
    expect((await view(token, ask({ client_id: 'erp' }).query)).body.data.pending).toEqual([
      'user.read',
    ])
    await ds.query(
      'UPDATE oauth_consent SET expires_at = CURRENT_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE user_id = ?',
      [id],
    )
    expect((await view(token, ask().query)).body.data.pending).toEqual(['user.read'])
    // approving again renews it (no duplicate key error)
    await answer(token, ask().query).expect(200)
    expect((await view(token, ask().query)).body.data.pending).toEqual([])
    // a soft-deleted consent does not count; approving revives the row
    await ds.query('UPDATE oauth_consent SET deleted_at = CURRENT_TIMESTAMP(3) WHERE user_id = ?', [
      id,
    ])
    expect((await view(token, ask().query)).body.data.pending).toEqual(['user.read'])
    await answer(token, ask().query).expect(200)
    expect((await view(token, ask().query)).body.data.pending).toEqual([])
    expect((await consents(id))[0]?.deleted_at).toBeNull()
  })

  it('auto-approved scopes are never pending nor stored; scope omitted = the client’s, duplicates once', async () => {
    const { id, token } = await someone('eli')
    const { query } = ask({ client_id: 'auto', scope: undefined })
    expect((await view(token, query).expect(200)).body.data).toMatchObject({
      scopes: ['user.read'],
      pending: [],
    })
    expect(
      parsed((await answer(token, query).expect(200)).body.data.redirectTo).searchParams.get(
        'code',
      ),
    ).toBeTruthy()
    expect(await consents(id)).toEqual([])
    const dup = await view(token, ask({ scope: 'user.read  user.read' }).query).expect(200)
    expect(dup.body.data.scopes).toEqual(['user.read'])
  })

  it('oauth.consent_ttl_days = 0: nothing stored, a stored consent is not honoured', async () => {
    const { id, token } = await someone('fay')
    await answer(token, ask().query).expect(200)
    try {
      await setDays(0)
      expect((await view(token, ask().query)).body.data.pending).toEqual(['user.read'])
      const fresh = await someone('fay2')
      await answer(fresh.token, ask().query).expect(200)
      expect(await consents(fresh.id)).toEqual([])
    } finally {
      await setDays(30)
    }
    expect((await view(token, ask().query)).body.data.pending).toEqual([])
    expect(await consents(id)).toHaveLength(1)
  })

  it('deny → error=access_denied and the state; nothing remembered, no code', async () => {
    const { id, token } = await someone('gus')
    const res = await answer(token, ask({ state: 'a b&c' }).query, false).expect(200)
    const to = parsed(res.body.data.redirectTo)
    expect([...to.searchParams.entries()]).toEqual([
      ['error', 'access_denied'],
      ['state', 'a b&c'],
    ])
    expect(await consents(id)).toEqual([])
    // no state asked, none answered
    const bare = parsed(
      (await answer(token, ask({ state: undefined }).query, false)).body.data.redirectTo,
    )
    expect([...bare.searchParams.keys()]).toEqual(['error'])
  })

  it('a registered redirect URI with a query keeps it; the code redeems with that exact URI', async () => {
    const { verifier, query } = ask({ client_id: 'q', redirect_uri: QCB })
    const to = parsed((await answer(catConsole, query).expect(200)).body.data.redirectTo)
    expect(to.href.startsWith(`${QCB}&code=`)).toBe(true)
    expect([...to.searchParams.keys()]).toEqual(['tenant', 'code', 'state'])
    await exchange('q', to.searchParams.get('code')!, verifier, { redirect_uri: QCB }).expect(200)
  })

  it('invalid requests are 400 envelopes on GET and POST, never a redirect: client, redirect URI, response_type, scope, PKCE', async () => {
    const cases: [Record<string, string | undefined>, string][] = [
      // unknown, disabled, first-party (also a row named so), no authorization_code grant
      ...['nobody', 'off', 'console', 'mobile', 'cconly'].map(
        (id) =>
          [{ client_id: id }, Err.OAUTH_CLIENT_INVALID.code] as [Record<string, string>, string],
      ),
      // the registered URI verbatim only
      ...[
        `${CB}/`,
        'https://CRM.example/cb',
        'https://crm.example/CB',
        `${CB}?x=1`,
        'https://crm.example/c',
        'http://crm.example/cb',
        'https://evil.example/cb',
        `${CB}#f`,
      ].map(
        (uri) =>
          [{ redirect_uri: uri }, Err.OAUTH_CLIENT_INVALID.code] as [
            Record<string, string>,
            string,
          ],
      ),
      [{ response_type: 'token' }, Err.OAUTH_REQUEST_INVALID.code],
      [{ scope: 'admin' }, Err.OAUTH_REQUEST_INVALID.code],
      [{ scope: 'user.read admin' }, Err.OAUTH_REQUEST_INVALID.code],
      [{ scope: '  ' }, Err.OAUTH_REQUEST_INVALID.code],
      // PKCE: S256 only (an omitted method means plain), a 43-character challenge
      [{ code_challenge_method: 'plain' }, Err.VALIDATION_FAILED.code],
      [{ code_challenge_method: undefined }, Err.VALIDATION_FAILED.code],
      [{ code_challenge: undefined }, Err.VALIDATION_FAILED.code],
      [{ code_challenge: 'a'.repeat(42) }, Err.VALIDATION_FAILED.code],
      [{ redirect_uri: undefined }, Err.VALIDATION_FAILED.code],
    ]
    for (const [over, code] of cases) {
      const { query } = ask(over)
      const got = await view(catConsole, query)
      expect([over, got.status, got.body.code]).toEqual([over, 400, code])
      const post = await answer(catConsole, query)
      expect([over, post.status, post.body.code, post.body.data]).toEqual([over, 400, code, null])
    }
  })

  it('only first-party sessions answer: third-party tokens get 401; a session that must change its password 403', async () => {
    const p = await pair('crm', cat)
    const machine = (await cc('crm').expect(200)).body.access_token as string
    for (const t of [p.access_token, machine]) {
      await view(t, ask().query).expect(401)
      await answer(t, ask().query).expect(401)
    }
    const stale = (
      await signIn(app, `${PREFIX}cat`, {
        flags: { mustChangePassword: true, passwordExpired: false },
      })
    ).accessToken
    expect((await view(stale, ask().query).expect(403)).body.code).toBe(
      Err.AUTH_PASSWORD_CHANGE_REQUIRED.code,
    )
    await answer(stale, ask().query).expect(403)
  })

  it('userinfo: user.read tokens of a user only — without the scope 403, client_credentials 403 B4003', async () => {
    const u = (await app.get(PermVersion).load(cat))!
    const noScope = await tokens.issue(u, {
      clientId: 'crm',
      scopes: [],
      ip: '127.0.0.1',
      ua: UA,
      keepSignedIn: false,
    })
    const res = await http()
      .get('/api/oauth2/userinfo')
      .set(bearer(noScope.accessToken))
      .expect(403)
    expect(res.body.code).toBe(Err.FORBIDDEN.code)
    const machine = (await cc('crm').expect(200)).body.access_token as string
    const cct = await http().get('/api/oauth2/userinfo').set(bearer(machine)).expect(403)
    expect(cct.body.code).toBe(Err.OAUTH_INSUFFICIENT_SCOPE.code)
    await http().get('/api/oauth2/userinfo').expect(401)
  })

  it('a password change ends the user’s OAuth tokens on userinfo too', async () => {
    const { id, token } = await someone('hal')
    const p = await pair('crm', id)
    await http().get('/api/oauth2/userinfo').set(bearer(p.access_token)).expect(200)
    await http()
      .put('/api/iam/profile/password')
      .set(bearer(token))
      .send({ oldPassword: PW, newPassword: 'Changed#Pass2' })
      .expect(200)
    await http().get('/api/oauth2/userinfo').set(bearer(p.access_token)).expect(401)
  })

  it('the approve is action-logged (oauth.consent grant, the client id) with the code masked', async () => {
    const traceId = `${PREFIX}${process.pid}-grant`
    const res = await answer(catConsole, ask().query).set('X-Request-Id', traceId).expect(200)
    const code = parsed(res.body.data.redirectTo).searchParams.get('code')!
    const row = await logOf(ds, traceId)
    expect(row).toMatchObject({ domain: 'oauth.consent', verb: 'grant', biz_id: 'crm', ok: 1 })
    expect(JSON.parse(row.result)).toEqual({ redirectTo: '***' })
    expect(JSON.stringify(row)).not.toContain(code)
  })

  it('consents go with their client (deleted in the client pages) and with their user', async () => {
    const { id, token } = await someone('ivy')
    const pk = await client('crm-del')
    await answer(token, ask({ client_id: 'crm-del' }).query).expect(200)
    await answer(token, ask().query).expect(200)
    expect(await consents(id)).toHaveLength(2)
    await http().delete(`/api/oauth/clients/${pk}`).set(bearer(admin)).expect(200)
    const after = await consents(id)
    expect(after.find((r) => r.client_id === pk)?.deleted_at).toBeInstanceOf(Date)
    expect(after.find((r) => r.client_id !== pk)?.deleted_at).toBeNull()
    await http().delete(`/api/iam/users/${id}`).set(bearer(admin)).expect(200)
    expect((await consents(id)).every((r) => r.deleted_at instanceof Date)).toBe(true)
  })

  it('a client registered in the client pages works end to end with the secret it was given', async () => {
    const created = await http()
      .post('/api/oauth/clients')
      .set(bearer(admin))
      .send({
        clientId: 'crm-ui',
        name: 'CRM UI',
        grantTypes: ['authorization_code', 'refresh_token', 'client_credentials'],
        redirectUris: [CB],
        scopes: ['user.read'],
        autoApproveScopes: [],
      })
      .expect(201)
    clientRows.push(created.body.data.id)
    const secret = created.body.data.secret as string
    const { verifier, query } = ask({ client_id: 'crm-ui' })
    const to = parsed((await answer(catConsole, query).expect(200)).body.data.redirectTo)
    const t = await token({
      grant_type: 'authorization_code',
      code: to.searchParams.get('code')!,
      redirect_uri: CB,
      code_verifier: verifier,
      client_id: 'crm-ui',
      client_secret: secret,
    }).expect(200)
    await http().get('/api/oauth2/userinfo').set(bearer(t.body.access_token)).expect(200)
    await token({
      grant_type: 'client_credentials',
      client_id: 'crm-ui',
      client_secret: secret,
    }).expect(200)
  })

  it('Swagger documents /authorize and /userinfo as envelopes', async () => {
    const doc = (await http().get('/api/docs-json').expect(200)).body
    const env = (op: { responses: Record<string, any> }) =>
      op.responses['200'].content['application/json'].schema.properties.data.properties
    expect(Object.keys(env(doc.paths['/api/oauth2/authorize'].get))).toEqual([
      'client',
      'scopes',
      'pending',
    ])
    expect(Object.keys(env(doc.paths['/api/oauth2/authorize'].post))).toEqual(['redirectTo'])
    for (const method of ['get', 'post'])
      expect(
        (doc.paths['/api/oauth2/authorize'][method].parameters as { name: string }[]).map(
          (p) => p.name,
        ),
      ).toEqual(expect.arrayContaining(['client_id', 'redirect_uri', 'code_challenge', 'state']))
    expect(Object.keys(env(doc.paths['/api/oauth2/userinfo'].get))).toEqual(
      expect.arrayContaining(['sub', 'username', 'name', 'avatarUrl', 'locale']),
    )
  }, 60_000)
})
