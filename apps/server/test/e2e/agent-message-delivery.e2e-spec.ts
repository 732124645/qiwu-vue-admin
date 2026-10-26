import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import type { MockInstance } from 'vitest'
import type { DataSource } from 'typeorm'
import { In } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import {
  AgentItem,
  AgentThread,
  AgentTurn,
} from '../../src/core/agent/entities/agent-thread.entity.js'
import { ItemStore } from '../../src/core/agent/runtime/item-store.js'
import { TurnQueue } from '../../src/core/agent/runtime/turn-queue.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { Inbox } from '../../src/modules/platform/messaging/inbox/inbox.entity.js'
import { bearer } from '../setup/auth.js'
import { TEST_AGENT_PRICING } from '../setup/agent-pricing.js'
import {
  addUser,
  createTenant,
  inTenant1,
  signInDirect,
  type PeopledTenant,
} from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
})
let app: NestExpressApplication, ds: DataSource, first: PeopledTenant, second: PeopledTenant
let owner = '',
  anotherSession = '',
  foreign = '',
  denied = '',
  providerId = 0
const ids: number[] = []
let kick: MockInstance<TurnQueue['kick']>
const http = () => request(app.getHttpServer())
const send = (
  id: number,
  clientMessageId: string,
  text = 'A stable message',
  token = owner,
  mode = 'steer',
) =>
  http()
    .post(`/api/agent/threads/${id}/messages`)
    .set(bearer(token))
    .send({ text, clientMessageId, mode })
const receipt = (id: number, clientMessageId: string, token = owner) =>
  http().get(`/api/agent/threads/${id}/messages/${clientMessageId}/receipt`).set(bearer(token))
const create = async (clientDraftId = randomUUID(), token = owner, extra: object = {}) => {
  const response = await http()
    .post('/api/agent/threads')
    .set(bearer(token))
    .send({ clientDraftId, providerId, model: 'delivery-model', ...extra })
    .expect(201)
  ids.push(Number(response.body.data.id))
  return response.body.data as { id: number; recoveryRequired: boolean; recoveryRevision: number }
}

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get(getDataSourceToken())
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
  owner = (await signInDirect(app, first.ownerId))!.accessToken
  anotherSession = (await signInDirect(app, first.ownerId))!.accessToken
  foreign = (await signInDirect(app, second.ownerId))!.accessToken
  const deniedId = await addUser(ds, first.id, 'delivery-forbidden')
  denied = (await signInDirect(app, deniedId))!.accessToken
  providerId = await inTenant1(() =>
    insertRow(ds.manager, 'agent_provider', {
      name: 'Delivery fixture provider',
      base_url: 'https://models.example.invalid/v1',
      enabled: 1,
      models: [
        {
          id: 'delivery-model',
          label: 'Delivery',
          reasoning: false,
          contextWindow: 64000,
          pricing: TEST_AGENT_PRICING,
        },
      ],
    }),
  )
  // 这里只测试接收事务；队列边界不执行模型或工具，真实进程恢复由独立集成专项覆盖。
  kick = vi.spyOn(app.get(TurnQueue), 'kick').mockResolvedValue(undefined)
})

beforeEach(async () => {
  // 所有这些轮次都被 kick 边界拦下，从未有活模型或业务写入；结束夹具避免占用别的用例并发名额。
  if (ids.length)
    for (const tenant of [first, second])
      await withTenant(tenant.id, () =>
        ds
          .getRepository(AgentTurn)
          .update({ threadId: In(ids) }, { status: 'completed', endedAt: new Date() }),
      )
  kick.mockClear()
})

it('offers only an owned live thread action for known inbox notices without exposing arbitrary params', async () => {
  const own = await create()
  const otherTenant = await create(randomUUID(), foreign)
  const otherUser = await create()
  await withTenant(first.id, () =>
    ds.getRepository(AgentThread).update(otherUser.id, { userId: first.users.alice }),
  )
  const removed = await create()
  await http().delete(`/api/agent/threads/${removed.id}`).set(bearer(owner)).expect(200)
  const notices = await withTenant(first.id, async () => {
    const repo = ds.getRepository(Inbox)
    return repo.save(
      [
        ['agent.turn.waiting', { threadId: own.id, url: 'https://outside.example.invalid' }],
        ['agent.turn.completed', { threadId: own.id }],
        ['agent.turn.waiting', { threadId: otherTenant.id }],
        ['agent.turn.waiting', { threadId: otherUser.id }],
        ['agent.turn.waiting', { threadId: removed.id }],
        ['agent.turn.waiting', { threadId: String(own.id) }],
        ['unknown.notice', { threadId: own.id }],
        ['agent.turn.waiting', { threadId: Number.MAX_SAFE_INTEGER + 1 }],
      ].map(([templateCode, params]) =>
        repo.create({
          userId: first.ownerId,
          templateCode: templateCode as string,
          params,
          locale: 'en-US',
          category: 'business',
          title: 'Conversation notice',
          body: 'Plain text https://outside.example.invalid',
          status: 'delivered',
        }),
      ),
    )
  })
  for (let at = 0; at < notices.length; at++) {
    const result = await http()
      .get(`/api/messaging/inboxes/mine/${notices[at]!.id}`)
      .set(bearer(owner))
      .expect(200)
    expect(result.body.data.action).toEqual(
      at < 2 ? { kind: 'agent-thread', threadId: own.id } : undefined,
    )
    expect(result.body.data).not.toHaveProperty('params')
    await http()
      .get(`/api/messaging/inboxes/mine/${notices[at]!.id}`)
      .set(bearer(foreign))
      .expect(404)
  }
  const page = await http().get('/api/messaging/inboxes/mine').set(bearer(owner)).expect(200)
  expect(
    page.body.data.items.find((row: { id: number }) => row.id === Number(notices[0]!.id)).action,
  ).toEqual({ kind: 'agent-thread', threadId: own.id })
})

afterAll(async () => {
  kick?.mockRestore()
  await second?.dispose()
  await first?.dispose()
  if (providerId) await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
  await app?.close()
})

it('deduplicates concurrent draft creation across sessions and rejects a changed payload', async () => {
  const clientDraftId = randomUUID()
  const [a, b] = await Promise.all([create(clientDraftId), create(clientDraftId, anotherSession)])
  expect(a.id).toBe(b.id)
  await http()
    .post('/api/agent/threads')
    .set(bearer(owner))
    .send({ clientDraftId, providerId, model: 'delivery-model', title: 'Different intent' })
    .expect(409)
  const found = await http()
    .get(`/api/agent/threads/client-drafts/${clientDraftId}`)
    .set(bearer(owner))
    .expect(200)
  expect(found.body.data).toMatchObject({
    clientDraftId,
    threadId: a.id,
    status: 'accepted',
    thread: { id: a.id },
  })
  await http()
    .get(`/api/agent/threads/client-drafts/${clientDraftId}`)
    .set(bearer(foreign))
    .expect(404)
})

it('accepts a concurrent message only once across sessions and after the short guard expires', async () => {
  const thread = await create()
  const id = randomUUID()
  const [a, b] = await Promise.all([
    send(thread.id, id),
    send(thread.id, id, 'A stable message', anotherSession),
  ])
  expect([a.status, b.status]).toEqual([201, 201])
  expect(a.body.data.id).toBe(b.body.data.id)
  expect(kick).toHaveBeenCalledTimes(1)
  await new Promise((resolve) => setTimeout(resolve, 3100))
  const retried = await send(thread.id, id).expect(201)
  expect(retried.body.data.id).toBe(a.body.data.id)
  expect(kick).toHaveBeenCalledTimes(1)
  const rows = await withTenant(first.id, () =>
    ds.getRepository(AgentItem).findBy({ threadId: thread.id, kind: 'user' }),
  )
  expect(rows).toHaveLength(1)
  expect((await receipt(thread.id, id).expect(200)).body.data).toMatchObject({
    clientMessageId: id,
    itemId: Number(rows[0]!.id),
    turnId: a.body.data.id,
    status: 'accepted',
  })
})

it('refuses the same message identity for different text or another owned thread', async () => {
  const a = await create(),
    b = await create()
  const id = randomUUID()
  await send(a.id, id).expect(201)
  await send(a.id, id, 'Different content').expect(409)
  await send(b.id, id).expect(409)
  expect(kick).toHaveBeenCalledTimes(1)
  expect(
    await withTenant(first.id, () => ds.getRepository(AgentItem).countBy({ threadId: b.id })),
  ).toBe(0)
})

it('does not duplicate a steered or queued message and preserves its acceptance turn after moving', async () => {
  const thread = await create()
  const original = await send(thread.id, randomUUID()).expect(201)
  const steer = randomUUID(),
    queued = randomUUID()
  await send(thread.id, steer, 'Steer once').expect(201)
  await send(thread.id, steer, 'Steer once', anotherSession).expect(201)
  await send(thread.id, queued, 'Queue once', owner, 'queue').expect(201)
  await send(thread.id, queued, 'Queue once', anotherSession, 'queue').expect(201)
  const pending = await withTenant(first.id, () =>
    ds
      .getRepository(AgentItem)
      .findOneByOrFail({ threadId: thread.id, kind: 'user', status: 'pending' }),
  )
  await withTenant(first.id, () =>
    app.get(ItemStore).tx(async (w) => {
      await w.thread(thread.id)
      const old = await w.m
        .getRepository(AgentTurn)
        .findOneByOrFail({ id: Number(original.body.data.id), threadId: thread.id })
      await w.patchTurn(old, { status: 'completed', endedAt: new Date() })
      const next = await w.createTurn(thread.id, first.ownerId)
      await w.move(pending, Number(next.id))
    }),
  )
  expect((await receipt(thread.id, queued).expect(200)).body.data.turnId).toBe(
    original.body.data.id,
  )
  const freshSession = (await signInDirect(app, first.ownerId))!.accessToken
  expect(
    (await send(thread.id, queued, 'Queue once', freshSession, 'queue').expect(201)).body.data.id,
  ).toBe(original.body.data.id)
  expect(
    await withTenant(first.id, () =>
      ds.getRepository(AgentItem).countBy({ threadId: thread.id, kind: 'user' }),
    ),
  ).toBe(3)
  expect(kick).toHaveBeenCalledTimes(1)
})

it('keeps old clients compatible and refuses out-of-scope receipt access without revealing existence', async () => {
  const clientDraftId = randomUUID(),
    thread = await create(clientDraftId),
    id = randomUUID()
  await http()
    .post(`/api/agent/threads/${thread.id}/messages`)
    .set(bearer(owner))
    .send({ text: 'Legacy client' })
    .expect(201)
  await send(thread.id, id, 'Accepted receipt').expect(201)
  expect((await receipt(thread.id, id).expect(200)).body.data).toMatchObject({
    clientMessageId: id,
    threadId: thread.id,
    status: 'accepted',
  })
  await receipt(thread.id, id, foreign).expect(404)
  await receipt(thread.id, id, denied).expect(403)
  await http().get(`/api/agent/threads/${thread.id}/messages/${id}/receipt`).expect(401)
  await receipt(thread.id, randomUUID()).expect(404)
  await http()
    .get(`/api/agent/threads/${thread.id}/messages/not-a-uuid/receipt`)
    .set(bearer(owner))
    .expect(400)
  const draftUrl = `/api/agent/threads/client-drafts/${clientDraftId}`
  await http().get(draftUrl).expect(401)
  await http().get(draftUrl).set(bearer(denied)).expect(403)
  await http().get(draftUrl).set(bearer(foreign)).expect(404)
  await http().get('/api/agent/threads/client-drafts/not-a-uuid').set(bearer(owner)).expect(400)
})

it('does not delete an active or unverified thread and returns removed receipts after explicit cleanup', async () => {
  const draftId = randomUUID(),
    id = randomUUID(),
    thread = await create(draftId)
  await send(thread.id, id).expect(201)
  const busy = await http().delete(`/api/agent/threads/${thread.id}`).set(bearer(owner)).expect(409)
  expect(busy.body.code).toBe(Err.AGENT_THREAD_BUSY.code)
  await http().post(`/api/agent/threads/${thread.id}/cancel`).set(bearer(owner)).expect(201)
  await withTenant(first.id, () =>
    ds
      .getRepository(AgentThread)
      .update(thread.id, { recoveryRequired: true, recoveryRevision: 2 }),
  )
  await http().delete(`/api/agent/threads/${thread.id}`).set(bearer(owner)).expect(409)
  await http()
    .post(`/api/agent/threads/${thread.id}/fork`)
    .set(bearer(owner))
    .send({ seq: 0 })
    .expect(409)
  await http().post(`/api/agent/threads/${thread.id}/revert`).set(bearer(owner)).expect(409)
  await http()
    .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
    .set(bearer(owner))
    .send({ revision: 1 })
    .expect(409)
  await http()
    .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
    .set(bearer(foreign))
    .send({ revision: 2 })
    .expect(404)
  await http()
    .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
    .send({ revision: 2 })
    .expect(401)
  await http()
    .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
    .set(bearer(denied))
    .send({ revision: 2 })
    .expect(403)
  await http()
    .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
    .set(bearer(owner))
    .send({ revision: -1 })
    .expect(400)
  kick.mockClear()
  await http()
    .post(`/api/agent/threads/${thread.id}/recovery/acknowledge`)
    .set(bearer(owner))
    .send({ revision: 2 })
    .expect(200)
  expect(kick).not.toHaveBeenCalled()
  await http().delete(`/api/agent/threads/${thread.id}`).set(bearer(owner)).expect(200)
  expect((await receipt(thread.id, id).expect(200)).body.data.status).toBe('removed')
  expect(
    (await http().get(`/api/agent/threads/client-drafts/${draftId}`).set(bearer(owner)).expect(200))
      .body.data.status,
  ).toBe('removed')
  await http()
    .post('/api/agent/threads')
    .set(bearer(anotherSession))
    .send({ clientDraftId: draftId, providerId, model: 'delivery-model' })
    .expect(409)
})

it('uses persistent draft identity for fork acknowledgements without copying a recovery flag', async () => {
  const source = await create(),
    clientDraftId = randomUUID()
  const fork = (token = owner, seq = 0) =>
    http()
      .post(`/api/agent/threads/${source.id}/fork`)
      .set(bearer(token))
      .send({ seq, clientDraftId })
  const firstFork = await fork().expect(201),
    replay = await fork(anotherSession).expect(201)
  expect(firstFork.body.data.id).toBe(replay.body.data.id)
  await fork(owner, 1).expect(409)
  const found = await http()
    .get(`/api/agent/threads/client-drafts/${clientDraftId}`)
    .set(bearer(owner))
    .expect(200)
  expect(found.body.data.thread.id).toBe(firstFork.body.data.id)
  expect(found.body.data.thread).toMatchObject({ recoveryRequired: false, recoveryRevision: 0 })
  const different = await create(),
    outside = await create(randomUUID(), foreign)
  await http()
    .post(`/api/agent/threads/${different.id}/fork`)
    .set(bearer(owner))
    .send({ seq: 0, clientDraftId })
    .expect(409)
  await http()
    .post(`/api/agent/threads/${outside.id}/fork`)
    .set(bearer(owner))
    .send({ seq: 0, clientDraftId })
    .expect(404)
  await http()
    .post('/api/agent/threads')
    .set(bearer(anotherSession))
    .send({ clientDraftId, providerId, model: 'delivery-model' })
    .expect(409)
})
