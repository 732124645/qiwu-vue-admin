import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { AGENT_TURN_QUEUE, TurnQueue } from '../../src/core/agent/runtime/turn-queue.js'
import request from 'supertest'
import { z } from 'zod'
import { bearer, signIn } from '../setup/auth.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { OpenAiChatModel } from '../../src/core/agent/provider/openai-chat-model.js'
import type { ImageRequest } from '../../src/core/agent/provider/chat-model.js'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AGENT_LIMIT_PARAMS, Err } from '@qiwu/shared'
import { ParamService } from '../../src/core/settings/param.service.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { EntityManager, type DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import {
  AgentItem,
  AgentThread,
  AgentTurn,
} from '../../src/core/agent/entities/agent-thread.entity.js'
import { FakeChatModel } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { usageOf } from '../../src/core/agent/provider/usage.js'
import { ItemStore, StaleItem } from '../../src/core/agent/runtime/item-store.js'
import { TurnRunner } from '../../src/core/agent/runtime/turn-runner.js'
import { InvocationLeaseLost, UsageBook } from '../../src/core/agent/runtime/usage-book.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { QueueService } from '../../src/core/queue/queue.service.js'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { REDIS } from '../../src/core/redis/redis.module.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { TEST_AGENT_PRICING } from '../setup/agent-pricing.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
})
let app: NestExpressApplication
let ds: DataSource
let book: UsageBook
let store: ItemStore
let providerId: number
let ownerId: number
let server: Server
let endpoint = ''
let mode: 'hold' | 'finish' | 'receipt' = 'hold'
let upstreamCalls = 0
let imageRequests = 0
const shutdownMode = process.platform === 'win32' ? 'ipc' : 'sigterm'
const children = new Set<ChildProcess>()
const threads: number[] = []
const receipts: number[] = []
const tenant = <T>(fn: () => Promise<T>) => withTenant(1, fn)
const target = () => ({
  providerId,
  providerName: 'Restart fixture',
  model: 'restart-model',
  pricing: TEST_AGENT_PRICING,
})
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until<T>(
  read: () => Promise<T | null | undefined | false>,
  timeout = 10_000,
): Promise<T> {
  for (const end = Date.now() + timeout; ; await sleep(40)) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error('Recovery fixture condition did not become true')
  }
}
async function makeTurn(extra: Partial<AgentThread> = {}) {
  return tenant(() =>
    store.tx(async (w) => {
      const thread = await w.m.getRepository(AgentThread).save({
        userId: ownerId,
        title: 'Restart fixture',
        providerId,
        model: 'restart-model',
        ...extra,
      })
      threads.push(Number(thread.id))
      const turn = await w.createTurn(Number(thread.id), ownerId)
      await w.append(
        Number(thread.id),
        Number(turn.id),
        'user',
        { text: 'Answer briefly.' },
        'done',
      )
      return { thread, turn }
    }),
  )
}
async function startChild() {
  const fixture = new URL('../fixtures/agent-recovery-process.mjs', import.meta.url)
  const child = fork(fixture, [], {
    env: {
      ...process.env,
      APP_AGENT: 'true',
      APP_MCP: 'false',
      APP_MULTI_TENANT: 'false',
      NODE_ENV: 'test',
      ENV_FILE: '.env.test',
    },
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  children.add(child)
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output = (output + String(chunk)).slice(-8000)
  })
  child.stderr?.on('data', (chunk) => {
    output = (output + String(chunk)).slice(-8000)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Recovery child did not start: ${output}`)),
      15_000,
    )
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Recovery child exited ${code}: ${output}`))
    })
    child.on('message', (message) => {
      if ((message as { type: string }).type === 'ready') {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  return child
}
async function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  if (signal === 'SIGTERM' && shutdownMode === 'ipc') child.send({ command: 'shutdown' })
  else child.kill(signal)
  await exited
  children.delete(child)
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url?.endsWith('/images/generations')) {
        imageRequests++
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [], usage: { input_tokens: 7, output_tokens: 2 } }))
        return
      }
      upstreamCalls++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const send = (value: object) => res.write(`data: ${JSON.stringify(value)}\n\n`)
      send({
        choices: [
          {
            index: 0,
            delta: { content: mode === 'finish' ? 'Recovered answer.' : 'durable prefix' },
            finish_reason: null,
          },
        ],
      })
      if (mode === 'receipt')
        send({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } })
      if (mode === 'finish') {
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        send({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })
        res.end('data: [DONE]\n\n')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const env = { ...process.env, APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get(getDataSourceToken())
  // 前序种子测试保留自增计数，按自然键取当前本人，不能把用户主键当作固定种子契约。
  const [owner] = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_user WHERE tenant_id = ? AND username = ? AND deleted_at IS NULL',
    [1, 'admin'],
  )
  assert.ok(owner, 'Recovery fixture requires the seeded owner')
  ownerId = Number(owner.id)
  const principal = await tenant(() => app.get(PermVersion).load(ownerId))
  assert.ok(principal, 'Recovery fixture owner must be active')
  assert.equal(principal.userId, ownerId)
  assert.equal(principal.tenantId, 1)
  assert.equal(principal.root, true)
  book = app.get(UsageBook)
  store = app.get(ItemStore)
  await Promise.all(
    app
      .get(QueueService)
      .workers()
      .map((w) => w.pause(true)),
  )
  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: 'Restart fixture',
    base_url: endpoint,
    enabled: 1,
    models: [
      {
        id: 'restart-model',
        label: 'Restart model',
        contextWindow: 64000,
        pricing: TEST_AGENT_PRICING,
      },
    ],
  })
}, 30_000)
afterAll(async () => {
  await Promise.all([...children].map((child) => stopChild(child, 'SIGKILL')))
  if (app) await app.get(NotifyDispatcher).idle()
  server?.closeAllConnections()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (ds && providerId) {
    if (threads.length) {
      const rows = await ds.query<{ id: number }[]>(
        'SELECT id FROM agent_turn WHERE tenant_id = 1 AND thread_id IN (?)',
        [threads],
      )
      const ids = new Set(rows.map((row) => Number(row.id)))
      const queue = app.get(QueueService).queues().get(AGENT_TURN_QUEUE)
      // 正常关闭会给未完轮次重新入队；只清本夹具的任务，不让它们进入下一份 spec 的新记录。
      for (const job of (await queue?.getJobs(['waiting', 'delayed'])) ?? [])
        if (job.data?.tenantId === 1 && ids.has(Number(job.data?.payload?.turnId)))
          await job.remove()
    }
    await ds.query('DELETE FROM agent_usage_entry WHERE provider_id = ?', [providerId])
    await ds.query('DELETE FROM agent_usage WHERE provider_id = ?', [providerId])
    if (threads.length) {
      for (const table of ['msg_inbox', 'msg_mail_record']) {
        // arch-allow: sql-concat fixed notification tables; tenant: only tenant 1 and this fixture's own thread ids
        await ds.query(
          `DELETE FROM ${table} WHERE tenant_id = 1 AND user_id = ? AND template_code = ? AND JSON_EXTRACT(params, '$.threadId') IN (?)`,
          [ownerId, 'agent.turn.waiting', threads],
        )
      }
      await ds.query('DELETE FROM agent_item WHERE tenant_id = 1 AND thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_turn WHERE tenant_id = 1 AND thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_thread WHERE tenant_id = 1 AND id IN (?)', [threads])
    }
    await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
  }
  await app?.close()
})

it('commits invocation, daily usage and durable parent totals exactly once, while live pending calls do not block concurrency', async () => {
  const parent = await makeTurn()
  const child = await makeTurn({ parentThreadId: parent.thread.id })
  await tenant(() =>
    ds.getRepository(AgentTurn).update({ id: child.turn.id }, { parentTurnId: parent.turn.id }),
  )
  const a = await tenant(() =>
    book.begin(ownerId, target(), { threadId: child.thread.id, turnId: child.turn.id }),
  )
  const b = await tenant(() => book.begin(ownerId, target(), {}))
  receipts.push(a.id, b.id)
  const [pending] = await ds.query(
    'SELECT status, credits, usage_json FROM agent_usage_entry WHERE id = ?',
    [a.id],
  )
  expect(pending).toMatchObject({ status: 'pending', credits: null, usage_json: null })
  const key = AGENT_LIMIT_PARAMS.userDailyCredits
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['1', key])
  await app.get(ParamService).invalidate(key)
  try {
    expect(await tenant(() => book.overDaily(ownerId))).toBeNull()
  } finally {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['0', key])
    await app.get(ParamService).invalidate(key)
  }
  const u = usageOf({ prompt_tokens: 4, completion_tokens: 2 })
  await tenant(() => Promise.all([a.settle(u), a.settle(u)]))
  await tenant(() => b.settle(usageOf({ prompt_tokens: 0, completion_tokens: 0 })))
  const totals = await ds.query(
    'SELECT id, credits, prompt_tokens, completion_tokens FROM agent_turn WHERE tenant_id = 1 AND id IN (?, ?) ORDER BY id',
    [parent.turn.id, child.turn.id],
  )
  expect(
    totals.map((r: any) => [r.credits, Number(r.prompt_tokens), Number(r.completion_tokens)]),
  ).toEqual([
    ['6.000000', 4, 2],
    ['6.000000', 4, 2],
  ])
  const [daily] = await ds.query(
    'SELECT SUM(calls) AS calls, SUM(credits) AS credits FROM agent_usage WHERE tenant_id = 1 AND provider_id = ?',
    [providerId],
  )
  expect(Number(daily.calls)).toBe(2)
  expect(daily.credits).toBe('6.000000')
})

it('settles an expired attempt as unknown once and fences a late original receipt', async () => {
  const invocation = await tenant(() => book.begin(ownerId, target()))
  receipts.push(invocation.id)
  invocation.release()
  await ds.query(
    'UPDATE agent_usage_entry SET lease_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ? AND tenant_id = 1',
    [invocation.id],
  )
  await book.recoverExpired()
  await book.recoverExpired()
  await expect(
    tenant(() => invocation.settle(usageOf({ prompt_tokens: 999, completion_tokens: 999 }))),
  ).rejects.toBeInstanceOf(InvocationLeaseLost)
  const [entry] = await ds.query(
    'SELECT status, credits, usage_json FROM agent_usage_entry WHERE id = ?',
    [invocation.id],
  )
  expect(entry).toMatchObject({ status: 'complete', credits: '1998.000000' })
  expect(entry.usage_json.promptTokens).toBe(999)
  const [daily] = await ds.query(
    'SELECT SUM(unpriced_calls) AS n FROM agent_usage WHERE tenant_id = 1 AND provider_id = ?',
    [providerId],
  )
  expect(Number(daily.n)).toBe(0)
})

it('reconciles a real numeric receipt racing the expiry sweep without adding another call or parent charge', async () => {
  const parent = await makeTurn()
  const child = await makeTurn({ parentThreadId: parent.thread.id })
  await tenant(() =>
    ds.getRepository(AgentTurn).update({ id: child.turn.id }, { parentTurnId: parent.turn.id }),
  )
  const invocation = await tenant(() =>
    book.begin(
      ownerId,
      { ...target(), model: 'settle-sweep-race' },
      { threadId: child.thread.id, turnId: child.turn.id },
    ),
  )
  await ds.query(
    'UPDATE agent_usage_entry SET lease_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE tenant_id = 1 AND id = ?',
    [invocation.id],
  )
  const usage = usageOf({
    prompt_tokens: 5,
    completion_tokens: 2,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 1 },
  })
  const raced = await Promise.allSettled([
    tenant(() => invocation.settle(usage)),
    book.recoverExpired(),
  ])
  expect(raced[0].status).toBe('rejected')
  expect((raced[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvocationLeaseLost)
  await expect(tenant(() => invocation.settle(usage))).rejects.toBeInstanceOf(InvocationLeaseLost)
  const [daily] = await ds.query(
    "SELECT calls, credits, unpriced_calls, cache_read_tokens FROM agent_usage WHERE tenant_id = 1 AND provider_id = ? AND model = 'settle-sweep-race'",
    [providerId],
  )
  expect(daily).toMatchObject({ calls: 1, credits: '7.000000', unpriced_calls: 0 })
  expect(Number(daily.cache_read_tokens)).toBe(0)
  const rows = await ds.query(
    'SELECT credits FROM agent_turn WHERE tenant_id = 1 AND id IN (?, ?)',
    [parent.turn.id, child.turn.id],
  )
  expect(rows.map((r: any) => r.credits)).toEqual(['7.000000', '7.000000'])
})

it('rolls back the entry, daily and both turn aggregates together when settlement storage fails', async () => {
  const parent = await makeTurn()
  const child = await makeTurn({ parentThreadId: parent.thread.id })
  await tenant(() =>
    ds.getRepository(AgentTurn).update({ id: child.turn.id }, { parentTurnId: parent.turn.id }),
  )
  const invocation = await tenant(() =>
    book.begin(
      ownerId,
      { ...target(), model: 'atomic-failure' },
      { threadId: child.thread.id, turnId: child.turn.id },
    ),
  )
  const original = EntityManager.prototype.query
  const failure = vi.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
    this: EntityManager,
    ...args: Parameters<EntityManager['query']>
  ) {
    if (String(args[0]).includes('INSERT INTO agent_usage'))
      throw new Error('fixture settlement failure')
    return original.apply(this, args)
  })
  try {
    await expect(
      tenant(() => invocation.settle(usageOf({ prompt_tokens: 4, completion_tokens: 2 }))),
    ).rejects.toThrow('fixture settlement failure')
  } finally {
    failure.mockRestore()
  }
  const [entry] = await ds.query('SELECT status, settled_at FROM agent_usage_entry WHERE id = ?', [
    invocation.id,
  ])
  expect(entry).toMatchObject({ status: 'pending', settled_at: null })
  const turns = await ds.query(
    'SELECT credits FROM agent_turn WHERE tenant_id = 1 AND id IN (?, ?)',
    [parent.turn.id, child.turn.id],
  )
  expect(turns.map((t: any) => t.credits)).toEqual(['0.000000', '0.000000'])
  await tenant(() => invocation.settle(usageOf({ prompt_tokens: 4, completion_tokens: 2 })))
  const rows = await ds.query(
    'SELECT credits FROM agent_turn WHERE tenant_id = 1 AND id IN (?, ?)',
    [parent.turn.id, child.turn.id],
  )
  expect(rows.map((t: any) => t.credits)).toEqual(['6.000000', '6.000000'])
})

it('keeps a reported receipt across abandonment and anchors correction to its original UTC day', async () => {
  const invocation = await tenant(() =>
    book.begin(ownerId, { ...target(), model: 'reported-before-crash' }),
  )
  const usage = usageOf({
    prompt_tokens: 7,
    completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 1 },
  })
  await tenant(() => invocation.observe(usage))
  invocation.release()
  await ds.query(
    "UPDATE agent_usage_entry SET usage_day = '2026-01-02', lease_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ? AND tenant_id = 1",
    [invocation.id],
  )
  await Promise.all([book.recoverExpired(), book.recoverExpired()])
  const [entry] = await ds.query(
    'SELECT status, credits, usage_json FROM agent_usage_entry WHERE id = ?',
    [invocation.id],
  )
  expect(entry).toMatchObject({ status: 'unknown', credits: '10.000000' })
  expect(entry.usage_json).toEqual(usage)
  const [daily] = await ds.query(
    'SELECT day, calls, credits, cache_read_tokens, reasoning_tokens FROM agent_usage WHERE tenant_id = 1 AND provider_id = ? AND model = ?',
    [providerId, 'reported-before-crash'],
  )
  expect(daily).toMatchObject({ day: '2026-01-02', calls: 1, credits: '10.000000' })
  expect(Number(daily.cache_read_tokens)).toBe(2)
  expect(Number(daily.reasoning_tokens)).toBe(1)
})

it('publishes only committed prefixes with offsets and revisions, and rejects stale item updates', async () => {
  const { thread, turn } = await makeTurn()
  const item = await tenant(() =>
    store.append(Number(thread.id), Number(turn.id), 'assistant', { text: '' }, 'running'),
  )
  const stale = { ...item }
  const send = vi.spyOn(app.get(RealtimeService), 'toUser')
  try {
    await tenant(() => store.checkpoint(ownerId, item, 'prefix'))
    const [row] = await ds.query(
      'SELECT payload, revision FROM agent_item WHERE id = ? AND tenant_id = 1',
      [item.id],
    )
    expect(row.payload.text).toBe('prefix')
    expect(row.revision).toBe(1)
    const invocation = await tenant(() =>
      book.begin(ownerId, target(), { threadId: Number(thread.id), turnId: Number(turn.id) }),
    )
    await ds.query(
      'UPDATE agent_usage_entry SET lease_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ? AND tenant_id = 1',
      [invocation.id],
    )
    await expect(
      tenant(() =>
        store.checkpoint(ownerId, item, 'prefix leaked', invocation.signal, invocation.fence),
      ),
    ).rejects.toBeInstanceOf(InvocationLeaseLost)
    invocation.release()
    await book.recoverExpired()
    const [fenced] = await ds.query(
      'SELECT payload, revision FROM agent_item WHERE tenant_id = 1 AND id = ?',
      [item.id],
    )
    expect(fenced.payload.text).toBe('prefix')
    expect(fenced.revision).toBe(1)
    expect(send.mock.calls.at(-1)?.[1]).toMatchObject({
      payload: { type: 'delta', itemId: Number(item.id), offset: 0, revision: 1, delta: 'prefix' },
    })
    await expect(
      tenant(() => store.update(stale, { payload: { text: 'stale' } })),
    ).rejects.toBeInstanceOf(StaleItem)
  } finally {
    send.mockRestore()
  }
})

it('stops a recovered uncertain write, retains the evidence and expires previously queued intent', async () => {
  const { thread, turn } = await makeTurn({ approvalMode: 'trust' })
  await tenant(() =>
    store.append(
      Number(thread.id),
      Number(turn.id),
      'tool_call',
      {
        callId: 'uncertain-write',
        tool: 'test.changed.write',
        title: 'Change',
        source: 'local',
        kind: 'write',
        args: {},
      },
      'running',
    ),
  )
  await tenant(() =>
    store.append(Number(thread.id), null, 'user', { text: 'Do the next write.' }, 'pending'),
  )
  const fake = new FakeChatModel([{ text: 'Must not be called.' }])
  const connect = vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(fake)
  try {
    await tenant(() => app.get(TurnRunner).run(Number(turn.id)))
    const saved = await tenant(() =>
      ds.getRepository(AgentThread).findOneByOrFail({ id: thread.id }),
    )
    expect(saved).toMatchObject({ recoveryRequired: true, recoveryRevision: 1 })
    const ended = await tenant(() => ds.getRepository(AgentTurn).findOneByOrFail({ id: turn.id }))
    expect(ended).toMatchObject({ status: 'failed', errorCode: Err.AGENT_RECOVERY_REQUIRED.code })
    expect(fake.requests).toHaveLength(0)
    const items = await tenant(() => ds.getRepository(AgentItem).findBy({ threadId: thread.id }))
    expect(items.find((i) => i.kind === 'tool_result')?.payload).toMatchObject({
      ok: false,
      error: { code: 'interrupted' },
    })
    expect(items.find((i) => i.kind === 'user' && i.turnId === null)?.status).toBe('expired')
  } finally {
    connect.mockRestore()
  }
})

it('keeps permanent draft tombstones and never purges unchecked temporary evidence', async () => {
  const draft = randomUUID()
  const completed = await makeTurn({
    temporary: true,
    clientDraftId: draft,
    clientDraftHash: 'f'.repeat(64),
    title: 'Private text',
    summary: 'Private summary',
    trusted: ['private target'],
  })
  const legacy = await makeTurn({ temporary: true })
  const risk = await makeTurn({ temporary: true, recoveryRequired: true, recoveryRevision: 1 })
  await tenant(() =>
    ds.getRepository(AgentTurn).update({ id: completed.turn.id }, { status: 'completed' }),
  )
  await tenant(() =>
    ds.getRepository(AgentTurn).update({ id: legacy.turn.id }, { status: 'completed' }),
  )
  await tenant(() => ds.getRepository(AgentTurn).update({ id: risk.turn.id }, { status: 'failed' }))
  await tenant(() => app.get(TurnQueue).dropTemporary(ownerId, 0))
  const [tombstone] = await ds.query(
    'SELECT client_draft_id, client_draft_hash, title, summary, trusted, deleted_at FROM agent_thread WHERE tenant_id = 1 AND id = ?',
    [completed.thread.id],
  )
  expect(tombstone).toMatchObject({
    client_draft_id: draft,
    client_draft_hash: null,
    title: '',
    summary: null,
    trusted: null,
  })
  expect(tombstone.deleted_at).not.toBeNull()
  expect(
    await ds.query('SELECT id FROM agent_item WHERE tenant_id = 1 AND thread_id = ?', [
      completed.thread.id,
    ]),
  ).toEqual([])
  expect(
    await ds.query('SELECT id FROM agent_thread WHERE tenant_id = 1 AND id = ?', [
      legacy.thread.id,
    ]),
  ).toEqual([])
  expect(
    await tenant(() => ds.getRepository(AgentThread).findOneByOrFail({ id: risk.thread.id })),
  ).toMatchObject({ recoveryRequired: true, temporary: true })
  expect(
    await tenant(() => ds.getRepository(AgentItem).countBy({ threadId: risk.thread.id })),
  ).toBeGreaterThan(0)
})

it('holds the real local work lease after timeout and refuses early acknowledgement until the work settles', async () => {
  const { thread, turn } = await makeTurn()
  let release!: () => void
  let effects = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  app.get(McpRegistry).add(
    {
      name: 'test.recovery.slow',
      title: 'Slow write',
      description: 'A gated write',
      kind: 'write',
      perm: null,
      input: z.object({ id: z.number() }),
      timeoutMs: 25,
    },
    async () => {
      await gate
      effects++
      return { ok: true }
    },
  )
  await tenant(() =>
    store.tx(async (w) => {
      await w.append(
        Number(thread.id),
        Number(turn.id),
        'tool_call',
        {
          callId: 'slow',
          tool: 'test.recovery.slow',
          title: 'Slow write',
          source: 'local',
          kind: 'write',
          args: { id: Number(thread.id) },
        },
        'pending',
      )
      await w.append(
        Number(thread.id),
        Number(turn.id),
        'approval',
        {
          callId: 'slow',
          tool: 'test.recovery.slow',
          title: 'Slow write',
          args: { id: Number(thread.id) },
          sources: [],
        },
        'approved',
      )
    }),
  )
  const runner = app.get(TurnRunner)
  const running = tenant(() => runner.run(Number(turn.id)))
  const token = (await signIn(app)).accessToken
  const acknowledge = () =>
    request(app.getHttpServer())
      .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
      .set(bearer(token))
      .send({ revision: 1 })
  try {
    await until(
      async () =>
        (await tenant(() => ds.getRepository(AgentTurn).findOneByOrFail({ id: turn.id })))
          .status === 'failed',
    )
    expect(await app.get(REDIS).exists(redisKey('lock', `agent-turn-${turn.id}`))).toBe(1)
    const busy = await acknowledge().expect(409)
    expect(busy.body.code).toBe(Err.AGENT_RECOVERY_BUSY.code)
    expect(effects).toBe(0)
  } finally {
    release()
    await running
  }
  expect(effects).toBe(1)
  await acknowledge().expect(200)
  expect(
    (await tenant(() => ds.getRepository(AgentThread).findOneByOrFail({ id: thread.id })))
      .recoveryRequired,
  ).toBe(false)
  expect(effects).toBe(1)
})

it.each(['output', 'business-error'] as const)(
  'requires verification when a committed local write loses its trusted result through %s',
  async (kind) => {
    const { thread, turn } = await makeTurn()
    let effects = 0
    const name = `test.recovery.${kind === 'output' ? 'shape' : 'error'}`
    app.get(McpRegistry).add(
      {
        name,
        title: 'Change a record',
        description: 'Commits before producing a result',
        kind: 'write',
        perm: null,
        input: z.object({}),
        ...(kind === 'output' && { output: z.object({ value: z.string() }) }),
      },
      () => {
        effects++
        if (kind === 'business-error') throw new BizError(Err.CONFLICT)
        return { invalid: true }
      },
    )
    await tenant(() =>
      store.tx(async (w) => {
        await w.append(
          Number(thread.id),
          Number(turn.id),
          'tool_call',
          {
            callId: 'committed',
            tool: name,
            title: 'Change record',
            source: 'local',
            kind: 'write',
            args: {},
          },
          'pending',
        )
        await w.append(
          Number(thread.id),
          Number(turn.id),
          'approval',
          { callId: 'committed', tool: name, title: 'Change record', args: {}, sources: [] },
          'approved',
        )
      }),
    )
    await tenant(() => app.get(TurnRunner).run(Number(turn.id)))
    expect(effects).toBe(1)
    expect(
      await tenant(() => ds.getRepository(AgentThread).findOneByOrFail({ id: thread.id })),
    ).toMatchObject({ recoveryRequired: true, recoveryRevision: 1 })
    expect(
      await tenant(() => ds.getRepository(AgentTurn).findOneByOrFail({ id: turn.id })),
    ).toMatchObject({ status: 'failed', errorCode: Err.AGENT_RECOVERY_REQUIRED.code })
  },
)

it('retains real image usage without a usable image and blocks another generation', async () => {
  await ds.query('UPDATE agent_provider SET models = ? WHERE id = ?', [
    JSON.stringify([
      {
        id: 'restart-model',
        label: 'Restart model',
        contextWindow: 64000,
        pricing: TEST_AGENT_PRICING,
        image: true,
      },
    ]),
    providerId,
  ])
  const actual = new OpenAiChatModel({
    baseUrl: endpoint,
    apiKey: null,
    models: [{ id: 'restart-model', reasoning: false }],
    retries: 0,
  })
  class ImageModel extends FakeChatModel {
    image(req: ImageRequest) {
      return actual.image(req)
    }
  }
  const fake = new ImageModel([
    { toolCalls: [{ name: 'image.generate', args: { prompt: 'A generic test square' } }] },
    { toolCalls: [{ name: 'image.generate', args: { prompt: 'Try again' } }] },
  ])
  const connect = vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(fake)
  try {
    const { thread, turn } = await makeTurn()
    await tenant(() => app.get(TurnRunner).run(Number(turn.id)))
    expect(imageRequests).toBe(1)
    expect(fake.requests).toHaveLength(1)
    expect(
      await tenant(() => ds.getRepository(AgentThread).findOneByOrFail({ id: thread.id })),
    ).toMatchObject({ recoveryRequired: true })
    const [entry] = await ds.query(
      "SELECT usage_json, credits FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ? AND kind = 'image'",
      [turn.id],
    )
    expect(entry.usage_json).toMatchObject({
      promptTokens: 7,
      completionTokens: 2,
      usageReported: true,
    })
    expect(entry.credits).toBe('9.000000')
  } finally {
    connect.mockRestore()
    await ds.query('UPDATE agent_provider SET models = ? WHERE id = ?', [
      JSON.stringify([
        {
          id: 'restart-model',
          label: 'Restart model',
          contextWindow: 64000,
          pricing: TEST_AGENT_PRICING,
        },
      ]),
      providerId,
    ])
  }
})

it('commits failed terminal states for a checkpointed answer and reasoning when the user cancels', async () => {
  const { thread, turn } = await makeTurn()
  let seen = false
  class SlowModel extends FakeChatModel {
    override async *stream(req: Parameters<FakeChatModel['stream']>[0]) {
      yield { type: 'reasoning' as const, delta: 'durable thought' }
      yield { type: 'text' as const, delta: 'durable text' }
      seen = true
      await new Promise<void>((_resolve, reject) =>
        req.signal!.addEventListener('abort', () => reject(req.signal!.reason), { once: true }),
      )
    }
  }
  const connect = vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(new SlowModel([]))
  const running = tenant(() => app.get(TurnRunner).run(Number(turn.id)))
  try {
    await until(async () => {
      const rows = await ds.query(
        "SELECT payload FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind IN ('assistant', 'reasoning')",
        [turn.id],
      )
      return seen && rows.length === 2 && rows.every((r: any) => r.payload.text)
    })
    const { TURN_CONTROL } = await import('../../src/core/agent/agent-ports.js')
    const { loadPrincipal } = await import('../../src/core/agent/automation/pre-approval.js')
    const principal = await tenant(() => loadPrincipal(app.get(PermVersion), ownerId))
    await tenant(() => app.get(TURN_CONTROL).cancel(principal!, Number(thread.id)))
    await running
    const rows = await ds.query(
      "SELECT status, payload FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind IN ('assistant', 'reasoning') ORDER BY seq",
      [turn.id],
    )
    expect(rows.map((r: any) => [r.status, r.payload.text])).toEqual([
      ['failed', 'durable thought'],
      ['failed', 'durable text'],
    ])
  } finally {
    connect.mockRestore()
  }
})

it(`keeps a streamed prefix and unknown billing through forced process termination, then drains ${shutdownMode === 'ipc' ? 'cooperative IPC' : 'SIGTERM'} within its deadline`, async () => {
  expect(existsSync(new URL('../../dist/core/agent/runtime/usage-book.js', import.meta.url))).toBe(
    true,
  )
  mode = 'hold'
  const { thread, turn } = await makeTurn()
  const first = await startChild()
  first.send({ command: 'run', turnId: Number(turn.id) })
  await until(async () => {
    const [row] = await ds.query(
      'SELECT payload FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind = ? AND status = ?',
      [turn.id, 'assistant', 'running'],
    )
    return row?.payload.text === 'durable prefix'
  })
  const [pending] = await ds.query(
    'SELECT id, status, usage_json FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ?',
    [turn.id],
  )
  expect(pending).toMatchObject({ status: 'pending', usage_json: null })
  await stopChild(first, 'SIGKILL')
  // 不伪造租约失效：等待真实 Redis TTL 和数据库 UTC lease_until。
  await until(async () => {
    const held = await app.get(REDIS).exists(redisKey('lock', `agent-turn-${turn.id}`))
    const [row] = await ds.query(
      'SELECT lease_until <= UTC_TIMESTAMP(3) AS expired FROM agent_usage_entry WHERE id = ? AND tenant_id = 1',
      [pending.id],
    )
    return !held && Number(row.expired) === 1
  }, 36_000)
  mode = 'finish'
  const second = await startChild()
  second.send({ command: 'run', turnId: Number(turn.id) })
  await until(async () => {
    const [row] = await ds.query('SELECT status FROM agent_turn WHERE id = ? AND tenant_id = 1', [
      turn.id,
    ])
    return row?.status === 'completed'
  })
  const rows = await ds.query(
    'SELECT status, payload FROM agent_item WHERE tenant_id = 1 AND thread_id = ? AND kind = ? ORDER BY seq',
    [thread.id, 'assistant'],
  )
  expect(rows.map((r: any) => [r.status, r.payload.text])).toEqual([
    ['failed', 'durable prefix'],
    ['done', 'Recovered answer.'],
  ])
  const entries = await ds.query(
    'SELECT status, credits FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ? ORDER BY id',
    [turn.id],
  )
  expect(entries).toEqual([
    { status: 'unknown', credits: null },
    { status: 'complete', credits: '6.000000' },
  ])
  const [total] = await ds.query(
    'SELECT credits, unpriced_calls FROM agent_turn WHERE tenant_id = 1 AND id = ?',
    [turn.id],
  )
  expect(total).toMatchObject({ credits: '6.000000', unpriced_calls: 1 })
  expect(upstreamCalls).toBe(2)
  mode = 'receipt'
  const metered = await makeTurn()
  second.send({ command: 'run', turnId: Number(metered.turn.id) })
  const observed = await until(async () => {
    const [row] = await ds.query(
      'SELECT id, usage_json FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ?',
      [metered.turn.id],
    )
    return row?.usage_json?.promptTokens === 9 ? row : null
  })
  await stopChild(second, 'SIGKILL')
  await until(async () => {
    const held = await app.get(REDIS).exists(redisKey('lock', `agent-turn-${metered.turn.id}`))
    const [row] = await ds.query(
      'SELECT lease_until <= UTC_TIMESTAMP(3) AS expired FROM agent_usage_entry WHERE id = ? AND tenant_id = 1',
      [observed.id],
    )
    return !held && Number(row.expired) === 1
  }, 36_000)
  mode = 'finish'
  const third = await startChild()
  third.send({ command: 'run', turnId: Number(metered.turn.id) })
  await until(async () => {
    const [row] = await ds.query('SELECT status FROM agent_turn WHERE id = ? AND tenant_id = 1', [
      metered.turn.id,
    ])
    return row?.status === 'completed'
  })
  const meteredEntries = await ds.query(
    'SELECT status, credits, usage_json FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ? ORDER BY id',
    [metered.turn.id],
  )
  expect(meteredEntries.map((e: any) => [e.status, e.credits])).toEqual([
    ['unknown', '12.000000'],
    ['complete', '6.000000'],
  ])
  expect(meteredEntries[0].usage_json.promptTokens).toBe(9)
  const [meteredTotal] = await ds.query(
    'SELECT credits, unpriced_calls FROM agent_turn WHERE id = ? AND tenant_id = 1',
    [metered.turn.id],
  )
  expect(meteredTotal).toMatchObject({ credits: '18.000000', unpriced_calls: 0 })
  mode = 'hold'
  const next = await makeTurn()
  third.send({ command: 'run', turnId: Number(next.turn.id) })
  await until(async () => {
    const [row] = await ds.query(
      'SELECT payload FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind = ?',
      [next.turn.id, 'assistant'],
    )
    return row?.payload.text === 'durable prefix'
  })
  const since = Date.now()
  await stopChild(third, 'SIGTERM')
  const shutdownMs = Date.now() - since
  expect(shutdownMs).toBeLessThan(8500)
  const [closedInvocation] = await ds.query(
    'SELECT status FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ?',
    [next.turn.id],
  )
  expect(closedInvocation.status).not.toBe('pending')
  const [closedItem] = await ds.query(
    "SELECT status FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind = 'assistant'",
    [next.turn.id],
  )
  expect(closedItem.status).toBe('failed')
  console.info(
    'Recovery process proof',
    JSON.stringify({
      shutdownMode,
      shutdownMs,
      upstreamCalls,
      durablePrefix: true,
      reportedUsageSurvivedKill: true,
    }),
  )
  const [saved] = await ds.query(
    'SELECT payload FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind = ?',
    [next.turn.id, 'assistant'],
  )
  expect(saved.payload.text).toBe('durable prefix')
}, 120_000)

it('does not repeat a real committed write after its process dies before returning a tool result', async () => {
  const { thread, turn } = await makeTurn()
  const addWrite = (turnId: number) =>
    tenant(() =>
      store.tx(async (w) => {
        await w.append(
          Number(thread.id),
          turnId,
          'tool_call',
          {
            callId: `write-${turnId}`,
            tool: 'test.recovery.write',
            title: 'Change fixture',
            source: 'local',
            kind: 'write',
            args: { id: Number(thread.id) },
          },
          'pending',
        )
        await w.append(
          Number(thread.id),
          turnId,
          'approval',
          {
            callId: `write-${turnId}`,
            tool: 'test.recovery.write',
            title: 'Change fixture',
            args: { id: Number(thread.id) },
            sources: [],
          },
          'approved',
        )
      }),
    )
  await addWrite(Number(turn.id))
  const first = await startChild()
  first.send({ command: 'run', turnId: Number(turn.id) })
  await until(async () => {
    const [row] = await ds.query(
      'SELECT summary_seq FROM agent_thread WHERE tenant_id = 1 AND id = ?',
      [thread.id],
    )
    return Number(row.summary_seq) === 1
  })
  await stopChild(first, 'SIGKILL')
  await until(
    async () => !(await app.get(REDIS).exists(redisKey('lock', `agent-turn-${turn.id}`))),
    36_000,
  )
  const second = await startChild()
  second.send({ command: 'run', turnId: Number(turn.id) })
  await until(async () => {
    const [row] = await ds.query(
      'SELECT recovery_required FROM agent_thread WHERE tenant_id = 1 AND id = ?',
      [thread.id],
    )
    return !!row.recovery_required
  })
  await until(async () => {
    const [row] = await ds.query('SELECT status FROM agent_turn WHERE tenant_id = 1 AND id = ?', [
      turn.id,
    ])
    return row.status === 'failed'
  })
  const next = await tenant(() =>
    store.tx(async (w) => {
      const t = await w.createTurn(Number(thread.id), ownerId)
      await w.append(
        Number(thread.id),
        Number(t.id),
        'user',
        { text: 'Try changing it again.' },
        'done',
      )
      return t
    }),
  )
  await addWrite(Number(next.id))
  second.send({ command: 'run', turnId: Number(next.id) })
  await until(async () => {
    const [row] = await ds.query('SELECT status FROM agent_turn WHERE tenant_id = 1 AND id = ?', [
      next.id,
    ])
    return row.status === 'failed'
  })
  const [row] = await ds.query(
    'SELECT summary_seq, recovery_required, recovery_revision FROM agent_thread WHERE tenant_id = 1 AND id = ?',
    [thread.id],
  )
  expect(row).toMatchObject({ summary_seq: 1, recovery_required: 1, recovery_revision: 1 })
  const [result] = await ds.query(
    "SELECT payload FROM agent_item WHERE tenant_id = 1 AND turn_id = ? AND kind = 'tool_result'",
    [turn.id],
  )
  expect(result.payload).toMatchObject({ ok: false, error: { code: 'interrupted' } })
  await stopChild(second, 'SIGTERM')
}, 65_000)
