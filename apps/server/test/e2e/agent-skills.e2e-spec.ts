import { TEST_AGENT_PRICING, clearAgentUsage } from '../setup/agent-pricing.js'
// Agent skills and instructions (see docs/agent.md): own skills for anyone on the chat page, tenant-wide
// ones behind agent.skill.*, platform skills root-only on the platform page; another user's own skill and
// another tenant's are 404; the skill source resolves a name own > tenant > platform and lists one per name;
// SKILL.md import accepts only the small front-matter format (anything else is a skill_invalid) and export
// reads back unchanged; a thread becomes a disabled draft through the default model (a fake one here);
// personal and tenant instructions compose with the platform param and the tone line. Multi-tenancy on.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  AGENT_INSTRUCTIONS_PARAM,
  AGENT_LIMIT_PARAMS,
  AGENT_PAUSED_PARAM,
  agentPerms,
  Err,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import {
  INSTRUCTION_SOURCE,
  type InstructionSource,
  SKILL_SOURCE,
  type SkillSource,
} from '../../src/core/agent/agent-ports.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { FakeChatModel } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { TONE_LINES } from '../../src/core/agent/skills/instruction.service.js'
import { formatSkillMd, parseSkillMd } from '../../src/core/agent/skills/skill-md.js'
import { UNTRUSTED_NOTE } from '../../src/core/agent/web/web-tools.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agskill-'
const { chat, skill, instruction } = agentPerms

let app: NestExpressApplication
let ds: DataSource
let root: string
let member: string
let manager: string
let reader: string
let memberId = 0
let managerId = 0
let readerId = 0
const roleIds: number[] = []
let other: PeopledTenant
let otherAdmin: string
let source: SkillSource
let providerId = 0
let platformBefore: string | null = null

const http = () => request(app.getHttpServer())
const principal = (userId: number): Principal => ({
  userId,
  deptId: null,
  deptTreePath: null,
  roles: [],
  perms: [],
  tenantId: 1,
})
const body = (name: string, extra: object = {}) => ({
  name: `${PREFIX}${name}`,
  description: `When ${name} is needed`,
  body: `Do ${name} step by step.`,
  ...extra,
})
const post = (token: string, b: object) =>
  http().post('/api/agent/skills').set(bearer(token)).send(b)

/** A thread of `userId` with one user message and one answer to draft from. */
async function thread(userId: number, name: string): Promise<number> {
  const { insertId } = await ds.query<{ insertId: number }>(
    'INSERT INTO agent_thread (tenant_id, user_id, title) VALUES (1, ?, ?)',
    [userId, `${PREFIX}${name}`],
  )
  for (const [seq, kind] of [
    [1, 'user'],
    [2, 'assistant'],
  ] as const)
    await ds.query(
      'INSERT INTO agent_item (tenant_id, thread_id, seq, kind, payload) VALUES (1, ?, ?, ?, ?)',
      [Number(insertId), seq, kind, JSON.stringify({ text: `${kind} text` })],
    )
  return Number(insertId)
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
const MANAGER_PERMS = [
  chat.use,
  skill.browse,
  skill.create,
  skill.modify,
  skill.remove,
  instruction.modify,
]

beforeAll(async () => {
  const env = { ...process.env, APP_MULTI_TENANT: 'true', APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  source = app.get<SkillSource>(SKILL_SOURCE)
  root = (await signIn(app)).accessToken
  memberId = await userWith('member', [chat.use])
  managerId = await userWith('manager', MANAGER_PERMS)
  readerId = await addUser(app, 1, `${PREFIX}reader`)
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
  member = (await signIn(app, `${PREFIX}member`)).accessToken
  manager = (await signIn(app, `${PREFIX}manager`)).accessToken
  other = await createTenant(app, { users: true })
  // the other tenant's manager: every agent perm a tenant may hold (its rows go with the tenant)
  await userWith('b-manager', MANAGER_PERMS, other.id)
  otherAdmin = (await signIn(app, `${PREFIX}b-manager`, {}, other.id)).accessToken
  platformBefore = await app.get(ParamService).get(AGENT_INSTRUCTIONS_PARAM)
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM agent_skill WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_skill WHERE tenant_id = 1 AND owner_user_id IN (?)', [
      [memberId, managerId],
    ])
    await ds.query('DELETE FROM agent_platform_skill WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query(
      'DELETE FROM agent_instruction WHERE tenant_id = 1 AND owner_user_id IN (0, ?, ?)',
      [memberId, managerId],
    )
    await ds.query(
      'DELETE FROM agent_item WHERE tenant_id = 1 AND thread_id IN (SELECT id FROM agent_thread WHERE title LIKE ?)',
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM agent_thread WHERE tenant_id = 1 AND title LIKE ?', [`${PREFIX}%`])
    if (providerId) await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
    await clearAgentUsage(ds, [memberId])
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      platformBefore ?? '',
      AGENT_INSTRUCTIONS_PARAM,
    ])
    await app.get(ParamService).invalidate(AGENT_INSTRUCTIONS_PARAM)
    const users = [memberId, managerId, readerId].filter(Boolean)
    if (users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  await other?.dispose()
  await app?.close()
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('skills', () => {
  it('own skills for anyone, tenant-wide ones need agent.skill.*', async () => {
    const own = await post(member, body('own'))
    expect(own.status).toBe(201)
    expect(own.body.data).toMatchObject({
      scope: 'user',
      editable: true,
      enabled: true,
      tools: null,
    })
    expect((await post(member, body('wide', { scope: 'tenant' }))).status).toBe(403)
    const wide = await post(manager, body('wide', { scope: 'tenant' }))
    expect(wide.status).toBe(201)
    expect(wide.body.data.scope).toBe('tenant')
    const off = await post(manager, body('wide-off', { scope: 'tenant', enabled: false }))
    expect(off.status).toBe(201)
    expect((await post(member, body('own', { description: 'again' }))).status).toBe(409)
    expect((await post(member, body('bad name'))).status).toBe(400)

    const seen = (await http().get('/api/agent/skills').set(bearer(member))).body.data as {
      name: string
      scope: string
      editable: boolean
    }[]
    const names = seen.map((s) => s.name)
    expect(names).toContain(`${PREFIX}own`)
    expect(names).toContain(`${PREFIX}wide`)
    expect(names).not.toContain(`${PREFIX}wide-off`)
    expect(seen.find((s) => s.name === `${PREFIX}wide`)).toMatchObject({ editable: false })
    const managed = (await http().get('/api/agent/skills').set(bearer(manager))).body.data as {
      name: string
    }[]
    expect(managed.map((s) => s.name)).toContain(`${PREFIX}wide-off`)
    expect(managed.map((s) => s.name)).not.toContain(`${PREFIX}own`)

    const ownId = own.body.data.id as number
    const wideId = wide.body.data.id as number
    // another user's own skill does not exist for the caller
    expect(
      (await http().put(`/api/agent/skills/${ownId}`).set(bearer(manager)).send(body('x'))).status,
    ).toBe(404)
    expect(
      (await http().get(`/api/agent/skills/${ownId}/export`).set(bearer(manager))).status,
    ).toBe(404)
    // tenant-wide changes need the perm
    expect(
      (await http().put(`/api/agent/skills/${wideId}`).set(bearer(member)).send(body('wide')))
        .status,
    ).toBe(403)
    expect((await http().delete(`/api/agent/skills/${wideId}`).set(bearer(member))).status).toBe(
      403,
    )
    const changed = await http()
      .put(`/api/agent/skills/${wideId}`)
      .set(bearer(manager))
      .send(body('wide', { body: 'Changed body.', scope: 'user' }))
    expect(changed.status).toBe(200)
    expect(changed.body.data).toMatchObject({ scope: 'tenant', body: 'Changed body.' })
    const mine = await http()
      .put(`/api/agent/skills/${ownId}`)
      .set(bearer(member))
      .send(body('own', { enabled: false }))
    expect(mine.status).toBe(200)
    expect(mine.body.data.enabled).toBe(false)
    // another tenant: 404, whatever its perms
    expect(
      (await http().get(`/api/agent/skills/${wideId}/export`).set(bearer(otherAdmin))).status,
    ).toBe(404)
    expect(
      (await http().put(`/api/agent/skills/${wideId}`).set(bearer(otherAdmin)).send(body('wide')))
        .status,
    ).toBe(404)
    expect(
      (await http().delete(`/api/agent/skills/${wideId}`).set(bearer(otherAdmin))).status,
    ).toBe(404)
    const theirs = (await http().get('/api/agent/skills').set(bearer(otherAdmin))).body.data as {
      name: string
    }[]
    expect(theirs.map((s) => s.name)).not.toContain(`${PREFIX}wide`)
    // no chat perm at all
    expect((await http().get('/api/agent/skills').set(bearer(reader))).status).toBe(403)
    expect((await http().delete(`/api/agent/skills/${ownId}`).set(bearer(member))).status).toBe(200)
  })

  it('resolves a name own > tenant > platform, listing one per name', async () => {
    const plat = await http()
      .post('/api/agent/platform-skills')
      .set(bearer(root))
      .send(body('same', { body: 'platform body' }))
    expect(plat.status).toBe(201)
    expect(plat.body.data.scope).toBe('platform')
    const wide = await post(manager, body('same', { scope: 'tenant', body: 'tenant body' }))
    const own = await post(member, body('same', { body: 'own body' }))
    const load = () => inTenant1(() => source.load(principal(memberId), `${PREFIX}same`))
    const listed = async () =>
      (await inTenant1(() => source.listFor(principal(memberId)))).filter(
        (s) => s.name === `${PREFIX}same`,
      )
    expect(await load()).toEqual({
      id: own.body.data.id,
      name: `${PREFIX}same`,
      body: 'own body',
      tools: null,
      scope: 'user',
    })
    // by id and scope the platform one is found although the member's own shadows it by name; another
    // user's personal skill is not
    const byRef = (userId: number, ref: { id: number; scope: 'user' | 'platform' }) =>
      inTenant1(() => source.loadRef(principal(userId), ref))
    expect(await byRef(memberId, { id: plat.body.data.id, scope: 'platform' })).toMatchObject({
      body: 'platform body',
      scope: 'platform',
    })
    expect(await byRef(memberId, { id: own.body.data.id, scope: 'user' })).toMatchObject({
      body: 'own body',
    })
    expect(await byRef(managerId, { id: own.body.data.id, scope: 'user' })).toBeNull()
    expect(await listed()).toEqual([
      { name: `${PREFIX}same`, description: 'When same is needed', scope: 'user' },
    ])
    await http()
      .put(`/api/agent/skills/${own.body.data.id}`)
      .set(bearer(member))
      .send(body('same', { body: 'own body', enabled: false }))
    expect(await load()).toMatchObject({ body: 'tenant body', scope: 'tenant' })
    await http()
      .put(`/api/agent/skills/${wide.body.data.id}`)
      .set(bearer(manager))
      .send(body('same', { body: 'tenant body', enabled: false }))
    expect(await load()).toMatchObject({ body: 'platform body', scope: 'platform' })
    expect((await listed())[0]?.scope).toBe('platform')
    // another tenant sees only the platform one
    expect((await withOther(() => source.load(principal(memberId), `${PREFIX}same`)))?.body).toBe(
      'platform body',
    )
    await http()
      .put(`/api/agent/platform-skills/${plat.body.data.id}`)
      .set(bearer(root))
      .send(body('same', { body: 'platform body', enabled: false }))
    expect(await load()).toBeNull()
    expect(await inTenant1(() => source.load(principal(memberId), 'nope'))).toBeNull()
  })

  it('keeps platform skills on the root-only platform page', async () => {
    expect((await http().get('/api/agent/platform-skills').set(bearer(member))).status).toBe(403)
    expect((await http().get('/api/agent/platform-skills').set(bearer(otherAdmin))).status).toBe(
      403,
    )
    expect(
      (await http().post('/api/agent/platform-skills').set(bearer(otherAdmin)).send(body('p2')))
        .status,
    ).toBe(403)
    expect((await http().get('/api/agent/platform-skills').set(bearer(root))).status).toBe(200)
    expect(
      (await http().put('/api/agent/platform-skills/99999999').set(bearer(root)).send(body('p3')))
        .status,
    ).toBe(404)
  })
})

describe('SKILL.md', () => {
  const md = (front: string, text = 'Body text.') => `---\n${front}\n---\n\n${text}\n`
  const importAs = (token: string, text: string, scope = 'user') =>
    http().post('/api/agent/skills/import').set(bearer(token)).send({ text, scope })

  it('imports the front-matter format and exports it back unchanged', async () => {
    const text = md(
      `name: ${PREFIX}imp\ndescription: "When: a \\"quoted\\" case"\ntools:\n  - web.search\n  - 'demo.customer.get'`,
      '# Steps\n\n1. Search.\n2. Fill: only empty fields.',
    )
    const res = await importAs(member, text)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      name: `${PREFIX}imp`,
      description: 'When: a "quoted" case',
      tools: ['web.search', 'demo.customer.get'],
      body: '# Steps\n\n1. Search.\n2. Fill: only empty fields.',
      scope: 'user',
    })
    const out = await http().get(`/api/agent/skills/${res.body.data.id}/export`).set(bearer(member))
    expect(out.status).toBe(200)
    expect(parseSkillMd(out.body.data.text)).toEqual({
      name: `${PREFIX}imp`,
      description: 'When: a "quoted" case',
      tools: ['web.search', 'demo.customer.get'],
      body: '# Steps\n\n1. Search.\n2. Fill: only empty fields.',
    })
    const again = out.body.data.text.replace(`name: ${PREFIX}imp`, `name: ${PREFIX}imp2`)
    expect((await importAs(member, again)).status).toBe(201)
    expect((await importAs(member, text, 'tenant')).status).toBe(403)
    const inline = await importAs(
      manager,
      md(`name: ${PREFIX}inline\ndescription: x\ntools: [a.b, "c.d"]`),
      'tenant',
    )
    expect(inline.status).toBe(201)
    expect(inline.body.data).toMatchObject({ scope: 'tenant', tools: ['a.b', 'c.d'] })
    const s = { name: 'rt', description: 'a: "b" 中', tools: null, body: 'x\n---\ny' }
    expect(parseSkillMd(formatSkillMd(s))).toEqual(s)
  })

  it('refuses anything outside the format', async () => {
    const bad: [string, string][] = [
      ['no front matter', `name: ${PREFIX}x\n\nbody`],
      ['unclosed', `---\nname: ${PREFIX}x\ndescription: d\nbody`],
      ['unknown key', md(`name: ${PREFIX}x\ndescription: d\nrun: rm -rf /`)],
      ['duplicate key', md(`name: ${PREFIX}x\nname: ${PREFIX}y\ndescription: d`)],
      ['anchor', md(`name: &a ${PREFIX}x\ndescription: d`)],
      ['tag', md(`name: ${PREFIX}x\ndescription: !!js/function d`)],
      ['block scalar', md(`name: ${PREFIX}x\ndescription: |\n  d`)],
      ['flow map', md(`name: ${PREFIX}x\ndescription: {a: 1}`)],
      ['bad name', md('name: has space\ndescription: d')],
      ['no description', md(`name: ${PREFIX}x`)],
      ['empty body', md(`name: ${PREFIX}x\ndescription: d`, '')],
      ['tools not a list', md(`name: ${PREFIX}x\ndescription: d\ntools: web.search`)],
    ]
    for (const [label, text] of bad) {
      const res = await importAs(member, text)
      expect([label, res.status, res.body.code]).toEqual([label, 422, Err.AGENT_SKILL_INVALID.code])
    }
    expect(() => parseSkillMd(md('name: x'))).toThrow(BizError)
  })
})

describe('skill from a thread', () => {
  it('drafts a disabled own skill with the default model; another user thread is 404', async () => {
    const prov = await http()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send({
        name: `${PREFIX}model`,
        baseUrl: 'https://api.example.com/v1',
        models: [{ id: 'm1', pricing: TEST_AGENT_PRICING }],
        isDefault: true,
        sort: -1000,
      })
    expect(prov.status).toBe(201)
    providerId = prov.body.data.id
    const { insertId } = await ds.query<{ insertId: number }>(
      'INSERT INTO agent_thread (tenant_id, user_id, title) VALUES (1, ?, ?)',
      [memberId, `${PREFIX}thread`],
    )
    const threadId = Number(insertId)
    const items: [string, string][] = [
      ['user', 'Fill the CRM record of Acme from its website'],
      ['assistant', 'I searched Acme and filled industry and city.'],
      ['tool_result', 'SECRET TOOL OUTPUT'],
    ]
    for (const [i, [kind, text]] of items.entries())
      await ds.query(
        'INSERT INTO agent_item (tenant_id, thread_id, seq, kind, payload) VALUES (1, ?, ?, ?, ?)',
        [threadId, i + 1, kind, JSON.stringify({ text })],
      )
    const fake = new FakeChatModel([
      {
        text: 'Here it is: {"name":"Fill CRM!","description":"When a CRM record has empty fields","body":"1. Search.\\n2. Fill."}',
      },
    ])
    vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(fake)
    const res = await http()
      .post(`/api/agent/skills/from-thread/${threadId}`)
      .set(bearer(member))
      .send({})
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      scope: 'user',
      enabled: false,
      name: 'Fill-CRM',
      description: 'When a CRM record has empty fields',
      body: '1. Search.\n2. Fill.',
    })
    const sent = fake.requests[0]!.messages.map((m) => ('content' in m ? m.content : '')).join('\n')
    expect(sent).toContain(UNTRUSTED_NOTE)
    expect(sent).toContain('Fill the CRM record of Acme')
    expect(sent).not.toContain('SECRET TOOL OUTPUT')

    expect(
      (await http().post(`/api/agent/skills/from-thread/${threadId}`).set(bearer(manager)).send({}))
        .status,
    ).toBe(404)
    expect(
      (
        await http()
          .post(`/api/agent/skills/from-thread/${threadId}`)
          .set(bearer(otherAdmin))
          .send({})
      ).status,
    ).toBe(404)
    // the model call is counted like a turn's
    const [used] = await ds.query<{ calls: number; tokens: number }[]>(
      `SELECT SUM(calls) AS calls, SUM(prompt_tokens + completion_tokens) AS tokens
         FROM agent_usage WHERE tenant_id = 1 AND user_id = ? AND model = 'm1'`,
      [memberId],
    )
    expect(Number(used!.calls)).toBe(1)
    expect(Number(used!.tokens)).toBe(15)
    // one draft per thread for a while, whatever the body says
    const again = await http()
      .post(`/api/agent/skills/from-thread/${threadId}`)
      .set(bearer(member))
      .send({ name: `${PREFIX}again` })
    expect(again.status).toBe(429)

    const second = await thread(memberId, 'second')
    vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(
      new FakeChatModel([{ text: 'no json here' }]),
    )
    const broken = await http()
      .post(`/api/agent/skills/from-thread/${second}`)
      .set(bearer(member))
      .send({ name: `${PREFIX}given` })
    expect(broken.status).toBe(422)
    expect(broken.body.code).toBe(Err.AGENT_SKILL_INVALID.code)
    // a failed draft frees the thread for a retry
    const retry = new FakeChatModel([{ text: '{"name":"x","description":"d","body":"b"}' }])
    vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(retry)
    expect(
      (
        await http()
          .post(`/api/agent/skills/from-thread/${second}`)
          .set(bearer(member))
          .send({ name: `${PREFIX}retried` })
      ).status,
    ).toBe(201)
  })

  it('stops before the model while the agent is paused or the daily tokens are used up', async () => {
    const fake = new FakeChatModel([{ text: '{"name":"x","description":"d","body":"b"}' }])
    vi.spyOn(app.get(ProviderRegistry), 'connect').mockReturnValue(fake)
    const draft = async (name: string) =>
      http()
        .post(`/api/agent/skills/from-thread/${await thread(memberId, name)}`)
        .set(bearer(member))
        .send({ name: `${PREFIX}${name}` })
    const params = app.get(ParamService)
    const before = {
      paused: (await params.get(AGENT_PAUSED_PARAM)) ?? 'false',
      limit: (await params.get(AGENT_LIMIT_PARAMS.userDailyCredits)) ?? '1000000',
    }
    try {
      await setParam(AGENT_PAUSED_PARAM, 'true')
      const paused = await draft('paused')
      expect(paused.status).toBe(Err.AGENT_PAUSED.status)
      expect(paused.body.code).toBe(Err.AGENT_PAUSED.code)
      await setParam(AGENT_PAUSED_PARAM, 'false')
      // the earlier drafts of this user already used more than one token today
      await setParam(AGENT_LIMIT_PARAMS.userDailyCredits, '1')
      const limited = await draft('limited')
      expect(limited.status).toBe(429)
      expect(limited.body.code).toBe(Err.AGENT_LIMIT.code)
      expect(fake.requests).toHaveLength(0)
    } finally {
      await setParam(AGENT_PAUSED_PARAM, before.paused)
      await setParam(AGENT_LIMIT_PARAMS.userDailyCredits, before.limit)
    }
  })
})

describe('platform SKILL.md', () => {
  it('imports and exports platform skills on the platform page; the own-skill export never reads them', async () => {
    const text = `---\nname: ${PREFIX}plat-md\ndescription: For every tenant\n---\n\nPlatform body.\n`
    const imp = await http()
      .post('/api/agent/platform-skills/import')
      .set(bearer(root))
      .send({ text })
    expect(imp.status).toBe(201)
    expect(imp.body.data).toMatchObject({
      scope: 'platform',
      name: `${PREFIX}plat-md`,
      enabled: true,
    })
    const id = imp.body.data.id as number
    const out = await http().get(`/api/agent/platform-skills/${id}/export`).set(bearer(root))
    expect(out.status).toBe(200)
    expect(parseSkillMd(out.body.data.text)).toMatchObject({
      name: `${PREFIX}plat-md`,
      body: 'Platform body.',
    })
    // the chat page's export reads own and tenant skills only (an id of the platform table is unknown there)
    const [taken] = await ds.query<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM agent_skill WHERE id = ?',
      [id],
    )
    if (Number(taken!.n) === 0)
      expect((await http().get(`/api/agent/skills/${id}/export`).set(bearer(member))).status).toBe(
        404,
      )
    for (const token of [member, otherAdmin]) {
      expect(
        (await http().get(`/api/agent/platform-skills/${id}/export`).set(bearer(token))).status,
      ).toBe(403)
      expect(
        (await http().post('/api/agent/platform-skills/import').set(bearer(token)).send({ text }))
          .status,
      ).toBe(403)
    }
    expect(
      (await http().get('/api/agent/platform-skills/99999999/export').set(bearer(root))).status,
    ).toBe(404)
  })
})

describe('instructions', () => {
  it('saves personal and tenant instructions and composes them after the platform ones', async () => {
    const mine = await http()
      .put('/api/agent/instructions/me')
      .set(bearer(member))
      .send({ body: 'Answer with tables.', tone: 'concise' })
    expect(mine.status).toBe(200)
    expect(mine.body.data).toEqual({ body: 'Answer with tables.', tone: 'concise' })
    // tone kept when only the body changes
    await http().put('/api/agent/instructions/me').set(bearer(member)).send({ body: 'Use tables.' })
    expect((await http().get('/api/agent/instructions/me').set(bearer(member))).body.data).toEqual({
      body: 'Use tables.',
      tone: 'concise',
    })
    expect(
      (await http().put('/api/agent/instructions/tenant').set(bearer(member)).send({ body: 'x' }))
        .status,
    ).toBe(403)
    const tenant = await http()
      .put('/api/agent/instructions/tenant')
      .set(bearer(manager))
      .send({ body: 'Our customers are B2B.' })
    expect(tenant.status).toBe(200)
    expect(
      (await http().get('/api/agent/instructions/tenant').set(bearer(member))).body.data,
    ).toEqual({ body: 'Our customers are B2B.' })
    // another tenant has its own
    expect(
      (await http().get('/api/agent/instructions/tenant').set(bearer(otherAdmin))).body.data,
    ).toEqual({ body: '' })
    expect(
      (await http().put('/api/agent/instructions/me').set(bearer(member)).send({ body: 1 })).status,
    ).toBe(400)

    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [
      'Never delete data.',
      AGENT_INSTRUCTIONS_PARAM,
    ])
    await app.get(ParamService).invalidate(AGENT_INSTRUCTIONS_PARAM)
    const text = await inTenant1(() =>
      app.get<InstructionSource>(INSTRUCTION_SOURCE).compose(principal(memberId)),
    )
    expect(text).toBe(
      [
        'Platform instructions:\nNever delete data.',
        'Organization instructions:\nOur customers are B2B.',
        "The user's own instructions:\nUse tables.",
        TONE_LINES.concise,
      ].join('\n\n'),
    )
    const managerText = await inTenant1(() =>
      app.get<InstructionSource>(INSTRUCTION_SOURCE).compose(principal(managerId)),
    )
    expect(managerText).not.toContain('Use tables.')
  })
})

/** Runs `fn` in the other tenant (the skill source reads the current tenant from the context). */
const withOther = <T>(fn: () => Promise<T>): Promise<T> => withTenant(other.id, fn)
