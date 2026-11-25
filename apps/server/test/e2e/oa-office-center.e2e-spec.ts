import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer } from '../setup/auth.js'
import { bootApp, createTenant, signInDirect, type PeopledTenant } from '../setup/tenants.js'

let app: NestExpressApplication
let ds: DataSource
let first: PeopledTenant
let second: PeopledTenant
let token: string
let foreign: string
const modelKeys = ['office-alpha', 'office-beta']
const versions = new Map<string, number>()
const get = (path: string, query: object = {}, who = token) =>
  request(app.getHttpServer()).get(`/api/wf/${path}`).set(bearer(who)).query(query)

/** 列表夹具直接建立两种流程的已有运行行，不改引擎，也不依赖业务模块的表单发布。 */
async function addInstance(
  t: PeopledTenant,
  key: string,
  owner = t.ownerId,
  receiver = t.ownerId,
  read = false,
) {
  return withTenant(t.id, () =>
    ds.transaction(async (q) => {
      const versionId = versions.get(`${t.id}:${key}`)!
      const instanceId = await insertRow(q, 'wf_instance', {
        version_id: versionId,
        model_key: key,
        initiator_id: owner,
        state: 'running',
        form_values: {},
        initiator_picks: {},
        initiator_ctx: {},
        active_node_ids: [],
        started_at: new Date('2026-10-22T01:00:00Z'),
      })
      await insertRow(q, 'wf_task', {
        instance_id: instanceId,
        node_id: 'review',
        node_name: 'Review',
        assignee_id: receiver,
        state: 'pending',
      })
      await insertRow(q, 'wf_task', {
        instance_id: instanceId,
        node_id: 'done',
        node_name: 'Handled',
        assignee_id: receiver,
        state: 'approved',
        handled_at: new Date('2026-10-22T02:00:00Z'),
      })
      await insertRow(q, 'wf_cc', {
        instance_id: instanceId,
        node_id: 'copy',
        user_id: receiver,
        read_at: read ? new Date('2026-10-22T02:00:00Z') : null,
      })
      return instanceId
    }),
  )
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
  for (const t of [first, second])
    await withTenant(t.id, () =>
      ds.transaction(async (q) => {
        for (const key of [...modelKeys, ...(t === second ? ['foreign-only'] : [])]) {
          const modelId = await insertRow(q, 'wf_model', {
            model_key: key,
            name: key,
            form_kind: 'dynamic',
            draft_json: { id: 'begin', type: 'begin', name: 'Start' },
          })
          const version = await insertRow(q, 'wf_version', {
            model_id: modelId,
            model_key: key,
            version: 1,
            tree_json: { id: 'begin', type: 'begin', name: 'Start' },
            form_snapshot: { fields: {} },
          })
          versions.set(`${t.id}:${key}`, version)
        }
      }),
    )
  token = (await signInDirect(app, first.ownerId))!.accessToken
  foreign = (await signInDirect(app, second.ownerId))!.accessToken
  await addInstance(first, modelKeys[0]!)
  await addInstance(first, modelKeys[0]!, first.ownerId, first.ownerId, true)
  await addInstance(first, modelKeys[0]!)
  await addInstance(first, modelKeys[1]!)
  await addInstance(first, modelKeys[0]!, first.users.alice, first.users.alice)
  await addInstance(first, modelKeys[0]!, first.users.alice, first.ownerId)
  await addInstance(second, modelKeys[0]!)
  await addInstance(second, 'foreign-only')
})
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

it('filters all four personal lists before pagination without widening owner or tenant visibility', async () => {
  for (const [path, total] of [
    ['instances/mine', 3],
    ['tasks/todo', 4],
    ['tasks/done', 4],
    ['ccs/mine', 4],
  ] as const) {
    const firstPage = (
      await get(path, { modelKey: modelKeys[0], page: 1, pageSize: 2 }).expect(200)
    ).body.data
    const secondPage = (
      await get(path, { modelKey: modelKeys[0], page: 2, pageSize: 2 }).expect(200)
    ).body.data
    expect(firstPage.total).toBe(total)
    expect(secondPage.total).toBe(total)
    expect(firstPage.items).toHaveLength(2)
    const items = [...firstPage.items, ...secondPage.items]
    expect(items).toHaveLength(total)
    expect(
      items.every(
        (item: { modelKey?: string; instance?: { modelKey: string } }) =>
          (item.instance?.modelKey ?? item.modelKey) === modelKeys[0],
      ),
    ).toBe(true)
    expect((await get(path, { modelKey: 'foreign-only' }).expect(200)).body.data.total).toBe(0)
    expect(
      (await get(path, { modelKey: 'foreign-only' }, foreign).expect(200)).body.data.total,
    ).toBe(1)
    expect((await get(path, { modelKey: modelKeys[1] }).expect(200)).body.data.total).toBe(1)
  }
})

it('combines copies model filtering with unread state and preserves the existing read action', async () => {
  const unread = (await get('ccs/mine', { modelKey: modelKeys[0], unread: 'true' }).expect(200))
    .body.data
  expect(unread.total).toBe(3)
  expect(
    (await get('ccs/mine', { modelKey: modelKeys[0], unread: 'false' }).expect(200)).body.data
      .total,
  ).toBe(1)
  await request(app.getHttpServer())
    .post(`/api/wf/ccs/${unread.items[0].id}/read`)
    .set(bearer(foreign))
    .send({})
    .expect(404)
  await request(app.getHttpServer())
    .post(`/api/wf/ccs/${unread.items[0].id}/read`)
    .set(bearer(token))
    .send({})
    .expect(200)
  expect(
    (await get('ccs/mine', { modelKey: modelKeys[0], unread: 'true' }).expect(200)).body.data.total,
  ).toBe(2)
})

it('keeps unfiltered calls compatible and rejects invalid filters without interpreting them as SQL', async () => {
  expect((await get('instances/mine').expect(200)).body.data.total).toBe(4)
  for (const path of ['instances/mine', 'tasks/todo', 'tasks/done', 'ccs/mine']) {
    await get(path, { modelKey: 'x'.repeat(65) }).expect(400)
    expect(
      (await get(path, { modelKey: "office-alpha' OR 1=1" }).expect(200)).body.data.total,
    ).toBe(0)
  }
})

it('uses the translated model label for invalid filters on every personal list', async () => {
  for (const lang of ['zh-CN', 'en-US']) {
    let expected: string | undefined
    for (const path of ['instances/mine', 'tasks/todo', 'tasks/done', 'ccs/mine']) {
      const response = await get(path, { modelKey: 'x'.repeat(65), lang }).expect(400)
      expected ??= response.body.msg
      expect(response.body.msg).toBe(expected)
      expect(response.body.msg).not.toContain('modelKey')
      if (lang === 'en-US') expect(response.body.msg).toContain('Model key')
      expect(response.body.errors[0].path).toBe('modelKey')
    }
  }
})
