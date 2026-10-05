// wf approval center lists (access model; see docs/design-notes.md#workflow): my started instances, my todo (pending
// tasks), my done (tasks I handled), copies sent to me and marking one read. Sign-in only, each list only the
// caller's own rows on live instances; reading someone else's copy → 404.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { WfChangeSet } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { approve } from '../../src/modules/workflow/engine/actions.js'
import { cc } from '../../src/modules/workflow/engine/lifecycle.js'
import { transfer } from '../../src/modules/workflow/engine/routing.js'
import type { WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { type WfRun, WfStore } from '../../src/modules/workflow/runtime/wf-store.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfl-'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[] }
let seq = 0
let deptId = 0
/**
 * alice's: `main` (bob → notify dave → carol, carol transferred to erin), `pair` (bob or carol, bob
 * approved: carol's task canceled), `done` (nobody to ask: approved at start); carol's: `hers` (bob, who
 * copied dave).
 */
const inst = { main: 0, pair: 0, done: 0, hers: 0 }

const get = (who: string, path: string, query: Record<string, unknown> = {}) =>
  request(app.getHttpServer())
    .get(`/api/wf/${path}`)
    .query(query)
    .set({ ...bearer(tokens[who]!), 'Accept-Language': 'en-US', 'X-Timezone': 'UTC' })
const list = async (who: string, path: string, query: Record<string, unknown> = {}) =>
  (await get(who, path, query).expect(200)).body.data as { items: any[]; total: number }
const read = (who: string, id: number) =>
  request(app.getHttpServer()).post(`/api/wf/ccs/${id}/read`).set(bearer(tokens[who]!))

const review = (id: string, userIds: number[], next?: object) => ({
  id,
  type: 'review',
  name: `${id} step`,
  assignee: { kind: 'users', ids: userIds },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'sendBack',
  next,
})
const tree = (next?: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })

/** A dynamic model named `name` with one published version of `root`; its key. */
async function model(root: object, name: string): Promise<string> {
  const key = `${PREFIX}m${++seq}`
  const m = await ds.query(
    'INSERT INTO wf_model (model_key, name, form_kind, enabled) VALUES (?, ?, ?, 1)',
    [key, name, 'dynamic'],
  )
  const v = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, 1, ?, ?)`,
    [m.insertId, key, JSON.stringify(root), JSON.stringify({ fields: {} })],
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [
    v.insertId,
    m.insertId,
  ])
  return key
}

/** Starts model `key` as `who` through the API; the instance id. */
async function start(who: string, key: string): Promise<number> {
  const res = await request(app.getHttpServer())
    .post('/api/wf/instances')
    .set(bearer(tokens[who]!))
    .send({ modelKey: key })
    .expect(201)
  return res.body.data.id as number
}

/** Runs an engine action on the pending task of `userId` (its own CLS context, no caller). */
const act = (id: number, userId: number, fn: (r: WfRun, task: WfTaskRow) => Promise<WfChangeSet>) =>
  app.get(ClsService).run(() =>
    app.get(WfStore).act(id, (r) =>
      fn(
        r,
        r.tasks.find((t) => t.assigneeId === userId && t.state === 'pending')!,
      ),
    ),
  )

async function user(name: string) {
  u[name] = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: deptId,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  made.iam_user.push(u[name]!)
  tokens[name] = (await signIn(app, PREFIX + name)).accessToken
}

async function cleanup() {
  const sub = `SELECT id FROM wf_instance WHERE model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  await cleanup()
  deptId = await insertRow(ds.manager, 'iam_dept', {
    parent_id: 0,
    name: `${PREFIX}dept`,
    tree_path: '/',
  })
  made.iam_dept.push(deptId)
  for (const name of ['alice', 'bob', 'carol', 'dave', 'erin', 'mallory']) await user(name)

  inst.main = await start(
    'alice',
    await model(
      tree(
        review('r1', [u.bob!], {
          id: 'c1',
          type: 'notify',
          name: 'c1 copy',
          assignee: { kind: 'users', ids: [u.dave] },
          next: review('r2', [u.carol!]),
        }),
      ),
      'seed.role.staff',
    ),
  )
  await act(inst.main, u.bob!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: 'fine' }))
  await act(inst.main, u.carol!, (r, t) =>
    transfer(r.ctx, r.inst, r.tasks, t, { to: u.erin!, comment: 'busy' }),
  )
  inst.pair = await start('alice', await model(tree(review('p', [u.bob!, u.carol!])), 'pair'))
  await act(inst.pair, u.bob!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: null }))
  inst.done = await start('alice', await model(tree(), 'nobody'))
  inst.hers = await start('carol', await model(tree(review('h', [u.bob!])), 'hers'))
  await act(inst.hers, u.bob!, (r, t) =>
    cc(r.ctx, r.inst, r.tasks, t, { userIds: [u.dave!], reason: 'fyi' }),
  )
  // a known order of starts (newest first: done, pair, main) and of task times
  const at = (sec: number) => `2026-03-01 08:00:${String(sec).padStart(2, '0')}.000`
  for (const [id, sec] of [
    [inst.main, 1],
    [inst.pair, 2],
    [inst.done, 3],
    [inst.hers, 4],
  ] as const)
    await ds.query('UPDATE wf_instance SET started_at = ? WHERE id = ?', [at(sec), id])
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    for (const t of ['iam_user', 'iam_dept'] as const)
      if (made[t].length) await ds.query(`DELETE FROM ${t} WHERE id IN (?)`, [made[t]])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

const ids = (page: { items: { id: number }[] }) => page.items.map((i) => i.id)
const instIds = (page: { items: { instance: { id: number } }[] }) =>
  page.items.map((i) => i.instance.id)

describe('my started instances', () => {
  it('only mine, newest first, with the title and state', async () => {
    const page = await list('alice', 'instances/mine')
    expect(page.total).toBe(3)
    expect(ids(page)).toEqual([inst.done, inst.pair, inst.main])
    expect(page.items[2]).toEqual({
      id: inst.main,
      modelKey: `${PREFIX}m1`,
      modelName: 'seed.role.staff',
      title: 'Staff-alice-2026-03-01',
      initiator: { id: u.alice, name: 'alice' },
      state: 'running',
      startedAt: '2026-03-01T08:00:01.000Z',
      endedAt: null,
    })
    expect(page.items[0]).toMatchObject({ state: 'approved', endedAt: expect.any(String) })
    expect(ids(await list('carol', 'instances/mine'))).toEqual([inst.hers])
    expect(await list('mallory', 'instances/mine')).toEqual({ items: [], total: 0 })
  })

  it('filters by state, sorts and pages', async () => {
    expect(ids(await list('alice', 'instances/mine', { state: 'running' }))).toEqual([inst.main])
    expect(ids(await list('alice', 'instances/mine', { state: 'approved' }))).toEqual([
      inst.done,
      inst.pair,
    ])
    expect(ids(await list('alice', 'instances/mine', { sort: 'startedAt' }))).toEqual([
      inst.main,
      inst.pair,
      inst.done,
    ])
    const page = await list('alice', 'instances/mine', { page: 2, pageSize: 1 })
    expect(page).toMatchObject({ total: 3, items: [{ id: inst.pair }] })
    await get('alice', 'instances/mine', { state: 'nope' }).expect(400)
    await get('alice', 'instances/mine', { sort: 'initiatorId' }).expect(400)
  })
})

describe('my tasks', () => {
  it('todo: my pending tasks only, with their instance', async () => {
    const bob = await list('bob', 'tasks/todo')
    expect(bob.total).toBe(1)
    expect(bob.items[0]).toMatchObject({
      nodeId: 'h',
      nodeName: 'h step',
      state: 'pending',
      comment: null,
      handledAt: null,
      instance: { id: inst.hers, modelName: 'hers', initiator: { id: u.carol, name: 'carol' } },
    })
    const erin = await list('erin', 'tasks/todo')
    expect(erin.items).toMatchObject([
      {
        nodeId: 'r2',
        state: 'pending',
        instance: { id: inst.main, title: 'Staff-alice-2026-03-01' },
      },
    ])
    // carol's main task was transferred, her pair task canceled when bob approved it
    for (const who of ['alice', 'carol', 'dave', 'mallory'])
      expect(await list(who, 'tasks/todo')).toEqual({ items: [], total: 0 })
  })

  it('done: the tasks I handled, latest first; a task canceled by another is not one', async () => {
    const bob = await list('bob', 'tasks/done')
    expect(instIds(bob)).toEqual([inst.pair, inst.main])
    expect(bob.items[1]).toMatchObject({
      nodeId: 'r1',
      state: 'approved',
      comment: 'fine',
      handledAt: expect.any(String),
    })
    const carol = await list('carol', 'tasks/done')
    expect(carol.items).toMatchObject([
      { nodeId: 'r2', state: 'transferred', comment: 'busy', instance: { id: inst.main } },
    ])
    for (const who of ['alice', 'dave', 'erin', 'mallory'])
      expect(await list(who, 'tasks/done')).toEqual({ items: [], total: 0 })
    expect(instIds(await list('bob', 'tasks/done', { sort: 'handledAt' }))).toEqual([
      inst.main,
      inst.pair,
    ])
    await get('bob', 'tasks/done', { sort: 'createdAt,-nope' }).expect(400)
  })
})

describe('copies sent to me', () => {
  it('only mine, newest first: from a reviewer with a reason, or from a notify step', async () => {
    const dave = await list('dave', 'ccs/mine')
    expect(dave.total).toBe(2)
    expect(dave.items).toMatchObject([
      {
        fromUser: { id: u.bob, name: 'bob' },
        reason: 'fyi',
        readAt: null,
        instance: { id: inst.hers, title: expect.stringMatching(/^hers-carol-/) },
      },
      { fromUser: null, reason: null, readAt: null, instance: { id: inst.main } },
    ])
    for (const who of ['alice', 'bob', 'mallory'])
      expect(await list(who, 'ccs/mine')).toEqual({ items: [], total: 0 })
  })

  it("marks my copy read once; someone else's or an unknown one 404", async () => {
    const [copy] = (await list('dave', 'ccs/mine', { unread: true })).items
    await read('mallory', copy.id).expect(404)
    await read('bob', copy.id).expect(404)
    await read('dave', 2 ** 31).expect(404)
    await read('dave', 'abc' as unknown as number).expect(400)
    expect((await list('dave', 'ccs/mine', { unread: true })).total).toBe(2)

    expect((await read('dave', copy.id).expect(200)).body.data).toBeNull()
    const [first] = (await list('dave', 'ccs/mine', { unread: false })).items
    expect(first).toMatchObject({ id: copy.id, readAt: expect.any(String) })
    await read('dave', copy.id).expect(200)
    const [again] = (await list('dave', 'ccs/mine', { unread: false })).items
    expect(again.readAt).toBe(first.readAt)
    expect(ids(await list('dave', 'ccs/mine', { unread: true }))).not.toContain(copy.id)
    expect((await list('dave', 'ccs/mine')).total).toBe(2)
  })
})

describe('deleted rows and sign-in', () => {
  it('a deleted instance leaves every list; a deleted task or copy its own', async () => {
    await ds.query('UPDATE wf_instance SET deleted_at = NOW(3) WHERE id = ?', [inst.main])
    try {
      expect(ids(await list('alice', 'instances/mine'))).toEqual([inst.done, inst.pair])
      expect((await list('erin', 'tasks/todo')).total).toBe(0)
      expect(instIds(await list('bob', 'tasks/done'))).toEqual([inst.pair])
      expect(instIds(await list('dave', 'ccs/mine'))).toEqual([inst.hers])
    } finally {
      await ds.query('UPDATE wf_instance SET deleted_at = NULL WHERE id = ?', [inst.main])
    }
    const [copy] = (await list('dave', 'ccs/mine')).items
    await ds.query('UPDATE wf_task SET deleted_at = NOW(3) WHERE instance_id = ? AND node_id = ?', [
      inst.hers,
      'h',
    ])
    await ds.query('UPDATE wf_cc SET deleted_at = NOW(3) WHERE id = ?', [copy.id])
    try {
      expect((await list('bob', 'tasks/todo')).total).toBe(0)
      expect(instIds(await list('dave', 'ccs/mine'))).toEqual([inst.main])
      await read('dave', copy.id).expect(404)
    } finally {
      await ds.query('UPDATE wf_task SET deleted_at = NULL WHERE instance_id = ?', [inst.hers])
      await ds.query('UPDATE wf_cc SET deleted_at = NULL WHERE id = ?', [copy.id])
    }
  })

  it('signed out: 401', async () => {
    for (const path of ['instances/mine', 'tasks/todo', 'tasks/done', 'ccs/mine'])
      await request(app.getHttpServer()).get(`/api/wf/${path}`).expect(401)
    await request(app.getHttpServer()).post('/api/wf/ccs/1/read').expect(401)
  })
})
