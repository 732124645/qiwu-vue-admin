// The guards every tool call passes (see docs/mcp.md), multi-tenancy on: one action log row per call
// (`mcp.tool` / `call`, the tool as business id, marked as made by an agent, the token's kind and id, a
// keyed digest of the arguments, stable for identical calls; refused calls with their error, write calls with their result); a per-token
// rate limit; the platform's per-tool switch; the root-only `mcp.paused` stop (calls refused at once,
// tools/list still answering, back on as soon as it is cleared); a platform user's stay in another tenant
// never reaches MCP: its console session is no MCP token and its own token keeps to its own tenant.
// Arguments nested too deep or too large are refused before anything runs, their call logged without
// them; only the first rate-limit refusal of a window is logged, while paused too. A tool on a platform page's perm is the
// default tenant's only; a tool of a feature (menu group) only for tenants whose package holds it.
import { createHash } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, MCP_PAUSED_PARAM, mcpPerms } from '@qiwu/shared'
import type { Request } from 'express'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AuditWriter } from '../../src/core/audit/audit-writer.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { withTenant } from '../../src/core/context/tenant.js'
import type { McpCaller } from '../../src/core/mcp/mcp-auth.js'
import { tokenDigest } from '../../src/core/mcp/access-token.service.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import {
  MCP_ARGS_MAX_BYTES,
  MCP_ARGS_MAX_DEPTH,
  MCP_CALLS_PER_MINUTE,
  McpService,
} from '../../src/core/mcp/mcp.service.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { callTool, patFor, rpc, toolNames } from './mcp-kit.js'
import { cleanRedis } from '../setup/redis.js'
import { bootApp, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'mcp-guard-e2e-'
const PW = 'McpGuard#Pass1'

let app: NestExpressApplication
let ds: DataSource
let B: PeopledTenant
let adminId = 0
let rootConsole = ''
let paramId = 0
const userIds: number[] = []
const roleIds: number[] = []

const http = () => request(app.getHttpServer())
const setPaused = (value: string, token = rootConsole) =>
  http().put(`/api/settings/params/${paramId}`).set(bearer(token)).send({ paramValue: value })

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  await cleanRedis(app.get<Redis>(REDIS))
  adminId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
      )
    )[0]!.id,
  )
  rootConsole = (await signIn(app)).accessToken
  paramId = Number(
    (
      await ds.query<{ id: number }[]>('SELECT id FROM cfg_param WHERE param_key = ?', [
        MCP_PAUSED_PARAM,
      ])
    )[0]!.id,
  )
  B = await createTenant(app, { users: true })
})

afterAll(async () => {
  if (ds) {
    await setPaused('false')
    await ds.query("DELETE FROM cfg_mcp_tool WHERE name = 'iam.me.get'")
    await B?.dispose()
    await ds.query('DELETE FROM iam_access_token WHERE user_id IN (?)', [[adminId, ...userIds]])
    await ds.query('DELETE FROM demo_book WHERE isbn LIKE ?', [`${PREFIX}%`])
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  await app?.close()
})

it('logs every call as made by an agent: the token, a keyed argument digest, refusals with their error, writes with their result', async () => {
  const t = await patFor(app, adminId, { allowWrite: true })
  const ok = await rpc(app, t.token, 'tools/call', {
    name: 'iam.user.search',
    arguments: { pageSize: 5 },
  }).expect(200)
  const row = await logOf(ds, ok.headers['x-request-id'] as string)
  expect(row).toMatchObject({
    domain: 'mcp.tool',
    verb: 'call',
    biz_id: 'iam.user.search',
    user_id: adminId,
    ok: 1,
    result: null,
    tenant_id: 1,
  })
  const params = JSON.parse(row.params as string)
  expect(params).toMatchObject({
    agent: true,
    tool: 'iam.user.search',
    credential: 'access-token',
    credentialId: String(t.id),
    argsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    arguments: { pageSize: 5 },
  })
  // keyed: no plain SHA-256 of the arguments (a masked low-entropy value could be guessed from it)
  expect(params.argsDigest).not.toBe(
    createHash('sha256')
      .update(JSON.stringify({ pageSize: 5 }))
      .digest('hex'),
  )
  const again = await rpc(app, t.token, 'tools/call', {
    name: 'iam.user.search',
    arguments: { pageSize: 5 },
  }).expect(200)
  const second = await logOf(ds, again.headers['x-request-id'] as string)
  expect(JSON.parse(second.params as string).argsDigest).toBe(params.argsDigest)

  const write = await rpc(app, t.token, 'tools/call', {
    name: 'demo.book.create',
    arguments: { isbn: `${PREFIX}1`, title: 'Agent book', genre: 'fiction' },
  }).expect(200)
  const w = await logOf(ds, write.headers['x-request-id'] as string)
  expect(w).toMatchObject({ biz_id: 'demo.book.create', ok: 1 })
  expect(JSON.parse(w.result as string)).toMatchObject({ isbn: `${PREFIX}1`, title: 'Agent book' })

  const listed = await patFor(app, adminId, { tools: ['iam.me.get'] })
  const refused = await rpc(app, listed.token, 'tools/call', {
    name: 'cfg.dict.options',
    arguments: { code: 'iam.gender' },
  }).expect(200)
  expect(await logOf(ds, refused.headers['x-request-id'] as string)).toMatchObject({
    ok: 0,
    error_msg: Err.MCP_TOOL_NOT_ALLOWED.key,
  })
})

it('refuses arguments nested too deep or too large before anything runs and still logs the call without them', async () => {
  const t = await patFor(app, adminId, { allowWrite: true })
  const deep = '['.repeat(20_000) + ']'.repeat(20_000)
  // past the depth limit but far below the size limit: refused for its depth alone
  const nested = '['.repeat(MCP_ARGS_MAX_DEPTH + 8) + ']'.repeat(MCP_ARGS_MAX_DEPTH + 8)
  expect(nested.length).toBeLessThan(MCP_ARGS_MAX_BYTES / 100)
  const big = JSON.stringify('x'.repeat(MCP_ARGS_MAX_BYTES))
  for (const [i, extra] of [deep, nested, big].entries()) {
    const isbn = `${PREFIX}deep-${i}`
    const res = await request(app.getHttpServer())
      .post('/api/mcp')
      .set('Authorization', `Bearer ${t.token}`)
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send(
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"demo.book.create",` +
          `"arguments":{"isbn":"${isbn}","title":"Deep","genre":"fiction","extra":${extra}}}}`,
      )
      .expect(200)
    expect(JSON.parse(res.body.result.content[0].text).code).toBe(Err.VALIDATION_FAILED.code)
    const row = await logOf(ds, res.headers['x-request-id'] as string)
    expect(row).toMatchObject({ biz_id: 'demo.book.create', ok: 0 })
    const params = JSON.parse(row.params as string)
    expect(params).toMatchObject({ agent: true, argsDigest: null })
    expect(params).not.toHaveProperty('arguments')
    expect(await ds.query('SELECT id FROM demo_book WHERE isbn = ?', [isbn])).toEqual([])
  }
})

it('limits the calls per token and minute, logging the first refusal only; another token is not affected', async () => {
  const t = await patFor(app, adminId)
  for (let i = 0; i < MCP_CALLS_PER_MINUTE; i++) {
    const r = await callTool(app, t.token, 'iam.me.get')
    expect(r, `call ${i + 1}`).toMatchObject({ data: { id: adminId } })
  }
  const logged = vi.spyOn(app.get(AuditWriter), 'action')
  try {
    for (let i = 0; i < 3; i++)
      expect((await callTool(app, t.token, 'iam.me.get')).error?.code).toBe(
        Err.TOO_MANY_REQUESTS.code,
      )
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0]![0]).toMatchObject({ errorKey: Err.TOO_MANY_REQUESTS.key })
  } finally {
    logged.mockRestore()
  }
  const other = await patFor(app, adminId)
  expect((await callTool(app, other.token, 'iam.me.get')).data).toBeDefined()
})

it('a token over its rate limit is refused by the limit while paused too, logged once per window', async () => {
  const t = await patFor(app, adminId)
  // the token's bucket filled to its limit (the same key the service counts under)
  const store = app.get<ThrottlerStorage>(getStorageToken())
  const bucket = `token:${tokenDigest(t.token).slice(0, 32)}`
  for (let i = 0; i < MCP_CALLS_PER_MINUTE; i++)
    await store.increment(bucket, 60_000, MCP_CALLS_PER_MINUTE, 0, 'mcp')
  await setPaused('true').expect(200)
  const logged = vi.spyOn(app.get(AuditWriter), 'action')
  try {
    for (let i = 0; i < 3; i++)
      expect((await callTool(app, t.token, 'iam.me.get')).error?.code).toBe(
        Err.TOO_MANY_REQUESTS.code,
      )
    expect(logged).toHaveBeenCalledTimes(1)
  } finally {
    logged.mockRestore()
    await setPaused('false').expect(200)
  }
})

it('a tool on a platform perm is the default tenant’s only; a tool of a feature needs it in the package', async () => {
  const registry = app.get(McpRegistry)
  const meta = { title: 't', description: 'd', kind: 'read' as const, input: z.object({}) }
  registry.add({ ...meta, name: 'spec.platform.read', perm: mcpPerms.tool.browse }, () => ({}))
  registry.add(
    { ...meta, name: 'spec.feature.read', perm: null, feature: 'spec-group' },
    () => ({}),
  )
  const req = {
    method: 'POST',
    originalUrl: '/api/mcp',
    ip: '127.0.0.1',
    headers: {},
    get: () => undefined,
  } as unknown as Request
  // a caller holding the platform perm (a session of another tenant never does; the tool checks anyway)
  const caller = (tenantId: number): McpCaller => ({
    kind: 'token',
    id: `spec-${tenantId}`,
    principal: {
      userId: adminId,
      username: 'spec',
      roles: [],
      perms: [mcpPerms.tool.browse],
      tenantId,
    } as unknown as Principal,
    tenantId,
    tools: null,
    allowWrite: false,
    bucket: `spec-platform:${tenantId}:${Date.now()}`,
  })
  const code = async (tenantId: number, name: string) => {
    const r = await withTenant(tenantId, () =>
      app.get(McpService).call(req, caller(tenantId), name, {}),
    )
    return r.isError ? JSON.parse((r.content[0] as { text: string }).text).code : 'ok'
  }
  expect(await code(1, 'spec.platform.read')).toBe('ok')
  expect(await code(B.id, 'spec.platform.read')).toBe(Err.FORBIDDEN.code)
  // the feature: unrestricted in the default tenant, outside B's package
  expect(await code(1, 'spec.feature.read')).toBe('ok')
  expect(await code(B.id, 'spec.feature.read')).toBe(Err.FORBIDDEN.code)
  const own = await patFor(app, B.ownerId, {}, B.id)
  expect(await toolNames(app, own.token)).not.toContain('spec.feature.read')
  expect(await toolNames(app, (await patFor(app, adminId)).token)).toContain('spec.feature.read')
})

it('a tool switched off on the platform page is refused and leaves the list', async () => {
  const t = await patFor(app, adminId)
  await http()
    .put('/api/mcp/tools/iam.me.get/enabled')
    .set(bearer(rootConsole))
    .send({ enabled: false })
    .expect(200)
  try {
    expect((await callTool(app, t.token, 'iam.me.get')).error?.code).toBe(
      Err.MCP_TOOL_DISABLED.code,
    )
    expect(await toolNames(app, t.token)).not.toContain('iam.me.get')
    const tools = (await http().get('/api/mcp/tools').set(bearer(rootConsole)).expect(200)).body
      .data
    expect(tools).toContainEqual(
      expect.objectContaining({ name: 'iam.me.get', enabled: false, kind: 'read', perm: null }),
    )
  } finally {
    await http()
      .put('/api/mcp/tools/iam.me.get/enabled')
      .set(bearer(rootConsole))
      .send({ enabled: true })
      .expect(200)
  }
  expect((await callTool(app, t.token, 'iam.me.get')).data).toBeDefined()
  await http()
    .put('/api/mcp/tools/iam.nothing.get/enabled')
    .set(bearer(rootConsole))
    .send({ enabled: false })
    .expect(404)
})

it('mcp.paused is root’s: while on every call is refused at once, the list still answers; cleared, calls work again', async () => {
  // an administrator who may edit params but is not root
  const id = await inTenant1(async () =>
    insertRow(ds.manager, 'iam_user', {
      username: `${PREFIX}params`,
      display_name: 'params',
      password_hash: await bcrypt.hash(PW, 4),
      password_changed_at: new Date(),
    }),
  )
  userIds.push(id)
  const roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}params`,
      name: `${PREFIX}params`,
      data_scope: 'all',
    }),
  )
  roleIds.push(roleId)
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
    id,
    roleId,
  ])
  for (const m of await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_menu WHERE perms IN ('settings.param.browse', 'settings.param.modify') AND deleted_at IS NULL",
  ))
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
      roleId,
      m.id,
    ])
  const editor = (await signIn(app, `${PREFIX}params`)).accessToken
  expect((await setPaused('true', editor).expect(403)).body.code).toBe(
    Err.IAM_GRANT_EXCEEDS_OWN.code,
  )

  const t = await patFor(app, adminId)
  await setPaused('true').expect(200)
  try {
    expect((await callTool(app, t.token, 'iam.me.get')).error?.code).toBe(Err.MCP_PAUSED.code)
    expect(await toolNames(app, t.token)).toContain('iam.me.get')
  } finally {
    await setPaused('false').expect(200)
  }
  expect((await callTool(app, t.token, 'iam.me.get')).data).toMatchObject({ id: adminId })
})

it('a platform user inside another tenant: the console session is no MCP token, its own token stays in its tenant', async () => {
  const t = await patFor(app, adminId)
  const acting = (await signIn(app)).accessToken
  await http()
    .post(`/api/iam/tenants/${B.id}/enter`)
    .set(bearer(acting))
    .send({ reason: 'support' })
    .expect(200)
  await rpc(app, acting, 'tools/list').expect(401)
  const found = await callTool(app, t.token, 'iam.user.search', { keyword: 'owner' })
  const names = (found.data as { items: { username: string }[] }).items.map((u) => u.username)
  expect(names).not.toContain('owner')
  const all = await callTool(app, t.token, 'iam.user.search', { pageSize: 50 })
  expect((all.data as { items: { username: string }[] }).items.map((u) => u.username)).toContain(
    'admin',
  )
})
