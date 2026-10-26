// Agent thread management (see docs/agent.md): the chat page's options, the owner-only thread routes
// (list with views and full-text search over message text, create, update, delete, items, fork, read,
// revert, export, status, read-all), read-only sharing within the tenant (tool details hidden from every
// viewer but the owner), answer feedback (one per user and answer), prompt templates (own and tenant-wide)
// and usage. Another user's thread and another tenant's are 404. Turns and items are written as rows
// here (the runtime that writes them is not needed for these routes). Multi-tenancy on.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AGENT_TRUST_MODE_PARAM, agentPerms, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agthr-'

let app: NestExpressApplication
let ds: DataSource
let roleId = 0
let providerId = 0
const ids: Record<'a' | 'b' | 'none', number> = { a: 0, b: 0, none: 0 }
const tok: Record<'a' | 'b' | 'none' | 'root' | 'other', string> = {
  a: '',
  b: '',
  none: '',
  root: '',
  other: '',
}
let rootId = 0
let other: PeopledTenant

const http = () => request(app.getHttpServer())
let titleSeq = 0
/** a unique title: two creates with the same body within 3 s would be a duplicate submit (429) */
const title = (s = 'thread') => `${PREFIX}${s}-${++titleSeq}`

/** a new thread of the token's owner through the API */
async function newThread(token: string, body: object = {}): Promise<number> {
  const res = await http()
    .post('/api/agent/threads')
    .set(bearer(token))
    .send({ title: title(), ...body })
  expect(res.status).toBe(201)
  return res.body.data.id as number
}

/** a turn row of `threadId` in tenant `tid` */
async function addTurn(threadId: number, userId: number, status: string, tid = 1) {
  const { insertId } = await ds.query<{ insertId: number }>(
    'INSERT INTO agent_turn (tenant_id, thread_id, user_id, status) VALUES (?, ?, ?, ?)',
    [tid, threadId, userId, status],
  )
  return Number(insertId)
}

/** an item row; `text` is what the search index reads (user and assistant messages) */
async function addItem(
  threadId: number,
  seq: number,
  kind: string,
  payload: object,
  opts: { turnId?: number | null; status?: string | null; text?: string | null; tid?: number } = {},
) {
  const { insertId } = await ds.query<{ insertId: number }>(
    `INSERT INTO agent_item (tenant_id, thread_id, turn_id, seq, kind, status, payload, text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.tid ?? 1,
      threadId,
      opts.turnId ?? null,
      seq,
      kind,
      opts.status ?? null,
      JSON.stringify(payload),
      opts.text ?? null,
    ],
  )
  return Number(insertId)
}

/** A thread with one finished turn: a question, a tool call with a secret argument, its result, an answer. */
async function conversation(token: string, ownerId: number) {
  const id = await newThread(token)
  const turn = await addTurn(id, ownerId, 'completed')
  await addItem(
    id,
    1,
    'user',
    { text: '帮我补齐客户信息' },
    { turnId: turn, text: '帮我补齐客户信息' },
  )
  await addItem(
    id,
    2,
    'tool_call',
    {
      callId: 'c1',
      tool: 'demo.book.create',
      title: 'Create a book',
      source: 'local',
      kind: 'write',
      args: { title: 'Dune', password: 'hunter2-secret' },
    },
    { turnId: turn, status: 'done' },
  )
  await addItem(
    id,
    3,
    'tool_result',
    { callId: 'c1', ok: true, preview: 'BOOK-PREVIEW-42', untrusted: false },
    { turnId: turn },
  )
  const answer = await addItem(
    id,
    4,
    'assistant',
    { text: '已经补齐了三家客户的官网' },
    { turnId: turn, text: '已经补齐了三家客户的官网' },
  )
  return { id, turn, answer }
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
  await cleanRedis(app.get<Redis>(REDIS))
  const { insertId } = await ds.query<{ insertId: number }>(
    'INSERT INTO agent_provider (name, base_url, models, enabled, is_default, sort) VALUES (?, ?, ?, 1, 1, -100)',
    [
      `${PREFIX}provider`,
      'http://127.0.0.1:9/v1',
      JSON.stringify([
        { id: 'chat-1', label: 'Chat 1', reasoning: false, fast: true, contextWindow: 32000 },
        { id: 'think-1', reasoning: true, vision: true, contextWindow: 128000 },
      ]),
    ],
  )
  providerId = Number(insertId)
  const chatMenu = await findId(ds.manager, 'iam_menu', { perms: agentPerms.chat.use })
  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}chat`,
      name: `${PREFIX}chat`,
      data_scope: 'all',
    }),
  )
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
    roleId,
    chatMenu,
  ])
  ids.a = await addUser(app, 1, `${PREFIX}a`, { roleId })
  ids.b = await addUser(app, 1, `${PREFIX}b`, { roleId })
  ids.none = await addUser(app, 1, `${PREFIX}none`)
  for (const k of ['a', 'b', 'none'] as const)
    tok[k] = (await signIn(app, `${PREFIX}${k}`)).accessToken
  const root = await signIn(app)
  tok.root = root.accessToken
  rootId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
      )
    )[0]!.id,
  )
  other = await createTenant(app, { users: true })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
    other.roleId,
    chatMenu,
    other.id,
  ])
  tok.other = (await signIn(app, 'admin', {}, other.id)).accessToken
})

afterAll(async () => {
  if (ds) {
    const users = [...Object.values(ids), rootId]
    const threads = (
      await ds.query<{ id: number }[]>(
        // qw:include-deleted the spec's own rows, deleted ones too
        'SELECT id FROM agent_thread WHERE tenant_id = 1 AND user_id IN (?)',
        [users],
      )
    ).map((r) => r.id)
    if (threads.length) {
      await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_feedback WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
    }
    await ds.query('DELETE FROM agent_prompt WHERE tenant_id = 1 AND name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_usage WHERE tenant_id = 1 AND model LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_instruction WHERE tenant_id = 1 AND owner_user_id IN (?)', [
      users,
    ])
    await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
    await ds.query(
      'DELETE FROM agent_mcp_tool WHERE server_id IN (SELECT id FROM agent_mcp_server WHERE name LIKE ?)',
      [`${PREFIX}%`],
    )
    await ds.query('DELETE FROM agent_mcp_server WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_user_roles WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [Object.values(ids)])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  await other?.dispose()
  await app?.close()
})

describe('options', () => {
  it('lists the enabled models with their flags and the default, modes, starters by language, prompts and tone; 403 without agent.chat.use', async () => {
    const res = await http().get('/api/agent/options').set(bearer(tok.a))
    expect(res.status).toBe(200)
    const o = res.body.data
    const mine = o.providers.find((p: { id: number }) => p.id === providerId)
    expect(mine.models).toEqual([
      {
        id: 'chat-1',
        label: 'Chat 1',
        reasoning: false,
        vision: false,
        fast: true,
        pricing: null,
        reasoningDefault: 'provider',
        reasoningStyle: 'standard',
        contextWindow: 32000,
      },
      {
        id: 'think-1',
        label: 'think-1',
        reasoning: true,
        vision: true,
        fast: false,
        pricing: null,
        reasoningDefault: 'provider',
        reasoningStyle: 'standard',
        contextWindow: 128000,
      },
    ])
    expect(o.defaults).toEqual({ providerId, model: 'chat-1' })
    expect(o.approvalModes).toEqual(['read_only', 'ask', 'trust'])
    // the seeded platform skills only (this spec adds none)
    expect(o.skills.filter((s: { scope: string }) => s.scope !== 'platform')).toEqual([])
    expect(o.paused).toBe(false)
    expect(o.webSearch).toBe(false)
    expect(o.tone).toBe('default')
    expect(o.trustSession).toBe(true)
    expect(o.servers).toEqual(expect.any(Array))
    expect(o.starters).toHaveLength(4)
    const en = await http()
      .get('/api/agent/options')
      .set(bearer(tok.a))
      .set('Accept-Language', 'en-US')
    expect(en.body.data.starters[0]).not.toBe(o.starters[0])
    expect(en.body.data.starters[0]).toMatch(/^[\x20-\x7e]+$/)

    await ds.query(
      'INSERT INTO agent_instruction (tenant_id, owner_user_id, body, tone) VALUES (1, ?, ?, ?)',
      [ids.a, '', 'concise'],
    )
    expect((await http().get('/api/agent/options').set(bearer(tok.a))).body.data.tone).toBe(
      'concise',
    )

    expect((await http().get('/api/agent/options').set(bearer(tok.none))).status).toBe(403)
  })

  it('starters fit the page the chat came from: up to three of its own first, then the defaults', async () => {
    const starters = async (route: string, lang = 'zh-CN') =>
      (
        await http()
          .get(`/api/agent/options?route=${encodeURIComponent(route)}`)
          .set(bearer(tok.a))
          .set('Accept-Language', lang)
          .expect(200)
      ).body.data.starters as string[]
    const defaults = (await http().get('/api/agent/options').set(bearer(tok.a))).body.data
      .starters as string[]
    for (const route of ['demo-customer', 'iam-user']) {
      const s = await starters(route)
      expect(s).toHaveLength(7)
      expect(s.slice(3)).toEqual(defaults)
      expect(s.slice(0, 3).every((x) => !defaults.includes(x) && !x.includes('starterFor'))).toBe(
        true,
      )
    }
    expect(await starters('agent-chat')).toHaveLength(6)
    const en = await starters('demo-customer', 'en-US')
    expect(en[0]).toMatch(/^[\x20-\x7e]+$/)
    // a page without its own starters, and a name that is no route name, get the defaults
    expect(await starters('demo-book')).toEqual(defaults)
    expect(await starters('starter')).toEqual(defaults)
    expect(await starters('demo-customer.s1')).toEqual(defaults)
    expect(
      (
        await http()
          .get(`/api/agent/options?route=${'x'.repeat(201)}`)
          .set(bearer(tok.a))
      ).status,
    ).toBe(400)
  })

  it('lists the external servers the agent may use now: enabled with an enabled, not denied tool', async () => {
    const server = async (name: string, enabled: number, tools: [string, number, string][]) => {
      const { insertId } = await ds.query<{ insertId: number }>(
        "INSERT INTO agent_mcp_server (name, url, auth_kind, enabled) VALUES (?, 'https://mcp.example.com/mcp', 'none', ?)",
        [`${PREFIX}${name}`, enabled],
      )
      for (const [tool, on, policy] of tools)
        await ds.query(
          'INSERT INTO agent_mcp_tool (server_id, name, enabled, policy) VALUES (?, ?, ?, ?)',
          [insertId, tool, on, policy],
        )
    }
    await server('srv-on', 1, [
      ['a', 1, 'ask'],
      ['b', 1, 'auto'],
    ])
    await server('srv-tools-off', 1, [['a', 0, 'ask']])
    await server('srv-denied', 1, [['a', 1, 'deny']])
    await server('srv-off', 0, [['a', 1, 'ask']])
    const o = (await http().get('/api/agent/options').set(bearer(tok.a))).body.data
    const mine = (o.servers as { name: string }[]).filter((s) => s.name.startsWith(PREFIX))
    expect(mine).toEqual([{ name: `${PREFIX}srv-on` }])
  })

  it('drops the trust mode while agent.trust_mode is false, and refuses it on a thread then', async () => {
    const params = app.get(ParamService)
    // only the word false turns it off, in any case and with blanks around it
    await ds.query("UPDATE cfg_param SET param_value = ' FALSE ' WHERE param_key = ?", [
      AGENT_TRUST_MODE_PARAM,
    ])
    await params.invalidate(AGENT_TRUST_MODE_PARAM)
    try {
      const o = (await http().get('/api/agent/options').set(bearer(tok.a))).body.data
      expect(o.approvalModes).toEqual(['read_only', 'ask'])
      expect(o.trustSession).toBe(false)
      const res = await http()
        .post('/api/agent/threads')
        .set(bearer(tok.a))
        .send({ title: title(), approvalMode: 'trust' })
      expect(res.status).toBe(400)
      const id = await newThread(tok.a)
      expect(
        (
          await http()
            .patch(`/api/agent/threads/${id}`)
            .set(bearer(tok.a))
            .send({ approvalMode: 'trust' })
        ).status,
      ).toBe(400)
      // any other value keeps it on
      await ds.query("UPDATE cfg_param SET param_value = 'off' WHERE param_key = ?", [
        AGENT_TRUST_MODE_PARAM,
      ])
      await params.invalidate(AGENT_TRUST_MODE_PARAM)
      const on = (await http().get('/api/agent/options').set(bearer(tok.a))).body.data
      expect(on.approvalModes).toEqual(['read_only', 'ask', 'trust'])
      expect(on.trustSession).toBe(true)
    } finally {
      await ds.query("UPDATE cfg_param SET param_value = 'true' WHERE param_key = ?", [
        AGENT_TRUST_MODE_PARAM,
      ])
      await params.invalidate(AGENT_TRUST_MODE_PARAM)
    }
  })
})

describe('threads', () => {
  it('creates with the default model, validates provider, model and reasoning; 400 for a bad body, 403 without the perm', async () => {
    const res = await http()
      .post('/api/agent/threads')
      .set(bearer(tok.a))
      .send({ title: title(), context: { route: '/demo/books', target: 'demo.book', ids: [1, 2] } })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      providerId,
      model: 'chat-1',
      reasoning: null,
      approvalMode: 'ask',
      planMode: false,
      temporary: false,
      unread: 0,
      shared: false,
      turnStatus: null,
    })
    const ctx = await ds.query<{ context: unknown }[]>(
      'SELECT context FROM agent_thread WHERE id = ?',
      [res.body.data.id],
    )
    expect(ctx[0]!.context).toEqual({ route: '/demo/books', target: 'demo.book', ids: [1, 2] })

    const think = await http()
      .post('/api/agent/threads')
      .set(bearer(tok.a))
      .send({ title: title(), providerId, model: 'think-1', reasoning: 'high' })
    expect(think.body.data).toMatchObject({ model: 'think-1', reasoning: 'high' })

    const send = (body: object) =>
      http()
        .post('/api/agent/threads')
        .set(bearer(tok.a))
        .send({ title: title(), ...body })
    expect((await send({ model: 'chat-1', reasoning: 'low' })).status).toBe(400)
    expect((await send({ model: 'missing' })).status).toBe(422)
    expect((await send({ providerId: providerId + 100_000 })).status).toBe(422)
    expect((await send({ approvalMode: 'never' })).status).toBe(400)
    expect((await send({ title: 'x'.repeat(201) })).status).toBe(400)
    expect(
      (await http().post('/api/agent/threads').set(bearer(tok.none)).send({ title: title() }))
        .status,
    ).toBe(403)
  })

  it('lists own threads only: temporary never, archived only with status=archived, pinned first, views active and unread with unread counts', async () => {
    const plain = await newThread(tok.b)
    const pinned = await newThread(tok.b)
    const temp = await newThread(tok.b, { temporary: true })
    const archived = await newThread(tok.b)
    const running = await newThread(tok.b)
    const unread = await newThread(tok.b)
    await http()
      .patch(`/api/agent/threads/${pinned}`)
      .set(bearer(tok.b))
      .send({ pinned: true })
      .expect(200)
    await http()
      .patch(`/api/agent/threads/${archived}`)
      .set(bearer(tok.b))
      .send({ status: 'archived' })
      .expect(200)
    await addTurn(running, ids.b, 'running')
    const t = await addTurn(unread, ids.b, 'completed')
    await addItem(unread, 1, 'user', { text: 'q' }, { turnId: t, text: 'q' })
    await addItem(unread, 2, 'assistant', { text: 'a1' }, { turnId: t, text: 'a1' })
    await addItem(unread, 3, 'assistant', { text: 'a2' }, { turnId: t, text: 'a2' })

    const list = async (query = '') =>
      (await http().get(`/api/agent/threads?pageSize=200${query}`).set(bearer(tok.b)).expect(200))
        .body.data
    const all = await list()
    const got = all.items.map((x: { id: number }) => x.id)
    expect(got[0]).toBe(pinned)
    expect(got).toEqual(expect.arrayContaining([plain, pinned, running, unread]))
    expect(got).not.toContain(temp)
    expect(got).not.toContain(archived)
    const u = all.items.find((x: { id: number }) => x.id === unread)
    expect(u.unread).toBe(2)
    expect(all.items.find((x: { id: number }) => x.id === running).turnStatus).toBe('running')

    expect((await list('&status=archived')).items.map((x: { id: number }) => x.id)).toEqual([
      archived,
    ])
    expect((await list('&view=pinned')).items.map((x: { id: number }) => x.id)).toEqual([pinned])
    expect((await list('&view=active')).items.map((x: { id: number }) => x.id)).toEqual([running])
    expect((await list('&view=unread')).items.map((x: { id: number }) => x.id)).toEqual([unread])

    // someone else's threads are not in the list
    const aList = (await http().get('/api/agent/threads?pageSize=200').set(bearer(tok.a))).body.data
    expect(aList.items.map((x: { id: number }) => x.id)).not.toContain(plain)
    expect((await http().get('/api/agent/threads?view=bogus').set(bearer(tok.b))).status).toBe(400)
    expect((await http().get('/api/agent/threads').set(bearer(tok.none))).status).toBe(403)
  })

  it('searches titles and message text (Chinese, through the ngram full-text index); boolean operators are taken as text', async () => {
    const byText = await newThread(tok.a, { title: title('plain') })
    await addItem(
      byText,
      1,
      'user',
      { text: '请帮我补齐这家公司的工商信息' },
      { text: '请帮我补齐这家公司的工商信息' },
    )
    const byTitle = await newThread(tok.a, { title: `${PREFIX}季度报表整理` })
    const theirs = await newThread(tok.b)
    await addItem(theirs, 1, 'user', { text: '工商信息也在这里' }, { text: '工商信息也在这里' })

    const search = async (kw: string) =>
      (
        await http()
          .get(`/api/agent/threads?pageSize=200&keyword=${encodeURIComponent(kw)}`)
          .set(bearer(tok.a))
          .expect(200)
      ).body.data.items.map((x: { id: number }) => x.id)
    expect(await search('工商信息')).toEqual([byText])
    expect(await search('季度报表')).toEqual([byTitle])
    expect(await search('+工商 -"信息')).toEqual(expect.arrayContaining([byText]))
    expect(await search('完全不存在的词语')).toEqual([])
  })

  it('updates title, status, pin, modes and model; reasoning only for reasoning models; 400, 422, 404 for another user', async () => {
    const id = await newThread(tok.a)
    const patch = (body: object, token = tok.a) =>
      http().patch(`/api/agent/threads/${id}`).set(bearer(token)).send(body)
    const res = await patch({
      title: `${PREFIX}renamed`,
      approvalMode: 'read_only',
      planMode: true,
    })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({
      title: `${PREFIX}renamed`,
      approvalMode: 'read_only',
      planMode: true,
    })
    expect((await patch({ reasoning: 'low' })).status).toBe(400)
    expect((await patch({ model: 'think-1', reasoning: 'medium' })).body.data).toMatchObject({
      model: 'think-1',
      reasoning: 'medium',
    })
    // back to a model without reasoning: the stored effort goes
    expect((await patch({ model: 'chat-1' })).body.data).toMatchObject({
      model: 'chat-1',
      reasoning: null,
    })
    expect((await patch({ model: 'nope' })).status).toBe(422)
    expect((await patch({ title: '' })).status).toBe(400)
    expect((await patch({ title: 'x' }, tok.b)).status).toBe(404)
    expect((await patch({ title: 'x' }, tok.none)).status).toBe(403)
  })

  it('answers items after afterSeq with the latest turn', async () => {
    const { id, turn } = await conversation(tok.a, ids.a)
    const all = (await http().get(`/api/agent/threads/${id}/items`).set(bearer(tok.a)).expect(200))
      .body.data
    expect(all.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3, 4])
    expect(all.items[0]).toMatchObject({
      kind: 'user',
      turnId: turn,
      payload: { text: '帮我补齐客户信息' },
    })
    expect(all.turn).toMatchObject({ id: turn, threadId: id, status: 'completed', error: null })
    const after = (await http().get(`/api/agent/threads/${id}/items?afterSeq=2`).set(bearer(tok.a)))
      .body.data
    expect(after.items.map((i: { seq: number }) => i.seq)).toEqual([3, 4])
    expect(
      (await http().get(`/api/agent/threads/${id}/items?afterSeq=x`).set(bearer(tok.a))).status,
    ).toBe(400)
    expect((await http().get(`/api/agent/threads/${id}/items`).set(bearer(tok.b))).status).toBe(404)
  })

  it('forks: items up to seq copied with the same seqs and new ids, pending ones expired, titled as a fork', async () => {
    const { id } = await conversation(tok.a, ids.a)
    await addItem(
      id,
      5,
      'approval',
      { callId: 'c2', tool: 'demo.book.create', title: 'x', args: {}, sources: [] },
      { status: 'pending' },
    )
    await addItem(id, 6, 'user', { text: 'later' }, { text: 'later' })
    const res = await http()
      .post(`/api/agent/threads/${id}/fork`)
      .set(bearer(tok.a))
      .send({ seq: 5 })
    expect(res.status).toBe(201)
    const fork = res.body.data
    expect(fork).toMatchObject({ forkedFromId: id, unread: 0, turnStatus: null })
    expect(fork.title).toMatch(/（分叉）$/)
    const src = (await http().get(`/api/agent/threads/${id}/items`).set(bearer(tok.a))).body.data
      .items
    const copy = (await http().get(`/api/agent/threads/${fork.id}/items`).set(bearer(tok.a))).body
      .data
    expect(copy.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3, 4, 5])
    expect(copy.items[0].id).not.toBe(src[0].id)
    expect(copy.items[0].turnId).toBeNull()
    expect(copy.items[4]).toMatchObject({ kind: 'approval', status: 'expired' })
    expect(copy.turn).toBeNull()
    // what never ran or never finished is not history: a queued message, unfinished or empty answers
    const live = await addTurn(id, ids.a, 'running')
    await addItem(id, 7, 'user', { text: 'queued, never ran' }, { status: 'pending' })
    await addItem(id, 8, 'assistant', { text: '' }, { turnId: live, status: 'running' })
    await addItem(id, 9, 'assistant', { text: 'half an answ' }, { turnId: live, status: 'failed' })
    await addItem(id, 10, 'reasoning', { text: 'thinking' }, { turnId: live, status: 'expired' })
    await addItem(id, 11, 'assistant', { text: '  ' }, { turnId: live, status: 'done' })
    await addItem(id, 12, 'user', { text: 'ran' }, { turnId: live })
    const busy = await http()
      .post(`/api/agent/threads/${id}/fork`)
      .set(bearer(tok.a))
      .send({ seq: 12 })
    expect(busy.status).toBe(409)
    expect(busy.body.code).toBe(Err.AGENT_THREAD_BUSY.code)
    // 这里的轮次直接以行构造，没有实际 worker；结束夹具后仍须验证未完成条目不会进入历史。
    await ds.query(
      "UPDATE agent_turn SET status = 'failed', ended_at = NOW(3) WHERE tenant_id = 1 AND id = ?",
      [live],
    )
    const all = await http()
      .post(`/api/agent/threads/${id}/fork`)
      .set(bearer(tok.a))
      .send({ seq: 12 })
    expect(all.status).toBe(201)
    const copied = (
      await http().get(`/api/agent/threads/${all.body.data.id}/items`).set(bearer(tok.a))
    ).body.data.items as { seq: number }[]
    expect(copied.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 12])
    // a fork of the fork keeps its history (the copies belong to no turn)
    const again = await http()
      .post(`/api/agent/threads/${all.body.data.id}/fork`)
      .set(bearer(tok.a))
      .send({ seq: 12 })
    const twice = (
      await http().get(`/api/agent/threads/${again.body.data.id}/items`).set(bearer(tok.a))
    ).body.data.items as { seq: number }[]
    expect(twice.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 12])
    expect(
      (await http().post(`/api/agent/threads/${id}/fork`).set(bearer(tok.a)).send({ seq: -1 }))
        .status,
    ).toBe(400)
    expect(
      (await http().post(`/api/agent/threads/${id}/fork`).set(bearer(tok.b)).send({ seq: 1 }))
        .status,
    ).toBe(404)
  })

  it('marks read up to seq, never back', async () => {
    const { id } = await conversation(tok.a, ids.a)
    const unread = async () =>
      (await http().get('/api/agent/threads?pageSize=200').set(bearer(tok.a))).body.data.items.find(
        (x: { id: number }) => x.id === id,
      ).unread
    expect(await unread()).toBe(3)
    await http()
      .post(`/api/agent/threads/${id}/read`)
      .set(bearer(tok.a))
      .send({ seq: 3 })
      .expect(200)
    expect(await unread()).toBe(1)
    await http()
      .post(`/api/agent/threads/${id}/read`)
      .set(bearer(tok.a))
      .send({ seq: 1 })
      .expect(200)
    expect(await unread()).toBe(1)
    expect(
      (await http().post(`/api/agent/threads/${id}/read`).set(bearer(tok.a)).send({})).status,
    ).toBe(400)
    expect(
      (await http().post(`/api/agent/threads/${id}/read`).set(bearer(tok.b)).send({ seq: 9 }))
        .status,
    ).toBe(404)
  })

  it('marks every own thread read at once; other users’ and tenants’ threads stay unread', async () => {
    const one = await conversation(tok.a, ids.a)
    const two = await conversation(tok.a, ids.a)
    const others = await conversation(tok.b, ids.b)
    const unread = async (token: string, id: number) =>
      (await http().get('/api/agent/threads?pageSize=200').set(bearer(token))).body.data.items.find(
        (x: { id: number }) => x.id === id,
      ).unread
    expect(await unread(tok.a, one.id)).toBe(3)
    // another tenant's caller marks only its own (none of these)
    await http().post('/api/agent/threads/read-all').set(bearer(tok.other)).expect(200)
    expect(await unread(tok.a, one.id)).toBe(3)
    const res = await http().post('/api/agent/threads/read-all').set(bearer(tok.a))
    expect(res.status).toBe(200)
    expect(await unread(tok.a, one.id)).toBe(0)
    expect(await unread(tok.a, two.id)).toBe(0)
    expect(await unread(tok.b, others.id)).toBe(3)
    // never moves back: a thread read further than its items stays there
    await ds.query('UPDATE agent_thread SET read_seq = 50 WHERE id = ?', [one.id])
    await http().post('/api/agent/threads/read-all').set(bearer(tok.a)).expect(200)
    const [row] = await ds.query<{ read_seq: number }[]>(
      'SELECT read_seq FROM agent_thread WHERE id = ?',
      [one.id],
    )
    expect(Number(row!.read_seq)).toBe(50)
    expect((await http().post('/api/agent/threads/read-all').set(bearer(tok.none))).status).toBe(
      403,
    )
  })

  it('leaving the trust mode forgets what the thread trusted', async () => {
    const id = await newThread(tok.a, { approvalMode: 'trust' })
    const trusted = async () =>
      (
        await ds.query<{ trusted: unknown }[]>('SELECT trusted FROM agent_thread WHERE id = ?', [
          id,
        ])
      )[0]!.trusted
    await ds.query('UPDATE agent_thread SET trusted = ? WHERE id = ?', [
      JSON.stringify(['demo.book.create:1']),
      id,
    ])
    await http()
      .patch(`/api/agent/threads/${id}`)
      .set(bearer(tok.a))
      .send({ title: 'x' })
      .expect(200)
    expect(await trusted()).not.toBeNull()
    await http()
      .patch(`/api/agent/threads/${id}`)
      .set(bearer(tok.a))
      .send({ approvalMode: 'trust' })
      .expect(200)
    expect(await trusted()).not.toBeNull()
    await http()
      .patch(`/api/agent/threads/${id}`)
      .set(bearer(tok.a))
      .send({ approvalMode: 'ask' })
      .expect(200)
    expect(await trusted()).toBeNull()
  })

  it('reverts the latest turn with its items and what came after; 409 while it runs', async () => {
    const { id, turn } = await conversation(tok.a, ids.a)
    const next = await addTurn(id, ids.a, 'running')
    await addItem(id, 5, 'user', { text: 'second' }, { turnId: next, text: 'second' })
    await addItem(id, 6, 'user', { text: 'queued' }, { text: 'queued' })
    const revert = (token = tok.a) =>
      http().post(`/api/agent/threads/${id}/revert`).set(bearer(token))
    expect((await revert()).status).toBe(409)
    await ds.query("UPDATE agent_turn SET status = 'completed' WHERE id = ?", [next])
    expect((await revert(tok.b)).status).toBe(404)
    expect((await revert()).status).toBe(200)
    const d = (await http().get(`/api/agent/threads/${id}/items`).set(bearer(tok.a))).body.data
    expect(d.items.map((i: { seq: number }) => i.seq)).toEqual([1, 2, 3, 4])
    expect(d.turn.id).toBe(turn)
  })

  it('refuses to revert while a call of the latest turn runs; drops the trust the reverted turn recorded', async () => {
    const { id } = await conversation(tok.a, ids.a)
    // waiting inside an external call (its form open): the call cannot be undone
    const next = await addTurn(id, ids.a, 'waiting')
    await addItem(id, 5, 'user', { text: 'second' }, { turnId: next, text: 'second' })
    const call = await addItem(
      id,
      6,
      'tool_call',
      { callId: 'e1', tool: 'ext.srv.w', title: 'w', source: 'mcp', kind: 'write', args: {} },
      { turnId: next, status: 'running' },
    )
    const kept = '999999#t.a.b|id:2'
    await ds.query('UPDATE agent_thread SET trusted = ? WHERE id = ?', [
      JSON.stringify([`${next}#t.a.b|id:1`, kept]),
      id,
    ])
    const revert = () => http().post(`/api/agent/threads/${id}/revert`).set(bearer(tok.a))
    expect((await revert()).status).toBe(409)
    await ds.query("UPDATE agent_item SET status = 'failed' WHERE id = ?", [call])
    expect((await revert()).status).toBe(200)
    const [row] = await ds.query<{ trusted: unknown }[]>(
      'SELECT trusted FROM agent_thread WHERE id = ?',
      [id],
    )
    const trusted = typeof row!.trusted === 'string' ? JSON.parse(row!.trusted) : row!.trusted
    expect(trusted).toEqual([kept])
  })

  it('reverting a turn the summary covers clears the summary; an earlier summary stays', async () => {
    const summaryOf = async (id: number) =>
      (
        await ds.query<{ summary: string | null; summary_seq: number }[]>(
          'SELECT summary, summary_seq FROM agent_thread WHERE id = ?',
          [id],
        )
      )[0]!
    const covered = await conversation(tok.a, ids.a)
    const next = await addTurn(covered.id, ids.a, 'completed')
    await addItem(covered.id, 5, 'user', { text: 'second' }, { turnId: next, text: 'second' })
    await addItem(covered.id, 6, 'assistant', { text: 'answer' }, { turnId: next })
    await ds.query("UPDATE agent_thread SET summary = 'S', summary_seq = 5 WHERE id = ?", [
      covered.id,
    ])
    await http().post(`/api/agent/threads/${covered.id}/revert`).set(bearer(tok.a)).expect(200)
    expect(await summaryOf(covered.id)).toMatchObject({ summary: null, summary_seq: 0 })

    const earlier = await conversation(tok.a, ids.a)
    const later = await addTurn(earlier.id, ids.a, 'completed')
    await addItem(earlier.id, 5, 'user', { text: 'second' }, { turnId: later, text: 'second' })
    await ds.query("UPDATE agent_thread SET summary = 'S', summary_seq = 4 WHERE id = ?", [
      earlier.id,
    ])
    await http().post(`/api/agent/threads/${earlier.id}/revert`).set(bearer(tok.a)).expect(200)
    expect(await summaryOf(earlier.id)).toMatchObject({ summary: 'S', summary_seq: 4 })
  })

  it('exports Markdown with messages, tool titles and masked arguments, never tool output', async () => {
    const { id } = await conversation(tok.a, ids.a)
    const res = await http().get(`/api/agent/threads/${id}/export`).set(bearer(tok.a))
    expect(res.status).toBe(200)
    const { name, text } = res.body.data
    expect(name).toMatch(/\.md$/)
    expect(text).toContain('帮我补齐客户信息')
    expect(text).toContain('已经补齐了三家客户的官网')
    expect(text).toContain('Create a book')
    expect(text).toContain('"password":"***"')
    expect(text).not.toContain('hunter2-secret')
    expect(text).not.toContain('BOOK-PREVIEW-42')
    expect((await http().get(`/api/agent/threads/${id}/export`).set(bearer(tok.b))).status).toBe(
      404,
    )
  })

  it('status: context estimate over the summary and the items after it, the model window, today’s usage and limits', async () => {
    const { id, turn } = await conversation(tok.a, ids.a)
    await ds.query(
      "UPDATE agent_thread SET summary = ?, summary_seq = 3, model = 'think-1' WHERE id = ?",
      ['x'.repeat(10), id],
    )
    const day = new Date().toISOString().slice(0, 10)
    await ds.query(
      'INSERT INTO agent_usage (tenant_id, user_id, day, model, calls, prompt_tokens, completion_tokens, legacy_calls) VALUES (1, ?, ?, ?, 1, 100, 20, 1), (1, ?, ?, ?, 1, 1000, 0, 1)',
      [ids.a, day, `${PREFIX}m`, ids.b, day, `${PREFIX}m`],
    )
    const res = await http().get(`/api/agent/threads/${id}/status`).set(bearer(tok.a))
    expect(res.status).toBe(200)
    const s = res.body.data
    // summary 10 chars + item 4's text (12 chars) → 22 / 3.5
    expect(s).toMatchObject({
      threadId: id,
      model: 'think-1',
      contextWindow: 128000,
      contextUsed: Math.ceil(22 / 3.5),
    })
    expect(s.turn.id).toBe(turn)
    expect(s.today.userTokens).toBe(120)
    expect(s.today.tenantTokens).toBeGreaterThanOrEqual(1120)
    expect(s.today.userLimit).toBe('0.000000')
    expect(s.today.tenantLimit).toBe('0.000000')
    expect(s.today.userCredits).toBe('0.000000')
    expect(s.today.userLegacyCalls).toBe(1)
    expect((await http().get(`/api/agent/threads/${id}/status`).set(bearer(tok.b))).status).toBe(
      404,
    )
  })

  it('deletes a thread with its items; then 404; 404 for another user', async () => {
    const { id } = await conversation(tok.a, ids.a)
    expect((await http().delete(`/api/agent/threads/${id}`).set(bearer(tok.b))).status).toBe(404)
    expect((await http().delete(`/api/agent/threads/${id}`).set(bearer(tok.a))).status).toBe(200)
    expect((await http().get(`/api/agent/threads/${id}/items`).set(bearer(tok.a))).status).toBe(404)
    const [{ live }] = await ds.query<{ live: number }[]>(
      'SELECT COUNT(*) AS live FROM agent_item WHERE thread_id = ? AND deleted_at IS NULL',
      [id],
    )
    expect(Number(live)).toBe(0)
  })

  it('answers 404 to a user of another tenant on every thread route', async () => {
    const { id } = await conversation(tok.a, ids.a)
    const o = bearer(tok.other)
    expect((await http().get('/api/agent/options').set(o)).status).toBe(200)
    const list = (await http().get('/api/agent/threads?pageSize=200').set(o)).body.data.items
    expect(list.map((x: { id: number }) => x.id)).not.toContain(id)
    // built one at a time: a request object listens as soon as it is made
    for (const req of [
      () => http().patch(`/api/agent/threads/${id}`).set(o).send({ title: 'x' }),
      () => http().delete(`/api/agent/threads/${id}`).set(o),
      () => http().get(`/api/agent/threads/${id}/items`).set(o),
      () => http().post(`/api/agent/threads/${id}/fork`).set(o).send({ seq: 1 }),
      () => http().post(`/api/agent/threads/${id}/read`).set(o).send({ seq: 1 }),
      () => http().post(`/api/agent/threads/${id}/revert`).set(o),
      () => http().get(`/api/agent/threads/${id}/export`).set(o),
      () => http().get(`/api/agent/threads/${id}/status`).set(o),
      () => http().post(`/api/agent/threads/${id}/share`).set(o),
      () => http().delete(`/api/agent/threads/${id}/share`).set(o),
    ])
      expect((await req()).status).toBe(404)
  })
})

describe('sharing', () => {
  it('shares within the tenant: a 32-char token, kept on a second share; viewers other than the owner see no tool details', async () => {
    const { id, turn } = await conversation(tok.a, ids.a)
    await ds.query(
      "UPDATE agent_turn SET status = 'failed', error_code = 'E1', error_msg = 'TURN-SECRET' WHERE id = ?",
      [turn],
    )
    await addItem(
      id,
      5,
      'approval',
      {
        callId: 'c3',
        tool: 'demo.book.create',
        title: 'Create a book',
        args: { title: 'Secret plan' },
        changes: { target: 'demo.book:1', fields: [{ field: 'title', from: 'a', to: 'b' }] },
        sources: [],
      },
      { status: 'approved' },
    )
    const res = await http().post(`/api/agent/threads/${id}/share`).set(bearer(tok.a))
    expect(res.status).toBe(201)
    const { token } = res.body.data
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(
      (await http().post(`/api/agent/threads/${id}/share`).set(bearer(tok.a))).body.data.token,
    ).toBe(token)
    const listed = (await http().get('/api/agent/threads?pageSize=200').set(bearer(tok.a))).body
      .data.items
    expect(listed.find((x: { id: number }) => x.id === id).shared).toBe(true)

    // any viewer but the owner: tool arguments, output and approval details are hidden, the text stays;
    // root too (it may call the tool, but the output was read with the owner's data scope)
    type Seen = { kind: string; status: string | null; payload: Record<string, unknown> }[]
    for (const viewer of [tok.b, tok.root]) {
      const seen = await http().get(`/api/agent/shared/${token}`).set(bearer(viewer))
      expect(seen.status).toBe(200)
      const items = seen.body.data.items as Seen
      expect(seen.body.data.thread.id).toBe(id)
      const call = items.find((i) => i.kind === 'tool_call')!.payload
      expect(call.args).toBeNull()
      expect(call.title).toBe('Create a book')
      expect(items.find((i) => i.kind === 'tool_result')!.payload.preview).toBe('')
      const approval = items.find((i) => i.kind === 'approval')!
      expect(approval.payload.args).toBeNull()
      expect(approval.payload.changes).toBeUndefined()
      expect(approval.status).toBe('approved')
      expect(items.find((i) => i.kind === 'assistant')!.payload.text).toBe(
        '已经补齐了三家客户的官网',
      )
      expect(JSON.stringify(items)).not.toContain('BOOK-PREVIEW-42')
      expect(JSON.stringify(items)).not.toContain('Secret plan')
      // the turn's error keeps its code only
      expect(seen.body.data.turn.error).toEqual({ code: 'E1', message: '' })
    }
    // the owner sees everything
    const full = (await http().get(`/api/agent/shared/${token}`).set(bearer(tok.a))).body.data
      .items as Seen
    expect(full.find((i) => i.kind === 'tool_result')!.payload.preview).toBe('BOOK-PREVIEW-42')
    expect(full.find((i) => i.kind === 'approval')!.payload.changes).toBeDefined()

    expect((await http().get(`/api/agent/shared/${token}`).set(bearer(tok.none))).status).toBe(403)
    expect((await http().get(`/api/agent/shared/${token}`).set(bearer(tok.other))).status).toBe(404)
    expect((await http().post(`/api/agent/threads/${id}/share`).set(bearer(tok.b))).status).toBe(
      404,
    )
    expect((await http().delete(`/api/agent/threads/${id}/share`).set(bearer(tok.a))).status).toBe(
      200,
    )
    expect((await http().get(`/api/agent/shared/${token}`).set(bearer(tok.b))).status).toBe(404)
    expect((await http().get('/api/agent/shared/not-a-token').set(bearer(tok.b))).status).toBe(404)
  })

  it('refuses to share a temporary thread (409)', async () => {
    const id = await newThread(tok.a, { temporary: true })
    expect((await http().post(`/api/agent/threads/${id}/share`).set(bearer(tok.a))).status).toBe(
      409,
    )
  })
})

describe('feedback', () => {
  it('rates an answer of an own thread, one per user and answer (replaced), with the trace id; 404 for other items and threads, 400 for a bad rating', async () => {
    const { id, answer } = await conversation(tok.a, ids.a)
    const send = (body: object, token = tok.a) =>
      http().post('/api/agent/feedback').set(bearer(token)).send(body)
    const first = await send({ itemId: answer, rating: 1 })
    expect(first.status).toBe(200)
    expect((await send({ itemId: answer, rating: -1, comment: 'wrong city' })).status).toBe(200)
    const rows = await ds.query<
      { rating: number; comment: string; trace_id: string; thread_id: number }[]
    >(
      'SELECT rating, comment, trace_id, thread_id FROM agent_feedback WHERE item_id = ? AND deleted_at IS NULL',
      [answer],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rating: -1, comment: 'wrong city' })
    expect(Number(rows[0]!.thread_id)).toBe(id)
    expect(rows[0]!.trace_id).toBeTruthy()
    const userItem = Number(
      (
        await ds.query<{ id: number }[]>(
          'SELECT id FROM agent_item WHERE thread_id = ? AND seq = 1',
          [id],
        )
      )[0]!.id,
    )
    expect((await send({ itemId: userItem, rating: 1 })).status).toBe(404)
    expect((await send({ itemId: answer, rating: 1 }, tok.b)).status).toBe(404)
    expect((await send({ itemId: answer, rating: 1 }, tok.other)).status).toBe(404)
    expect((await send({ itemId: answer, rating: 2 })).status).toBe(400)
    expect((await send({ itemId: answer, rating: 1 }, tok.none)).status).toBe(403)
  })
})

describe('prompt templates', () => {
  it('keeps own templates per user and tenant-wide ones behind agent.skill.modify', async () => {
    const mine = await http()
      .post('/api/agent/prompts')
      .set(bearer(tok.a))
      .send({ name: `${PREFIX}weekly`, body: 'Summarize this week' })
    expect(mine.status).toBe(201)
    expect(mine.body.data).toMatchObject({ scope: 'user', editable: true })
    expect(
      (
        await http()
          .post('/api/agent/prompts')
          .set(bearer(tok.a))
          .send({ name: `${PREFIX}weekly`, body: 'again' })
      ).status,
    ).toBe(409)
    expect(
      (
        await http()
          .post('/api/agent/prompts')
          .set(bearer(tok.a))
          .send({ scope: 'tenant', name: `${PREFIX}t`, body: 'x' })
      ).status,
    ).toBe(403)
    const shared = await http()
      .post('/api/agent/prompts')
      .set(bearer(tok.root))
      .send({ scope: 'tenant', name: `${PREFIX}team`, body: 'Team template' })
    expect(shared.status).toBe(201)

    const aList = (await http().get('/api/agent/prompts').set(bearer(tok.a))).body.data
    expect(aList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: shared.body.data.id, scope: 'tenant', editable: false }),
        expect.objectContaining({ id: mine.body.data.id, scope: 'user', editable: true }),
      ]),
    )
    const bList = (await http().get('/api/agent/prompts').set(bearer(tok.b))).body.data
    expect(bList.map((p: { id: number }) => p.id)).not.toContain(mine.body.data.id)
    const otherList = (await http().get('/api/agent/prompts').set(bearer(tok.other))).body.data
    expect(otherList.map((p: { id: number }) => p.id)).not.toContain(shared.body.data.id)
    const opts = (await http().get('/api/agent/options').set(bearer(tok.a))).body.data
    expect(opts.prompts.map((p: { id: number }) => p.id)).toEqual(
      expect.arrayContaining([mine.body.data.id, shared.body.data.id]),
    )

    const put = (id: number, body: object, token = tok.a) =>
      http().put(`/api/agent/prompts/${id}`).set(bearer(token)).send(body)
    expect(
      (await put(mine.body.data.id, { name: `${PREFIX}weekly2`, body: 'changed' })).body.data,
    ).toMatchObject({
      name: `${PREFIX}weekly2`,
      body: 'changed',
    })
    expect((await put(mine.body.data.id, { name: 'x', body: 'y' }, tok.b)).status).toBe(404)
    expect((await put(mine.body.data.id, { name: 'x', body: 'y' }, tok.other)).status).toBe(404)
    expect((await put(shared.body.data.id, { scope: 'tenant', name: 'x', body: 'y' })).status).toBe(
      403,
    )
    expect((await put(mine.body.data.id, { scope: 'tenant', name: 'x', body: 'y' })).status).toBe(
      403,
    )
    expect((await put(mine.body.data.id, { name: '', body: 'y' })).status).toBe(400)
    expect(
      (await http().delete(`/api/agent/prompts/${shared.body.data.id}`).set(bearer(tok.a))).status,
    ).toBe(403)
    expect(
      (await http().delete(`/api/agent/prompts/${mine.body.data.id}`).set(bearer(tok.b))).status,
    ).toBe(404)
    expect(
      (await http().delete(`/api/agent/prompts/${mine.body.data.id}`).set(bearer(tok.a))).status,
    ).toBe(200)
    expect(
      (await http().delete(`/api/agent/prompts/${shared.body.data.id}`).set(bearer(tok.root)))
        .status,
    ).toBe(200)
    expect((await http().get('/api/agent/prompts').set(bearer(tok.none))).status).toBe(403)
  })
})

describe('usage', () => {
  it('sums the current tenant by day, user or model; 403 without agent.usage.browse, 400 for a bad range', async () => {
    const day = '2026-01-15'
    await ds.query(
      `INSERT INTO agent_usage (tenant_id, user_id, day, model, calls, prompt_tokens, completion_tokens, legacy_calls)
       VALUES (1, ?, ?, ?, 2, 100, 10, 2), (1, ?, ?, ?, 3, 200, 20, 3), (?, ?, ?, ?, 5, 999, 99, 5)`,
      [
        ids.a,
        day,
        `${PREFIX}u1`,
        ids.b,
        day,
        `${PREFIX}u2`,
        other.id,
        other.users.admin,
        day,
        `${PREFIX}u1`,
      ],
    )
    const get = (groupBy: string, token = tok.root) =>
      http().get(`/api/agent/usage?from=${day}&to=${day}&groupBy=${groupBy}`).set(bearer(token))
    const byDay = (await get('day')).body.data
    expect(byDay).toEqual([
      {
        key: day,
        label: day,
        calls: 5,
        promptTokens: 300,
        completionTokens: 30,
        totalTokens: 330,
        credits: '0.000000',
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        unpricedCalls: 0,
        unreportedCalls: 0,
        legacyCalls: 5,
      },
    ])
    const byModel = (await get('model')).body.data
    expect(byModel).toEqual([
      {
        key: `0:${PREFIX}u2`,
        label: `${PREFIX}u2`,
        calls: 3,
        promptTokens: 200,
        completionTokens: 20,
        totalTokens: 220,
        credits: '0.000000',
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        unpricedCalls: 0,
        unreportedCalls: 0,
        legacyCalls: 3,
      },
      {
        key: `0:${PREFIX}u1`,
        label: `${PREFIX}u1`,
        calls: 2,
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        credits: '0.000000',
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        unpricedCalls: 0,
        unreportedCalls: 0,
        legacyCalls: 2,
      },
    ])
    const byUser = (await get('user')).body.data
    expect(byUser.map((r: { label: string }) => r.label)).toEqual([`${PREFIX}b`, `${PREFIX}a`])
    expect((await get('day', tok.a)).status).toBe(403)
    expect(
      (await http().get('/api/agent/usage?from=bad&to=2026-01-01').set(bearer(tok.root))).status,
    ).toBe(400)
  })
})
