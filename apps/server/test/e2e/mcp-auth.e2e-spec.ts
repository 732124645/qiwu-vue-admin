// Who may call the MCP endpoint (see docs/mcp.md), multi-tenancy on. A personal access token (made by its
// user with the current password, answered once, stored as a digest) or a third-party OAuth2 token with
// scope `mcp` runs as its user, in its user's tenant, with that user's perms; anything else is 401 with a
// challenge naming the resource metadata. Tools the user lacks the perm for, the token does not list, or
// write tools without the token allowing writes are refused (403 codes). A revoked token, one of a disabled
// user, an expired one, and every token of a user whose password changed or who was kicked, or of a
// disabled tenant, stop at once and for good; so does a token whose tenant ran out (checked on every call).
// A token made while the user's sessions or their tenant were revoked is dropped (409); parallel creations keep to the
// per-user limit. Every signed-in user lists the tools they could use. The admin routes keep to the caller's own tokens and tenant
// (another tenant's token 404); the tool page is the platform's. OAuth2 requests naming a resource must
// name this site's MCP endpoint.
import { createHash, randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, MCP_TOKEN_MAX_PER_USER } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AuthService } from '../../src/core/auth/auth.service.js'
import {
  KICKED,
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  SessionRevoker,
} from '../../src/core/auth/session-revoker.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { AccessTokenService } from '../../src/core/mcp/access-token.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  OAuthProvider,
  secretDigest,
} from '../../src/modules/platform/oauth/provider/provider.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { callTool, patFor, rpc, toolNames } from './mcp-kit.js'
import { bootApp, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'mcp-auth-e2e-'
const PW = 'McpAuth#Pass1'
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD ?? ''
const SECRET = 'mcp-client-secret-0123456789abcdef'
const CB = 'https://agent.example/cb'

let app: NestExpressApplication
let ds: DataSource
let B: PeopledTenant
let adminId = 0
let rootConsole = ''
const userIds: number[] = []
const clientRows: number[] = []

const http = () => request(app.getHttpServer())
const revokedAt = async (id: number) =>
  (
    await ds.query<{ revoked_at: Date | null }[]>(
      'SELECT revoked_at FROM iam_access_token WHERE id = ?',
      [id],
    )
  )[0]?.revoked_at ?? null

/** A user of the default tenant with a role holding `perms` (none: a role without menus). */
async function user(name: string, perms: string[] = []) {
  const id = await inTenant1(async () =>
    insertRow(ds.manager, 'iam_user', {
      username: PREFIX + name,
      display_name: name,
      password_hash: await bcrypt.hash(PW, 4),
      password_changed_at: new Date(),
    }),
  )
  userIds.push(id)
  if (perms.length) {
    const roleId = await inTenant1(() =>
      insertRow(ds.manager, 'iam_role', {
        code: `${PREFIX}${name}`,
        name: `${PREFIX}${name}`,
        data_scope: 'all',
      }),
    )
    const menus = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
      [perms],
    )
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
      id,
      roleId,
    ])
    for (const m of menus)
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
        roleId,
        m.id,
      ])
  }
  return id
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  adminId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
      )
    )[0]!.id,
  )
  rootConsole = (await signIn(app)).accessToken
  B = await createTenant(app, { users: true })
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    await ds.query('DELETE FROM iam_access_token WHERE user_id IN (?)', [[adminId, ...userIds]])
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    const roles = await ds.query<{ id: number }[]>('SELECT id FROM iam_role WHERE code LIKE ?', [
      `${PREFIX}%`,
    ])
    if (roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roles.map((r) => r.id)])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles.map((r) => r.id)])
    }
    if (clientRows.length) await ds.query('DELETE FROM oauth_client WHERE id IN (?)', [clientRows])
  }
  await app?.close()
})

it('401 without a token, with an unknown or malformed one, or a console session; the challenge names the metadata', async () => {
  for (const token of [null, 'qwmcp_unknown', `qwmcp_${'a'.repeat(43)}`, rootConsole]) {
    const res = await rpc(app, token, 'tools/list').expect(401)
    expect(res.headers['www-authenticate']).toMatch(
      /^Bearer resource_metadata="http:\/\/[^"]+\/\.well-known\/oauth-protected-resource\/api\/mcp", scope="mcp"$/,
    )
  }
  const meta = await http().get('/.well-known/oauth-protected-resource/api/mcp').expect(200)
  expect(meta.body).toMatchObject({
    resource: expect.stringMatching(/\/api\/mcp$/),
    scopes_supported: ['mcp', 'mcp.write'],
  })
  await http().get('/.well-known/oauth-protected-resource').expect(200)
  const as = await http().get('/.well-known/oauth-authorization-server').expect(200)
  expect(as.body).toMatchObject({
    token_endpoint: expect.stringMatching(/\/api\/oauth2\/token$/),
    code_challenge_methods_supported: ['S256'],
  })
})

describe('own tokens', () => {
  it('are made with the current password and shown once; the list never carries them', async () => {
    const made = await http()
      .post('/api/mcp/my-tokens')
      .set(bearer(rootConsole))
      .send({ name: `${PREFIX}cli`, expiresInDays: 30, currentPassword: ADMIN_PW })
      .expect(201)
    const t = made.body.data as { id: number; token: string; tokenHint: string; expiresAt: string }
    expect(t.token).toMatch(/^qwmcp_[\w-]{43}$/)
    expect(t.tokenHint).toBe(t.token.slice(-4))
    expect(Date.parse(t.expiresAt) - Date.now()).toBeGreaterThan(29 * 86_400_000)
    const [row] = await ds.query<{ token_digest: string }[]>(
      'SELECT token_digest FROM iam_access_token WHERE id = ?',
      [t.id],
    )
    expect(row!.token_digest).toBe(createHash('sha256').update(t.token).digest('hex'))
    const list = await http().get('/api/mcp/my-tokens').set(bearer(rootConsole)).expect(200)
    expect(JSON.stringify(list.body)).not.toContain(t.token)
    expect((await callTool(app, t.token, 'iam.me.get')).data).toMatchObject({ id: adminId })
  })

  it('refuses a wrong password, an unknown tool, a write tool without writes, a lifetime over 90 days', async () => {
    const make = (body: Record<string, unknown>) =>
      http()
        .post('/api/mcp/my-tokens')
        .set(bearer(rootConsole))
        .send({ name: `${PREFIX}x`, currentPassword: ADMIN_PW, ...body })
    expect((await make({ currentPassword: 'Wrong#Pass1' })).body.code).toBe(
      Err.AUTH_PASSWORD_WRONG.code,
    )
    expect((await make({ tools: ['iam.nothing.get'] }).expect(422)).body.code).toBe(
      Err.MCP_TOOL_UNKNOWN.code,
    )
    expect((await make({ tools: ['demo.book.create'] }).expect(403)).body.code).toBe(
      Err.MCP_WRITE_NOT_ALLOWED.code,
    )
    await make({ expiresInDays: 91 }).expect(400)
    await make({ tools: ['demo.book.create'], allowWrite: true }).expect(201)
  })

  it('a user keeps at most the limit of live tokens, parallel creations too', async () => {
    const id = await user('many')
    for (let i = 0; i < MCP_TOKEN_MAX_PER_USER - 1; i++) await patFor(app, id)
    const made = await Promise.allSettled(Array.from({ length: 8 }, () => patFor(app, id)))
    expect(made.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of made.filter((x) => x.status === 'rejected'))
      expect(r.reason).toMatchObject({ err: Err.MCP_TOKEN_LIMIT })
    await expect(patFor(app, id)).rejects.toMatchObject({ err: Err.MCP_TOKEN_LIMIT })
    const [{ n }] = await ds.query<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM iam_access_token WHERE user_id = ? AND revoked_at IS NULL',
      [id],
    )
    expect(Number(n)).toBe(MCP_TOKEN_MAX_PER_USER)
  })

  it('a token made while the user’s sessions were revoked is dropped (409)', async () => {
    const auth = app.get(AuthService)
    const real = auth.verifyPassword.bind(auth)
    // the revocation lands between the password check and the insert
    const spy = vi.spyOn(auth, 'verifyPassword').mockImplementationOnce(async (...a) => {
      await real(...a)
      await app.get<Redis>(REDIS).incr(redisKey('authCredVer', adminId))
    })
    try {
      const name = `${PREFIX}raced`
      const res = await http()
        .post('/api/mcp/my-tokens')
        .set(bearer(rootConsole))
        .send({ name, currentPassword: ADMIN_PW })
        .expect(409)
      expect(res.body.code).toBe(Err.CONFLICT.code)
      expect(
        await ds.query('SELECT id FROM iam_access_token WHERE user_id = ? AND name = ?', [
          adminId,
          name,
        ]),
      ).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('a token stored after the revocation hooks ran but before credver moved is revoked all the same', async () => {
    const id = await user('late')
    const redis = app.get<Redis>(REDIS)
    const credVer = await app.get(TokenService).credVersion(id)
    const incr = redis.incr.bind(redis)
    let late: { id: number; token: string } | undefined
    // the creation lands between the first hook run and the credver bump, its own check before the bump
    const spy = vi.spyOn(redis, 'incr').mockImplementation(async (key) => {
      if (key === redisKey('authCredVer', id) && !late)
        late = await withTenant(1, () =>
          app
            .get(AccessTokenService)
            .create(
              id,
              { name: `${PREFIX}late`, allowWrite: false, currentPassword: 'unused' },
              credVer,
            ),
        )
      return incr(key)
    })
    try {
      await inTenant1(() => app.get(SessionRevoker).revokeUser(id, PASSWORD_CHANGED))
    } finally {
      spy.mockRestore()
    }
    expect(late).toBeDefined()
    expect(await revokedAt(late!.id)).not.toBeNull()
    await rpc(app, late!.token, 'tools/list').expect(401)
  })

  it('every signed-in user lists the tools they could use; without a session 401', async () => {
    const names = async (token: string) =>
      (
        (await http().get('/api/mcp/my-tools').set(bearer(token)).expect(200)).body.data as {
          name: string
        }[]
      )
        .map((t) => t.name)
        .sort()
    await user('picker')
    const picker = (await signIn(app, `${PREFIX}picker`)).accessToken
    expect(await names(picker)).toEqual([
      'cfg.dict.options',
      'iam.me.get',
      'oa.application.get',
      'oa.application.options',
      'oa.generic.apply',
      'oa.task.todo',
    ])
    expect(await names(rootConsole)).toEqual(
      expect.arrayContaining(['demo.book.create', 'iam.user.search', 'iam.me.get']),
    )
    await http().get('/api/mcp/my-tools').expect(401)
  })
})

it('403: a tool the user has no perm for, one the token does not list, a write tool without writes', async () => {
  const limited = await patFor(app, await user('limited'))
  expect(await toolNames(app, limited.token)).toEqual([
    'cfg.dict.options',
    'iam.me.get',
    'oa.application.get',
    'oa.application.options',
    'oa.task.todo',
  ])
  expect((await callTool(app, limited.token, 'iam.user.search')).error?.code).toBe(
    Err.FORBIDDEN.code,
  )
  const listed = await patFor(app, adminId, { tools: ['iam.me.get'] })
  expect(await toolNames(app, listed.token)).toEqual(['iam.me.get'])
  expect(
    (await callTool(app, listed.token, 'cfg.dict.options', { code: 'iam.gender' })).error?.code,
  ).toBe(Err.MCP_TOOL_NOT_ALLOWED.code)
  const readOnly = await patFor(app, adminId)
  const write = await callTool(app, readOnly.token, 'demo.book.create', {
    isbn: `${PREFIX}1`,
    title: 'x',
    genre: 'fiction',
  })
  expect(write.error?.code).toBe(Err.MCP_WRITE_NOT_ALLOWED.code)
  const writer = await patFor(app, adminId, { allowWrite: true })
  expect(await toolNames(app, writer.token)).toContain('demo.book.create')
})

it('a personal token allowing writes cannot bypass personal confirmation for office applications', async () => {
  const applications = [
    [
      'oa.leave.apply',
      {
        leaveKind: 'annual',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-02T00:00:00Z',
        days: 1,
        reason: 'Annual leave',
      },
    ],
    [
      'oa.trip.apply',
      {
        destination: 'North office',
        startAt: '2026-11-01T00:00:00Z',
        endAt: '2026-11-02T00:00:00Z',
        reason: 'Office visit',
        initiatorPicks: {},
      },
    ],
    [
      'oa.expense.apply',
      {
        reason: 'Office supplies',
        items: [
          {
            expenseDate: '2026-11-01',
            expenseKind: 'supplies',
            amount: '1.00',
            description: 'Office paper',
          },
        ],
        initiatorPicks: {},
      },
    ],
    [
      'oa.seal.apply',
      {
        sealKind: 'company',
        documentName: 'Office agreement',
        purpose: 'Office lease',
        copies: 1,
        expectedDate: '2026-11-03',
        initiatorPicks: {},
      },
    ],
    [
      'oa.generic.apply',
      {
        formValues: {
          title: 'Office request',
          description: 'Office access',
          expectedDate: '2026-11-03',
        },
        initiatorPicks: {},
      },
    ],
  ] as const
  const writer = await patFor(app, adminId, {
    allowWrite: true,
    tools: applications.map(([name]) => name),
  })
  expect(await toolNames(app, writer.token)).toEqual(applications.map(([name]) => name).sort())
  const counts = async () =>
    (
      await ds.query(
        `SELECT (SELECT COUNT(*) FROM biz_leave_request WHERE tenant_id = 1) AS leaves,
            (SELECT COUNT(*) FROM oa_trip_request WHERE tenant_id = 1) AS trips,
            (SELECT COUNT(*) FROM oa_expense_claim WHERE tenant_id = 1) AS expenses,
            (SELECT COUNT(*) FROM oa_seal_request WHERE tenant_id = 1) AS seals,
            (SELECT COUNT(*) FROM wf_instance WHERE tenant_id = 1) AS instances`,
      )
    )[0]
  const before = await counts()
  for (const [name, args] of applications) {
    const result = await callTool(app, writer.token, name, {
      ...args,
      confirmed: true,
      prepared: { args },
    })
    expect([name, result.error?.code]).toEqual([name, Err.FORBIDDEN.code])
  }
  expect(await counts()).toEqual(before)
})

describe('ends', () => {
  it('a revoked token (own or by an administrator), an expired one and one of a disabled user stop at once', async () => {
    const own = await patFor(app, adminId)
    await http().post(`/api/mcp/my-tokens/${own.id}/revoke`).set(bearer(rootConsole)).expect(200)
    await rpc(app, own.token, 'tools/list').expect(401)

    const id = await user('ends', ['iam.user.browse'])
    const byAdmin = await patFor(app, id)
    await rpc(app, byAdmin.token, 'tools/list').expect(200)
    await http().post(`/api/mcp/tokens/${byAdmin.id}/revoke`).set(bearer(rootConsole)).expect(200)
    await rpc(app, byAdmin.token, 'tools/list').expect(401)

    const expiring = await patFor(app, id, { expiresInDays: 1 })
    await rpc(app, expiring.token, 'tools/list').expect(200)
    await ds.query(
      'UPDATE iam_access_token SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE id = ?',
      [expiring.id],
    )
    await rpc(app, expiring.token, 'tools/list').expect(401)

    const disabled = await patFor(app, id)
    await http()
      .put(`/api/iam/users/${id}/enabled`)
      .set(bearer(rootConsole))
      .send({ enabled: false })
      .expect(200)
    await rpc(app, disabled.token, 'tools/list').expect(401)
    expect(await revokedAt(disabled.id)).not.toBeNull()
    // for good: enabling the user again does not bring the token back
    await http()
      .put(`/api/iam/users/${id}/enabled`)
      .set(bearer(rootConsole))
      .send({ enabled: true })
      .expect(200)
    await rpc(app, disabled.token, 'tools/list').expect(401)
  })

  it('a password change or reset, a kick and a lock after wrong passwords end every token of the user; a mobile change does not', async () => {
    const revoker = app.get(SessionRevoker)
    for (const reason of [PASSWORD_CHANGED, PASSWORD_RESET, KICKED, 'password_attempts']) {
      const id = await user(`end-${reason}`)
      const t = await patFor(app, id)
      await inTenant1(() => revoker.revokeUser(id, reason))
      await rpc(app, t.token, 'tools/list').expect(401)
      expect(await revokedAt(t.id)).not.toBeNull()
    }
    const id = await user('mobile')
    const t = await patFor(app, id)
    await inTenant1(() => revoker.revokeUser(id, 'mobile_changed'))
    await rpc(app, t.token, 'tools/list').expect(200)
  })

  it('a token runs in its own tenant and ends with it when the tenant is disabled', async () => {
    const t = await patFor(app, B.ownerId, {}, B.id)
    expect((await callTool(app, t.token, 'iam.me.get')).data).toMatchObject({ id: B.ownerId })
    await http()
      .put(`/api/iam/tenants/${B.id}/enabled`)
      .set(bearer(rootConsole))
      .send({ enabled: false })
      .expect(200)
    try {
      await rpc(app, t.token, 'tools/list').expect(401)
      expect(await revokedAt(t.id)).not.toBeNull()
    } finally {
      await http()
        .put(`/api/iam/tenants/${B.id}/enabled`)
        .set(bearer(rootConsole))
        .send({ enabled: true })
        .expect(200)
    }
    await rpc(app, t.token, 'tools/list').expect(401)
  })

  it('a token stored after its tenant was disabled and its tokens revoked is dropped (409)', async () => {
    const C = await createTenant(app)
    try {
      // the request passed its tenant check, then the tenant was disabled before the insert
      await http()
        .put(`/api/iam/tenants/${C.id}/enabled`)
        .set(bearer(rootConsole))
        .send({ enabled: false })
        .expect(200)
      await expect(patFor(app, C.ownerId, {}, C.id)).rejects.toMatchObject({ err: Err.CONFLICT })
      expect(
        await ds.query('SELECT id FROM iam_access_token WHERE user_id = ?', [C.ownerId]),
      ).toEqual([])
    } finally {
      await C.dispose()
    }
  })

  it('a token of a tenant that ran out stops on its next call, the row untouched', async () => {
    const C = await createTenant(app)
    try {
      const t = await patFor(app, C.ownerId, {}, C.id)
      await rpc(app, t.token, 'tools/list').expect(200)
      // no revocation hook runs: only the reload of every call sees the end
      await ds.query('UPDATE iam_tenant SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE id = ?', [
        C.id,
      ])
      await rpc(app, t.token, 'tools/list').expect(401)
      expect(await revokedAt(t.id)).toBeNull()
    } finally {
      await C.dispose()
    }
  })
})

describe('tenants', () => {
  it('every admin route keeps to the caller’s tenant: another tenant’s token is 404', async () => {
    const owner = (await signIn(app, 'owner', {}, B.id)).accessToken
    const mine = await patFor(app, adminId)
    // B's administrator: the default tenant's token is no token of theirs
    await http().post(`/api/mcp/tokens/${mine.id}/revoke`).set(bearer(owner)).expect(404)
    await http().post(`/api/mcp/my-tokens/${mine.id}/revoke`).set(bearer(owner)).expect(404)
    const page = await http().get('/api/mcp/tokens').set(bearer(owner)).expect(200)
    expect((page.body.data.items as { id: number }[]).some((t) => t.id === mine.id)).toBe(false)
    expect(
      (
        (await http().get('/api/mcp/my-tokens').set(bearer(owner)).expect(200)).body.data as {
          id: number
        }[]
      ).some((t) => t.id === mine.id),
    ).toBe(false)
    // and the other way round
    const theirs = await patFor(app, B.users.alice, {}, B.id)
    const listed = await http()
      .get('/api/mcp/tokens')
      .set(bearer(owner))
      .query({ userId: B.users.alice })
      .expect(200)
    expect(listed.body.data.items).toMatchObject([{ id: theirs.id, username: 'alice' }])
    await http().post(`/api/mcp/my-tokens/${theirs.id}/revoke`).set(bearer(rootConsole)).expect(404)
    await http().post(`/api/mcp/tokens/${theirs.id}/revoke`).set(bearer(rootConsole)).expect(404)
    await rpc(app, theirs.token, 'tools/list').expect(200)
    // the tool page is the platform's
    await http().get('/api/mcp/tools').set(bearer(owner)).expect(403)
    await http()
      .put('/api/mcp/tools/iam.me.get/enabled')
      .set(bearer(owner))
      .send({ enabled: false })
      .expect(403)
  })

  it('on a host bound to a tenant only that tenant’s tokens pass', async () => {
    const C = await createTenant(app, { domains: ['mcp-auth-c.example'] })
    try {
      const own = await patFor(app, C.ownerId, {}, C.id)
      const other = await patFor(app, adminId)
      await rpc(app, own.token, 'tools/list').set('Host', 'mcp-auth-c.example').expect(200)
      await rpc(app, other.token, 'tools/list').set('Host', 'mcp-auth-c.example').expect(401)
      await rpc(app, other.token, 'tools/list').expect(200)
    } finally {
      await C.dispose()
    }
  })

  it('without the perm the tenant’s token list and revocation are 403', async () => {
    const alice = (await signIn(app, 'alice', {}, B.id)).accessToken
    await http().get('/api/mcp/tokens').set(bearer(alice)).expect(403)
    await http().post('/api/mcp/tokens/1/revoke').set(bearer(alice)).expect(403)
    await http().get('/api/mcp/tools').set(bearer(alice)).expect(403)
  })
})

describe('OAuth2', () => {
  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
  }
  async function client(clientId: string, scopes: string[], grants = ['authorization_code']) {
    clientRows.push(
      await insertRow(ds.manager, 'oauth_client', {
        client_id: clientId,
        secret_hash: secretDigest(SECRET),
        name: clientId,
        grant_types: grants,
        redirect_uris: [CB],
        scopes,
        auto_approve_scopes: [],
        access_ttl_sec: 600,
        refresh_ttl_sec: 3600,
      }),
    )
  }
  async function tokenOf(
    clientId: string,
    userId: number,
    scopes: string[],
    extra = {},
    status = 200,
  ): Promise<{ access_token: string } & Record<string, unknown>> {
    const provider = app.get(OAuthProvider)
    const { verifier, challenge } = pkce()
    const c = await provider.client(clientId)
    const code = await provider.issueCode(userId, c!, { redirectUri: CB, scopes, challenge })
    return http()
      .post('/api/oauth2/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CB,
        code_verifier: verifier,
        client_id: clientId,
        client_secret: SECRET,
        ...extra,
      })
      .expect(status)
      .then((r) => r.body as { access_token: string })
  }

  beforeAll(async () => {
    await client(`${PREFIX}agent`, ['user.read', 'mcp', 'mcp.write'])
    await client(`${PREFIX}machine`, ['mcp'], ['client_credentials'])
  })

  it('a code token with scope mcp acts as its user; mcp.write opens write tools', async () => {
    const read = (await tokenOf(`${PREFIX}agent`, adminId, ['mcp'])).access_token
    expect((await callTool(app, read, 'iam.me.get')).data).toMatchObject({ id: adminId })
    expect(await toolNames(app, read)).not.toContain('demo.book.create')
    const write = (await tokenOf(`${PREFIX}agent`, adminId, ['mcp', 'mcp.write'])).access_token
    expect(await toolNames(app, write)).toContain('demo.book.create')
  })

  it('refuses a token without the scope and a client credentials token; a session inside another tenant is refused', async () => {
    const userinfo = (await tokenOf(`${PREFIX}agent`, adminId, ['user.read'])).access_token
    await rpc(app, userinfo, 'tools/list').expect(401)
    const machine = await http()
      .post('/api/oauth2/token')
      .type('form')
      .send({
        grant_type: 'client_credentials',
        client_id: `${PREFIX}machine`,
        client_secret: SECRET,
      })
      .expect(200)
    await rpc(app, machine.body.access_token as string, 'tools/list').expect(403)
    // an OAuth2 session never enters a tenant; were one marked so, it is refused
    const t = (await tokenOf(`${PREFIX}agent`, adminId, ['mcp'])).access_token as string
    const tokens = app.get(TokenService)
    const s = await tokens.authenticate(t)
    await tokens.save({ ...s!, actingTenantId: B.id, actingUntil: Date.now() + 60_000 })
    await rpc(app, t, 'tools/list').expect(403)
  })

  it('a resource indicator must name this site’s MCP endpoint', async () => {
    const resource = (await http().get('/.well-known/oauth-protected-resource').expect(200)).body
      .resource as string
    const { challenge } = pkce()
    const query = {
      response_type: 'code',
      client_id: `${PREFIX}agent`,
      redirect_uri: CB,
      scope: 'mcp',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }
    const authorize = (q: Record<string, string>) =>
      http()
        .get('/api/oauth2/authorize')
        .set(bearer(rootConsole))
        .query({ ...query, ...q })
    await authorize({ resource }).expect(200)
    expect(
      (await authorize({ resource: 'https://other.example/api/mcp' }).expect(400)).body.code,
    ).toBe(Err.OAUTH_REQUEST_INVALID.code)
    // the resource is the MCP endpoint: the request must ask for its scope
    await authorize({ resource, scope: 'user.read' }).expect(400)
    expect(
      await tokenOf(
        `${PREFIX}agent`,
        adminId,
        ['mcp'],
        { resource: 'https://other.example/api/mcp' },
        400,
      ),
    ).toEqual({ error: 'invalid_target' })
    await tokenOf(`${PREFIX}agent`, adminId, ['mcp'], { resource })
  })
})
