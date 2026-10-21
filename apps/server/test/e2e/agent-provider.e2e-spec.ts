// Agent model and search providers (see docs/agent.md): the platform settings API keeps keys sealed and
// write-only (never answered, masked in the action log, kept when a save leaves them out, required again
// when the target changes, dropped with the row), one default per table, platform-only and behind
// agent.setting.*; ProviderRegistry resolves the enabled default; the OpenAI-compatible adapter is
// driven end to end against a local server speaking the Chat Completions format (streamed text and
// tool-call fragments, usage, reasoning only for flagged models, retry on 5xx only, idle timeout,
// caller abort, safe errors). The module is imported beside AppModule here, multi-tenancy on.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentProviderModule } from '../../src/core/agent/provider/agent-provider.module.js'
import type { ChatEvent } from '../../src/core/agent/provider/chat-model.js'
import { FakeChatModel } from '../../src/core/agent/provider/fake-chat-model.js'
import { OpenAiChatModel } from '../../src/core/agent/provider/openai-chat-model.js'
import {
  AgentProviderController,
  AgentSearchProviderController,
} from '../../src/core/agent/provider/provider.controller.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { PLATFORM_ONLY } from '../../src/core/auth/platform-only.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, createTenant, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agprov-'
const KEY = 'e2e-provider-key-not-real-0123456789'

let app: NestExpressApplication
let ds: DataSource
let root: string
let reader: string
let readerId = 0
let other: PeopledTenant
let otherAdmin: string

// ---- the local Chat Completions server ----
type Handler = (body: Record<string, any>, res: ServerResponse) => void
let stub: Server
let baseUrl = ''
let handler: Handler = (_b, res) => res.end()
const seen: { body: Record<string, any>; auth?: string }[] = []

const chunk = (delta: object, finish: string | null = null) => ({
  id: 'chatcmpl-e2e',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'm',
  choices: [{ index: 0, delta, finish_reason: finish }],
})
/** writes the chunks as server-sent events, then `[DONE]` */
function sse(res: ServerResponse, chunks: object[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
  res.end('data: [DONE]\n\n')
}
const fail = (res: ServerResponse, status: number) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: `upstream-detail ${KEY}`, type: 'server_error' } }))
}

const http = () => request(app.getHttpServer())
const providerBody = (name: string, extra: object = {}) => ({
  name: `${PREFIX}${name}`,
  baseUrl,
  models: [
    { id: 'chat-1', label: 'Chat 1' },
    { id: 'think-1', reasoning: true, contextWindow: 128_000 },
  ],
  ...extra,
})
const storedKey = async (table: string, id: number) =>
  (
    await ds.query<{ api_key: unknown }[]>(`SELECT api_key FROM ${table} WHERE id = ?`, [id])
  ) // arch-allow: sql-concat table name from this spec's two literals; tenant: platform tables
  [0]?.api_key ?? null
const events = async (it: AsyncIterable<ChatEvent>) => {
  const out: ChatEvent[] = []
  for await (const e of it) out.push(e)
  return out
}
const caught = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  )
const model = (extra: object = {}) =>
  new OpenAiChatModel({
    baseUrl,
    apiKey: KEY,
    models: [
      { id: 'chat-1', reasoning: false },
      { id: 'think-1', reasoning: true },
    ],
    ...extra,
  })

beforeAll(async () => {
  stub = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (d: Buffer) => (raw += d.toString()))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {}
      seen.push({ body, auth: req.headers.authorization })
      handler(body, res)
    })
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`

  const env = { ...process.env, APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentProviderModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
  readerId = await addUser(app, 1, `${PREFIX}reader`)
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
  other = await createTenant(app, { users: true })
  otherAdmin = (await signIn(app, 'admin', {}, other.id)).accessToken
})

afterAll(async () => {
  await ds?.query('DELETE FROM agent_provider WHERE name LIKE ?', [`${PREFIX}%`])
  await ds?.query('DELETE FROM agent_search_provider WHERE name LIKE ?', [`${PREFIX}%`])
  if (readerId) await ds.query('DELETE FROM iam_user WHERE id = ?', [readerId])
  await other?.dispose()
  await app?.close()
  stub?.closeAllConnections()
  await new Promise((r) => stub?.close(r))
})

beforeEach(() => {
  seen.length = 0
  handler = (_b, res) => res.end()
})

describe('provider settings', () => {
  it('seals the key, never answers it, masks it in the action log', async () => {
    const res = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .set('X-Request-Id', `${PREFIX}${process.pid}-create`)
      .send(providerBody('sealed', { apiKey: KEY }))
    expect(res.status).toBe(201)
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      name: `${PREFIX}sealed`,
      baseUrl,
      hasKey: true,
      models: [
        {
          id: 'chat-1',
          label: 'Chat 1',
          reasoning: false,
          vision: false,
          fast: false,
          contextWindow: 64_000,
        },
        {
          id: 'think-1',
          label: 'think-1',
          reasoning: true,
          vision: false,
          fast: false,
          contextWindow: 128_000,
        },
      ],
      enabled: true,
      isDefault: false,
      sort: 0,
    })
    const id = res.body.data.id as number
    const box = await storedKey('agent_provider', id)
    expect(box).toEqual({ iv: expect.any(String), tag: expect.any(String), ct: expect.any(String) })
    expect(JSON.stringify(box)).not.toContain(KEY)
    const list = await http().get('/api/agent/providers').set(bearer(root))
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).not.toContain(KEY)
    expect(list.body.data.find((p: { id: number }) => p.id === id)).toMatchObject({ hasKey: true })
    const log = await logOf(ds, `${PREFIX}${process.pid}-create`)
    expect(log).toMatchObject({ domain: 'agent.provider', verb: 'create', ok: 1 })
    expect(JSON.stringify(log)).not.toContain(KEY)
  })

  it('keeps the key when a save leaves it out or empty, replaces it when given', async () => {
    const reg = app.get(ProviderRegistry)
    const { body } = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send(providerBody('keep', { apiKey: KEY }))
    const id = body.data.id as number
    const box = await storedKey('agent_provider', id)
    for (const apiKey of [undefined, '']) {
      const res = await http()
        .put(`/api/agent/providers/${id}`)
        .set(bearer(root))
        .send(providerBody('keep', { apiKey, sort: 5 }))
      expect(res.status).toBe(200)
      expect(res.body.data).toMatchObject({ hasKey: true, sort: 5 })
      expect(await storedKey('agent_provider', id)).toEqual(box)
    }
    await http()
      .put(`/api/agent/providers/${id}`)
      .set(bearer(root))
      .send(providerBody('keep', { apiKey: 'sk-new' }))
    expect(await storedKey('agent_provider', id)).not.toEqual(box)
    const connect = vi.spyOn(reg, 'connect')
    await reg.resolve(id)
    expect(connect.mock.calls[0]![0].apiKey).toBe('sk-new')
    connect.mockRestore()
  })

  it('needs the key again when the address changes', async () => {
    const { body } = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send(providerBody('moved', { apiKey: KEY }))
    const id = body.data.id as number
    const moved = providerBody('moved', { baseUrl: 'https://elsewhere.example/v1' })
    const refused = await http().put(`/api/agent/providers/${id}`).set(bearer(root)).send(moved)
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe(Err.AGENT_KEY_REQUIRED.code)
    const ok = await http()
      .put(`/api/agent/providers/${id}`)
      .set(bearer(root))
      .send({ ...moved, apiKey: 'sk-for-elsewhere' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.baseUrl).toBe('https://elsewhere.example/v1')
  })

  it('one default per table', async () => {
    const add = async (name: string) =>
      (
        await http()
          .post('/api/agent/providers')
          .set(bearer(root))
          .send(providerBody(name, { isDefault: true }))
      ).body.data.id as number
    const a = await add('default-a')
    const b = await add('default-b')
    const rows = await ds.query<{ id: number }[]>(
      'SELECT id FROM agent_provider WHERE is_default = 1 AND deleted_at IS NULL',
    )
    expect(rows.map((r) => Number(r.id))).toEqual([b])
    await http()
      .put(`/api/agent/providers/${a}`)
      .set(bearer(root))
      .send(providerBody('default-a', { isDefault: true }))
    const after = await ds.query<{ id: number }[]>(
      'SELECT id FROM agent_provider WHERE is_default = 1 AND deleted_at IS NULL',
    )
    expect(after.map((r) => Number(r.id))).toEqual([a])
  })

  it('400 for a bad body, 409 for a taken name, 429 for a duplicate submit, 404 for a missing id', async () => {
    const bad = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send(providerBody('bad', { baseUrl: 'ftp://x', models: [] }))
    expect(bad.status).toBe(400)
    const body = providerBody('taken')
    expect((await http().post('/api/agent/providers').set(bearer(root)).send(body)).status).toBe(
      201,
    )
    // the same body again within the idempotency window; a changed body passes it and meets the name
    const dup = await http().post('/api/agent/providers').set(bearer(root)).send(body)
    expect(dup.status).toBe(429)
    const taken = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send({ ...body, sort: 1 })
    expect(taken.status).toBe(409)
    expect(
      (await http().put('/api/agent/providers/999999999').set(bearer(root)).send(body)).status,
    ).toBe(404)
    expect((await http().delete('/api/agent/providers/999999999').set(bearer(root))).status).toBe(
      404,
    )
  })

  it('delete drops the key with the row', async () => {
    const { body } = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send(providerBody('gone', { apiKey: KEY }))
    const id = body.data.id as number
    expect((await http().delete(`/api/agent/providers/${id}`).set(bearer(root))).status).toBe(200)
    const [row] = await ds.query<{ api_key: unknown; deleted_at: Date | null }[]>(
      'SELECT api_key, deleted_at FROM agent_provider WHERE id = ?',
      [id],
    )
    expect(row).toMatchObject({ api_key: null, deleted_at: expect.any(Date) })
    const list = await http().get('/api/agent/providers').set(bearer(root))
    expect(list.body.data.some((p: { id: number }) => p.id === id)).toBe(false)
  })

  it('search providers: sealed write-only key, kind change needs it again, one default', async () => {
    const add = (name: string, extra: object = {}) =>
      http()
        .post('/api/agent/search-providers')
        .set(bearer(root))
        .send({ kind: 'bocha', name: `${PREFIX}${name}`, ...extra })
    const a = await add('search-a', { apiKey: KEY, isDefault: true })
    expect(a.status).toBe(201)
    expect(a.body.data).toEqual({
      id: expect.any(Number),
      kind: 'bocha',
      name: `${PREFIX}search-a`,
      hasKey: true,
      enabled: true,
      isDefault: true,
    })
    const b = await add('search-b', { kind: 'tavily', isDefault: true })
    expect(b.body.data.hasKey).toBe(false)
    const list = await http().get('/api/agent/search-providers').set(bearer(root))
    expect(JSON.stringify(list.body)).not.toContain(KEY)
    const mine = list.body.data.filter((p: { name: string }) => p.name.startsWith(PREFIX))
    expect(mine.map((p: { isDefault: boolean }) => p.isDefault)).toEqual([true, false])
    expect(mine[0].id).toBe(b.body.data.id)
    const id = a.body.data.id as number
    const kept = await http()
      .put(`/api/agent/search-providers/${id}`)
      .set(bearer(root))
      .send({ kind: 'bocha', name: `${PREFIX}search-a`, enabled: false })
    expect(kept.body.data).toMatchObject({ hasKey: true, enabled: false, isDefault: false })
    const refused = await http()
      .put(`/api/agent/search-providers/${id}`)
      .set(bearer(root))
      .send({ kind: 'tavily', name: `${PREFIX}search-a` })
    expect(refused.status).toBe(422)
    await http()
      .put(`/api/agent/search-providers/${b.body.data.id}`)
      .set(bearer(root))
      .send({ kind: 'tavily', name: `${PREFIX}search-b`, apiKey: 'tvly-key', isDefault: true })
    expect(await app.get(ProviderRegistry).resolveSearch()).toMatchObject({
      kind: 'tavily',
      apiKey: 'tvly-key',
    })
    expect(
      (await http().delete(`/api/agent/search-providers/${id}`).set(bearer(root))).status,
    ).toBe(200)
    expect(await storedKey('agent_search_provider', id)).toBeNull()
  })

  it('403 without agent.setting.*, 403 for a user of another tenant; reads are platform-only, changes root-only', async () => {
    for (const token of [reader, otherAdmin]) {
      expect((await http().get('/api/agent/providers').set(bearer(token))).status).toBe(403)
      expect(
        (await http().post('/api/agent/providers').set(bearer(token)).send(providerBody('x')))
          .status,
      ).toBe(403)
      expect(
        (await http().put('/api/agent/providers/1').set(bearer(token)).send(providerBody('x')))
          .status,
      ).toBe(403)
      expect((await http().delete('/api/agent/providers/1').set(bearer(token))).status).toBe(403)
      expect((await http().get('/api/agent/search-providers').set(bearer(token))).status).toBe(403)
    }
    for (const ctrl of [AgentProviderController, AgentSearchProviderController])
      for (const name of ['list', 'create', 'update', 'remove'] as const)
        // 读取对平台人员开放；改动（含密钥与费用）只有 root 能做
        expect(Reflect.getMetadata(PLATFORM_ONLY, ctrl.prototype[name])).toBe(
          name === 'list' ? 'platform' : 'root',
        )
  })
})

describe('ProviderRegistry', () => {
  it('resolves the enabled default and its first model, or the asked one', async () => {
    const reg = app.get(ProviderRegistry)
    const add = async (name: string, extra: object) =>
      (await http().post('/api/agent/providers').set(bearer(root)).send(providerBody(name, extra)))
        .body.data.id as number
    const def = await add('reg-default', { apiKey: KEY, isDefault: true })
    const off = await add('reg-off', { enabled: false })
    const first = await reg.resolve()
    expect(first).toMatchObject({
      providerId: def,
      providerName: `${PREFIX}reg-default`,
      model: { id: 'chat-1', label: 'Chat 1', reasoning: false, contextWindow: 64_000 },
    })
    expect((await reg.resolve(def, 'think-1')).model).toMatchObject({
      id: 'think-1',
      reasoning: true,
    })
    const misses: [number, string?][] = [[off], [def, 'no-such-model'], [999999999]]
    for (const args of misses) {
      const e = await caught(reg.resolve(...args))
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).err).toBe(Err.AGENT_NOT_CONFIGURED)
    }
  })

  it('the resolved model talks to the provider with the opened key', async () => {
    const { body } = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send(providerBody('reg-live', { apiKey: KEY, isDefault: true }))
    handler = (_b, res) => sse(res, [chunk({ content: 'hi' }, 'stop')])
    const { chat } = await app.get(ProviderRegistry).resolve(body.data.id)
    expect(
      await events(chat.stream({ model: 'chat-1', messages: [{ role: 'user', content: 'x' }] })),
    ).toEqual([
      { type: 'text', delta: 'hi' },
      { type: 'finish', reason: 'stop' },
    ])
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`)
  })

  it('a fake model can stand in for the provider', async () => {
    const reg = app.get(ProviderRegistry)
    const fake = new FakeChatModel([{ text: 'from the script' }])
    const spy = vi.spyOn(reg, 'connect').mockReturnValue(fake)
    const { chat } = await reg.resolve()
    expect((await chat.complete({ model: 'chat-1', messages: [] })).text).toBe('from the script')
    expect(seen).toHaveLength(0)
    spy.mockRestore()
  })
})

describe('OpenAiChatModel against a Chat Completions server', () => {
  const tools = [
    { name: 'demo.customer.search', description: 'Find customers', parameters: { type: 'object' } },
    { name: 'plan.update', description: 'Update the plan', parameters: { type: 'object' } },
  ]

  it('streams text, assembles tool-call fragments, reports usage', async () => {
    handler = (_b, res) =>
      sse(res, [
        chunk({ role: 'assistant', content: 'Hel' }),
        chunk({ content: 'lo' }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_a',
              type: 'function',
              function: { name: 'demo_customer_search', arguments: '{"kw' },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '":"acme"}' } }] }),
        chunk({
          tool_calls: [
            { index: 1, id: 'call_b', function: { name: 'plan_update', arguments: '' } },
          ],
        }),
        chunk({}, 'tool_calls'),
        {
          ...chunk({}),
          choices: [],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        },
      ])
    const out = await events(
      model().stream({
        model: 'chat-1',
        reasoning: 'high',
        maxTokens: 500,
        tools,
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'find acme' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [{ id: 'old', name: 'demo.customer.search', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 'old', content: '[]' },
        ],
      }),
    )
    expect(out).toEqual([
      { type: 'text', delta: 'Hel' },
      { type: 'text', delta: 'lo' },
      { type: 'usage', usage: { promptTokens: 12, completionTokens: 7 } },
      {
        type: 'tool_call',
        call: { id: 'call_a', name: 'demo.customer.search', arguments: '{"kw":"acme"}' },
      },
      { type: 'tool_call', call: { id: 'call_b', name: 'plan.update', arguments: '{}' } },
      { type: 'finish', reason: 'tool_calls' },
    ])
    const sent = seen[0]!
    expect(sent.auth).toBe(`Bearer ${KEY}`)
    expect(sent.body).toMatchObject({
      model: 'chat-1',
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 500,
      tools: [
        {
          type: 'function',
          function: { name: 'demo_customer_search', description: 'Find customers' },
        },
        { type: 'function', function: { name: 'plan_update' } },
      ],
    })
    expect(sent.body.messages[2]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'old',
          type: 'function',
          function: { name: 'demo_customer_search', arguments: '{}' },
        },
      ],
    })
    expect(sent.body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'old', content: '[]' })
    // not a reasoning model: no effort, the classic token limit
    expect(sent.body).not.toHaveProperty('reasoning_effort')
    expect(sent.body).not.toHaveProperty('max_completion_tokens')
  })

  it('streams the reasoning summary of reasoning_content or reasoning as reasoning events', async () => {
    handler = (_b, res) =>
      sse(res, [
        chunk({ role: 'assistant', reasoning_content: 'weigh ' }),
        chunk({ reasoning: 'options' }),
        chunk({ content: 'done' }, 'stop'),
      ])
    expect(await events(model().stream({ model: 'think-1', messages: [] }))).toEqual([
      { type: 'reasoning', delta: 'weigh ' },
      { type: 'reasoning', delta: 'options' },
      { type: 'text', delta: 'done' },
      { type: 'finish', reason: 'stop' },
    ])
  })

  it('sends reasoning_effort only to a model flagged reasoning', async () => {
    handler = (_b, res) => sse(res, [chunk({ content: 'ok' }, 'stop')])
    await events(
      model().stream({ model: 'think-1', reasoning: 'low', maxTokens: 64, messages: [] }),
    )
    expect(seen[0]!.body).toMatchObject({ reasoning_effort: 'low', max_completion_tokens: 64 })
    expect(seen[0]!.body).not.toHaveProperty('max_tokens')
  })

  it('retries a 500 and a 429, then answers', async () => {
    let n = 0
    handler = (_b, res) =>
      ++n <= 2 ? fail(res, n === 1 ? 500 : 429) : sse(res, [chunk({ content: 'ok' }, 'stop')])
    const out = await events(model().stream({ model: 'chat-1', messages: [] }))
    expect(out.at(-1)).toEqual({ type: 'finish', reason: 'stop' })
    expect(seen).toHaveLength(3)
  })

  it('gives up after the retries with a safe error, and never retries a 400', async () => {
    handler = (_b, res) => fail(res, 503)
    const e = await caught(events(model({ retries: 1 }).stream({ model: 'chat-1', messages: [] })))
    expect(seen).toHaveLength(2)
    expect(e).toBeInstanceOf(BizError)
    expect((e as BizError).err).toBe(Err.AGENT_PROVIDER_FAILED)
    expect((e as BizError).params).toEqual({ reason: 'http_503' })
    expect(JSON.stringify({ m: (e as Error).message, p: (e as BizError).params })).not.toMatch(
      /upstream-detail|sk-e2e/,
    )
    seen.length = 0
    handler = (_b, res) => fail(res, 400)
    const bad = await caught(model().complete({ model: 'chat-1', messages: [] }))
    expect(seen).toHaveLength(1)
    expect((bad as BizError).params).toEqual({ reason: 'http_400' })
  })

  it('times out a silent server and a stalled stream', async () => {
    handler = () => undefined
    const silent = await caught(
      model({ timeoutMs: 200 }).complete({ model: 'chat-1', messages: [] }),
    )
    expect((silent as BizError).params).toEqual({ reason: 'timeout' })
    handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)
    }
    const got: ChatEvent[] = []
    const stalled = await caught(
      (async () => {
        for await (const e of model({ timeoutMs: 200 }).stream({ model: 'chat-1', messages: [] }))
          got.push(e)
      })(),
    )
    expect(got).toEqual([{ type: 'text', delta: 'partial' }])
    expect((stalled as BizError).params).toEqual({ reason: 'timeout' })
  })

  it('an answer cut off before its finish reason is a failure, not a short answer', async () => {
    handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify(chunk({ content: 'half' }))}\n\n`)
    }
    const e = await caught(events(model().stream({ model: 'chat-1', messages: [] })))
    expect((e as BizError).params).toEqual({ reason: 'bad_response' })
  })

  it('an aborted signal rejects with its reason, not a provider failure', async () => {
    handler = () => undefined
    const ctrl = new AbortController()
    const stop = new Error('stopped by the user')
    setTimeout(() => ctrl.abort(stop), 50)
    expect(
      await caught(events(model().stream({ model: 'chat-1', messages: [], signal: ctrl.signal }))),
    ).toBe(stop)
    // mid-stream too
    handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk({ content: 'partial' }))}\n\n`)
    }
    const mid = new AbortController()
    const it = model().stream({ model: 'chat-1', messages: [], signal: mid.signal })
    const got = caught(
      (async () => {
        for await (const e of it) if (e.type === 'text') mid.abort(stop)
      })(),
    )
    expect(await got).toBe(stop)
  })

  it('complete() answers text, tool calls and usage without streaming', async () => {
    handler = (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'chat-1',
          choices: [
            {
              index: 0,
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: 'calling',
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'plan_update', arguments: '{"a":1}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      )
    }
    expect(await model().complete({ model: 'chat-1', tools, messages: [] })).toEqual({
      text: 'calling',
      toolCalls: [{ id: 'c1', name: 'plan.update', arguments: '{"a":1}' }],
      usage: { promptTokens: 3, completionTokens: 2 },
      finishReason: 'tool_calls',
    })
    expect(seen[0]!.body.stream).toBeUndefined()
  })
})
