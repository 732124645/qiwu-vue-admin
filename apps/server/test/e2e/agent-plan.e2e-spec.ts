import { TEST_AGENT_PRICING, clearAgentUsage } from '../setup/agent-pricing.js'
// The plan card of the plan mode (see docs/agent.md#计划模式): plan.propose is offered only in plan mode and
// stops the turn with a card; only the owner decides it (another user's or another tenant's card is 404);
// approving switches the thread to ask or auto_review (only when the platform offers it) and starts a new
// turn whose first message carries the approved plan; refining keeps plan mode and continues the same turn
// with the feedback as a user message, and so does a message sent while the card waits; stopping the turn
// expires the card; plan.update refuses two steps in progress at once. Approving names an untitled thread
// after the planning turn's first message, keeps its $skill for the execution turn and is refused while the
// agent is paused; only plan.propose makes a card.
import { Injectable, Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  AGENT2_PARAMS,
  AGENT_LIMIT_PARAMS,
  AGENT_PAUSED_PARAM,
  agentPerms,
  Err,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentBuiltinTool, type AgentToolContext } from '../../src/core/agent/agent-ports.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import type { ChatMessage } from '../../src/core/agent/provider/chat-model.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { addRow, addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})

const PREFIX = 'e2e_agpl_'
const PLAN = {
  title: 'Rename note 1',
  summary: 'Read the note, then change its title.',
  steps: ['Read note 1', 'Change its title to New'],
  changes: 'The title of note 1',
  assumptions: ['Note 1 exists'],
}

let app: NestExpressApplication
let ds: DataSource
let providerId = 0
let ownerId = 0
let otherId = 0
let owner = ''
let otherUser = ''
let roleId = 0
let tenant: PeopledTenant
let tenantUser = ''
let readerId = 0
let reader = ''
let fake = new FakeChatModel([])
const threads: number[] = []

const SKILL_BODY = 'PLAN-SKILL-BODY: rename notes carefully.'
const PLAN_SKILL = 'plan-skill'

/** A read built-in that tries to pass off a plan card of its own. */
@Injectable()
class SneakyBuiltins {
  @AgentBuiltinTool({
    name: 'test.plan.sneak',
    title: 'Sneak a plan',
    description: 'Asks a question with a proposal attached',
    kind: 'read',
    input: z.object({}),
  })
  sneak(_: object, ctx: AgentToolContext) {
    const q = { header: 'H', question: 'Q?', options: [{ label: 'a' }, { label: 'b' }] }
    return { ...ctx.ask([{ ...q, multiSelect: false }]), proposal: PLAN }
  }
}

@Module({ providers: [SneakyBuiltins] })
class SneakyModule {}

const http = () => request(app.getHttpServer())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const script = (...turns: FakeTurn[]) => (fake = new FakeChatModel(turns))
const propose = (plan: object = PLAN): FakeTurn => ({
  toolCalls: [{ name: 'plan.propose', args: plan }],
})

async function thread(mode = 'plan'): Promise<number> {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'agent_thread', {
      user_id: ownerId,
      title: '',
      provider_id: providerId,
      model: 'm1',
      approval_mode: mode,
    }),
  )
  threads.push(id)
  return id
}

const send = (id: number, text: string) =>
  http().post(`/api/agent/threads/${id}/messages`).set(bearer(owner)).send({ text })
async function start(id: number, text: string): Promise<number> {
  const res = await send(id, text)
  expect(res.status).toBe(201)
  return res.body.data.id as number
}

const TERMINAL = ['completed', 'failed', 'cancelled']
async function settled(turnId: number, want = [...TERMINAL, 'waiting'], ms = 15_000) {
  for (const until = Date.now() + ms; ; await sleep(40)) {
    const [t] = await ds.query<{ status: string }[]>('SELECT status FROM agent_turn WHERE id = ?', [
      turnId,
    ])
    if (t && want.includes(t.status)) return t.status
    if (Date.now() > until) throw new Error(`turn ${turnId} is still ${t?.status}`)
  }
}

interface Row {
  id: number
  turn_id: number | null
  kind: string
  status: string | null
  payload: any
}
async function items(threadId: number, kind?: string): Promise<Row[]> {
  const rows = await ds.query<Row[]>(
    'SELECT id, turn_id, kind, status, payload FROM agent_item WHERE thread_id = ? AND deleted_at IS NULL ORDER BY seq',
    [threadId],
  )
  for (const r of rows) if (typeof r.payload === 'string') r.payload = JSON.parse(r.payload)
  return kind ? rows.filter((r) => r.kind === kind) : rows
}
const modeOf = async (id: number) =>
  (
    await ds.query<{ approval_mode: string }[]>(
      'SELECT approval_mode FROM agent_thread WHERE id = ?',
      [id],
    )
  )[0]!.approval_mode
const turnsOf = (id: number) =>
  ds.query<{ id: number; status: string }[]>(
    'SELECT id, status FROM agent_turn WHERE thread_id = ? ORDER BY id',
    [id],
  )
const toolNames = (i: number) => (fake.requests[i]!.tools ?? []).map((t) => t.name)
const userMsgs = (i: number) =>
  fake.requests[i]!.messages.filter((m) => m.role === 'user').map((m) => String(m.content))
const toolMsgs = (i: number) =>
  fake.requests[i]!.messages.filter(
    (m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool',
  )

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

const decide = (itemId: number, body: object, token = owner) =>
  http().post(`/api/agent/plans/${itemId}`).set(bearer(token)).send(body)

/** Starts a plan-mode turn that proposes PLAN and returns the thread, turn and card. */
async function proposed(...after: FakeTurn[]) {
  script(propose(), ...after)
  const id = await thread()
  const turnId = await start(id, 'rename note 1')
  expect(await settled(turnId)).toBe('waiting')
  const [card] = await items(id, 'question')
  return { id, turnId, card: card! }
}

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule, SneakyModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  for (const key of [
    AGENT_LIMIT_PARAMS.turnCredits,
    AGENT_LIMIT_PARAMS.userDailyCredits,
    AGENT_LIMIT_PARAMS.tenantDailyCredits,
  ])
    await setParam(key, '0')
  await setParam(AGENT2_PARAMS.reviewModel, '')

  app.get(McpRegistry).add(
    {
      name: 'test.plan.update',
      title: 'Change a note',
      description: 'Changes the title of a note',
      perm: agentPerms.chat.use,
      kind: 'write',
      input: z.object({ id: z.number().int(), title: z.string() }),
    },
    () => ({ ok: true }),
  )
  app.get(McpRegistry).add(
    {
      name: 'test.plan.other',
      title: 'Read a list',
      description: 'Reads a list outside the skill',
      perm: agentPerms.chat.use,
      kind: 'read',
      input: z.object({}),
    },
    () => ({ ok: true }),
  )

  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: `${PREFIX}provider`,
    base_url: 'http://127.0.0.1:9/v1',
    models: [
      {
        id: 'm1',
        label: 'm1',
        reasoning: false,
        pricing: TEST_AGENT_PRICING,
        contextWindow: 64_000,
      },
    ],
    enabled: 1,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)

  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}chat`,
      name: `${PREFIX}chat`,
      data_scope: 'all',
    }),
  )
  const [chatMenu] = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_menu WHERE perms = 'agent.chat.use' AND deleted_at IS NULL",
  )
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
    roleId,
    chatMenu!.id,
  ])
  ownerId = await addUser(app, 1, `${PREFIX}owner`, { roleId })
  otherId = await addUser(app, 1, `${PREFIX}other`, { roleId })
  owner = (await signIn(app, `${PREFIX}owner`)).accessToken
  otherUser = (await signIn(app, `${PREFIX}other`)).accessToken
  tenant = await createTenant(app, { users: true })
  await addRow(app, tenant.id, 'iam_role_menus', { role_id: tenant.roleId, menu_id: chatMenu!.id })
  tenantUser = (await signIn(app, 'admin', {}, tenant.id)).accessToken
  // a signed-in user without agent.chat.use
  readerId = await addUser(app, 1, `${PREFIX}reader`)
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
  // the owner's own skill, limited to the write tool
  await addRow(app, 1, 'agent_skill', {
    owner_user_id: ownerId,
    name: PLAN_SKILL,
    description: 'Notes',
    body: SKILL_BODY,
    tools: ['test.plan.update'],
  })
})

afterAll(async () => {
  if (ds) {
    if (threads.length) {
      await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
    }
    const users = [ownerId, otherId, readerId].filter(Boolean)
    if (ownerId) await ds.query('DELETE FROM agent_skill WHERE owner_user_id = ?', [ownerId])
    if (users.length) {
      await clearAgentUsage(ds, users)
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
    await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
    await setParam(AGENT2_PARAMS.reviewModel, '')
  }
  await tenant?.dispose()
  await app?.close()
})

describe('plan card', () => {
  it('plan.propose is offered only in plan mode, and the prompt says to finish with it', async () => {
    script({ text: 'ok' }, { text: 'ok' })
    const ask = await thread('ask')
    expect(await settled(await start(ask, 'hello'), TERMINAL)).toBe('completed')
    expect(toolNames(0)).not.toContain('plan.propose')
    const plan = await thread()
    expect(await settled(await start(plan, 'hello'), TERMINAL)).toBe('completed')
    expect(toolNames(1)).toContain('plan.propose')
    expect(toolNames(1)).not.toContain('test.plan.update')
    expect(fake.requests[1]!.messages[0]!.content).toContain('call plan.propose')
  })

  it('a proposal waits for the owner only; approving with ask runs the plan in a new turn', async () => {
    const { id, turnId, card } = await proposed({ text: 'Done.' })
    expect(card).toMatchObject({ status: 'pending', payload: { questions: [], proposal: PLAN } })
    // the model cannot leave plan mode by itself
    expect(await modeOf(id)).toBe('plan')
    expect((await decide(card.id, { decision: 'ask' }, otherUser)).status).toBe(404)
    expect((await decide(card.id, { decision: 'ask' }, tenantUser)).status).toBe(404)
    expect((await decide(card.id, { decision: 'later' })).status).toBe(400)
    // a plan card is no plain question
    const answer = await http()
      .post(`/api/agent/questions/${card.id}`)
      .set(bearer(owner))
      .send({ answers: [] })
    expect(answer.status).toBe(400)

    expect((await decide(card.id, { decision: 'ask' })).status).toBe(201)
    expect(await modeOf(id)).toBe('ask')
    const turns = await turnsOf(id)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ id: turnId, status: 'completed' })
    expect(await settled(turns[1]!.id, TERMINAL)).toBe('completed')
    const [decided] = await items(id, 'question')
    expect(decided).toMatchObject({
      status: 'answered',
      payload: { choice: { decision: 'ask', decidedBy: ownerId } },
    })
    const first = (await items(id, 'user')).find((u) => u.turn_id === turns[1]!.id)!
    expect(first.payload.fromPlan).toBe(card.id)
    expect(first.payload.text).toContain('The approved plan:')
    expect(first.payload.text).toContain('2. Change its title to New')
    expect(first.payload.text).toContain('Expected changes: The title of note 1')
    expect(first.payload.text).toContain('- Note 1 exists')
    // the execution turn offers writes again, the plan tool no more; the model saw the approval
    expect(toolNames(1)).toContain('test.plan.update')
    expect(toolNames(1)).not.toContain('plan.propose')
    expect(userMsgs(1).at(-1)).toContain('The approved plan:')
    expect(toolMsgs(1).at(-1)!.content).toContain('approved this plan')
    expect((await decide(card.id, { decision: 'ask' })).body.code).toBe(
      Err.AGENT_APPROVAL_CLOSED.code,
    )
    // the untitled thread is named after the planning turn's first message, not the runtime's plan text
    const [t] = await ds.query<{ title: string }[]>('SELECT title FROM agent_thread WHERE id = ?', [
      id,
    ])
    expect(t!.title).toBe('rename note 1')
  })

  it('approving keeps the $skill of the planning turn: its instructions and tool list still apply', async () => {
    script(propose(), { text: 'Done.' })
    const id = await thread()
    const res = await http()
      .post(`/api/agent/threads/${id}/messages`)
      .set(bearer(owner))
      .send({ text: 'rename note 1', skill: PLAN_SKILL })
    expect(res.status).toBe(201)
    expect(await settled(res.body.data.id as number)).toBe('waiting')
    const [card] = await items(id, 'question')
    expect((await decide(card!.id, { decision: 'ask' })).status).toBe(201)
    const turns = await turnsOf(id)
    expect(await settled(turns[1]!.id, TERMINAL)).toBe('completed')
    const first = (await items(id, 'user')).find((u) => u.turn_id === turns[1]!.id)!
    expect(first.payload).toMatchObject({ fromPlan: card!.id, skill: PLAN_SKILL })
    expect(fake.requests[1]!.messages[0]!.content).toContain(SKILL_BODY)
    expect(toolNames(1)).toContain('test.plan.update')
    expect(toolNames(1)).not.toContain('test.plan.other')
  })

  it('approving while the agent is paused is refused and changes nothing', async () => {
    const { id, turnId, card } = await proposed({ text: 'Done.' })
    await setParam(AGENT_PAUSED_PARAM, 'true')
    try {
      const res = await decide(card.id, { decision: 'ask' })
      expect(res.status).toBe(503)
      expect(res.body.code).toBe(Err.AGENT_PAUSED.code)
      expect((await items(id, 'question'))[0]!.status).toBe('pending')
      expect(await modeOf(id)).toBe('plan')
      expect(await turnsOf(id)).toEqual([{ id: turnId, status: 'waiting' }])
    } finally {
      await setParam(AGENT_PAUSED_PARAM, 'false')
    }
    // once resumed the same card can still be approved
    expect((await decide(card.id, { decision: 'ask' })).status).toBe(201)
    expect(await settled((await turnsOf(id))[1]!.id, TERMINAL)).toBe('completed')
  })

  it('a built-in other than plan.propose cannot make a plan card', async () => {
    script({ toolCalls: [{ name: 'test.plan.sneak', args: {} }] })
    const id = await thread('ask')
    expect(await settled(await start(id, 'sneak'))).toBe('waiting')
    const [q] = await items(id, 'question')
    expect(q!.payload.proposal).toBeUndefined()
    expect(q!.payload.questions).toHaveLength(1)
    expect((await decide(q!.id, { decision: 'ask' })).status).toBe(404)
    expect(await modeOf(id)).toBe('ask')
  })

  it('deciding a plan needs agent.chat.use', async () => {
    expect((await decide(1, { decision: 'ask' }, reader)).status).toBe(403)
  })

  it('approving with the automatic review needs the platform to offer it', async () => {
    const { id, card } = await proposed({ text: 'Done.' })
    expect((await decide(card.id, { decision: 'auto_review' })).status).toBe(400)
    expect((await items(id, 'question'))[0]!.status).toBe('pending')
    await setParam(AGENT2_PARAMS.reviewModel, `${providerId}:m1`)
    try {
      expect((await decide(card.id, { decision: 'auto_review' })).status).toBe(201)
      expect(await modeOf(id)).toBe('auto_review')
      const turns = await turnsOf(id)
      expect(await settled(turns[1]!.id, TERMINAL)).toBe('completed')
    } finally {
      await setParam(AGENT2_PARAMS.reviewModel, '')
    }
  })

  it('refining keeps plan mode and continues with the feedback; a message while waiting refines too', async () => {
    const { id, turnId, card } = await proposed(propose(), { text: 'Revised.' })
    expect(
      (await decide(card.id, { decision: 'refine', feedback: 'Add a backup step' })).status,
    ).toBe(201)
    expect(await settled(turnId)).toBe('waiting')
    expect(toolMsgs(1).at(-1)!.content).toContain('wants it refined')
    expect(userMsgs(1).at(-1)).toBe('Add a backup step')
    const cards = await items(id, 'question')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.payload.choice).toMatchObject({
      decision: 'refine',
      feedback: 'Add a backup step',
    })
    expect(cards[1]!.status).toBe('pending')

    expect((await send(id, 'Also notify the team')).status).toBe(201)
    expect(await settled(turnId, TERMINAL)).toBe('completed')
    expect((await items(id, 'question'))[1]!.payload.choice).toMatchObject({
      decision: 'refine',
      decidedBy: ownerId,
      feedback: 'Also notify the team',
    })
    expect(userMsgs(2).at(-1)).toBe('Also notify the team')
    expect(await modeOf(id)).toBe('plan')
    expect(await turnsOf(id)).toHaveLength(1)
  })

  it('stopping the turn expires the card', async () => {
    const { id, turnId, card } = await proposed()
    await http().post(`/api/agent/threads/${id}/cancel`).set(bearer(owner)).expect(201)
    expect(await settled(turnId, TERMINAL)).toBe('cancelled')
    expect((await items(id, 'question'))[0]!.status).toBe('expired')
    expect((await decide(card.id, { decision: 'ask' })).body.code).toBe(
      Err.AGENT_APPROVAL_CLOSED.code,
    )
    expect(await modeOf(id)).toBe('plan')
  })

  it('plan.update refuses two steps in progress at once', async () => {
    const two = [
      { text: 'a', status: 'doing' },
      { text: 'b', status: 'doing' },
    ]
    script({ toolCalls: [{ name: 'plan.update', args: { steps: two } }] }, { text: 'ok' })
    const id = await thread('ask')
    expect(await settled(await start(id, 'plan it'), TERMINAL)).toBe('completed')
    expect(toolMsgs(1)[0]!.content).toContain('At most one step may be doing')
    expect(await items(id, 'plan')).toHaveLength(0)
  })
})
