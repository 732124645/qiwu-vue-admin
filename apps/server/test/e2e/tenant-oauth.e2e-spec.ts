// OAuth2 with tenants (see docs/design-notes.md#tenancy), the switch on, between the default tenant (A)
// and tenant B. Clients are platform rows: B's administrator reaches none of the client pages (403,
// nothing changes) while B's users approve and use every client. The consent page runs in the user's own
// tenant, also for a platform user who entered B: the consent is stored and read there and the code
// redeems into a session of that tenant only; a consent row of another tenant counts for nothing. Users
// of the same name keep a consent each. userinfo answers the token's user in the session's tenant only;
// a client introspects and revokes its tokens of every tenant, each naming its own user. A user deleted
// in B takes its consents along; a client the platform disables or deletes ends the sessions and the
// consents of every tenant.
import { createHash, randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID as A, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { type Session, TokenService } from '../../src/core/auth/token.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { secretDigest } from '../../src/modules/platform/oauth/provider/provider.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'to-e2e-'
const SECRET = 'tenant-oauth-secret-0123456789abc'
const CB = 'https://crm.tenant-oauth.test/cb'
const SCOPE = 'user.read'

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: TokenService
let B: PeopledTenant
let rootId = 0
let carol = 0
const clientRows: number[] = []
/** the last action log id before this spec: every row above it is this spec's */
let lastAction = 0

const http = () => request(on.getHttpServer())
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** A third-party client (a platform row) with secret {@link SECRET}; returns its row id. */
async function client(clientId: string): Promise<number> {
  const id = await insertRow(ds.manager, 'oauth_client', {
    client_id: PREFIX + clientId,
    secret_hash: secretDigest(SECRET),
    name: PREFIX + clientId,
    grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
    redirect_uris: [CB],
    scopes: [SCOPE],
    auto_approve_scopes: [],
    access_ttl_sec: 600,
    refresh_ttl_sec: 3600,
  })
  clientRows.push(id)
  return id
}

/** The consent page's query string for client `clientId` and its PKCE verifier. */
const ask = (clientId: string) => {
  const { verifier, challenge } = pkce()
  return {
    verifier,
    query: {
      response_type: 'code',
      client_id: PREFIX + clientId,
      redirect_uri: CB,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  }
}
/** GET /authorize as the holder of `accessToken`: the scopes still needing consent. */
const pending = async (accessToken: string, clientId: string): Promise<string[]> =>
  (
    await http()
      .get('/api/oauth2/authorize')
      .query(ask(clientId).query)
      .set(bearer(accessToken))
      .expect(200)
  ).body.data.pending
/** POST /authorize (approve) as the holder of `accessToken`: the code and its verifier. */
async function approve(accessToken: string, clientId: string) {
  const { verifier, query } = ask(clientId)
  const res = await http()
    .post('/api/oauth2/authorize')
    .query(query)
    .set(bearer(accessToken))
    .send({ approve: true })
    .expect(200)
  return { code: new URL(res.body.data.redirectTo as string).searchParams.get('code')!, verifier }
}
const token = (clientId: string, form: Record<string, string>) =>
  http()
    .post('/api/oauth2/token')
    .type('form')
    .send({ client_id: PREFIX + clientId, client_secret: SECRET, ...form })
const exchange = (clientId: string, { code, verifier }: { code: string; verifier: string }) =>
  token(clientId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: CB,
    code_verifier: verifier,
  })
interface Pair {
  access_token: string
  refresh_token: string
}
/** Approve and redeem: a third-party session of the holder of `accessToken`. */
const pair = async (accessToken: string, clientId: string): Promise<Pair> =>
  (await exchange(clientId, await approve(accessToken, clientId)).expect(200)).body as Pair
const sessionOf = async (accessToken: string) => (await tokens.inspect(accessToken))?.session
const introspect = (clientId: string, t: string) =>
  http()
    .post('/api/oauth2/introspect')
    .type('form')
    .auth(PREFIX + clientId, SECRET)
    .send({ token: t })
const userinfo = (accessToken: string) =>
  http().get('/api/oauth2/userinfo').set(bearer(accessToken))
/** The consent rows of client row `clientPk` (raw SQL: every tenant's). */
const consents = async (clientPk: number) =>
  (
    await ds.query<{ user_id: number; tenant_id: number; deleted: number }[]>(
      `SELECT user_id, tenant_id, deleted_at IS NOT NULL AS deleted FROM oauth_consent
        WHERE client_id = ? ORDER BY tenant_id, user_id`,
      [clientPk],
    )
  ).map((r) => ({
    user: Number(r.user_id),
    tenant: Number(r.tenant_id),
    deleted: Number(r.deleted) === 1,
  }))
async function patchSession(sid: string, patch: (s: Session) => void): Promise<void> {
  const key = redisKey('authSession', sid)
  const session = JSON.parse((await redis.get(key))!) as Session
  patch(session)
  await redis.set(key, JSON.stringify(session), { KEEPTTL: true })
}

/** console tokens: A's root, B's administrator (`owner`), B's `admin` and `alice` */
const t = { root: '', bOwner: '', bAdmin: '', bAlice: '' }
const crm = { pk: 0 }

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  tokens = on.get(TokenService)
  await cleanRedis(redis)
  lastAction = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM aud_action_log'))[0].n)
  B = await createTenant(on, { users: true })
  carol = await addUser(on, B.id, `${PREFIX}carol`, { deptId: B.deptId, roleId: B.roleId })
  crm.pk = await client('crm')
  const root = await signIn(on)
  rootId = root.session.userId!
  t.root = root.accessToken
  t.bOwner = (await signInDirect(on, B.ownerId))!.accessToken
  t.bAdmin = (await signInDirect(on, B.users.admin))!.accessToken
  t.bAlice = (await signInDirect(on, B.users.alice))!.accessToken
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    if (clientRows.length) {
      await ds.query('DELETE FROM oauth_consent WHERE client_id IN (?)', [clientRows])
      await ds.query('DELETE FROM oauth_client WHERE id IN (?)', [clientRows])
    }
    await ds.query('DELETE FROM oauth_client WHERE client_id LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM aud_action_log WHERE id > ?', [lastAction])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe('client pages: platform rows', () => {
  const stored = async (id: number) =>
    (
      await ds.query(
        'SELECT name, enabled, secret_hash, deleted_at FROM oauth_client WHERE id = ?',
        [id],
      )
    )[0]
  const live = async () =>
    Number((await ds.query('SELECT COUNT(*) AS n FROM oauth_client WHERE deleted_at IS NULL'))[0].n)
  const body = {
    clientId: `${PREFIX}new`,
    name: `${PREFIX}new`,
    grantTypes: ['authorization_code'],
    redirectUris: [CB],
    scopes: [SCOPE],
    autoApproveScopes: [],
  }

  const routes: ['get' | 'post' | 'put' | 'delete', string, ((id: number) => object)?][] = [
    ['get', ''],
    ['get', '/:id'],
    ['post', '', () => body],
    ['put', '/:id', () => ({ ...body, name: `${PREFIX}renamed` })],
    ['put', '/:id/enabled', () => ({ enabled: false })],
    ['post', '/:id/secret'],
    ['delete', '/:id'],
    ['post', '/batch-delete', (id) => ({ ids: [id] })],
  ]
  it.each(routes)(
    '%s /oauth/clients%s: B’s administrator gets 403, nothing changes',
    async (method, path, send) => {
      const before = await stored(crm.pk)
      const count = await live()
      const req = http()
        [method](`/api/oauth/clients${path.replace(':id', String(crm.pk))}`)
        .set(bearer(t.bOwner))
      const res = await (send ? req.send(send(crm.pk)) : req)
      expect([res.status, res.body.code]).toEqual([403, Err.FORBIDDEN.code])
      expect(await stored(crm.pk)).toEqual(before)
      expect(await live()).toBe(count)
      // the platform still sees and serves it
      await http().get(`/api/oauth/clients/${crm.pk}`).set(bearer(t.root)).expect(200)
    },
  )
})

describe('consent page', () => {
  it('B’s user approves in B: the consent is stored there and the code redeems into a session of B; A’s `admin` keeps a consent of its own', async () => {
    expect(await pending(t.bAdmin, 'crm')).toEqual([SCOPE])
    const p = await pair(t.bAdmin, 'crm')
    expect(await sessionOf(p.access_token)).toMatchObject({
      userId: B.users.admin,
      tenantId: B.id,
    })
    expect(await consents(crm.pk)).toEqual([{ user: B.users.admin, tenant: B.id, deleted: false }])
    expect(await pending(t.bAdmin, 'crm')).toEqual([])

    // the default tenant's user of the same name is asked, and remembered, separately
    expect(await pending(t.root, 'crm')).toEqual([SCOPE])
    const q = await pair(t.root, 'crm')
    expect(await sessionOf(q.access_token)).toMatchObject({ userId: rootId, tenantId: A })
    expect(await consents(crm.pk)).toEqual([
      { user: rootId, tenant: A, deleted: false },
      { user: B.users.admin, tenant: B.id, deleted: false },
    ])
    expect(await pending(t.root, 'crm')).toEqual([])
  })

  it('a consent row of another tenant counts for nothing', async () => {
    // B's alice under the default tenant: never written so (a user's consents live in its tenant)
    await addRow(on, A, 'oauth_consent', {
      user_id: B.users.alice,
      client_id: crm.pk,
      scope: SCOPE,
      expires_at: new Date(Date.now() + 86_400_000),
    })
    try {
      expect(await pending(t.bAlice, 'crm')).toEqual([SCOPE])
      // approving takes the stray row over into the user's own tenant: asked once, then remembered
      await pair(t.bAlice, 'crm')
      expect(
        (await consents(crm.pk)).filter((c) => c.user === B.users.alice && !c.deleted),
      ).toEqual([{ user: B.users.alice, tenant: B.id, deleted: false }])
      expect(await pending(t.bAlice, 'crm')).toEqual([])
    } finally {
      await ds.query('DELETE FROM oauth_consent WHERE user_id = ? AND client_id = ?', [
        B.users.alice,
        crm.pk,
      ])
    }
  })

  it('a platform user who entered B approves in its own tenant: the consent and the code are the default tenant’s', async () => {
    const erp = await client('erp')
    const s = await signIn(on)
    await patchSession(s.session.sid, (x) => {
      x.actingTenantId = B.id
    })
    expect(await pending(s.accessToken, 'erp')).toEqual([SCOPE])
    const p = await pair(s.accessToken, 'erp')
    expect(await sessionOf(p.access_token)).toMatchObject({ userId: rootId, tenantId: A })
    expect(await consents(erp)).toEqual([{ user: rootId, tenant: A, deleted: false }])
    // still inside B, the consent page reads the user's own tenant
    expect(await pending(s.accessToken, 'erp')).toEqual([])
  })
})

describe('token, userinfo, introspection, revocation', () => {
  it('a refresh keeps the session’s tenant; client_credentials sessions are the default tenant’s', async () => {
    const p = await pair(t.bAlice, 'crm')
    const r = await token('crm', { grant_type: 'refresh_token', refresh_token: p.refresh_token })
      .expect(200)
      .then((res) => res.body as Pair)
    expect(await sessionOf(r.access_token)).toMatchObject({
      userId: B.users.alice,
      tenantId: B.id,
    })
    const machine = await token('crm', { grant_type: 'client_credentials', scope: SCOPE }).expect(
      200,
    )
    expect(await sessionOf(machine.body.access_token)).toMatchObject({
      userId: null,
      tenantId: A,
    })
  })

  it('a code naming another tenant than its user’s redeems into nothing: 400 invalid_grant, no session', async () => {
    const { verifier, challenge } = pkce()
    const code = randomBytes(32).toString('base64url')
    await tokens.saveCode(
      code,
      {
        client: `${PREFIX}crm`,
        clientPk: crm.pk,
        userId: B.users.alice,
        redirectUri: CB,
        scopes: [SCOPE],
        challenge,
        credVer: await tokens.credVersion(B.users.alice),
        tenantId: A,
        exp: Date.now() + 60_000,
      },
      60_000,
    )
    const sessions = async () =>
      (await tokens.online()).filter(
        (s) => s.userId === B.users.alice && s.clientId === `${PREFIX}crm`,
      ).length
    const before = await sessions()
    const res = await exchange('crm', { code, verifier }).expect(400)
    expect(res.body.error).toBe('invalid_grant')
    expect(await sessions()).toBe(before)
  })

  it('userinfo answers the token’s user in the session’s tenant only', async () => {
    const b = await pair(t.bAdmin, 'crm')
    const a = await pair(t.root, 'crm')
    expect((await userinfo(b.access_token).expect(200)).body.data).toMatchObject({
      sub: String(B.users.admin),
      username: 'admin',
    })
    expect((await userinfo(a.access_token).expect(200)).body.data).toMatchObject({
      sub: String(rootId),
      username: 'admin',
    })
    // a session naming another tenant than its user's finds no user there
    await patchSession((await sessionOf(b.access_token))!.sid, (x) => {
      x.tenantId = A
    })
    expect((await userinfo(b.access_token)).status).toBe(401)
  })

  it('the client introspects and revokes its tokens of every tenant, each naming its own user', async () => {
    const b = await pair(t.bAdmin, 'crm')
    const a = await pair(t.root, 'crm')
    expect((await introspect('crm', b.access_token).expect(200)).body).toMatchObject({
      active: true,
      sub: String(B.users.admin),
      username: 'admin',
    })
    expect((await introspect('crm', a.access_token).expect(200)).body).toMatchObject({
      active: true,
      sub: String(rootId),
    })
    await http()
      .post('/api/oauth2/revoke')
      .type('form')
      .auth(`${PREFIX}crm`, SECRET)
      .send({ token: b.access_token })
      .expect(200)
    expect((await introspect('crm', b.access_token)).body.active).toBe(false)
    expect((await introspect('crm', a.access_token)).body.active).toBe(true)
  })

  it('an end set after the tokens were issued ends them once it passes: the refresh is invalid_grant, introspection inactive', async () => {
    const C = await createTenant(on, { users: true })
    try {
      const alice = (await signInDirect(on, C.users.alice))!.accessToken
      const toRefresh = await pair(alice, 'crm')
      const toInspect = await pair(alice, 'crm')
      await http()
        .put(`/api/iam/tenants/${C.id}`)
        .set(bearer(t.root))
        .send({ expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(200)
      // that moment passes (by the app clock, which judges it)
      await ds.query('UPDATE iam_tenant SET expires_at = ? WHERE id = ?', [
        new Date(Date.now() - 1000),
        C.id,
      ])
      const refreshed = await token('crm', {
        grant_type: 'refresh_token',
        refresh_token: toRefresh.refresh_token,
      }).expect(400)
      expect(refreshed.body.error).toBe('invalid_grant')
      expect((await introspect('crm', toInspect.access_token).expect(200)).body).toEqual({
        active: false,
      })
    } finally {
      await C.dispose()
    }
  })
})

describe('consents going with their user or client', () => {
  it('a user deleted in B takes its consents in B along', async () => {
    const carolToken = (await signInDirect(on, carol))!.accessToken
    await pair(carolToken, 'crm')
    const others = (await consents(crm.pk)).filter((c) => c.user !== carol)
    await http().delete(`/api/iam/users/${carol}`).set(bearer(t.bOwner)).expect(200)
    const after = await consents(crm.pk)
    expect(after.filter((c) => c.user === carol)).toEqual([
      { user: carol, tenant: B.id, deleted: true },
    ])
    expect(after.filter((c) => c.user !== carol)).toEqual(others)
  })

  it('a client the platform disables ends the sessions of every tenant; deleted, it takes every tenant’s consents along', async () => {
    const gone = await client('gone')
    const b = await pair(t.bAdmin, 'gone')
    const a = await pair(t.root, 'gone')
    expect(await consents(gone)).toEqual([
      { user: rootId, tenant: A, deleted: false },
      { user: B.users.admin, tenant: B.id, deleted: false },
    ])
    await http()
      .put(`/api/oauth/clients/${gone}/enabled`)
      .set(bearer(t.root))
      .send({ enabled: false })
      .expect(200)
    expect(await tokens.authenticate(b.access_token)).toBeNull()
    expect(await tokens.authenticate(a.access_token)).toBeNull()
    await http().delete(`/api/oauth/clients/${gone}`).set(bearer(t.root)).expect(200)
    expect(await consents(gone)).toEqual([
      { user: rootId, tenant: A, deleted: true },
      { user: B.users.admin, tenant: B.id, deleted: true },
    ])
  })
})
