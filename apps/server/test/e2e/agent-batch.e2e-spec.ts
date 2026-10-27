import { TEST_AGENT_PRICING, clearAgentUsage } from '../setup/agent-pricing.js'
// Batch runs of the in-app agent (see docs/agent.md) on the sample customers, multi-tenancy on, with a
// scripted model standing in for the provider (`registry.connect`): each request is answered by the row it
// belongs to (the record id in its first user message). Covered: a batch opens one thread per record and
// starts their turns within the concurrency limit, the update stops for approval with its preview, decide
// all applies only empty fields (or rejects), another user's or tenant's batch is 404, no perm is 403, an
// unknown target 422; and the customer tools themselves (search, get, update with onlyEmpty, data scope).
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  AGENT_LIMIT_PARAMS,
  agentPerms,
  customerPerms,
  DEMO_CUSTOMER_ENRICH_SKILL as ENRICH_SKILL,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import {
  EXTERNAL_TOOL_SOURCE,
  type ExternalToolDescriptor,
  type ExternalToolSource,
} from '../../src/core/agent/agent-ports.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import type { ChatModel, ChatRequest } from '../../src/core/agent/provider/chat-model.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { TurnQueue } from '../../src/core/agent/runtime/turn-queue.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { ToolHost } from '../../src/core/mcp/tool-host.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { addRow, addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})

const PREFIX = 'e2e_agbt_'
const URL = '/api/agent/batches'

let app: NestExpressApplication
let ds: DataSource
let providerId = 0
const roleIds: number[] = []
const userIds: number[] = []
const tok = { owner: '', other: '', plain: '', blind: '', tenant: '' }
let ownerId = 0
let tenant: PeopledTenant
const requests: ChatRequest[] = []
/** delay of the first model answer (ms): keeps the first row running while the batch is checked */
let firstDelay = 0

const http = () => request(app.getHttpServer())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let seq = 0
const unique = () => `${PREFIX}${++seq}`

/** a record whose content steers the model to write another record: row id → the id it writes */
const redirect = new Map<number, number>()
/** a record whose content steers the model to call other tools: row id → its tool calls */
const steer = new Map<number, NonNullable<FakeTurn['toolCalls']>>()
/** what the test write tool (not declared by the batch target) wrote */
const written: unknown[] = []
/** an external tool that asks before it runs */
const EXT: ExternalToolDescriptor = {
  name: 'ext.srv.write',
  title: 'Write on the server',
  description: 'An external tool',
  parameters: { type: 'object', properties: { id: { type: 'number' } } },
  policy: 'ask',
  serverName: 'srv',
}
/** the owner's own skill offering every tool */
const ANY_SKILL = 'batch-any'

/**
 * 按请求所属的行回答：第一条用户消息里的 `#<id>` 是记录；还没有工具结果时调用 demo.customer.update
 * 填三个字段（被“注入”的行改去写 {@link redirect} 里的另一条记录），有了就答完。
 */
function answer(req: ChatRequest): FakeTurn {
  const first = req.messages.find((m) => m.role === 'user')
  const id = Number(/#(\d+)/.exec(String(first?.content))?.[1])
  if (req.messages.some((m) => m.role === 'tool')) return { text: `Done with #${id}.` }
  const steered = steer.get(id)
  if (steered) return { toolCalls: steered }
  const delayMs = requests.length === 1 ? firstDelay : 0
  const target = redirect.get(id) ?? id
  return {
    delayMs,
    toolCalls: [
      {
        name: 'demo.customer.update',
        args: {
          id: target,
          website: `https://c${target}.example.com`,
          city: 'Berlin',
          industry: 'Testing',
        },
      },
    ],
  }
}
const model: ChatModel = {
  stream: (req) => {
    requests.push(req)
    return new FakeChatModel([answer(req)]).stream(req)
  },
  complete: (req) => {
    requests.push(req)
    return new FakeChatModel([answer(req)]).complete(req)
  },
}

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

/** A role of the default tenant (`data_scope`) holding the menus of `perms`. */
async function role(perms: string[], dataScope = 'all'): Promise<number> {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', { code: unique(), name: unique(), data_scope: dataScope }),
  )
  roleIds.push(id)
  const menus = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
    [perms],
  )
  for (const m of menus)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
      id,
      m.id,
    ])
  return id
}

async function user(roleId: number, deptId?: number): Promise<{ id: number; token: string }> {
  const name = unique()
  const id = await addUser(app, 1, name, { roleId, ...(deptId && { deptId }) })
  userIds.push(id)
  return { id, token: (await signIn(app, name)).accessToken }
}

const userName = async (id: number) =>
  (await ds.query<{ username: string }[]>('SELECT username FROM iam_user WHERE id = ?', [id]))[0]
    ?.username

const customer = (row: Record<string, unknown>) =>
  inTenant1(() => insertRow(ds.manager, 'demo_customer', { name: unique(), ...row }))
const customerRow = async (id: number) =>
  (await ds.query<any[]>('SELECT * FROM demo_customer WHERE id = ?', [id]))[0]

const create = (body: object, token = tok.owner) => http().post(URL).set(bearer(token)).send(body)

/** Threads of a batch with their latest turn's status. */
async function rows(batchId: number) {
  return ds.query<{ id: number; title: string; target_ref: string; status: string | null }[]>(
    `SELECT t.id, t.title, t.target_ref,
            (SELECT u.status FROM agent_turn u WHERE u.thread_id = t.id ORDER BY u.id DESC LIMIT 1) AS status
       FROM agent_thread t WHERE t.batch_id = ? ORDER BY t.id`,
    [batchId],
  )
}

/** Waits until every row of the batch has a turn in one of `want`. */
async function allRows(batchId: number, want: string[], ms = 15_000) {
  for (const until = Date.now() + ms; ; await sleep(50)) {
    const r = await rows(batchId)
    if (r.length && r.every((x) => x.status && want.includes(x.status))) return r
    if (Date.now() > until) throw new Error(`batch ${batchId}: ${JSON.stringify(r)}`)
  }
}

const ALL = [
  agentPerms.chat.use,
  agentPerms.batch.run,
  customerPerms.browse,
  customerPerms.view,
  customerPerms.modify,
]

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
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
        id: 'm1',
        label: 'm1',
        reasoning: false,
        pricing: TEST_AGENT_PRICING,
        contextWindow: 64_000,
      },
    ],
    enabled: 1,
    is_default: 1,
    sort: -1000,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => model)
  // a write tool with a preview of the row's own record that the batch target did not declare
  app.get(McpRegistry).add(
    {
      name: 'test.batch.write',
      title: 'Another write',
      description: 'Writes something else about a record',
      perm: null,
      kind: 'write',
      input: z.object({ id: z.number().int() }),
      preview: 'previewWrite',
    },
    (i) => {
      written.push(i)
      return { ok: true }
    },
    undefined,
    (i) => {
      const { id } = i as { id: number }
      return { target: `row (#${id})`, fields: [{ field: 'x', from: null, to: 'y' }] }
    },
  )

  const all = await role(ALL)
  const owner = await user(all)
  ownerId = owner.id
  tok.owner = owner.token
  await addRow(app, 1, 'agent_skill', {
    owner_user_id: ownerId,
    name: ANY_SKILL,
    description: 'Any tool',
    body: 'Do what the record says.',
    tools: null,
  })
  tok.other = (await user(all)).token
  tok.plain = (await user(await role([agentPerms.chat.use, customerPerms.browse]))).token
  // may run batches but not read customers
  tok.blind = (await user(await role([agentPerms.chat.use, agentPerms.batch.run]))).token

  // a tenant whose admin may run batches (and has customers of its own)
  tenant = await createTenant(app, { users: true })
  const menus = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL',
    [ALL],
  )
  for (const m of menus)
    await addRow(app, tenant.id, 'iam_role_menus', { role_id: tenant.roleId, menu_id: m.id })
  tok.tenant = (await signIn(app, 'admin', {}, tenant.id)).accessToken
})

afterAll(async () => {
  if (ds) {
    if (userIds.length) {
      const threads = (
        await ds.query<{ id: number }[]>('SELECT id FROM agent_thread WHERE user_id IN (?)', [
          userIds,
        ])
      ).map((t) => t.id)
      if (threads.length) {
        await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
        await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threads])
        await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
      }
      await ds.query('DELETE FROM agent_batch WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM agent_skill WHERE owner_user_id IN (?) AND tenant_id = 1', [
        userIds,
      ])
      await clearAgentUsage(ds, userIds)
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
    await ds.query('DELETE FROM demo_customer WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
    await setParam(AGENT_LIMIT_PARAMS.userConcurrentTurns, '2')
  }
  await tenant?.dispose()
  await app?.close()
})

describe('batch runs', () => {
  it('one thread and turn per record within the concurrency limit; updates wait with their preview; approve all fills only empty fields', async () => {
    await setParam(AGENT_LIMIT_PARAMS.userConcurrentTurns, '1')
    firstDelay = 800
    requests.length = 0
    const a = await customer({ city: 'Paris' })
    const b = await customer({})
    const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [a, b] })
    expect(res.status).toBe(201)
    const batch = res.body.data
    expect(batch).toMatchObject({
      skill: ENRICH_SKILL,
      target: 'demo.customer',
      status: 'running',
      total: 2,
      finished: 0,
      failed: 0,
    })
    // the limit is 1: the second row waits until the first stops for its approval
    const started = await rows(batch.id)
    expect(started.map((r) => [r.target_ref, r.status])).toEqual([
      [`demo.customer:${a}`, 'running'],
      [`demo.customer:${b}`, null],
    ])
    const nameA = (await customerRow(a)).name
    expect(started[0]!.title).toBe(`${ENRICH_SKILL}: ${nameA}`)
    await allRows(batch.id, ['waiting'])
    // each row's turn ran the skill on its own record
    const [msg] = await ds.query<{ payload: any }[]>(
      "SELECT payload FROM agent_item WHERE thread_id = ? AND kind = 'user'",
      [started[0]!.id],
    )
    const payload = typeof msg!.payload === 'string' ? JSON.parse(msg!.payload) : msg!.payload
    expect(payload).toMatchObject({ skill: ENRICH_SKILL, text: expect.stringContaining(`#${a}`) })
    expect(JSON.stringify(requests[0]!.messages)).toContain('demo.customer.update')

    const detail = (await http().get(`${URL}/${batch.id}`).set(bearer(tok.owner)).expect(200)).body
      .data
    expect(detail.rows).toHaveLength(2)
    const [rowA, rowB] = detail.rows
    // the record's name comes from the batch target (not parsed from the thread title)
    expect(rowA).toMatchObject({ targetId: a, label: nameA, turnStatus: 'waiting' })
    expect(rowB.label).toBe((await customerRow(b)).name)
    expect(rowA.pending).toHaveLength(1)
    // onlyEmpty (default): the filled city of A is not among the changes
    expect(rowA.pending[0].payload.changes).toEqual({
      target: `${nameA} (#${a})`,
      fields: [
        { field: 'website', from: null, to: `https://c${a}.example.com` },
        { field: 'industry', from: null, to: 'Testing' },
      ],
    })
    expect(rowB.pending[0].payload.changes.fields.map((f: { field: string }) => f.field)).toEqual([
      'website',
      'industry',
      'city',
    ])
    // nothing written before the decision
    expect((await customerRow(a)).website).toBeNull()

    const decided = await http()
      .post(`${URL}/${batch.id}/decide`)
      .set(bearer(tok.owner))
      .send({ decision: 'approve' })
    expect(decided.status).toBe(200)
    expect(decided.body.data).toEqual({ decided: 2, skipped: 0 })
    await allRows(batch.id, ['completed'])
    expect(await customerRow(a)).toMatchObject({
      city: 'Paris',
      website: `https://c${a}.example.com`,
      industry: 'Testing',
    })
    expect(await customerRow(b)).toMatchObject({ city: 'Berlin', industry: 'Testing' })
    const done = (await http().get(`${URL}/${batch.id}`).set(bearer(tok.owner)).expect(200)).body
      .data
    expect(done.batch).toMatchObject({ status: 'completed', finished: 2, failed: 0 })
    expect(done.rows.every((r: { pending: unknown[] }) => !r.pending.length)).toBe(true)
    // nothing left to decide
    expect(
      (
        await http()
          .post(`${URL}/${batch.id}/decide`)
          .set(bearer(tok.owner))
          .send({ decision: 'approve' })
      ).body.data,
    ).toEqual({ decided: 0, skipped: 0 })
    firstDelay = 0
    await setParam(AGENT_LIMIT_PARAMS.userConcurrentTurns, '2')
  })

  it('reject all: the turns end and nothing is written', async () => {
    const c = await customer({})
    const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [c] })
    expect(res.status).toBe(201)
    await allRows(res.body.data.id, ['waiting'])
    const out = await http()
      .post(`${URL}/${res.body.data.id}/decide`)
      .set(bearer(tok.owner))
      .send({ decision: 'reject' })
    expect(out.body.data).toEqual({ decided: 1, skipped: 0 })
    await allRows(res.body.data.id, ['completed'])
    expect(await customerRow(c)).toMatchObject({ website: null, city: null, industry: null })
  })

  it('approve all leaves a card whose tool only a person confirms pending (skipped)', async () => {
    await ds.query(
      `INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES ('demo.customer.update', 1, 'human') AS n
        ON DUPLICATE KEY UPDATE agent_policy = n.agent_policy`,
    )
    try {
      const c = await customer({})
      const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [c] })
      expect(res.status).toBe(201)
      const id = res.body.data.id
      await allRows(id, ['waiting'])
      const detail = (await http().get(`${URL}/${id}`).set(bearer(tok.owner)).expect(200)).body.data
      expect(detail.rows[0].pending[0].payload).toMatchObject({
        tool: 'demo.customer.update',
        human: true,
      })
      const out = await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(tok.owner))
        .send({ decision: 'approve' })
      expect(out.body.data).toEqual({ decided: 0, skipped: 1 })
      expect((await customerRow(c)).website).toBeNull()
      // rejecting all only tightens: it still goes through
      const rejected = await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(tok.owner))
        .send({ decision: 'reject' })
      expect(rejected.body.data).toEqual({ decided: 1, skipped: 0 })
      await allRows(id, ['completed'])
      expect((await customerRow(c)).website).toBeNull()
    } finally {
      await ds.query(
        "UPDATE cfg_mcp_tool SET agent_policy = NULL WHERE name = 'demo.customer.update'",
      )
    }
  })

  it('approve all re-checks the policy: a tool set to human while its card waits is skipped', async () => {
    try {
      const c = await customer({})
      const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [c] })
      expect(res.status).toBe(201)
      const id = res.body.data.id
      await allRows(id, ['waiting'])
      const detail = (await http().get(`${URL}/${id}`).set(bearer(tok.owner)).expect(200)).body.data
      expect(detail.rows[0].pending[0].payload.human).toBeUndefined()
      await ds.query(
        `INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES ('demo.customer.update', 1, 'human') AS n
          ON DUPLICATE KEY UPDATE agent_policy = n.agent_policy`,
      )
      const out = await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(tok.owner))
        .send({ decision: 'approve' })
      expect(out.body.data).toEqual({ decided: 0, skipped: 1 })
      expect((await customerRow(c)).website).toBeNull()
      await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(tok.owner))
        .send({ decision: 'reject' })
        .expect(200)
      await allRows(id, ['completed'])
    } finally {
      await ds.query(
        "UPDATE cfg_mcp_tool SET agent_policy = NULL WHERE name = 'demo.customer.update'",
      )
    }
  })

  it("decide all leaves an approval that writes another row's record pending (skipped)", async () => {
    const a = await customer({})
    const b = await customer({})
    redirect.set(a, b)
    try {
      const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [a] })
      expect(res.status).toBe(201)
      const id = res.body.data.id
      await allRows(id, ['waiting'])
      const out = await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(tok.owner))
        .send({ decision: 'approve' })
      expect(out.status).toBe(200)
      expect(out.body.data).toEqual({ decided: 0, skipped: 1 })
      // nothing written to B; the approval still waits for a one-by-one decision
      expect((await customerRow(b)).website).toBeNull()
      const detail = (await http().get(`${URL}/${id}`).set(bearer(tok.owner)).expect(200)).body.data
      expect(detail.rows[0]).toMatchObject({ targetId: a, turnStatus: 'waiting' })
      expect(detail.rows[0].pending).toHaveLength(1)
      expect(detail.rows[0].pending[0].payload.args.id).toBe(b)
    } finally {
      redirect.delete(a)
    }
  })

  it('decide all leaves approvals of tools the target did not declare pending, an external tool too', async () => {
    const a = await customer({})
    const b = await customer({})
    steer.set(a, [{ name: 'test.batch.write', args: { id: a } }])
    steer.set(b, [{ name: EXT.name, args: { id: b } }])
    const list = vi
      .spyOn(app.get<ExternalToolSource>(EXTERNAL_TOOL_SOURCE), 'list')
      .mockResolvedValue([EXT])
    try {
      const res = await create({ skill: ANY_SKILL, target: 'demo.customer', ids: [a, b] })
      expect(res.status).toBe(201)
      const id = res.body.data.id
      await allRows(id, ['waiting'])
      const detail = (await http().get(`${URL}/${id}`).set(bearer(tok.owner)).expect(200)).body.data
      // both write the row's own id; the first even previews the row's own record
      expect(detail.rows[0].pending[0].payload).toMatchObject({
        tool: 'test.batch.write',
        args: { id: a },
        changes: { target: `row (#${a})` },
      })
      expect(detail.rows[1].pending[0].payload).toMatchObject({ tool: EXT.name, args: { id: b } })
      const out = await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(tok.owner))
        .send({ decision: 'approve' })
      expect(out.body.data).toEqual({ decided: 0, skipped: 2 })
      expect(written).toEqual([])
      // one by one they can still be decided
      for (const row of detail.rows)
        await http()
          .post(`/api/agent/approvals/${row.pending[0].id}`)
          .set(bearer(tok.owner))
          .send({ decision: 'reject' })
          .expect(201)
      await allRows(id, ['completed'])
      expect(written).toEqual([])
    } finally {
      steer.clear()
      list.mockRestore()
    }
  })

  it('reads record names under the target perm’s data scope, not the batch perm’s', async () => {
    const [d1, d2] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_dept WHERE tenant_id = 1 AND deleted_at IS NULL ORDER BY id LIMIT 2',
    )
    // batch.run with scope all, the customer perms with scope own dept
    const runner = await role([agentPerms.chat.use, agentPerms.batch.run], 'all')
    const reader = await role(
      [customerPerms.browse, customerPerms.view, customerPerms.modify],
      'own_dept',
    )
    const u = await user(runner, d1!.id)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
      u.id,
      reader,
    ])
    const token = (await signIn(app, (await userName(u.id))!)).accessToken
    const outside = await customer({ dept_id: d2!.id })
    const inside = await customer({ dept_id: d1!.id })
    const refused = await create(
      { skill: ENRICH_SKILL, target: 'demo.customer', ids: [outside] },
      token,
    )
    expect(refused.status).toBe(404)
    expect(JSON.stringify(refused.body)).not.toContain((await customerRow(outside)).name)
    const ok = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [inside] }, token)
    expect(ok.status).toBe(201)
    const detail = (await http().get(`${URL}/${ok.body.data.id}`).set(bearer(token)).expect(200))
      .body.data
    expect(detail.rows[0].label).toBe((await customerRow(inside)).name)
    await allRows(ok.body.data.id, ['waiting'])
    await http()
      .post(`${URL}/${ok.body.data.id}/decide`)
      .set(bearer(token))
      .send({ decision: 'reject' })
      .expect(200)
  })

  it("another user's batch and another tenant's are 404; their records cannot be batched", async () => {
    const c = await customer({})
    const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [c] })
    expect(res.status).toBe(201)
    const id = res.body.data.id
    await allRows(id, ['waiting'])
    for (const token of [tok.other, tok.tenant]) {
      expect((await http().get(`${URL}/${id}`).set(bearer(token))).status).toBe(404)
      const d = await http()
        .post(`${URL}/${id}/decide`)
        .set(bearer(token))
        .send({ decision: 'approve' })
      expect(d.status).toBe(404)
    }
    // a record of the default tenant is unknown in another tenant
    expect(
      (await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids: [c] }, tok.tenant)).status,
    ).toBe(404)
    // still pending for the owner
    expect((await customerRow(c)).website).toBeNull()
    const own = await http().post(`${URL}/${id}/decide`).set(bearer(tok.owner)).send({
      decision: 'reject',
    })
    expect(own.body.data).toEqual({ decided: 1, skipped: 0 })
  })

  it('stops starting rows at the first row the concurrency limit refuses', async () => {
    const queue = app.get(TurnQueue)
    const started = vi.spyOn(queue, 'startQueued').mockResolvedValue('full')
    const ids = [await customer({}), await customer({}), await customer({})]
    let batchId = 0
    try {
      const res = await create({ skill: ENRICH_SKILL, target: 'demo.customer', ids })
      expect(res.status).toBe(201)
      batchId = res.body.data.id
      const mine = new Set((await rows(batchId)).map((r) => r.id))
      expect(started.mock.calls.filter(([t]) => mine.has(t))).toHaveLength(1)
    } finally {
      started.mockRestore()
      // the rows never started: remove them so later pumps do not pick them up
      const threads = (await rows(batchId)).map((r) => r.id)
      if (threads.length) {
        await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
        await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
      }
      await ds.query('DELETE FROM agent_batch WHERE id = ?', [batchId])
    }
  })

  it('403 without agent.batch.run or the target read perm; 422 for an unknown target; 404 for an unknown skill or record; 400 for a bad body', async () => {
    const c = await customer({})
    const body = { skill: ENRICH_SKILL, target: 'demo.customer', ids: [c] }
    expect((await create(body, tok.plain)).status).toBe(403)
    // the target's own read perm is needed too (else record names could be probed by id)
    expect((await create(body, tok.blind)).status).toBe(403)
    expect((await http().get(`${URL}/1`).set(bearer(tok.plain))).status).toBe(403)
    expect(
      (await http().post(`${URL}/1/decide`).set(bearer(tok.plain)).send({ decision: 'approve' }))
        .status,
    ).toBe(403)
    expect((await create({ ...body, target: 'demo.nothing' })).status).toBe(422)
    expect((await create({ ...body, skill: 'no-such-skill' })).status).toBe(404)
    expect((await create({ ...body, ids: [c, 999_999_999] })).status).toBe(404)
    expect((await create({ ...body, ids: [] })).status).toBe(400)
    expect(
      (await http().post(`${URL}/1/decide`).set(bearer(tok.owner)).send({ decision: 'maybe' }))
        .status,
    ).toBe(400)
    // nothing was created by the refused requests
    expect(
      await ds.query('SELECT id FROM agent_thread WHERE target_ref = ? AND user_id = ?', [
        `demo.customer:${c}`,
        ownerId,
      ]),
    ).toEqual([])
  })
})

describe('customer tools', () => {
  const p = (perms: string[], extra: Partial<Principal> = {}): Principal => ({
    userId: ownerId,
    username: 'tools',
    deptId: null,
    deptTreePath: null,
    roles: [{ code: 'x', dataScope: 'all', perms }],
    perms,
    tenantId: 1,
    ...extra,
  })
  const call = (who: Principal, name: string, args: unknown) =>
    inTenant1(() => app.get(ToolHost).call(who, name, args, { threadId: 1, turnId: 1 }))
  const all = p([customerPerms.browse, customerPerms.view, customerPerms.modify])

  it('search tells which fields are empty; get reads one', async () => {
    const id = await customer({ city: 'Rome', website: 'https://r.example.com' })
    const name = (await customerRow(id)).name
    const out = await call(all, 'demo.customer.search', { keyword: name })
    expect(out.ok).toBe(true)
    expect(JSON.parse((out as { text: string }).text)).toEqual({
      items: [{ id, name, empty: ['industry', 'scale', 'phone', 'address', 'intro'] }],
    })
    const got = await call(all, 'demo.customer.get', { id })
    expect(JSON.parse((got as { text: string }).text)).toMatchObject({ id, city: 'Rome' })
  })

  it('update fills only empty fields unless onlyEmpty is false; the preview lists what changes', async () => {
    const id = await customer({ city: 'Rome' })
    const args = { id, city: 'Milan', phone: '+39 1' }
    const preview = await inTenant1(() =>
      app.get(ToolHost).preview(all, 'demo.customer.update', args),
    )
    expect(preview?.fields).toEqual([{ field: 'phone', from: null, to: '+39 1' }])
    const out = await call(all, 'demo.customer.update', args)
    expect(JSON.parse((out as { text: string }).text)).toEqual({
      id,
      updated: ['phone'],
      kept: ['city'],
    })
    expect(await customerRow(id)).toMatchObject({ city: 'Rome', phone: '+39 1' })
    await call(all, 'demo.customer.update', { ...args, onlyEmpty: false })
    expect((await customerRow(id)).city).toBe('Milan')
  })

  it('perms and data scope apply: no modify perm is refused, a row of another dept is not found', async () => {
    const [d1, d2] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_dept WHERE tenant_id = 1 AND deleted_at IS NULL ORDER BY id LIMIT 2',
    )
    const id = await customer({ dept_id: d2!.id })
    const reader = p([customerPerms.browse, customerPerms.view])
    expect((await call(reader, 'demo.customer.update', { id, city: 'X' })).ok).toBe(false)
    const scoped = p([customerPerms.browse, customerPerms.view, customerPerms.modify], {
      deptId: d1!.id,
      roles: [
        {
          code: 'x',
          dataScope: 'own_dept',
          perms: [customerPerms.browse, customerPerms.view, customerPerms.modify],
        },
      ],
    })
    const out = await call(scoped, 'demo.customer.update', { id, city: 'X' })
    expect(out).toMatchObject({ ok: false })
    expect((await call(scoped, 'demo.customer.get', { id })).ok).toBe(false)
    expect((await customerRow(id)).city).toBeNull()
  })
})
