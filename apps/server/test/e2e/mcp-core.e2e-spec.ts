// The MCP endpoint and its tool registry (see docs/mcp.md): a stateless Streamable HTTP server on
// POST /api/mcp serving initialize, tools/list and tools/call only (GET and DELETE 405); tools come from
// `@McpTool` provider methods found at start-up — a bad name, a name used twice, a perm that is no shared
// permission code or a non-object schema stops the start; arguments are validated (a tool error naming
// the field), the answer is shaped by the output schema, secret-named keys are masked, an answer over the
// size limit and a tool past its time limit are refused (a write tool is waited for in the background and
// logged with its real outcome, an answer off its output schema as an internal error); a protocol error a
// tool throws is an internal error like any other failure; an unknown tool is a JSON-RPC error, a batch request an invalid request;
// a failure inside tools/list answers a generic internal error; the switch list is read once per few seconds;
// a tool's sensitive argument names are masked in its log row.
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { Injectable, Module } from '@nestjs/common'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, userPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { McpRegistry, knownPerms } from '../../src/core/mcp/mcp-registry.js'
import { McpTool } from '../../src/core/mcp/mcp-tool.js'
import { McpToolSwitch } from '../../src/core/mcp/mcp.entity.js'
import { MCP_OUTPUT_MAX_BYTES, McpService, OUTPUT_SECRET } from '../../src/core/mcp/mcp.service.js'
import { logOf } from '../setup/audit.js'
import { callTool, patFor, rpc, toolNames } from './mcp-kit.js'

@Injectable()
class SpecTools {
  @McpTool({
    name: 'spec.echo.read',
    title: 'Echo',
    description: 'Echoes its argument with a secret beside it',
    perm: userPerms.browse,
    kind: 'read',
    input: z.object({ text: z.string().max(10), times: z.number().int().min(1).max(3).default(1) }),
    output: z.object({
      text: z.string(),
      apiKey: z.string(),
      password: z.string(),
      code: z.string(),
      key: z.string(),
    }),
  })
  echo({ text, times }: { text: string; times: number }) {
    return {
      text: text.repeat(times),
      apiKey: 'leak-me-not',
      password: 'hunter2',
      code: 'a-code',
      key: 'a-key',
      extra: 'dropped by the output schema',
    }
  }

  @McpTool({
    name: 'spec.slow.create',
    title: 'Slow write',
    description: 'Finishes its write after its time limit',
    perm: null,
    kind: 'write',
    input: z.object({}),
    timeoutMs: 50,
  })
  async slowWrite() {
    await new Promise((r) => setTimeout(r, 300))
    return { written: true }
  }

  @McpTool({
    name: 'spec.note.read',
    title: 'Note',
    description: 'Takes a note that must not reach the log',
    perm: null,
    kind: 'read',
    input: z.object({ note: z.string(), topic: z.string() }),
    sensitive: ['note'],
  })
  note() {
    return { ok: true }
  }

  @McpTool({
    name: 'spec.big.read',
    title: 'Big',
    description: 'Answers more than the limit',
    perm: null,
    kind: 'read',
    input: z.object({}),
  })
  big() {
    return { blob: 'x'.repeat(MCP_OUTPUT_MAX_BYTES + 1) }
  }

  @McpTool({
    name: 'spec.slow.read',
    title: 'Slow',
    description: 'Takes longer than its limit',
    perm: null,
    kind: 'read',
    input: z.object({}),
    timeoutMs: 50,
  })
  async slow() {
    await new Promise((r) => setTimeout(r, 500))
    return { done: true }
  }

  @McpTool({
    name: 'spec.boom.read',
    title: 'Boom',
    description: 'Fails with an internal error',
    perm: null,
    kind: 'read',
    input: z.object({}),
  })
  boom(): never {
    throw new Error('database password is hunter2')
  }

  @McpTool({
    name: 'spec.protocol.read',
    title: 'Protocol error',
    description: 'Throws a protocol error of its own',
    perm: null,
    kind: 'read',
    input: z.object({}),
  })
  protocol(): never {
    throw new McpError(ErrorCode.InvalidParams, 'upstream password is hunter2')
  }

  @McpTool({
    name: 'spec.late.create',
    title: 'Late write off its schema',
    description: 'Finishes after its time limit with an answer its output schema refuses',
    perm: null,
    kind: 'write',
    input: z.object({}),
    output: z.object({ written: z.literal(true) }),
    timeoutMs: 50,
  })
  async lateOffSchema() {
    await new Promise((r) => setTimeout(r, 300))
    return { written: 'no', secret: 'hunter2' }
  }
}

@Module({ providers: [SpecTools] })
class SpecToolsModule {}

let app: NestExpressApplication
let ds: DataSource
let root: string
let writer: string

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule, SpecToolsModule] }).compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  const [admin] = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
  )
  root = (await patFor(app, Number(admin!.id))).token
  writer = (await patFor(app, Number(admin!.id), { allowWrite: true })).token
})

afterAll(async () => {
  await ds?.query("DELETE FROM iam_access_token WHERE name = 'spec token'")
  await app?.close()
})

it('initialize answers with the tools capability only; other features are no methods', async () => {
  const init = await rpc(app, root, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'spec', version: '1' },
  }).expect(200)
  expect(init.body.result.capabilities).toEqual({ tools: { listChanged: false } })
  expect(init.headers['mcp-session-id']).toBeUndefined()
  for (const method of ['resources/list', 'prompts/list'])
    expect((await rpc(app, root, method).expect(200)).body.error.code).toBe(-32601)
})

it('tools/list shows every registered read tool with its JSON Schema', async () => {
  const res = await rpc(app, root, 'tools/list').expect(200)
  const echo = (res.body.result.tools as { name: string; inputSchema: unknown }[]).find(
    (t) => t.name === 'spec.echo.read',
  )
  expect(echo?.inputSchema).toMatchObject({
    type: 'object',
    properties: { text: { type: 'string', maxLength: 10 } },
    required: ['text'],
  })
  const names = await toolNames(app, root)
  expect(names).toEqual(
    expect.arrayContaining(['iam.me.get', 'iam.user.search', 'cfg.dict.options']),
  )
  // a token without write permission sees no write tool
  expect(names).not.toContain('demo.book.create')
})

it('validates the arguments, shapes and masks the answer', async () => {
  const ok = await callTool(app, root, 'spec.echo.read', { text: 'ab', times: 2 })
  // secret names are masked; a plain code or key is what the agent asked for
  const shaped = { text: 'abab', apiKey: '***', password: '***', code: 'a-code', key: 'a-key' }
  expect(ok.data).toEqual(shaped)
  expect(ok.structured).toEqual(shaped)
  const dict = await callTool(app, root, 'cfg.dict.options', { code: 'iam.gender' })
  expect(dict.data).toMatchObject({ code: 'iam.gender' })
  const bad = await callTool(app, root, 'spec.echo.read', { text: 'far too long text' })
  expect(bad.error?.code).toBe(Err.VALIDATION_FAILED.code)
  expect(bad.error?.errors?.[0]?.path).toBe('text')
})

it('masks secret-like names anywhere in the key, but not a plain code or key', () => {
  const masked = [
    'password',
    'passwd',
    'passphrase',
    'userPass',
    'pwd',
    'otp',
    'otpCode',
    'codeVerifier',
    'ticket',
    'serviceTicket',
    'token',
    'tokenHint',
    'refresh_token_id',
    'clientSecret',
    'apiKey',
    'privateKeyPem',
    'accessKey',
    'session_key',
    'signingKey',
    'encryptionKey',
    'appKey',
    'credentials',
  ]
  expect(masked.filter((name) => !OUTPUT_SECRET.test(name))).toEqual([])
  const plain = ['code', 'key', 'dictCode', 'keyword', 'title', 'isbn', 'monkey']
  expect(plain.filter((name) => OUTPUT_SECRET.test(name))).toEqual([])
})

it('a protocol error thrown by a tool is an internal error, logged as a failure, its text not answered', async () => {
  const res = await rpc(app, root, 'tools/call', {
    name: 'spec.protocol.read',
    arguments: {},
  }).expect(200)
  expect(res.body.error).toBeUndefined()
  expect(JSON.parse(res.body.result.content[0].text).code).toBe(Err.INTERNAL.code)
  expect(JSON.stringify(res.body)).not.toContain('hunter2')
  expect(await logOf(ds, res.headers['x-request-id'] as string)).toMatchObject({
    biz_id: 'spec.protocol.read',
    ok: 0,
    error_msg: Err.INTERNAL.key,
  })
})

it('a late write whose answer is off its output schema is logged as an internal error without the answer', async () => {
  const res = await rpc(app, writer, 'tools/call', {
    name: 'spec.late.create',
    arguments: {},
  }).expect(200)
  expect(JSON.parse(res.body.result.content[0].text).code).toBe(Err.MCP_TIMEOUT.code)
  const row = await logOf(ds, res.headers['x-request-id'] as string)
  expect(row).toMatchObject({
    biz_id: 'spec.late.create',
    ok: 0,
    error_msg: Err.INTERNAL.key,
    result: null,
  })
  expect(JSON.parse(row.params as string)).toMatchObject({ timedOut: true })
  expect(JSON.stringify(row)).not.toContain('hunter2')
})

it('refuses an answer over the size limit, a tool past its time limit and hides internal errors', async () => {
  expect((await callTool(app, root, 'spec.big.read')).error?.code).toBe(
    Err.MCP_OUTPUT_TOO_LARGE.code,
  )
  expect((await callTool(app, root, 'spec.slow.read')).error?.code).toBe(Err.MCP_TIMEOUT.code)
  const boom = await callTool(app, root, 'spec.boom.read')
  expect(boom.error?.code).toBe(Err.INTERNAL.code)
  expect(JSON.stringify(boom)).not.toContain('hunter2')
})

it('a write tool past its time limit is logged with its real outcome once it settles', async () => {
  const res = await rpc(app, writer, 'tools/call', {
    name: 'spec.slow.create',
    arguments: {},
  }).expect(200)
  expect(JSON.parse(res.body.result.content[0].text).code).toBe(Err.MCP_TIMEOUT.code)
  const row = await logOf(ds, res.headers['x-request-id'] as string)
  expect(row).toMatchObject({ biz_id: 'spec.slow.create', ok: 1 })
  expect(JSON.parse(row.params as string)).toMatchObject({ timedOut: true })
  expect(JSON.parse(row.result as string)).toEqual({ written: true })
})

it('masks a tool’s sensitive argument names in its log row', async () => {
  const res = await rpc(app, root, 'tools/call', {
    name: 'spec.note.read',
    arguments: { note: 'my secret note', topic: 'visible' },
  }).expect(200)
  const row = await logOf(ds, res.headers['x-request-id'] as string)
  expect(JSON.parse(row.params as string).arguments).toEqual({ note: '***', topic: 'visible' })
})

it('an unknown tool is a JSON-RPC error; a batch request is refused', async () => {
  const r = await callTool(app, root, 'spec.missing.read')
  expect(r.rpcError?.code).toBe(-32602)
  const one = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'iam.me.get' } }
  const batch = await request(app.getHttpServer())
    .post('/api/mcp')
    .set('Authorization', `Bearer ${root}`)
    .set('Accept', 'application/json, text/event-stream')
    .send([
      { ...one, id: 1 },
      { ...one, id: 2 },
    ])
    .expect(400)
  expect(batch.body.error.code).toBe(-32600)
})

it('reads the switch list once per few seconds; a failure in tools/list leaks nothing', async () => {
  const mcp = app.get(McpService)
  const switches = ds.getRepository(McpToolSwitch)
  mcp.forgetSwitches()
  const read = vi.spyOn(switches, 'findBy')
  try {
    for (let i = 0; i < 3; i++) await toolNames(app, root)
    expect(read).toHaveBeenCalledTimes(1)
    mcp.forgetSwitches()
    read.mockRejectedValueOnce(new Error("ER_ACCESS_DENIED_ERROR: SELECT secret_sql FROM 'x'"))
    const res = await rpc(app, root, 'tools/list').expect(200)
    expect(res.body.error.code).toBe(-32603)
    expect(JSON.stringify(res.body)).not.toContain('secret_sql')
  } finally {
    read.mockRestore()
    mcp.forgetSwitches()
  }
})

it('GET and DELETE answer 405 (stateless: no streams, no sessions); a browser of another site is refused', async () => {
  await request(app.getHttpServer()).get('/api/mcp').expect(405)
  await request(app.getHttpServer()).delete('/api/mcp').expect(405)
  await rpc(app, root, 'tools/list').set('Origin', 'https://evil.example').expect(403)
})

describe('registry checks at start-up', () => {
  const registry = () =>
    new McpRegistry(app.get(DiscoveryService), new MetadataScanner(), new Reflector())
  const meta = {
    name: 'spec.thing.read',
    title: 't',
    description: 'd',
    perm: null,
    kind: 'read' as const,
    input: z.object({}),
  }

  it('refuses a bad name, a second registration, an unknown perm and non-object schemas', () => {
    const r = registry()
    r.add(meta, () => null)
    expect(() => r.add(meta, () => null)).toThrow(/registered twice/)
    expect(() => r.add({ ...meta, name: 'Spec:thing' }, () => null)).toThrow(/name/)
    expect(() => r.add({ ...meta, name: 'spec.a.b', perm: 'iam.user.fly' }, () => null)).toThrow(
      /no shared permission/,
    )
    expect(() =>
      r.add({ ...meta, name: 'spec.c.d', input: z.string() as unknown as z.ZodObject }, () => null),
    ).toThrow(/object schemas/)
    expect(() => r.add({ ...meta, name: 'spec.e.f', timeoutMs: 0 }, () => null)).toThrow(
      /timeoutMs/,
    )
  })

  it('knows every perm of the shared *Perms constants, nested ones too', () => {
    const perms = knownPerms()
    expect(perms.has(userPerms.browse)).toBe(true)
    expect(perms.has('wxoa.account.browse')).toBe(true)
    expect(knownPerms({ fooPerms: { a: { b: 'x.y.z' } }, other: { c: 'p.q.r' } })).toEqual(
      new Set(['x.y.z']),
    )
  })

  it('the app registered the sample tools exactly once', () => {
    const names = app
      .get(McpRegistry)
      .list()
      .map((t) => t.name)
    for (const n of ['iam.me.get', 'iam.user.search', 'cfg.dict.options', 'demo.book.create'])
      expect(names.filter((x) => x === n)).toHaveLength(1)
  })
})
