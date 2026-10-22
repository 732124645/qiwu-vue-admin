// Agent diagnostics (see docs/agent.md): the platform page's overview (providers and search providers
// without keys, external MCP servers with their status, the turn queue's counts, running / waiting /
// failed-today turns of every tenant and the latest failures as numbers and short codes only, sweep
// stats) for agent.setting.browse on the platform side, and the root-only connectivity tests of a model
// provider, a search provider and an external MCP server against local fakes: a short reason code on
// failure, never the key or the upstream body, an action log row, a rate limit. Multi-tenancy on.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { agentDiagnosticsVo, agentPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { AgentDiagnosticsService } from '../../src/core/agent/diagnostics/diagnostics.service.js'
import { ItemStore } from '../../src/core/agent/runtime/item-store.js'
import { TurnRunner } from '../../src/core/agent/runtime/turn-runner.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { keyPattern, redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agdiag-'
const KEY = 'e2e-diag-key-not-real-0123456789'

let app: NestExpressApplication
let ds: DataSource
let root = ''
let reader = ''
let admin = ''
let other: PeopledTenant
let otherAdmin = ''
let readerId = 0
let adminId = 0
let roleId = 0
const turnIds: number[] = []
const threadIds: number[] = []

// ---- one local server: Chat Completions, a Tavily-shaped search, a stateless MCP server ----
let stub: Server
let base = ''
/** how the fake model and search answer: `ok`, `fail` (an error body echoing the key), `silent` */
let mode: 'ok' | 'fail' | 'silent' = 'ok'
const auths: (string | undefined)[] = []

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = ''
    req.on('data', (d: Buffer) => (raw += d.toString()))
    req.on('end', () => resolve(raw))
  })

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const raw = req.method === 'POST' ? await readBody(req) : ''
  if (path === '/mcp') {
    const body = raw ? (JSON.parse(raw) as unknown) : undefined
    if (req.method !== 'POST') return void res.writeHead(405).end()
    // stateless: every request gets a fresh server and transport
    const server = new McpServer({ name: 'fake', version: '1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [{ name: 'lookup', inputSchema: { type: 'object' } }],
    }))
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(t)
    res.on('close', () => void t.close())
    return t.handleRequest(req, res, body)
  }
  auths.push(req.headers.authorization)
  if (mode === 'silent') return
  if (mode === 'fail') {
    res.writeHead(401, { 'content-type': 'application/json' })
    return void res.end(JSON.stringify({ error: { message: `upstream-detail ${KEY}` } }))
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  if (path === '/tavily')
    return void res.end(
      JSON.stringify({ results: [{ title: 'Hit', url: 'https://hit.example/', content: 'x' }] }),
    )
  res.end(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      created: 1,
      model: 'chat-1',
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'pong' } },
      ],
    }),
  )
}

const http = () => request(app.getHttpServer())
const overview = (token = root) => http().get('/api/agent/diagnostics').set(bearer(token))
const probe = (kind: 'provider' | 'search' | 'mcp', id: number, token = root) =>
  http().post(`/api/agent/diagnostics/test-${kind}/${id}`).set(bearer(token))
async function add(path: string, body: object): Promise<number> {
  const res = await http().post(path).set(bearer(root)).send(body)
  expect(res.status).toBe(201)
  return res.body.data.id as number
}
async function addTurn(tid: number, status: string, extra: Record<string, unknown> = {}) {
  const { insertId } = await ds.query<{ insertId: number }>(
    `INSERT INTO agent_turn (tenant_id, thread_id, user_id, status, error_code, error_msg, ended_at)
     VALUES (?, 0, 1, ?, ?, ?, ?)`,
    [tid, status, extra.code ?? null, extra.msg ?? null, extra.endedAt ?? null],
  )
  turnIds.push(Number(insertId))
  return Number(insertId)
}

let providerId = 0
let searchId = 0
let mcpId = 0
let deadMcpId = 0

beforeAll(async () => {
  stub = createServer((req, res) => {
    handle(req, res).catch(() => res.writeHead(500).end())
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`

  const env = { ...process.env, APP_MULTI_TENANT: 'true', APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  // a rerun within the minute must not start out rate limited
  const redis = app.get<Redis>(REDIS)
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 500 }))
    if (keys.length) await redis.unlink(keys)
  const diag = app.get(AgentDiagnosticsService)
  diag.searchEndpoints = { bocha: `${base}/bocha`, tavily: `${base}/tavily` }
  root = (await signIn(app)).accessToken
  readerId = await addUser(app, 1, `${PREFIX}reader`)
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
  // a platform administrator of the agent settings who is not root
  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}r`,
      name: `${PREFIX}r`,
      data_scope: 'all',
    }),
  )
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, 1 FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, [agentPerms.setting.browse, agentPerms.setting.modify]],
  )
  adminId = await addUser(app, 1, `${PREFIX}admin`, { roleId })
  admin = (await signIn(app, `${PREFIX}admin`)).accessToken
  other = await createTenant(app, { users: true })
  otherAdmin = (await signIn(app, 'admin', {}, other.id)).accessToken

  providerId = await add('/api/agent/providers', {
    name: `${PREFIX}model`,
    baseUrl: `${base}/v1`,
    apiKey: KEY,
    models: [{ id: 'chat-1' }],
  })
  searchId = await add('/api/agent/search-providers', {
    kind: 'tavily',
    name: `${PREFIX}search`,
    apiKey: KEY,
  })
  mcpId = await add('/api/agent/mcp-servers', {
    name: `${PREFIX}mcp`,
    url: `${base}/mcp`,
    allowPrivate: true,
  })
  deadMcpId = await add('/api/agent/mcp-servers', {
    name: `${PREFIX}dead`,
    url: 'http://127.0.0.1:9/mcp',
    allowPrivate: true,
  })
})

afterAll(async () => {
  if (ds) {
    if (turnIds.length) await ds.query('DELETE FROM agent_turn WHERE id IN (?)', [turnIds])
    if (threadIds.length) {
      await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threadIds])
      await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threadIds])
      await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threadIds])
    }
    await ds.query('DELETE FROM agent_provider WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_search_provider WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_mcp_server WHERE name LIKE ?', [`${PREFIX}%`])
    for (const id of [readerId, adminId].filter(Boolean)) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [id])
      await ds.query('DELETE FROM iam_user WHERE id = ?', [id])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
  }
  await other?.dispose()
  await app?.close()
  stub?.closeAllConnections()
  await new Promise((r) => stub?.close(r))
})

beforeEach(() => {
  mode = 'ok'
  auths.length = 0
  app.get(AgentDiagnosticsService).timeoutMs = 15_000
})

describe('overview', () => {
  it('lists the settings without keys, for root', async () => {
    const res = await overview()
    expect(res.status).toBe(200)
    const vo = agentDiagnosticsVo.strict().parse(res.body.data)
    expect(vo.providers.find((p) => p.id === providerId)).toEqual({
      id: providerId,
      name: `${PREFIX}model`,
      enabled: true,
      hasKey: true,
    })
    expect(vo.search.find((s) => s.id === searchId)).toEqual({
      id: searchId,
      name: `${PREFIX}search`,
      enabled: true,
    })
    expect(vo.mcpServers.find((s) => s.id === mcpId)).toMatchObject({ status: 'unknown' })
    for (const n of Object.values(vo.queue)) expect(n).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(res.body)).not.toContain(KEY)
  })

  it('counts turns of every tenant and lists failures as codes only', async () => {
    const before = agentDiagnosticsVo.parse((await overview()).body.data).turns
    const now = new Date()
    await addTurn(other.id, 'running')
    await addTurn(other.id, 'waiting')
    await addTurn(1, 'running')
    const failed = await addTurn(other.id, 'failed', {
      code: 'A0500',
      msg: `boom ${'y'.repeat(400)}`,
      endedAt: now,
    })
    // failed before today (UTC): listed, not counted for today
    const old = await addTurn(1, 'failed', {
      code: 'A0501',
      msg: 'old',
      endedAt: new Date(Date.UTC(2020, 0, 1)),
    })
    const vo = agentDiagnosticsVo.parse((await overview()).body.data)
    expect(vo.turns).toEqual({
      running: before.running + 2,
      waiting: before.waiting + 1,
      failedToday: before.failedToday + 1,
    })
    const mine = vo.recentFailures.filter((f) => f.turnId === failed || f.turnId === old)
    // newest first
    expect(mine).toEqual([
      { turnId: old, tenantId: 1, code: 'A0501', message: 'old', at: '2020-01-01T00:00:00.000Z' },
      expect.objectContaining({ turnId: failed, tenantId: other.id, code: 'A0500' }),
    ])
    expect(mine[1]!.message.startsWith('boom ')).toBe(true)
    expect(mine[1]!.message.length).toBeLessThanOrEqual(200)
    expect(vo.recentFailures.length).toBeLessThanOrEqual(20)
  })

  it('refuses a platform administrator who is not root, a reader and a tenant administrator', async () => {
    expect((await overview(admin)).status).toBe(403)
    expect((await overview(reader)).status).toBe(403)
    expect((await overview(otherAdmin)).status).toBe(403)
  })
})

describe('connectivity tests', () => {
  it('tests a model provider with its key; a failure is a code without the upstream body', async () => {
    const res = await probe('provider', providerId)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ ok: true, ms: expect.any(Number) })
    expect(auths).toEqual([`Bearer ${KEY}`])
    const log = await logOf(ds, String(res.headers['x-request-id']))
    expect(log).toMatchObject({ domain: 'agent.provider', verb: 'test', ok: 1 })

    mode = 'fail'
    const bad = await probe('provider', providerId)
    expect(bad.body.data).toEqual({ ok: false, ms: expect.any(Number), error: 'http_401' })
    expect(JSON.stringify(bad.body)).not.toMatch(/upstream-detail|e2e-diag-key/)
  })

  it('a silent model provider times out', async () => {
    mode = 'silent'
    app.get(AgentDiagnosticsService).timeoutMs = 300
    const res = await probe('provider', providerId)
    expect(res.body.data).toEqual({ ok: false, ms: expect.any(Number), error: 'timeout' })
  })

  it('tests a search provider with one search', async () => {
    const res = await probe('search', searchId)
    expect(res.body.data).toEqual({ ok: true, ms: expect.any(Number) })
    expect(auths).toEqual([`Bearer ${KEY}`])
    mode = 'fail'
    const bad = await probe('search', searchId)
    expect(bad.body.data).toMatchObject({ ok: false, error: 'http_401' })
    expect(JSON.stringify(bad.body)).not.toMatch(/upstream-detail|e2e-diag-key/)
  })

  it('tests an MCP server by listing its tools, and saves nothing', async () => {
    const res = await probe('mcp', mcpId)
    expect(res.body.data).toEqual({ ok: true, ms: expect.any(Number) })
    const dead = await probe('mcp', deadMcpId)
    expect(dead.body.data).toMatchObject({ ok: false, error: expect.stringMatching(/^[\w.:-]+$/) })
    const [row] = await ds.query<{ status: string; synced_at: Date | null }[]>(
      'SELECT status, synced_at FROM agent_mcp_server WHERE id = ?',
      [mcpId],
    )
    expect(row).toEqual({ status: 'unknown', synced_at: null })
    const tools = await ds.query<unknown[]>('SELECT id FROM agent_mcp_tool WHERE server_id = ?', [
      mcpId,
    ])
    expect(tools).toHaveLength(0)
  })

  it('answers 404 for an unknown id', async () => {
    for (const kind of ['provider', 'search', 'mcp'] as const)
      expect((await probe(kind, 999_999_999)).status).toBe(404)
  })

  it('is root only: a platform administrator, a reader and a tenant administrator get 403', async () => {
    for (const kind of ['provider', 'search', 'mcp'] as const)
      for (const token of [admin, reader, otherAdmin])
        expect((await probe(kind, providerId, token)).status).toBe(403)
    expect(auths).toEqual([])
  })

  it('limits tests per route and caller', async () => {
    const codes: number[] = []
    for (let i = 0; i < 11; i++) codes.push((await probe('search', 999_999_999)).status)
    expect(codes).toContain(429)
  })
})

describe('orphan sweep stats', () => {
  /** a running turn of a new thread with no job, no lock and no activity for 3 minutes */
  async function orphan(name: string) {
    const res = await http()
      .post('/api/agent/threads')
      .set(bearer(root))
      .send({ title: `${PREFIX}${name}` })
    expect(res.status).toBe(201)
    const id = res.body.data.id as number
    threadIds.push(id)
    const [{ user_id: owner }] = await ds.query<{ user_id: number }[]>(
      'SELECT user_id FROM agent_thread WHERE id = ?',
      [id],
    )
    const store = app.get(ItemStore)
    const tid = await inTenant1(async () => {
      const turn = await store.tx((w) => w.createTurn(id, Number(owner)))
      await store.append(id, Number(turn.id), 'user', { text: 'left behind' })
      return Number(turn.id)
    })
    await ds.query('UPDATE agent_turn SET started_at = NOW(3) - INTERVAL 3 MINUTE WHERE id = ?', [
      tid,
    ])
    await ds.query(
      'UPDATE agent_thread SET last_active_at = NOW(3) - INTERVAL 3 MINUTE WHERE id = ?',
      [id],
    )
    return tid
  }
  /** waits until the turn is no longer running or waiting */
  async function settled(tid: number) {
    for (const until = Date.now() + 15_000; Date.now() < until;) {
      const [row] = await ds.query<{ status: string }[]>(
        'SELECT status FROM agent_turn WHERE id = ?',
        [tid],
      )
      if (row && row.status !== 'running' && row.status !== 'waiting') return row.status
      await new Promise((r) => setTimeout(r, 100))
    }
    return 'running'
  }

  it('shows what a real sweep did: one turn requeued, one failed, and when it ran', async () => {
    const before = agentDiagnosticsVo.parse((await overview()).body.data).sweeps
    const requeued = await orphan('requeued')
    const dying = await orphan('dying')
    const counters = [requeued, dying].map((t) => redisKey('lock', `agent-orphan-${t}`))
    const redis = app.get<Redis>(REDIS)
    await redis.set(counters[1]!, '3')
    const startedAt = Date.now()
    try {
      await app.get(TurnRunner).sweepOrphans()
      expect(await settled(dying)).toBe('failed')
      const { sweeps } = agentDiagnosticsVo.parse((await overview()).body.data)
      expect(sweeps).toMatchObject({
        requeued: before.requeued + 1,
        failed: before.failed + 1,
      })
      expect(Date.parse(sweeps.lastAt!)).toBeGreaterThanOrEqual(startedAt - 5)
      // the requeued turn runs again (and ends) before the spec cleans up
      expect(await settled(requeued)).not.toBe('running')
      // a sweep with nothing to do still records its run
      await new Promise((r) => setTimeout(r, 10))
      const second = Date.now()
      await app.get(TurnRunner).sweepOrphans()
      const after = agentDiagnosticsVo.parse((await overview()).body.data).sweeps
      expect(Date.parse(after.lastAt!)).toBeGreaterThanOrEqual(second - 5)
      expect(after).toMatchObject({ requeued: sweeps.requeued, failed: sweeps.failed })
    } finally {
      await redis.del(counters)
    }
  }, 40_000)
})
