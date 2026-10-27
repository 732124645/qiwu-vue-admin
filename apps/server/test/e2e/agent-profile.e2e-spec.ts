import { TEST_AGENT_PRICING, clearAgentUsage } from '../setup/agent-pricing.js'
// Agent profiles (see docs/agent.md): the caller's own and tenant-wide ones (those need agent.skill.modify),
// another user's personal profile and another tenant's are 404; the approval mode must be one the platform
// offers (a tenant-wide profile only read-only or ask), listed tools must exist, one default per scope. A new
// thread takes the chosen (else the default; none for `profileId: null`) profile's model, reasoning and approval
// mode (fields of the request win; a mode the platform no longer offers falls back to ask); at run time the
// profile's tool list limits the tools like a skill's, both lists together only what both list (read built-ins
// always stay, write built-ins only when listed), and its instructions reach the model as a user message, never
// the system prompt; a deleted profile leaves the thread on the default behaviour. No session 401, no
// agent.chat.use 403, invalid bodies 400. Multi-tenancy on.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AGENT2_PARAMS, agentPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { addRow, addUser, createTenant, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agprof-'
const URL = '/api/agent/profiles'

let app: NestExpressApplication
let ds: DataSource
let providerId = 0
let fake = new FakeChatModel([])
let other: PeopledTenant
const users: Record<'member' | 'peer' | 'manager' | 'reader', { id: number; token: string }> =
  {} as never
let otherMember = ''
const roleIds: number[] = []

const http = () => request(app.getHttpServer())
const script = (...turns: FakeTurn[]) => (fake = new FakeChatModel(turns))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const as = (who: keyof typeof users) => bearer(users[who].token)
const toolNames = (i: number) => (fake.requests[i]!.tools ?? []).map((t) => t.name)

/** Sets a system parameter (and drops its cached value); returns the value it had. */
async function setParam(key: string, value: string): Promise<string | null> {
  const [row] = await ds.query<{ v: string | null }[]>(
    'SELECT param_value AS v FROM cfg_param WHERE param_key = ?',
    [key],
  )
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
  return row?.v ?? null
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

const profile = (extra: Record<string, unknown> = {}) => ({
  name: `p-${Math.random().toString(36).slice(2, 8)}`,
  ...extra,
})

async function createProfile(who: keyof typeof users, extra: Record<string, unknown> = {}) {
  const res = await http().post(URL).set(as(who)).send(profile(extra))
  expect(res.status).toBe(201)
  return res.body.data as {
    id: number
    scope: string
    isDefault: boolean
    editable: boolean
    approvalMode: string
  }
}

async function newThread(who: keyof typeof users, body: Record<string, unknown> = {}) {
  const res = await http().post('/api/agent/threads').set(as(who)).send(body)
  return res
}

async function settled(turnId: number, ms = 15_000) {
  for (const until = Date.now() + ms; ; await sleep(40)) {
    const [t] = await ds.query<{ status: string }[]>('SELECT status FROM agent_turn WHERE id = ?', [
      turnId,
    ])
    if (t && ['completed', 'failed', 'cancelled', 'waiting'].includes(t.status)) return t.status
    if (Date.now() > until) throw new Error(`turn ${turnId} is still ${t?.status}`)
  }
}

async function say(who: keyof typeof users, threadId: number, text: string) {
  const res = await http()
    .post(`/api/agent/threads/${threadId}/messages`)
    .set(as(who))
    .send({ text })
  expect(res.status).toBe(201)
  return settled(res.body.data.id as number)
}

beforeAll(async () => {
  const env = { ...process.env, APP_MULTI_TENANT: 'true', APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())

  const reg = app.get(McpRegistry)
  reg.add(
    {
      name: 'test.pnote.read',
      title: 'Read a note',
      description: 'Reads a note',
      perm: null,
      kind: 'read',
      input: z.object({ id: z.number().int() }),
    },
    () => ({ title: 'note' }),
  )
  reg.add(
    {
      name: 'test.pnote.update',
      title: 'Change a note',
      description: 'Changes a note',
      perm: null,
      kind: 'write',
      input: z.object({ id: z.number().int() }),
    },
    () => ({ ok: true }),
  )

  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: `${PREFIX}provider`,
    base_url: 'http://127.0.0.1:9/v1',
    models: [
      {
        id: 'pm1',
        label: 'pm1',
        reasoning: false,
        pricing: TEST_AGENT_PRICING,
        contextWindow: 64_000,
      },
      {
        id: 'pm2',
        label: 'pm2',
        reasoning: true,
        pricing: TEST_AGENT_PRICING,
        contextWindow: 64_000,
      },
    ],
    enabled: 1,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)

  const chat = [agentPerms.chat.use]
  for (const [who, perms] of [
    ['member', chat],
    ['peer', chat],
    ['manager', [...chat, agentPerms.skill.modify]],
    ['reader', []],
  ] as const) {
    const id = perms.length
      ? await userWith(who, [...perms])
      : await addUser(app, 1, `${PREFIX}${who}`)
    users[who] = { id, token: (await signIn(app, `${PREFIX}${who}`)).accessToken }
  }
  other = await createTenant(app, { users: true })
  await userWith('b-member', chat, other.id)
  otherMember = (await signIn(app, `${PREFIX}b-member`, {}, other.id)).accessToken
})

afterAll(async () => {
  if (ds) {
    const ids = Object.values(users).map((u) => u.id)
    if (ids.length) {
      const threads = await ds.query<{ id: number }[]>(
        'SELECT id FROM agent_thread WHERE tenant_id = 1 AND user_id IN (?)',
        [ids],
      )
      if (threads.length) {
        const tids = threads.map((t) => t.id)
        await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [tids])
        await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [tids])
        await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [tids])
      }
      await ds.query('DELETE FROM agent_profile WHERE tenant_id = 1 AND created_by IN (?)', [ids])
      await ds.query('DELETE FROM agent_skill WHERE tenant_id = 1 AND owner_user_id IN (?)', [ids])
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

describe('agent profiles', () => {
  it('creates, lists, changes and deletes an own profile', async () => {
    const created = await createProfile('member', {
      providerId,
      model: 'pm2',
      reasoning: 'high',
      approvalMode: 'read_only',
      tools: ['test.pnote.read'],
      instructions: 'Answer in bullet points.',
    })
    expect(created).toMatchObject({ scope: 'user', isDefault: false, editable: true })
    const list = (await http().get(URL).set(as('member')).expect(200)).body.data as { id: number }[]
    expect(list.map((p) => p.id)).toContain(created.id)
    // another user never sees it
    const peer = (await http().get(URL).set(as('peer')).expect(200)).body.data as { id: number }[]
    expect(peer.map((p) => p.id)).not.toContain(created.id)

    const changed = await http()
      .put(`${URL}/${created.id}`)
      .set(as('member'))
      .send(profile({ name: `${PREFIX}renamed`, approvalMode: 'ask' }))
    expect(changed.status).toBe(200)
    expect(changed.body.data).toMatchObject({ name: `${PREFIX}renamed`, approvalMode: 'ask' })
    await http().delete(`${URL}/${created.id}`).set(as('member')).expect(200)
    const after = (await http().get(URL).set(as('member')).expect(200)).body.data as {
      id: number
    }[]
    expect(after.map((p) => p.id)).not.toContain(created.id)
  })

  it('answers 401 without a session, 403 without the chat permission, 400 for invalid bodies', async () => {
    await http().get(URL).expect(401)
    await http().get(URL).set(as('reader')).expect(403)
    await http().post(URL).set(as('reader')).send(profile()).expect(403)
    await http().post(URL).set(as('member')).send({ name: '' }).expect(400)
    await http()
      .post(URL)
      .set(as('member'))
      .send(profile({ approvalMode: 'bogus' }))
      .expect(400)
    // the platform has no review model: auto-review is not offered
    const was = await setParam(AGENT2_PARAMS.reviewModel, '')
    try {
      await http()
        .post(URL)
        .set(as('member'))
        .send(profile({ approvalMode: 'auto_review' }))
        .expect(400)
    } finally {
      await setParam(AGENT2_PARAMS.reviewModel, was ?? '')
    }
    // a tool that does not exist
    await http()
      .post(URL)
      .set(as('member'))
      .send(profile({ tools: ['test.pnote.read', 'no.such.tool'] }))
      .expect(400)
    // an unknown model of the provider
    await http()
      .post(URL)
      .set(as('member'))
      .send(profile({ providerId, model: 'nope' }))
      .expect(422)
  })

  it('keeps another user’s and another tenant’s profiles out of reach (404)', async () => {
    const mine = await createProfile('member')
    await http().put(`${URL}/${mine.id}`).set(as('peer')).send(profile()).expect(404)
    await http().delete(`${URL}/${mine.id}`).set(as('peer')).expect(404)
    expect((await newThread('peer', { profileId: mine.id })).status).toBe(404)
    // another tenant
    const res = await http().get(URL).set(bearer(otherMember)).expect(200)
    expect((res.body.data as { id: number }[]).map((p) => p.id)).not.toContain(mine.id)
    await http().put(`${URL}/${mine.id}`).set(bearer(otherMember)).send(profile()).expect(404)
    await http().delete(`${URL}/${mine.id}`).set(bearer(otherMember)).expect(404)
    const thread = await http()
      .post('/api/agent/threads')
      .set(bearer(otherMember))
      .send({ profileId: mine.id })
    expect(thread.status).toBe(404)
  })

  it('tenant-wide profiles need agent.skill.modify to change; everyone in the tenant may use them', async () => {
    await http()
      .post(URL)
      .set(as('member'))
      .send(profile({ scope: 'tenant' }))
      .expect(403)
    const shared = await createProfile('manager', { scope: 'tenant' })
    expect(shared).toMatchObject({ scope: 'tenant', editable: true })
    const seen = (await http().get(URL).set(as('member')).expect(200)).body.data as {
      id: number
      editable: boolean
    }[]
    expect(seen.find((p) => p.id === shared.id)).toMatchObject({ editable: false })
    await http().put(`${URL}/${shared.id}`).set(as('member')).send(profile()).expect(403)
    await http().delete(`${URL}/${shared.id}`).set(as('member')).expect(403)
    // a personal profile may not be turned tenant-wide without the permission either
    const mine = await createProfile('member')
    await http()
      .put(`${URL}/${mine.id}`)
      .set(as('member'))
      .send(profile({ scope: 'tenant' }))
      .expect(403)
    await http().delete(`${URL}/${shared.id}`).set(as('manager')).expect(200)
  })

  it('a tenant-wide profile may only be read-only, plan or ask: auto-review is the user’s own choice', async () => {
    const params = app.get(ParamService)
    const get = params.get.bind(params)
    const spy = vi
      .spyOn(params, 'get')
      .mockImplementation(async (key) => (key === AGENT2_PARAMS.reviewModel ? '1:pm1' : get(key)))
    try {
      // the retired trust mode is no mode at all
      for (const approvalMode of ['trust', 'auto_review'])
        await http()
          .post(URL)
          .set(as('manager'))
          .send(profile({ scope: 'tenant', isDefault: true, approvalMode }))
          .expect(400)
      await http()
        .post(URL)
        .set(as('manager'))
        .send(profile({ approvalMode: 'trust' }))
        .expect(400)
      const shared = await createProfile('manager', { scope: 'tenant', approvalMode: 'plan' })
      expect(shared.approvalMode).toBe('plan')
      await http()
        .put(`${URL}/${shared.id}`)
        .set(as('manager'))
        .send(profile({ scope: 'tenant', approvalMode: 'auto_review' }))
        .expect(400)
      // a personal one may (a review model is set)
      const mine = await createProfile('manager', { approvalMode: 'auto_review' })
      // a personal auto-review profile cannot be turned tenant-wide either
      await http()
        .put(`${URL}/${mine.id}`)
        .set(as('manager'))
        .send(profile({ scope: 'tenant', approvalMode: 'auto_review' }))
        .expect(400)
      await http().delete(`${URL}/${shared.id}`).set(as('manager')).expect(200)
      await http().delete(`${URL}/${mine.id}`).set(as('manager')).expect(200)
    } finally {
      spy.mockRestore()
    }
  })

  it('a default profile never overrides what the user chose; profileId null takes none', async () => {
    const def = await createProfile('member', {
      isDefault: true,
      providerId,
      model: 'pm2',
      approvalMode: 'read_only',
    })
    const ask = await newThread('member', { approvalMode: 'ask' })
    expect(ask.body.data).toMatchObject({ profileId: def.id, approvalMode: 'ask' })
    const none = await newThread('member', { profileId: null })
    expect(none.status).toBe(201)
    expect(none.body.data).toMatchObject({ profileId: null, approvalMode: 'ask' })
    expect(none.body.data.model).not.toBe('pm2')
    await http().delete(`${URL}/${def.id}`).set(as('member')).expect(200)
  })

  it('a profile’s mode the platform no longer offers falls back to ask', async () => {
    const params = app.get(ParamService)
    const get = params.get.bind(params)
    const spy = vi
      .spyOn(params, 'get')
      .mockImplementation(async (key) => (key === AGENT2_PARAMS.reviewModel ? '1:pm1' : get(key)))
    let id = 0
    try {
      id = (await createProfile('member', { approvalMode: 'auto_review' })).id
    } finally {
      spy.mockRestore()
    }
    // the review model is gone again: auto-review is not offered any more
    const res = await newThread('member', { providerId, model: 'pm1', profileId: id })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ profileId: id, approvalMode: 'ask' })
    await http().delete(`${URL}/${id}`).set(as('member')).expect(200)
  })

  it('keeps one default per scope and a new thread without a profile takes it', async () => {
    const first = await createProfile('peer', { isDefault: true, approvalMode: 'read_only' })
    const second = await createProfile('peer', {
      isDefault: true,
      providerId,
      model: 'pm2',
      reasoning: 'low',
      approvalMode: 'read_only',
    })
    const list = (await http().get(URL).set(as('peer')).expect(200)).body.data as {
      id: number
      isDefault: boolean
    }[]
    expect(list.find((p) => p.id === first.id)?.isDefault).toBe(false)
    expect(list.find((p) => p.id === second.id)?.isDefault).toBe(true)

    const res = await newThread('peer')
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      profileId: second.id,
      providerId,
      model: 'pm2',
      reasoning: 'low',
      approvalMode: 'read_only',
      memoryEnabled: true,
    })
    // fields given in the request win
    const own = await newThread('peer', { providerId, model: 'pm1', approvalMode: 'plan' })
    expect(own.body.data).toMatchObject({
      profileId: second.id,
      model: 'pm1',
      reasoning: null,
      approvalMode: 'plan',
    })
    await http().delete(`${URL}/${second.id}`).set(as('peer')).expect(200)
    await http().delete(`${URL}/${first.id}`).set(as('peer')).expect(200)
  })

  it('limits the tools to the profile’s list and adds its instructions as a user message', async () => {
    const p = await createProfile('member', {
      tools: ['test.pnote.read'],
      instructions: 'PROFILE-NOTE: answer in bullet points.',
    })
    const created = await newThread('member', { providerId, model: 'pm1', profileId: p.id })
    expect(created.status).toBe(201)
    const threadId = created.body.data.id as number
    script({ text: 'Done.' })
    expect(await say('member', threadId, 'hello')).toBe('completed')
    const names = toolNames(0)
    expect(names).toContain('test.pnote.read')
    // read built-ins stay, a write tool or write built-in not on the list goes
    expect(names).toContain('plan.update')
    expect(names).not.toContain('test.pnote.update')
    expect(names).not.toContain('memory.save')
    const msgs = fake.requests[0]!.messages
    expect(String(msgs[0]!.content)).not.toContain('PROFILE-NOTE')
    const part = msgs.find((m) => m.role === 'user' && String(m.content).includes('PROFILE-NOTE'))
    expect(part).toBeDefined()
    expect(String(part!.content)).toContain('[Context "profile"')

    // the profile goes away: the thread runs on the default behaviour, without an error
    await http().delete(`${URL}/${p.id}`).set(as('member')).expect(200)
    script({ text: 'Done again.' })
    expect(await say('member', threadId, 'again')).toBe('completed')
    expect(toolNames(0)).toEqual(expect.arrayContaining(['test.pnote.update', 'memory.save']))
    expect(JSON.stringify(fake.requests[0]!.messages)).not.toContain('PROFILE-NOTE')
  })

  it('a skill’s and the profile’s tool lists together offer only what both list', async () => {
    await addRow(app, 1, 'agent_skill', {
      owner_user_id: users.member.id,
      name: 'pnote-skill',
      description: 'Notes',
      body: 'Read notes.',
      tools: ['test.pnote.read'],
    })
    const p = await createProfile('member', { tools: ['test.pnote.read', 'test.pnote.update'] })
    const created = await newThread('member', { providerId, model: 'pm1', profileId: p.id })
    const threadId = created.body.data.id as number
    // the profile alone lets the write tool through
    script({ text: 'Done.' })
    expect(await say('member', threadId, 'hello')).toBe('completed')
    expect(toolNames(0)).toContain('test.pnote.update')
    script({ text: 'Done.' })
    const res = await http()
      .post(`/api/agent/threads/${threadId}/messages`)
      .set(as('member'))
      .send({ text: 'read notes', skill: 'pnote-skill' })
    expect(res.status).toBe(201)
    expect(await settled(res.body.data.id as number)).toBe('completed')
    expect(toolNames(0)).toContain('test.pnote.read')
    expect(toolNames(0)).not.toContain('test.pnote.update')
    await http().delete(`${URL}/${p.id}`).set(as('member')).expect(200)
  })

  it('switches a thread’s profile or drops it; another user’s profile is 404', async () => {
    const created = await newThread('member', { providerId, model: 'pm1' })
    const threadId = created.body.data.id as number
    const p = await createProfile('member')
    const set = await http()
      .patch(`/api/agent/threads/${threadId}`)
      .set(as('member'))
      .send({ profileId: p.id })
    expect(set.status).toBe(200)
    expect(set.body.data.profileId).toBe(p.id)
    const theirs = await createProfile('peer')
    await http()
      .patch(`/api/agent/threads/${threadId}`)
      .set(as('member'))
      .send({ profileId: theirs.id })
      .expect(404)
    const dropped = await http()
      .patch(`/api/agent/threads/${threadId}`)
      .set(as('member'))
      .send({ profileId: null })
    expect(dropped.body.data.profileId).toBeNull()
  })
})
