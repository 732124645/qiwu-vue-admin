// wf admin (管理员 + access model, 管理侧服务端; see docs/design-notes.md#workflow): GET /wf/instances, GET /wf/tasks,
// POST /wf/instances/:id/terminate, POST /wf/tasks/:id/reassign. Behind wfPerms (instance.browse,
// task.browse, task.manage); each list and action is limited to the caller's data scope for the route's perm
// on wf_instance.initiator_dept_id (out of scope → 404, as unknown). Terminate cancels the open tasks and
// ends the instance `terminated`; reassign moves an open review task (target rules: 422 WF_BAD_TARGET).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, wfPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfa-'
const KEY = `${PREFIX}m`

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const d: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[], iam_role: [] as number[] }
let seq = 0

const call = (who: string, method: 'get' | 'post', path: string, body?: object) => {
  const req = request(app.getHttpServer())[method](`/api/wf${path}`)
  if (tokens[who]) req.set(bearer(tokens[who]))
  return method === 'get' ? req.query(body ?? {}) : req.send(body ?? {})
}
const get = (who: string, path: string, query?: object) => call(who, 'get', path, query)
const post = (who: string, path: string, body?: object) => call(who, 'post', path, body)

/** An instance of the test model started by `who` (different values each time: not a duplicate submit). */
async function startAs(who: 'alice' | 'bob'): Promise<number> {
  const res = await post(who, '/instances', { modelKey: KEY, formValues: { n: ++seq } }).expect(201)
  return res.body.data.id as number
}

const instanceRow = async (id: number) =>
  (
    await ds.query<{ state: string; active_node_ids: string[]; ended_at: Date | null }[]>(
      'SELECT state, active_node_ids, ended_at FROM wf_instance WHERE id = ? AND deleted_at IS NULL',
      [id],
    )
  )[0]
const tasksOf = (instanceId: number) =>
  ds.query<{ id: number; assignee_id: number; state: string }[]>(
    'SELECT id, assignee_id, state FROM wf_task WHERE instance_id = ? AND deleted_at IS NULL ORDER BY id',
    [instanceId],
  )
const eventsOf = (instanceId: number, action: string) =>
  ds.query<{ actor_id: number; target_ids: number[] | null; comment: string | null }[]>(
    `SELECT actor_id, target_ids, comment FROM wf_event
      WHERE instance_id = ? AND action = ? AND deleted_at IS NULL ORDER BY id`,
    [instanceId, action],
  )

async function add(table: keyof typeof made, row: Record<string, unknown>) {
  const id = await insertRow(ds.manager, table, row)
  made[table].push(id)
  return id
}

/** A dept under `parent` (null = top level); tree_path = the parent's + its own id. */
async function dept(name: string, parent: string | null) {
  d[name] = await add('iam_dept', {
    parent_id: parent ? d[parent] : 0,
    name: PREFIX + name,
    tree_path: '/',
  })
  const [row] = await ds.query<{ tree_path: string }[]>(
    'SELECT tree_path FROM iam_dept WHERE id = ? AND deleted_at IS NULL',
    [parent ? d[parent] : 0],
  )
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [
    `${row?.tree_path ?? '/'}${d[name]}/`,
    d[name],
  ])
}

/** A role holding the menu rows of `perms`. */
async function role(name: string, dataScope: string, perms: string[]) {
  const id = await add('iam_role', {
    code: PREFIX + name,
    name: PREFIX + name,
    data_scope: dataScope,
  })
  for (const p of perms)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      id,
      await findId(ds.manager, 'iam_menu', { perms: p }),
    ])
  return id
}

/** A user in `deptName` with `roles`, signed in unless disabled. */
async function user(name: string, deptName: string, roles: number[] = [], enabled = true) {
  u[name] = await add('iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: d[deptName],
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
    enabled,
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [u[name], r])
  if (enabled) tokens[name] = (await signIn(app, PREFIX + name)).accessToken
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
  await dept('top', null)
  await dept('sub', 'top')
  await dept('other', null)
  const { instance, task } = wfPerms
  // own dept tree for every admin perm; all depts for browsing instances only
  const narrow = await role('narrow', 'own_dept_tree', [instance.browse, task.browse, task.manage])
  const wide = await role('wide', 'all', [instance.browse])
  const browse = await role('browse', 'all', [instance.browse, task.browse])
  const staff = (await findId(ds.manager, 'iam_role', { code: 'staff' }))!
  for (const name of ['carol', 'erin', 'frank']) await user(name, 'other')
  await user('dave', 'other', [], false)
  await user('alice', 'sub')
  await user('bob', 'other')
  await user('lead', 'top', [narrow])
  await user('mixed', 'top', [narrow, wide])
  await user('browser', 'other', [browse])
  await user('staffer', 'other', [staff])
  tokens.admin = (await signIn(app)).accessToken
  // begin → one review step for carol and erin (both must approve)
  const tree = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    next: {
      id: 'r1',
      type: 'review',
      name: 'Review',
      assignee: { kind: 'users', ids: [u.carol, u.erin] },
      sign: 'all',
      whenNobody: 'autoPass',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
    },
  }
  const m = await ds.query('INSERT INTO wf_model (model_key, name, form_kind) VALUES (?, ?, ?)', [
    KEY,
    `${PREFIX}name`,
    'dynamic',
  ])
  const v = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, 1, ?, ?)`,
    [m.insertId, KEY, JSON.stringify(tree), JSON.stringify({ fields: {} })],
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [
    v.insertId,
    m.insertId,
  ])
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    const users = made.iam_user
    if (users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      for (const t of ['msg_inbox', 'msg_mail_record'])
        await ds.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [users])
    }
    if (made.iam_role.length)
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [made.iam_role])
    for (const t of ['iam_user', 'iam_role', 'iam_dept'] as const)
      if (made[t].length) await ds.query(`DELETE FROM ${t} WHERE id IN (?)`, [made[t]])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('access (wfPerms)', () => {
  it('staff (no wfPerms) → 403 everywhere; browse perms list but cannot act; no session → 401', async () => {
    const id = await startAs('alice')
    const [task] = await tasksOf(id)
    const routes: [method: 'get' | 'post', path: string, body?: object][] = [
      ['get', '/instances'],
      ['get', '/tasks'],
      ['post', `/instances/${id}/terminate`],
      ['post', `/tasks/${task!.id}/reassign`, { to: u.frank }],
    ]
    for (const [method, path, body] of routes) {
      await call('staffer', method, path, body).expect(403)
      await call('nobody', method, path, body).expect(401)
    }
    await get('browser', '/instances', { modelKey: KEY }).expect(200)
    await get('browser', '/tasks', { modelKey: KEY }).expect(200)
    for (const [method, path, body] of routes.slice(2))
      await call('browser', method, path, body).expect(403)
    expect((await instanceRow(id))!.state).toBe('running')
  })
})

describe('lists', () => {
  let mine: number
  let theirs: number
  beforeAll(async () => {
    mine = await startAs('alice')
    theirs = await startAs('bob')
  })

  it('instances: root sees every one with names; filters by state and initiator', async () => {
    const res = await get('admin', '/instances', { modelKey: KEY, pageSize: 200 }).expect(200)
    const ids = res.body.data.items.map((i: { id: number }) => i.id)
    expect(ids).toEqual(expect.arrayContaining([mine, theirs]))
    expect(ids.indexOf(theirs)).toBeLessThan(ids.indexOf(mine)) // newest first
    expect(res.body.data.items.find((i: { id: number }) => i.id === mine)).toEqual({
      id: mine,
      modelKey: KEY,
      modelName: `${PREFIX}name`,
      initiator: { id: u.alice, name: 'alice' },
      dept: { id: d.sub, name: `${PREFIX}sub` },
      state: 'running',
      activeNodeIds: ['r1'],
      startedAt: expect.any(String),
      endedAt: null,
    })
    const bobs = await get('admin', '/instances', { modelKey: KEY, initiatorId: u.bob })
    expect(bobs.body.data.items.map((i: { id: number }) => i.id)).toContain(theirs)
    expect(
      bobs.body.data.items.every((i: { initiator: { id: number } }) => i.initiator.id === u.bob),
    ).toBe(true)
    const ended = await get('admin', '/instances', { modelKey: KEY, state: 'approved' })
    expect(ended.body.data).toEqual({ items: [], total: 0 })
    await get('admin', '/instances', { state: 'nope' }).expect(400)
  })

  it("instances: a non-root admin sees only its data scope's (the perm's roles)", async () => {
    const lead = await get('lead', '/instances', { modelKey: KEY, pageSize: 200 }).expect(200)
    const ids = lead.body.data.items.map((i: { id: number }) => i.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
    expect(lead.body.data.total).toBe(ids.length)
    // mixed also holds instance.browse at `all`
    const mixed = await get('mixed', '/instances', { modelKey: KEY, pageSize: 200 }).expect(200)
    expect(mixed.body.data.items.map((i: { id: number }) => i.id)).toEqual(
      expect.arrayContaining([mine, theirs]),
    )
  })

  it('tasks: root sees every one with its instance; filters; a non-root admin its scope only', async () => {
    const res = await get('admin', '/tasks', { instanceId: mine }).expect(200)
    expect(res.body.data.items).toEqual(
      [u.erin, u.carol].map((assignee) => ({
        id: expect.any(Number),
        nodeId: 'r1',
        nodeName: 'Review',
        assignee: { id: assignee, name: assignee === u.carol ? 'carol' : 'erin' },
        ownerId: null,
        state: 'pending',
        createdAt: expect.any(String),
        handledAt: null,
        dueAt: null,
        instance: {
          id: mine,
          modelKey: KEY,
          modelName: `${PREFIX}name`,
          initiator: { id: u.alice, name: 'alice' },
          dept: { id: d.sub, name: `${PREFIX}sub` },
          state: 'running',
        },
      })),
    )
    const carols = await get('admin', '/tasks', {
      modelKey: KEY,
      assigneeId: u.carol,
      state: 'pending',
      pageSize: 200,
    }).expect(200)
    const instances = carols.body.data.items.map((t: { instance: { id: number } }) => t.instance.id)
    expect(instances).toEqual(expect.arrayContaining([mine, theirs]))
    expect(
      carols.body.data.items.every((t: { assignee: { id: number } }) => t.assignee.id === u.carol),
    ).toBe(true)
    // the task perm's role is own_dept_tree for both, whatever else mixed holds
    for (const who of ['lead', 'mixed']) {
      const scoped = await get(who, '/tasks', { modelKey: KEY, pageSize: 200 }).expect(200)
      const seen = scoped.body.data.items.map((t: { instance: { id: number } }) => t.instance.id)
      expect(seen).toContain(mine)
      expect(seen).not.toContain(theirs)
    }
  })
})

describe('terminate', () => {
  it('ends a running instance in scope as terminated, its open tasks canceled; again → 409', async () => {
    const id = await startAs('alice')
    await post('lead', `/instances/${id}/terminate`, { comment: 'left the company' }).expect(200)
    expect(await instanceRow(id)).toEqual({
      state: 'terminated',
      active_node_ids: [],
      ended_at: expect.any(Date),
    })
    expect((await tasksOf(id)).map((t) => t.state)).toEqual(['canceled', 'canceled'])
    expect(await eventsOf(id, 'terminate')).toEqual([
      { actor_id: u.lead, target_ids: null, comment: 'left the company' },
    ])
    await post('lead', `/instances/${id}/terminate`).expect(409)
  })

  it('out of the scope of the task.manage roles → 404 (mixed browses it at all); unknown → 404', async () => {
    const id = await startAs('bob')
    for (const who of ['lead', 'mixed']) await post(who, `/instances/${id}/terminate`).expect(404)
    await post('lead', '/instances/999999999/terminate').expect(404)
    expect((await instanceRow(id))!.state).toBe('running')
    // root: every instance
    await post('admin', `/instances/${id}/terminate`, { comment: null }).expect(200)
    expect((await instanceRow(id))!.state).toBe('terminated')
  })

  it('a comment over 1000 characters → 400', async () => {
    const id = await startAs('alice')
    const res = await post('lead', `/instances/${id}/terminate`, { comment: 'x'.repeat(1001) })
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual([{ path: 'comment', msg: expect.any(String) }])
  })
})

describe('reassign', () => {
  it("moves an open task in scope to another user; the node's other holder or a disabled user → 422", async () => {
    const id = await startAs('alice')
    const [carols, erins] = await tasksOf(id)
    await post('lead', `/tasks/${carols!.id}/reassign`, {
      to: u.frank,
      comment: 'handover',
    }).expect(200)
    expect(await tasksOf(id)).toEqual([
      { id: carols!.id, assignee_id: u.frank, state: 'pending' },
      { id: erins!.id, assignee_id: u.erin, state: 'pending' },
    ])
    expect(await eventsOf(id, 'reassign')).toEqual([
      { actor_id: u.lead, target_ids: [u.frank], comment: 'handover' },
    ])
    // frank and erin each hold an open task on the node now; dave is disabled
    for (const to of [u.frank, u.dave]) {
      const res = await post('lead', `/tasks/${erins!.id}/reassign`, { to }).expect(422)
      expect(res.body.code).toBe(Err.WF_BAD_TARGET.code)
    }
    expect((await tasksOf(id))[1]).toMatchObject({ assignee_id: u.erin })
  })

  it('a task of an instance out of scope or unknown → 404; a closed one → 409; no target → 400', async () => {
    const id = await startAs('bob')
    const [task] = await tasksOf(id)
    for (const who of ['lead', 'mixed'])
      await post(who, `/tasks/${task!.id}/reassign`, { to: u.frank }).expect(404)
    await post('lead', '/tasks/999999999/reassign', { to: u.frank }).expect(404)
    expect((await tasksOf(id))[0]).toMatchObject({ assignee_id: u.carol })
    await post('admin', `/tasks/${task!.id}/reassign`, {}).expect(400)
    await post('admin', `/instances/${id}/terminate`).expect(200)
    await post('admin', `/tasks/${task!.id}/reassign`, { to: u.frank }).expect(409)
  })
})
