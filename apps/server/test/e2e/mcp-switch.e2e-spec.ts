// Agent access behind its start-up switch (see docs/mcp.md), here off (`APP_MCP=false`; the test env has
// it on, so every other mcp spec runs with the module): the module is not loaded, so /api/mcp, the
// discovery documents and every admin route answer 404, a live token too, and no tool is registered;
// the side menu and the role grant tree leave the two pages out while the menu management lists them;
// an OAuth2 authorization or token request of a real client naming the MCP resource is invalid. The token revocation follows the sessions anyway:
// a password change while the switch is off still ends the user's tokens for good.
import { createHash, randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { MenuNode, RoleMenuNode } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { PASSWORD_CHANGED, SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { tokenDigest } from '../../src/core/mcp/access-token.service.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  OAuthProvider,
  secretDigest,
} from '../../src/modules/platform/oauth/provider/provider.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { inTenant1 } from '../setup/tenants.js'

// before AppModule is imported: the module list reads the switch when the app module loads
vi.hoisted(() => {
  process.env.APP_MCP = 'false'
})

const TOKEN = `qwmcp_${'s'.repeat(43)}`
const CLIENT = 'mcp-switch-e2e-agent'
const SECRET = 'mcp-switch-client-secret-0123456789'
const CB = 'https://agent.example/cb'

let app: NestExpressApplication
let ds: DataSource
let root: string
let adminId = 0
let tokenId = 0
let clientRow = 0

const http = () => request(app.getHttpServer())
const ids = (nodes: { id: number; children: { id: number }[] }[]): number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children as typeof nodes)])
const mcpMenus = async (): Promise<number[]> =>
  (
    await ds.query<{ id: number }[]>(
      `SELECT id FROM iam_menu WHERE deleted_at IS NULL
          AND (route_name LIKE 'mcp-%' OR perms LIKE 'mcp.%') ORDER BY id`,
    )
  ).map((r) => Number(r.id))

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
  adminId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
      )
    )[0]!.id,
  )
  tokenId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_access_token', {
      user_id: adminId,
      name: 'switch-off',
      token_digest: tokenDigest(TOKEN),
      token_hint: TOKEN.slice(-4),
    }),
  )
  clientRow = await insertRow(ds.manager, 'oauth_client', {
    client_id: CLIENT,
    secret_hash: secretDigest(SECRET),
    name: CLIENT,
    grant_types: ['authorization_code'],
    redirect_uris: [CB],
    scopes: ['user.read'],
    auto_approve_scopes: [],
    access_ttl_sec: 600,
    refresh_ttl_sec: 3600,
  })
})

afterAll(async () => {
  await ds?.query('DELETE FROM iam_access_token WHERE id = ?', [tokenId])
  await ds?.query('DELETE FROM oauth_client WHERE id = ?', [clientRow])
  await app?.close()
})

it('every MCP route is 404, with a live token too; no tool is registered', async () => {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  await http()
    .post('/api/mcp')
    .set('Authorization', `Bearer ${TOKEN}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(rpc)
    .expect(404)
  for (const [method, path] of [
    ['get', '/api/mcp'],
    ['delete', '/api/mcp'],
    ['get', '/api/mcp/tools'],
    ['put', '/api/mcp/tools/iam.me.get/enabled'],
    ['get', '/api/mcp/my-tokens'],
    ['post', '/api/mcp/my-tokens'],
    ['post', `/api/mcp/my-tokens/${tokenId}/revoke`],
    ['get', '/api/mcp/tokens'],
    ['post', `/api/mcp/tokens/${tokenId}/revoke`],
    ['get', '/.well-known/oauth-protected-resource'],
    ['get', '/.well-known/oauth-protected-resource/api/mcp'],
    ['get', '/.well-known/oauth-authorization-server'],
  ] as const)
    await http()[method](path).set(bearer(root)).send({ enabled: false }).expect(404)
  expect(() => app.get(McpRegistry, { strict: false })).toThrow()
})

it('the side menu and the grant tree leave the pages out; the menu management lists them', async () => {
  const menus = await mcpMenus()
  expect(menus.length).toBe(6)
  const side = ids((await http().get('/api/auth/menus').set(bearer(root)).expect(200)).body.data)
  expect(side.filter((id) => menus.includes(id))).toEqual([])
  const tree = ids(
    (await http().get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
      .data as RoleMenuNode[],
  )
  expect(tree.filter((id) => menus.includes(id))).toEqual([])
  const listed = ids(
    (await http().get('/api/iam/menus').set(bearer(root)).expect(200)).body.data as MenuNode[],
  )
  expect(menus.filter((id) => !listed.includes(id))).toEqual([])
})

it('an OAuth2 authorization or token request naming the MCP resource is invalid', async () => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorize = (extra: Record<string, string> = {}) =>
    http()
      .get('/api/oauth2/authorize')
      .set(bearer(root))
      .query({
        response_type: 'code',
        client_id: CLIENT,
        redirect_uri: CB,
        scope: 'user.read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...extra,
      })
  // the client and request are valid: only the resource makes it invalid
  await authorize().expect(200)
  const resource = `${(await authorize().expect(200)).request.url.split('/api/')[0]}/api/mcp`
  await authorize({ resource }).expect(400)

  const provider = app.get(OAuthProvider)
  const code = await provider.issueCode(adminId, (await provider.client(CLIENT))!, {
    redirectUri: CB,
    scopes: ['user.read'],
    challenge,
  })
  const token = await http()
    .post('/api/oauth2/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CB,
      code_verifier: verifier,
      client_id: CLIENT,
      client_secret: SECRET,
      resource,
    })
    .expect(400)
  expect(token.body).toEqual({ error: 'invalid_target' })
})

it('a password change while the switch is off still ends the user’s tokens for good', async () => {
  await inTenant1(() => app.get(SessionRevoker).revokeUser(adminId, PASSWORD_CHANGED))
  const [row] = await ds.query<{ revoked_at: Date | null }[]>(
    'SELECT revoked_at FROM iam_access_token WHERE id = ?',
    [tokenId],
  )
  expect(row!.revoked_at).not.toBeNull()
  root = (await signIn(app)).accessToken
})
