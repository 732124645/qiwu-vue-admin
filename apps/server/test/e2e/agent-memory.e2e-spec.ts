import { TEST_AGENT_PRICING, clearAgentUsage } from '../setup/agent-pricing.js'
import assert from 'node:assert/strict'
// Agent memories (see docs/agent.md): each user's own, listed, added, changed, deleted and forgotten all at once
// (current password required); secrets are masked before anything is stored and the same content is kept once;
// another user's and another tenant's memories are 404. In a chat with memory on, the most relevant memories
// reach the model as a user message (never the system prompt) and are marked used, /status reads them without a
// trace; temporary chats and chats with memory off neither read nor write them. Memory text and chat messages
// never reach the action log. `memory.save` is a write tool only a person approves (an administrator's auto or
// review policy and the approval reviewers do not count): it stops for approval, saves only once approved and
// only while the chat still uses memory; refused saves retain their reason and pause further writes. The background distiller reads
// only the user's own messages (no answers, tool output or followed suggestions) of ordinary chats (no
// subagent, automation or batch ones), masks, keeps daily caps, records usage, stops while paused, skips a full
// memory without a model call and never distils the same part twice, a fork included. No session 401, no
// agent.chat.use 403, invalid bodies 400. A platform user inside another tenant keeps reading and writing the
// personal agent settings (memories, profiles, notifications, automations) in their own tenant. Multi-tenancy
// on.
import { Injectable, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AGENT_PAUSED_PARAM, AGENT2_PARAMS, agentPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import {
  AgentApprovalReviewer,
  type AgentReviewCall,
  type AgentReviewVerdict,
} from '../../src/core/agent/agent-ports.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import {
  AgentMemoryExtractor,
  EXTRACT_CALLS_PER_DAY,
  EXTRACT_PER_DAY,
} from '../../src/core/agent/memory/memory-extract.js'
import { MEMORY_MAX } from '../../src/core/agent/memory/memory.service.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import type { Session } from '../../src/core/auth/token.service.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  addRow,
  addUser,
  createTenant,
  inTenant1,
  type PeopledTenant,
  TENANT_PASSWORD,
} from '../setup/tenants.js'

const PREFIX = 'e2e-agmem-'
const URL = '/api/agent/memories'
const API_KEY = 'sk-' + 'abcdefghijklmnopqrstuvwx1234'
const SECRET = `my api key: ${API_KEY} and the password is hunter22`

let app: NestExpressApplication
let ds: DataSource
let providerId = 0
let fake = new FakeChatModel([])
let other: PeopledTenant
const users: Record<'member' | 'peer' | 'reader' | 'full', { id: number; token: string }> =
  {} as never
let otherMember = ''
const roleIds: number[] = []
const threads: number[] = []

const http = () => request(app.getHttpServer())
const script = (...turns: FakeTurn[]) => (fake = new FakeChatModel(turns))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const as = (who: keyof typeof users) => bearer(users[who].token)
const toolNames = (i: number) => (fake.requests[i]!.tools ?? []).map((t) => t.name)
const extractor = () => app.get(AgentMemoryExtractor)
const day = () => new Date().toISOString().slice(0, 10)

/** A test reviewer: approves every write it is asked about while `approveAll` is on, and notes the tools. */
let approveAll = false
const reviewedTools: string[] = []
@Injectable()
@AgentApprovalReviewer({ order: 1 })
class ApproveEverything {
  async review(_ctx: unknown, call: AgentReviewCall): Promise<AgentReviewVerdict | null> {
    reviewedTools.push(call.tool)
    return approveAll ? { verdict: 'approve', reason: 'looks fine', by: 'review' } : null
  }
}
@Module({ providers: [ApproveEverything] })
class TestReviewModule {}

async function setPolicy(name: string, policy: string | null) {
  await ds.query(
    `INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES (?, 1, ?) AS n
      ON DUPLICATE KEY UPDATE agent_policy = n.agent_policy, enabled = n.enabled`,
    [name, policy],
  )
}

/** The pending approval card of a thread. */
async function pendingCard(threadId: number) {
  const [card] = await ds.query<{ id: number; payload: string | Record<string, unknown> }[]>(
    "SELECT id, payload FROM agent_item WHERE thread_id = ? AND kind = 'approval' AND status = 'pending'",
    [threadId],
  )
  if (!card) return undefined
  return {
    id: card.id,
    payload: (typeof card.payload === 'string' ? JSON.parse(card.payload) : card.payload) as Record<
      string,
      unknown
    >,
  }
}

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

/** A role of tenant `tenantId` holding `perms`, and a user holding it. */
async function userWith(name: string, perms: string[], tenantId = 1): Promise<number> {
  const { insertId } = await ds.query<{ insertId: number }>(
    "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', ?)",
    [`${PREFIX}${name}`, `${PREFIX}${name}`, tenantId],
  )
  if (tenantId === 1) roleIds.push(Number(insertId))
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [Number(insertId), tenantId, perms],
  )
  return addUser(app, tenantId, `${PREFIX}${name}`, { roleId: Number(insertId) })
}

/** The user's memory rows, oldest first. */
async function rows(who: keyof typeof users) {
  return ds.query<
    {
      id: number
      content: string
      source: string
      source_thread_id: number | null
      last_used_at: Date | null
    }[]
  >(
    'SELECT id, content, source, source_thread_id, last_used_at FROM agent_memory WHERE tenant_id = 1 AND user_id = ? ORDER BY id',
    [users[who].id],
  )
}

async function clear(who: keyof typeof users) {
  await ds.query('DELETE FROM agent_memory WHERE tenant_id = 1 AND user_id = ?', [users[who].id])
}

async function remember(who: keyof typeof users, content: string): Promise<number> {
  const res = await http().post(URL).set(as(who)).send({ content })
  assert.equal(
    res.status,
    201,
    JSON.stringify({
      status: res.status,
      code: res.body?.code,
      hasPermVersion: !!res.headers['x-perm-ver'],
    }),
  )
  assert.equal(
    Number.isSafeInteger(res.body.data.id),
    true,
    JSON.stringify({
      code: res.body.code,
      id: res.body.data.id,
      fields: Object.keys(res.body.data),
    }),
  )
  return res.body.data.id as number
}

/** A memory written straight into the table (setup without the API's duplicate-submit window). */
const stored = (who: keyof typeof users, content: string) =>
  addRow(ds, 1, 'agent_memory', { user_id: users[who].id, content, source: 'manual' })

/** A thread of `who` (plain SQL), recorded for clean-up. */
async function thread(who: keyof typeof users, extra: Record<string, unknown> = {}) {
  const id = await addRow(ds, 1, 'agent_thread', {
    user_id: users[who].id,
    title: '',
    provider_id: providerId,
    model: 'mm1',
    ...extra,
  })
  threads.push(id)
  return id
}

async function settled(turnId: number, want = ['completed', 'failed', 'cancelled', 'waiting']) {
  for (const until = Date.now() + 15_000; ; await sleep(40)) {
    const [t] = await ds.query<{ status: string }[]>('SELECT status FROM agent_turn WHERE id = ?', [
      turnId,
    ])
    if (t && want.includes(t.status)) return t.status
    if (Date.now() > until) throw new Error(`turn ${turnId} is still ${t?.status}`)
  }
}

async function start(who: keyof typeof users, threadId: number, text: string) {
  const res = await http()
    .post(`/api/agent/threads/${threadId}/messages`)
    .set(as(who))
    .send({ text })
  expect(res.status).toBe(201)
  return res.body.data.id as number
}

/** The context message about memories in request `i`, if any. */
const memoryPart = (i: number) =>
  fake.requests[i]!.messages.find(
    (m) => m.role === 'user' && String(m.content).startsWith('[Context "memory"'),
  )

/** An item of a thread (plain SQL), as the runtime writes them. */
const item = (
  threadId: number,
  seq: number,
  kind: string,
  payload: object,
  status: string | null = null,
) =>
  addRow(ds, 1, 'agent_item', {
    thread_id: threadId,
    turn_id: null,
    seq,
    kind,
    status,
    payload,
    text: (payload as { text?: string }).text ?? null,
  })

/** An idle thread (last active an hour ago) with the given items. */
async function idleThread(who: keyof typeof users, extra: Record<string, unknown> = {}) {
  return thread(who, { last_active_at: new Date(Date.now() - 3600_000), ...extra })
}

const distil = (who: keyof typeof users, threadId: number) =>
  inTenant1(() => extractor().thread({ id: threadId, tenantId: 1, userId: users[who].id }))

beforeAll(async () => {
  const env = { ...process.env, APP_MULTI_TENANT: 'true', APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({
    imports: [AppModule, AgentModule, TestReviewModule],
  })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())

  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: `${PREFIX}provider`,
    base_url: 'http://127.0.0.1:9/v1',
    models: [
      {
        id: 'mm1',
        label: 'mm1',
        reasoning: false,
        pricing: TEST_AGENT_PRICING,
        contextWindow: 64_000,
      },
    ],
    enabled: 1,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)

  const chat = [agentPerms.chat.use]
  for (const who of ['member', 'peer', 'reader', 'full'] as const) {
    const id =
      who === 'reader' ? await addUser(app, 1, `${PREFIX}${who}`) : await userWith(who, chat)
    users[who] = { id, token: (await signIn(app, `${PREFIX}${who}`)).accessToken }
  }
  other = await createTenant(app, { users: true })
  await userWith('b-member', chat, other.id)
  otherMember = (await signIn(app, `${PREFIX}b-member`, {}, other.id)).accessToken
})

afterAll(async () => {
  if (app) {
    const keys = [
      ...threads.map((id) => redisKey('agentMemoryMark', id)),
      ...Object.values(users).map((u) => redisKey('agentMemoryMark', 'calls', u.id, day())),
    ]
    if (keys.length) await app.get<Redis>(REDIS).unlink(keys)
  }
  if (ds) {
    await ds.query("DELETE FROM cfg_mcp_tool WHERE name = 'memory.save'")
    await setParam(AGENT2_PARAMS.memoryExtract, 'false').catch(() => undefined)
    await setParam(AGENT_PAUSED_PARAM, 'false').catch(() => undefined)
    const ids = Object.values(users).map((u) => u.id)
    if (ids.length) {
      const all = await ds.query<{ id: number }[]>(
        'SELECT id FROM agent_thread WHERE tenant_id = 1 AND user_id IN (?)',
        [ids],
      )
      const tids = [...new Set([...threads, ...all.map((t) => t.id)])]
      if (tids.length) {
        await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [tids])
        await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [tids])
        await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [tids])
      }
      await ds.query('DELETE FROM agent_memory WHERE tenant_id = 1 AND user_id IN (?)', [ids])
      await clearAgentUsage(ds, ids)
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
    if (providerId) await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
  }
  await other?.dispose()
  await app?.close()
})

beforeEach(async () => {
  approveAll = false
  reviewedTools.length = 0
  await ds.query("DELETE FROM cfg_mcp_tool WHERE name = 'memory.save'")
  await setParam(AGENT_PAUSED_PARAM, 'false')
  await setParam(AGENT2_PARAMS.memoryExtract, 'false')
})

describe('my memories', () => {
  it('adds with secrets masked, lists, searches, changes and deletes; the same content once', async () => {
    await clear('member')
    const id = await remember('member', SECRET)
    const [row] = await rows('member')
    expect(row).toMatchObject({ id, source: 'manual', source_thread_id: null })
    expect(row!.content).not.toContain(API_KEY)
    expect(row!.content).not.toContain('hunter22')
    expect(row!.content).toContain('***')
    await remember('member', '我的密码是 abc12345，常用工号 A1')
    expect((await rows('member')).at(-1)!.content).toBe('我的密码是 ***，常用工号 A1')

    await remember('member', 'Prefers green tea')
    await http().post(URL).set(as('member')).send({ content: '  prefers GREEN tea ' }).expect(409)
    const page = await http().get(URL).set(as('member')).query({ keyword: 'tea' }).expect(200)
    expect(page.body.data).toMatchObject({ total: 1, items: [{ content: 'Prefers green tea' }] })

    const changed = await http()
      .put(`${URL}/${id}`)
      .set(as('member'))
      .send({ content: 'token=abcd1234 works in sales' })
    expect(changed.status).toBe(200)
    expect(changed.body.data.content).toBe('token=*** works in sales')
    await http()
      .put(`${URL}/${id}`)
      .set(as('member'))
      .send({ content: 'prefers green tea' })
      .expect(409)
    await http().delete(`${URL}/${id}`).set(as('member')).expect(200)
    expect((await rows('member')).map((r) => r.id)).not.toContain(id)
    // one memory is one line
    await remember('member', 'likes\n\n  jasmine\ttea')
    expect((await rows('member')).at(-1)!.content).toBe('likes jasmine tea')
  })

  it('keeps memory text and chat messages out of the action log', async () => {
    await clear('member')
    const res = await http()
      .post(URL)
      .set(as('member'))
      .send({ content: 'LOGGED-NOT works nights' })
    expect(res.status).toBe(201)
    const log = await logOf(ds, String(res.headers['x-request-id']))
    expect(log).not.toBeNull()
    expect(JSON.stringify([log.params, log.result])).not.toContain('LOGGED-NOT')
    const changed = await http()
      .put(`${URL}/${res.body.data.id}`)
      .set(as('member'))
      .send({ content: 'LOGGED-NOT works days' })
    const changeLog = await logOf(ds, String(changed.headers['x-request-id']))
    expect(JSON.stringify([changeLog.params, changeLog.result])).not.toContain('LOGGED-NOT')

    const id = await thread('member')
    script({ text: 'Fine.' })
    const sent = await http()
      .post(`/api/agent/threads/${id}/messages`)
      .set(as('member'))
      .send({ text: 'LOGGED-NOT my message' })
    expect(sent.status).toBe(201)
    await settled(sent.body.data.id as number)
    const sendLog = await logOf(ds, String(sent.headers['x-request-id']))
    expect(sendLog).not.toBeNull()
    expect(JSON.stringify([sendLog.params, sendLog.result])).not.toContain('LOGGED-NOT')
  })

  it('answers 401, 403, 400, and 404 for another user’s or another tenant’s memory', async () => {
    await http().get(URL).expect(401)
    await http().get(URL).set(as('reader')).expect(403)
    await http().post(URL).set(as('reader')).send({ content: 'x' }).expect(403)
    await http().post(URL).set(as('member')).send({ content: '   ' }).expect(400)
    await http().post(`${URL}/forget-all`).set(as('member')).send({}).expect(400)
    const id = await remember('member', `${PREFIX}private note`)
    const foreign = await http().put(`${URL}/${id}`).set(as('peer')).send({ content: 'mine now' })
    assert.equal(
      foreign.status,
      404,
      JSON.stringify({ id, code: foreign.body.code, message: foreign.body.msg }),
    )
    await http().delete(`${URL}/${id}`).set(as('peer')).expect(404)
    const peerList = await http().get(URL).set(as('peer')).expect(200)
    expect(JSON.stringify(peerList.body.data)).not.toContain('private note')
    // another tenant
    await http().put(`${URL}/${id}`).set(bearer(otherMember)).send({ content: 'x' }).expect(404)
    await http().delete(`${URL}/${id}`).set(bearer(otherMember)).expect(404)
    const theirs = await http().get(URL).set(bearer(otherMember)).expect(200)
    expect(JSON.stringify(theirs.body.data)).not.toContain('private note')
    expect((await rows('member')).some((r) => r.id === id)).toBe(true)
  })

  it('keeps the personal agent settings of a platform user inside another tenant in their own tenant', async () => {
    const root = await signIn(app)
    const key = redisKey('authSession', root.session.sid)
    const redis = app.get<Redis>(REDIS)
    const session = JSON.parse((await redis.get(key))!) as Session
    session.actingTenantId = other.id
    session.actingUntil = Date.now() + 3_600_000
    await redis.set(key, JSON.stringify(session), { KEEPTTL: true })
    const token = bearer(root.accessToken)
    try {
      const res = await http()
        .post(URL)
        .set(token)
        .send({ content: `${PREFIX}root note` })
      expect(res.status).toBe(201)
      expect(
        await ds.query('SELECT tenant_id FROM agent_memory WHERE id = ?', [res.body.data.id]),
      ).toEqual([{ tenant_id: 1 }])
      const mine = await http().get(URL).set(token).expect(200)
      expect(JSON.stringify(mine.body.data)).toContain(`${PREFIX}root note`)
      for (const path of [
        '/api/agent/profiles',
        '/api/agent/notify-settings',
        '/api/agent/automations',
      ])
        await http().get(path).set(token).expect(200)
    } finally {
      await ds.query('DELETE FROM agent_memory WHERE tenant_id = 1 AND user_id = ?', [
        root.session.userId,
      ])
    }
  })

  it('forgets everything only with the right current password', async () => {
    await clear('peer')
    await clear('member')
    await stored('member', 'Someone else entirely')
    await remember('peer', 'Likes short answers')
    await remember('peer', 'Works in finance')
    await http()
      .post(`${URL}/forget-all`)
      .set(as('peer'))
      .send({ currentPassword: 'wrong-password' })
      .expect(400)
    expect(await rows('peer')).toHaveLength(2)
    const res = await http()
      .post(`${URL}/forget-all`)
      .set(as('peer'))
      .send({ currentPassword: TENANT_PASSWORD })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ removed: 2 })
    expect(await rows('peer')).toHaveLength(0)
    // another user's memories stay
    expect((await rows('member')).map((r) => r.content)).toEqual(['Someone else entirely'])
  })
})

describe('memories in a chat', () => {
  it('puts the relevant memories into the turn as a user message and marks them used; /status leaves no trace', async () => {
    await clear('member')
    await stored('member', 'Prefers green tea')
    await stored('member', 'Works in the sales department')
    const id = await thread('member')
    await http().get(`/api/agent/threads/${id}/status`).set(as('member')).expect(200)
    expect((await rows('member')).every((r) => r.last_used_at === null)).toBe(true)

    script({ text: 'Noted.' })
    expect(await settled(await start('member', id, 'what tea should I order'))).toBe('completed')
    const msgs = fake.requests[0]!.messages
    expect(msgs[0]!.role).toBe('system')
    expect(String(msgs[0]!.content)).not.toContain('green tea')
    const part = memoryPart(0)
    // each memory one JSON string: a memory cannot pass for several
    expect(String(part?.content)).toContain('- "Prefers green tea"')
    expect(toolNames(0)).toContain('memory.save')
    expect((await rows('member')).some((r) => r.last_used_at !== null)).toBe(true)
  })

  it('a temporary chat and a chat with memory off neither read nor offer to save memories', async () => {
    await clear('member')
    await stored('member', 'Prefers green tea')
    const temp = await thread('member', { temporary: 1 })
    script({ text: 'Hi.' })
    expect(await settled(await start('member', temp, 'tea?'))).toBe('completed')
    expect(memoryPart(0)).toBeUndefined()
    expect(toolNames(0)).not.toContain('memory.save')

    const created = await http()
      .post('/api/agent/threads')
      .set(as('member'))
      .send({ providerId, model: 'mm1', memoryEnabled: false })
    expect(created.status).toBe(201)
    expect(created.body.data.memoryEnabled).toBe(false)
    const off = created.body.data.id as number
    threads.push(off)
    script({ text: 'Hi.' })
    expect(await settled(await start('member', off, 'tea?'))).toBe('completed')
    expect(memoryPart(0)).toBeUndefined()
    expect(toolNames(0)).not.toContain('memory.save')

    // switched on again for that thread
    const on = await http()
      .patch(`/api/agent/threads/${off}`)
      .set(as('member'))
      .send({ memoryEnabled: true })
    expect(on.body.data.memoryEnabled).toBe(true)
    script({ text: 'Hi.' })
    expect(await settled(await start('member', off, 'tea again?'))).toBe('completed')
    expect(String(memoryPart(0)?.content)).toContain('green tea')
  })

  it('memory.save stops for approval, saves masked once approved and never twice', async () => {
    await clear('member')
    const id = await thread('member')
    script(
      { toolCalls: [{ name: 'memory.save', args: { content: `Remember ${SECRET}` } }] },
      { text: 'Saved.' },
    )
    const turnId = await start('member', id, 'remember my key')
    expect(await settled(turnId)).toBe('waiting')
    expect(await rows('member')).toHaveLength(0)
    const [card] = await ds.query<
      { id: number; payload: string | { tool: string; args: unknown } }[]
    >(
      "SELECT id, payload FROM agent_item WHERE thread_id = ? AND kind = 'approval' AND status = 'pending'",
      [id],
    )
    const payload = typeof card!.payload === 'string' ? JSON.parse(card!.payload) : card!.payload
    expect(payload).toMatchObject({ tool: 'memory.save', args: { content: `Remember ${SECRET}` } })
    await http()
      .post(`/api/agent/approvals/${card!.id}`)
      .set(as('member'))
      .send({ decision: 'approve' })
      .expect(201)
    expect(await settled(turnId, ['completed', 'failed', 'cancelled'])).toBe('completed')
    const saved = await rows('member')
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ source: 'chat', source_thread_id: id })
    expect(saved[0]!.content).not.toContain('hunter22')
    expect(saved[0]!.content).not.toContain(API_KEY)

    // the same content again: approved, but kept once
    script(
      { toolCalls: [{ name: 'memory.save', args: { content: `Remember ${SECRET}` } }] },
      { text: 'Saved.' },
    )
    const again = await start('member', id, 'remember it again')
    expect(await settled(again)).toBe('waiting')
    const [second] = await ds.query<{ id: number }[]>(
      "SELECT id FROM agent_item WHERE thread_id = ? AND kind = 'approval' AND status = 'pending'",
      [id],
    )
    await http()
      .post(`/api/agent/approvals/${second!.id}`)
      .set(as('member'))
      .send({ decision: 'approve' })
      .expect(201)
    expect(await settled(again, ['completed', 'failed', 'cancelled'])).toBe('completed')
    expect(await rows('member')).toHaveLength(1)
    const tool = fake.requests[1]!.messages.filter((m) => m.role === 'tool').at(-1)
    expect(String(tool?.content)).toContain('already remembered')
  })

  it('memory.save checks the switch when it runs: memory switched off during the turn saves nothing', async () => {
    await clear('member')
    const id = await thread('member', { approval_mode: 'trust' })
    const save = { toolCalls: [{ name: 'memory.save', args: { content: 'Likes oolong' } }] }
    // the first save is approved for the rest of the thread
    script(save, { text: 'OK.' })
    const first = await start('member', id, 'remember oolong')
    expect(await settled(first)).toBe('waiting')
    await http()
      .post(`/api/agent/approvals/${(await pendingCard(id))!.id}`)
      .set(as('member'))
      .send({ decision: 'approve_session' })
      .expect(201)
    expect(await settled(first, ['completed', 'failed', 'cancelled'])).toBe('completed')
    expect(await rows('member')).toHaveLength(1)
    await clear('member')

    // the same save again, trusted, while the user switches memory off before the call runs
    script({ ...save, delayMs: 800 }, { text: 'OK.' })
    const second = await start('member', id, 'remember oolong again')
    await sleep(150)
    await http()
      .patch(`/api/agent/threads/${id}`)
      .set(as('member'))
      .send({ memoryEnabled: false })
      .expect(200)
    expect(await settled(second, ['completed', 'failed', 'cancelled'])).toBe('failed')
    expect(await rows('member')).toHaveLength(0)
    expect(fake.requests).toHaveLength(1)
    const [result] = await ds.query(
      'SELECT payload FROM agent_item WHERE thread_id = ? AND turn_id = ? AND tenant_id = 1 AND kind = ?',
      [id, second, 'tool_result'],
    )
    const payload = typeof result.payload === 'string' ? JSON.parse(result.payload) : result.payload
    expect(String(payload.internal.content)).toContain('memory is switched off')
    const [risk] = await ds.query(
      'SELECT recovery_required FROM agent_thread WHERE id = ? AND tenant_id = 1',
      [id],
    )
    expect(risk.recovery_required).toBe(1)
  })

  it('memory.save always waits for a person: neither an auto nor a review policy lets it through', async () => {
    await clear('member')
    await setPolicy('memory.save', 'auto')
    const id = await thread('member')
    script(
      { toolCalls: [{ name: 'memory.save', args: { content: 'Likes puer' } }] },
      { text: 'OK.' },
    )
    expect(await settled(await start('member', id, 'remember puer'))).toBe('waiting')
    expect(await pendingCard(id)).toBeDefined()

    // auto-review thread, review policy and a reviewer approving everything: still a card for the person
    await setPolicy('memory.save', 'review')
    approveAll = true
    const reviewed = await thread('member', { approval_mode: 'auto_review' })
    script(
      { toolCalls: [{ name: 'memory.save', args: { content: 'Likes puer' } }] },
      { text: 'OK.' },
    )
    expect(await settled(await start('member', reviewed, 'remember puer'))).toBe('waiting')
    const card = await pendingCard(reviewed)
    expect(card?.payload).toMatchObject({ tool: 'memory.save' })
    expect(card?.payload.auto).toBeUndefined()
    expect(reviewedTools).not.toContain('memory.save')
    expect(await rows('member')).toHaveLength(0)
  })

  it('a full memory saves nothing and retains the clean-up reason while stopping further writes', async () => {
    await clear('full')
    const values = Array.from({ length: MEMORY_MAX }, (_, i) => [
      1,
      users.full.id,
      `fact ${i}`,
      'manual',
    ])
    await ds.query('INSERT INTO agent_memory (tenant_id, user_id, content, source) VALUES ?', [
      values,
    ])
    await http().post(URL).set(as('full')).send({ content: 'one more' }).expect(409)
    const id = await addRow(ds, 1, 'agent_thread', {
      user_id: users.full.id,
      title: '',
      provider_id: providerId,
      model: 'mm1',
    })
    threads.push(id)
    script({ toolCalls: [{ name: 'memory.save', args: { content: 'one more' } }] }, { text: 'OK.' })
    const res = await http()
      .post(`/api/agent/threads/${id}/messages`)
      .set(as('full'))
      .send({ text: 'remember one more' })
    const turnId = res.body.data.id as number
    expect(await settled(turnId)).toBe('waiting')
    const [card] = await ds.query<{ id: number }[]>(
      "SELECT id FROM agent_item WHERE thread_id = ? AND kind = 'approval' AND status = 'pending'",
      [id],
    )
    await http()
      .post(`/api/agent/approvals/${card!.id}`)
      .set(as('full'))
      .send({ decision: 'approve' })
      .expect(201)
    expect(await settled(turnId, ['completed', 'failed', 'cancelled'])).toBe('failed')
    expect(await rows('full')).toHaveLength(MEMORY_MAX)
    expect(fake.requests).toHaveLength(1)
    const [result] = await ds.query(
      'SELECT payload FROM agent_item WHERE thread_id = ? AND turn_id = ? AND tenant_id = 1 AND kind = ?',
      [id, turnId, 'tool_result'],
    )
    const payload = typeof result.payload === 'string' ? JSON.parse(result.payload) : result.payload
    expect(String(payload.internal.content)).toContain('memory is full')
    const [risk] = await ds.query(
      'SELECT recovery_required FROM agent_thread WHERE id = ? AND tenant_id = 1',
      [id],
    )
    expect(risk.recovery_required).toBe(1)
    await clear('full')
  })
})

describe('distilling memories', () => {
  /** An idle thread of the peer: its own words, an answer, external tool output and a followed suggestion. */
  async function talk() {
    const id = await idleThread('peer')
    await item(id, 1, 'user', { text: 'I run the Shanghai sales team, keep answers short' })
    await item(id, 2, 'tool_result', {
      callId: 'c1',
      tool: 'web.fetch',
      preview: 'WEB-FACT the user is a pilot',
    })
    await item(
      id,
      3,
      'assistant',
      { text: 'ANSWER-FACT you love jazz', suggestions: ['SUGGESTED-FACT tell me more'] },
      'done',
    )
    await item(id, 4, 'user', { text: 'SUGGESTED-FACT tell me more' })
    await item(id, 5, 'user', { text: 'my password is hunter22' })
    return id
  }
  const answer = (...memories: string[]) => ({ text: JSON.stringify({ memories }) })

  it('reads only the user’s own words, masks, records usage and never distils the same part twice', async () => {
    await clear('peer')
    const id = await talk()
    script(
      answer('Runs the Shanghai sales team', 'Password: hunter22', 'Runs the Shanghai sales team'),
    )
    expect(await distil('peer', id)).toBe(2)
    const sent = JSON.stringify(fake.requests[0]!.messages)
    expect(sent).toContain('I run the Shanghai sales team')
    expect(sent).not.toContain('WEB-FACT')
    expect(sent).not.toContain('ANSWER-FACT')
    expect(sent).not.toContain('SUGGESTED-FACT')
    const saved = await rows('peer')
    expect(saved.map((r) => [r.content, r.source, r.source_thread_id])).toEqual([
      ['Runs the Shanghai sales team', 'extract', id],
      ['Password: ***', 'extract', id],
    ])
    const [usage] = await ds.query<{ n: number }[]>(
      'SELECT COALESCE(SUM(calls), 0) AS n FROM agent_usage WHERE tenant_id = 1 AND user_id = ?',
      [users.peer.id],
    )
    expect(Number(usage!.n)).toBeGreaterThan(0)

    // nothing new since: no second model call
    script()
    expect(await distil('peer', id)).toBeNull()
    expect(fake.requests).toHaveLength(0)
    // a new message after the mark: only it is read
    await item(id, 6, 'user', { text: 'I also manage the Beijing office' })
    await ds.query('UPDATE agent_thread SET last_active_at = ? WHERE id = ?', [
      new Date(Date.now() - 3000_000),
      id,
    ])
    script(answer('Manages the Beijing office'))
    expect(await distil('peer', id)).toBe(1)
    const second = JSON.stringify(fake.requests[0]!.messages)
    expect(second).toContain('Beijing office')
    expect(second).not.toContain('I run the Shanghai sales team')
  })

  it('a distilling call that fails on a priced model is still charged by its request estimate', async () => {
    await clear('peer')
    await clearAgentUsage(ds, [users.peer.id])
    const id = await talk()
    script({ error: new Error('upstream down') })
    await distil('peer', id).catch(() => undefined)
    expect(fake.requests).toHaveLength(1)
    const [row] = await ds.query<
      { credits: string; unpriced_calls: number; unreported_calls: number }[]
    >(
      'SELECT credits, unpriced_calls, unreported_calls FROM agent_usage WHERE tenant_id = 1 AND user_id = ?',
      [users.peer.id],
    )
    expect(Number(row!.credits)).toBeGreaterThan(0)
    expect(row).toMatchObject({ unpriced_calls: 0, unreported_calls: 1 })
  })

  it('skips temporary chats, chats with memory off, a paused agent and a reached daily cap', async () => {
    await clear('peer')
    script()
    const temp = await idleThread('peer', { temporary: 1 })
    await item(temp, 1, 'user', { text: 'temporary words' })
    expect(await distil('peer', temp)).toBeNull()
    const off = await idleThread('peer', { memory_enabled: 0 })
    await item(off, 1, 'user', { text: 'private words' })
    expect(await distil('peer', off)).toBeNull()
    // subagent, automation and batch threads are never distilled
    for (const extra of [{ parent_thread_id: off }, { automation_run_id: 1 }, { batch_id: 1 }]) {
      const hidden = await idleThread('peer', extra)
      await item(hidden, 1, 'user', { text: 'hidden words' })
      expect(await distil('peer', hidden)).toBeNull()
    }

    const id = await talk()
    await setParam(AGENT_PAUSED_PARAM, 'true')
    expect(await distil('peer', id)).toBeNull()
    await setParam(AGENT_PAUSED_PARAM, 'false')
    const values = Array.from({ length: EXTRACT_PER_DAY }, (_, i) => [
      1,
      users.peer.id,
      `daily ${i}`,
      'extract',
    ])
    await ds.query('INSERT INTO agent_memory (tenant_id, user_id, content, source) VALUES ?', [
      values,
    ])
    expect(await distil('peer', id)).toBeNull()
    expect(fake.requests).toHaveLength(0)
  })

  it('skips a full memory and a used-up day of model calls without calling the model', async () => {
    await clear('peer')
    script()
    const values = Array.from({ length: MEMORY_MAX }, (_, i) => [
      1,
      users.peer.id,
      `m ${i}`,
      'manual',
    ])
    await ds.query('INSERT INTO agent_memory (tenant_id, user_id, content, source) VALUES ?', [
      values,
    ])
    const full = await talk()
    expect(await distil('peer', full)).toBeNull()
    expect(fake.requests).toHaveLength(0)
    await clear('peer')
    // the mark moved on: the part read while full is not distilled later
    expect(await distil('peer', full)).toBeNull()

    const calls = redisKey('agentMemoryMark', 'calls', users.peer.id, day())
    await app.get<Redis>(REDIS).set(calls, String(EXTRACT_CALLS_PER_DAY))
    const id = await talk()
    expect(await distil('peer', id)).toBeNull()
    expect(fake.requests).toHaveLength(0)
    await app.get<Redis>(REDIS).unlink(calls)
  })

  it('a fork keeps the source’s progress: copied messages are not distilled again', async () => {
    await clear('peer')
    const id = await talk()
    script(answer('Runs the Shanghai sales team'))
    expect(await distil('peer', id)).toBe(1)
    const forked = await http()
      .post(`/api/agent/threads/${id}/fork`)
      .set(as('peer'))
      .send({ seq: 5 })
    expect(forked.status).toBe(201)
    const copy = forked.body.data.id as number
    threads.push(copy)
    await ds.query('UPDATE agent_thread SET last_active_at = ? WHERE id = ?', [
      new Date(Date.now() - 3600_000),
      copy,
    ])
    script()
    expect(await distil('peer', copy)).toBeNull()
    expect(fake.requests).toHaveLength(0)
  })

  it('a fork from an earlier message still distils what is said in it afterwards', async () => {
    await clear('peer')
    const id = await talk()
    script(answer('Runs the Shanghai sales team'))
    expect(await distil('peer', id)).toBe(1)
    // the source was read up to its 5th item; the fork copies only the first
    const forked = await http()
      .post(`/api/agent/threads/${id}/fork`)
      .set(as('peer'))
      .send({ seq: 1 })
    expect(forked.status).toBe(201)
    const copy = forked.body.data.id as number
    threads.push(copy)
    await item(copy, 2, 'user', { text: 'I also lead the Shenzhen office' })
    await ds.query('UPDATE agent_thread SET last_active_at = ? WHERE id = ?', [
      new Date(Date.now() - 3600_000),
      copy,
    ])
    script(answer('Leads the Shenzhen office'))
    expect(await distil('peer', copy)).toBe(1)
    const sent = JSON.stringify(fake.requests[0]!.messages)
    expect(sent).toContain('Shenzhen office')
    expect(sent).not.toContain('I run the Shanghai sales team')
  })

  it('the scheduled sweep does nothing while the platform parameter is off and distils idle chats when on', async () => {
    await clear('peer')
    const id = await talk()
    script()
    expect(await inTenant1(() => extractor().sweep())).toBe(0)
    expect(fake.requests).toHaveLength(0)
    await setParam(AGENT2_PARAMS.memoryExtract, 'true')
    // other specs' idle threads may be picked up too: give every call the same answer
    script(...Array.from({ length: 60 }, () => answer('Runs the Shanghai sales team')))
    await extractor().sweep()
    const saved = await rows('peer')
    expect(saved.map((r) => [r.content, r.source])).toEqual([
      ['Runs the Shanghai sales team', 'extract'],
    ])
    expect(fake.requests.some((r) => JSON.stringify(r.messages).includes(`thread ${id}`))).toBe(
      true,
    )
  })
})
