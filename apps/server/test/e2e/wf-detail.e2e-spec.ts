// wf instance detail (安全/实例访问; see docs/design-notes.md#workflow): GET /wf/instances/:id. Sign-in only; the
// initiator, anyone with a task on the instance (or owning a delegated one), a cc recipient, or a
// `wf.instance.view` holder whose scope for that perm covers `initiator_dept_id` (root: all) sees it,
// everybody else gets 404 (IDOR). The title is built on read (`{model}-{initiator}-{date}`, reader's
// language and time zone); the timeline is `wf_event` with actor, target and node names.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { type WfChangeSet, wfPerms } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { approve, resubmit, sendBack } from '../../src/modules/workflow/engine/actions.js'
import { addSign, delegate, transfer } from '../../src/modules/workflow/engine/routing.js'
import type { WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { type WfRun, WfStore } from '../../src/modules/workflow/runtime/wf-store.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfd-'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const d: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[], iam_role: [] as number[] }
let seq = 0
/** alice's instances: `main` (bob → notify dave → carol), `other` (frank only) */
const inst = { main: 0, other: 0 }

const get = (who: string, id: number | string, headers: Record<string, string> = {}) =>
  request(app.getHttpServer())
    .get(`/api/wf/instances/${id}`)
    .set({ ...bearer(tokens[who]!), ...headers })

const review = (id: string, userId: number, next?: object) => ({
  id,
  type: 'review',
  name: `${id} step`,
  assignee: { kind: 'users', ids: [userId] },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'sendBack',
  next,
})
const tree = (next: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })

/** A dynamic model named `name` with one published version of `root` (form `fields`); its key. */
async function model(root: object, name: string, fields: object = {}): Promise<string> {
  const key = `${PREFIX}m${++seq}`
  const m = await ds.query(
    'INSERT INTO wf_model (model_key, name, form_kind, enabled) VALUES (?, ?, ?, 1)',
    [key, name, 'dynamic'],
  )
  const v = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, 1, ?, ?)`,
    [m.insertId, key, JSON.stringify(root), JSON.stringify({ fields })],
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [
    v.insertId,
    m.insertId,
  ])
  return key
}

/** Starts model `key` as alice through the API; the instance id. */
async function startAsAlice(key: string): Promise<number> {
  const res = await request(app.getHttpServer())
    .post('/api/wf/instances')
    .set(bearer(tokens.alice!))
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

/** A role with `dataScope`, granted `wf.instance.view` when `view`. */
async function role(name: string, dataScope: string, view: boolean) {
  const id = await add('iam_role', {
    code: PREFIX + name,
    name: PREFIX + name,
    data_scope: dataScope,
  })
  if (view)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      id,
      await findId(ds.manager, 'iam_menu', { perms: wfPerms.instance.view }),
    ])
  return id
}

async function user(name: string, deptName: string, roleIds: number[] = []) {
  u[name] = await add('iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: d[deptName],
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roleIds)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [u[name], r])
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
  await dept('top', null)
  await dept('sub', 'top')
  await dept('other', null)
  const treeView = await role('tree-view', 'own_dept_tree', true)
  const ownView = await role('own-view', 'own_dept', true)
  const allNoView = await role('all-no-view', 'all', false)
  for (const name of ['bob', 'carol', 'dave', 'erin', 'frank', 'mallory']) await user(name, 'other')
  await user('alice', 'sub')
  // wf.instance.view over top and its sub-depts (alice's dept is one)
  await user('scoped', 'top', [treeView])
  // wf.instance.view over their own dept only (not alice's)
  await user('outside', 'other', [ownView])
  // scope `all`, but from a role without the perm
  await user('wide', 'other', [allNoView])
  // both: the perm's scope is own_dept, the `all` role must not widen it
  await user('mixed', 'other', [ownView, allNoView])
  tokens.root = (await signIn(app)).accessToken

  const main = await model(
    tree(
      review('r1', u.bob!, {
        id: 'c1',
        type: 'notify',
        name: 'c1 copy',
        assignee: { kind: 'users', ids: [u.dave] },
        next: review('r2', u.carol!),
      }),
    ),
    'seed.role.staff',
  )
  inst.main = await startAsAlice(main)
  await act(inst.main, u.bob!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: 'fine' }))
  await act(inst.main, u.carol!, (r, t) =>
    transfer(r.ctx, r.inst, r.tasks, t, { to: u.erin!, comment: 'busy' }),
  )
  await act(inst.main, u.erin!, (r, t) =>
    sendBack(r.ctx, r.inst, r.tasks, t, { to: 'r1', comment: 'again' }),
  )
  inst.other = await startAsAlice(await model(tree(review('only', u.frank!)), `${PREFIX}plain`))
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    if (made.iam_user.length)
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [made.iam_user])
    if (made.iam_role.length)
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [made.iam_role])
    for (const t of ['iam_user', 'iam_role', 'iam_dept'] as const)
      if (made[t].length) await ds.query(`DELETE FROM ${t} WHERE id IN (?)`, [made[t]])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('access (IDOR)', () => {
  it('the initiator, past and current task holders and cc recipients see it; anyone else 404', async () => {
    for (const who of ['alice', 'bob', 'carol', 'dave', 'erin'])
      await get(who, inst.main).expect(200)
    await get('mallory', inst.main).expect(404)
    await get('frank', inst.other).expect(200)
    // their tasks / copies are on the main instance, not on this one
    for (const who of ['bob', 'dave', 'mallory']) await get(who, inst.other).expect(404)
  })

  it('unknown id 404, a non-numeric one 400, signed out 401', async () => {
    await get('alice', 2 ** 31).expect(404)
    await get('alice', 'abc').expect(400)
    await request(app.getHttpServer()).get(`/api/wf/instances/${inst.main}`).expect(401)
  })

  it('a deleted task or copy grants nothing, a deleted instance is gone', async () => {
    await ds.query(
      `INSERT INTO wf_task (instance_id, node_id, node_name, assignee_id, state, deleted_at)
       VALUES (?, 'only', 'only step', ?, 'canceled', NOW(3))`,
      [inst.other, u.mallory],
    )
    await ds.query(
      'INSERT INTO wf_cc (instance_id, node_id, user_id, deleted_at) VALUES (?, ?, ?, NOW(3))',
      [inst.other, 'only', u.mallory],
    )
    await get('mallory', inst.other).expect(404)
    await ds.query('UPDATE wf_instance SET deleted_at = NOW(3) WHERE id = ?', [inst.other])
    try {
      await get('alice', inst.other).expect(404)
      await get('root', inst.other).expect(404)
    } finally {
      await ds.query('UPDATE wf_instance SET deleted_at = NULL WHERE id = ?', [inst.other])
    }
  })

  it('the owner of a delegated task sees it (a past assignee); a deleted such task grants nothing', async () => {
    // the delegate's task alone: mallory's own (owner) row is not needed for her to see it
    const task = await insertRow(ds.manager, 'wf_task', {
      instance_id: inst.other,
      node_id: 'only',
      node_name: 'only step',
      assignee_id: u.frank,
      owner_id: u.mallory,
      state: 'pending',
    })
    try {
      await get('mallory', inst.other).expect(200)
      await ds.query('UPDATE wf_task SET deleted_at = NOW(3) WHERE id = ?', [task])
      await get('mallory', inst.other).expect(404)
    } finally {
      await ds.query('DELETE FROM wf_task WHERE id = ?', [task])
    }
  })

  it('wf.instance.view: within the scope of the roles holding it (initiator_dept_id); root all', async () => {
    await get('scoped', inst.main).expect(200)
    await get('root', inst.main).expect(200)
    // own dept only: alice is in another one
    await get('outside', inst.main).expect(404)
    // scope `all` without the perm, alone or beside the perm's narrower role
    await get('wide', inst.main).expect(404)
    await get('mixed', inst.main).expect(404)
  })
})

describe('detail', () => {
  it('the title in the reader language and time zone; the instance and its timeline', async () => {
    await ds.query("UPDATE wf_instance SET started_at = '2026-03-01 20:00:00.000' WHERE id = ?", [
      inst.main,
    ])
    const zh = await get('alice', inst.main, {
      'Accept-Language': 'zh-CN',
      'X-Timezone': 'Asia/Shanghai',
    }).expect(200)
    expect(zh.body.data.title).toBe('员工-alice-2026-03-02')
    const res = await get('bob', inst.main, {
      'Accept-Language': 'en-US',
      'X-Timezone': 'UTC',
    }).expect(200)
    const data = res.body.data
    expect(data).toMatchObject({
      id: inst.main,
      modelName: 'seed.role.staff',
      title: 'Staff-alice-2026-03-01',
      formKind: 'dynamic',
      viewComponent: null,
      businessKey: null,
      state: 'running',
      initiator: { id: u.alice, name: 'alice' },
      startedAt: '2026-03-01T20:00:00.000Z',
      endedAt: null,
    })
    const rows = (data.timeline as Record<string, any>[]).map((e) => [
      e.action,
      e.nodeId,
      e.nodeName,
      e.actor,
      e.targets,
      e.comment,
    ])
    const who = (name: string) => ({ id: u[name], name })
    expect(rows).toEqual([
      ['begin', 'begin', 'Begin', who('alice'), [], null],
      ['approve', 'r1', 'r1 step', who('bob'), [], 'fine'],
      ['cc', 'c1', 'c1 copy', null, [who('dave')], null],
      ['transfer', 'r2', 'r2 step', who('carol'), [who('erin')], 'busy'],
      ['send_back', 'r2', 'r2 step', who('erin'), [{ id: 'r1', name: 'r1 step' }], 'again'],
    ])
  })

  it('the progress tree: the version tree, each node and path by progress, parallel paths at once', async () => {
    // main: erin sent r2 back to r1, the line after it is pending again
    const main = (await get('bob', inst.main).expect(200)).body.data
    expect(main.tree).toMatchObject({ id: 'begin', next: { id: 'r1', next: { id: 'c1' } } })
    expect(main.progress).toEqual({ begin: 'done', r1: 'active', c1: 'pending', r2: 'pending' })

    const fork = {
      id: 'f',
      type: 'fork',
      name: 'f fork',
      mode: 'parallel',
      paths: [
        { id: 'fa', name: 'fa path', when: [], child: review('pa', u.carol!) },
        { id: 'fb', name: 'fb path', when: [], child: review('pb', u.dave!) },
      ],
      next: review('pz', u.frank!),
    }
    const id = await startAsAlice(await model(tree(review('p1', u.bob!, fork)), `${PREFIX}fork`))
    await act(id, u.bob!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: null }))
    const progress = async () => (await get('alice', id).expect(200)).body.data.progress
    expect(await progress()).toEqual({
      begin: 'done',
      p1: 'done',
      f: 'active',
      fa: 'done',
      pa: 'active',
      fb: 'done',
      pb: 'active',
      pz: 'pending',
    })
    await act(id, u.carol!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: null }))
    expect(await progress()).toMatchObject({ f: 'active', pa: 'done', pb: 'active', pz: 'pending' })
  })

  it('a version whose tree no longer compiles still shows: no tree or progress, the rest as stored', async () => {
    const fork = {
      id: 'g',
      type: 'fork',
      name: 'g fork',
      paths: [
        {
          id: 'ga',
          name: 'ga path',
          when: [[{ field: 'applicant', op: 'in', value: [u.bob] }]],
          child: review('gr', u.bob!),
        },
        { id: 'gz', name: 'gz path', fallback: true, when: [], child: review('gz1', u.frank!) },
      ],
    }
    const key = await model(tree(fork), `${PREFIX}broken`, { applicant: 'user' })
    const started = await request(app.getHttpServer())
      .post('/api/wf/instances')
      .set(bearer(tokens.alice!))
      .send({ modelKey: key, formValues: { applicant: u.bob } })
      .expect(201)
    const id = started.body.data.id as number
    // as if drawn in BPMN: the version's XML comes with its tree
    await ds.query('UPDATE wf_version SET bpmn_xml = ? WHERE model_key = ?', ['<x/>', key])
    const before = (await get('bob', id).expect(200)).body.data
    expect(before.bpmnXml).toBe('<x/>')
    // the version's fields: the designer words the condition's user ids by them
    expect(before.fields).toEqual({ applicant: 'user' })
    expect(before.progress).toMatchObject({ g: 'active', ga: 'done', gr: 'active', gz: 'skipped' })

    // the condition's field gone from the snapshot: the tree no longer compiles
    await ds.query('UPDATE wf_version SET form_snapshot = ? WHERE model_key = ?', [
      JSON.stringify({ fields: {} }),
      key,
    ])
    const after = (await get('bob', id).expect(200)).body.data
    expect(after).toMatchObject({
      id,
      state: 'running',
      fields: {},
      tree: null,
      progress: null,
      bpmnXml: null,
    })
    expect(after.myTasks).toEqual([
      {
        id: expect.any(Number),
        nodeId: 'gr',
        nodeName: 'gr step',
        type: 'review',
        commentRequired: false,
        child: false,
      },
    ])
    expect(after.timeline).toMatchObject([
      { action: 'begin', nodeId: 'begin', actor: { id: u.alice } },
    ])
    // the initiator's view: cancel / urge as before (no begin step known)
    const mine = (await get('alice', id).expect(200)).body.data
    expect(mine).toMatchObject({ tree: null, canUrge: true, withdrawable: null })
  })

  it('a deleted model and a deleted user keep their names', async () => {
    const key = `${PREFIX}m2`
    for (const t of ['wf_model', 'wf_version'])
      await ds.query(`UPDATE ${t} SET deleted_at = NOW(3) WHERE model_key = ?`, [key])
    await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ?', [u.dave])
    try {
      const other = (await get('alice', inst.other).expect(200)).body.data
      expect(other.title).toMatch(new RegExp(`^${PREFIX}plain-alice-`))
      const main = (await get('alice', inst.main).expect(200)).body.data
      const copy = main.timeline.find((e: { action: string }) => e.action === 'cc')
      expect(copy.targets).toEqual([{ id: u.dave, name: 'dave' }])
    } finally {
      await ds.query('UPDATE iam_user SET deleted_at = NULL WHERE id = ?', [u.dave])
    }
  })

  it('myTasks: the caller’s pending tasks only; sent back to begin, the initiator holds a begin task', async () => {
    // main: erin sent it back to r1, so bob holds r1 again; carol transferred, erin sent back: nothing left
    const [task] = await ds.query(
      "SELECT id FROM wf_task WHERE instance_id = ? AND assignee_id = ? AND state = 'pending'",
      [inst.main, u.bob],
    )
    expect((await get('bob', inst.main).expect(200)).body.data.myTasks).toEqual([
      {
        id: Number(task.id),
        nodeId: 'r1',
        nodeName: 'r1 step',
        type: 'review',
        commentRequired: false,
        child: false,
      },
    ])
    for (const who of ['alice', 'carol', 'erin', 'dave'])
      expect((await get(who, inst.main).expect(200)).body.data.myTasks).toEqual([])

    const back = await startAsAlice(await model(tree(review('solo', u.frank!)), `${PREFIX}back`))
    await act(back, u.frank!, (r, t) =>
      sendBack(r.ctx, r.inst, r.tasks, t, { to: 'begin', comment: 'fix it' }),
    )
    expect((await get('alice', back).expect(200)).body.data.myTasks).toEqual([
      {
        id: expect.any(Number),
        nodeId: 'begin',
        nodeName: 'Begin',
        type: 'begin',
        commentRequired: false,
        child: false,
      },
    ])
    expect((await get('frank', back).expect(200)).body.data.myTasks).toEqual([])
    // a root admin sees the instance, not someone else's task
    expect((await get('root', back).expect(200)).body.data.myTasks).toEqual([])
  })

  it('myTasks: a step wanting a comment says so; a delegated task is a child, its owner holds none', async () => {
    const strict = await startAsAlice(
      await model(
        tree({ ...review('strict', u.frank!), commentRequired: true }),
        `${PREFIX}strict`,
      ),
    )
    const mine = async (who: string) =>
      (await get(who, strict).expect(200)).body.data.myTasks as object[]
    expect(await mine('frank')).toEqual([
      expect.objectContaining({ nodeId: 'strict', commentRequired: true, child: false }),
    ])
    await act(strict, u.frank!, (r, t) =>
      delegate(r.ctx, r.inst, r.tasks, t, { to: u.erin!, comment: null }),
    )
    expect(await mine('frank')).toEqual([])
    expect(await mine('erin')).toEqual([
      expect.objectContaining({ nodeId: 'strict', commentRequired: true, child: true }),
    ])
    // a delegated task is no add-sign: nothing for frank to remove
    expect((await get('frank', strict).expect(200)).body.data.signs).toEqual([])
  })

  it('signs, withdrawable, canCancel, canUrge: the other actions the caller may take', async () => {
    const key = await model(
      tree(review('first', u.frank!, review('second', u.bob!))),
      `${PREFIX}extra`,
    )
    const id = await startAsAlice(key)
    const data = async (who: string) => (await get(who, id).expect(200)).body.data
    const flags = (allow: 0 | 1) =>
      ds.query('UPDATE wf_model SET allow_cancel = ?, allow_withdraw = ? WHERE model_key = ?', [
        allow,
        allow,
        key,
      ])
    const none = { signs: [], withdrawable: null, canCancel: false, canUrge: false }
    // only the initiator cancels and urges
    expect(await data('alice')).toMatchObject({ ...none, canCancel: true, canUrge: true })
    expect(await data('frank')).toMatchObject(none)

    // frank signs erin in before him: hers is his to remove, not hers
    await act(id, u.frank!, (r, t) =>
      addSign(r.ctx, r.inst, r.tasks, t, { kind: 'before', userIds: [u.erin!], comment: null }),
    )
    const [sign] = await ds.query<{ id: string; parent: string }[]>(
      'SELECT id, parent_task_id AS parent FROM wf_task WHERE instance_id = ? AND assignee_id = ?',
      [id, u.erin],
    )
    const parent = Number(sign!.parent)
    expect((await data('frank')).signs).toEqual([
      {
        id: Number(sign!.id),
        parentTaskId: parent,
        nodeName: 'first step',
        user: { id: u.erin, name: 'erin' },
      },
    ])
    expect((await data('erin')).signs).toEqual([])

    // both approve: frank may withdraw his approval, erin's (an add-sign) is none; a handled sign is gone
    await act(id, u.erin!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: null }))
    await act(id, u.frank!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: null }))
    expect(await data('frank')).toMatchObject({
      signs: [],
      withdrawable: { id: parent, nodeName: 'first step' },
    })
    expect((await data('erin')).withdrawable).toBeNull()

    // the model allows neither: no withdraw, no cancel; bob's review may still be urged
    await flags(0)
    expect((await data('frank')).withdrawable).toBeNull()
    expect(await data('alice')).toMatchObject({ canCancel: false, canUrge: true })
    // sent back to alice: she cancels anyway, nobody to urge
    await act(id, u.bob!, (r, t) =>
      sendBack(r.ctx, r.inst, r.tasks, t, { to: 'begin', comment: null }),
    )
    expect(await data('alice')).toMatchObject({ canCancel: true, canUrge: false })

    // resubmitted (her begin task is approved: not withdrawable), frank approves again: his newest counts
    await flags(1)
    // bob's task, made by frank's approval, is handled (sent back): the engine would refuse (409), no button
    expect((await data('frank')).withdrawable).toBeNull()
    await act(id, u.alice!, (r, t) => resubmit(r.ctx, r.inst, r.tasks, t, { comment: null }))
    expect((await data('alice')).withdrawable).toBeNull()
    await act(id, u.frank!, (r, t) => approve(r.ctx, r.inst, r.tasks, t, { comment: null }))
    const again = (await data('frank')).withdrawable as { id: number }
    expect(again.id).toBeGreaterThan(parent)

    // ended: nothing left to do
    await request(app.getHttpServer())
      .post(`/api/wf/instances/${id}/cancel`)
      .set(bearer(tokens.alice!))
      .send({})
      .expect(200)
    expect(await data('alice')).toMatchObject(none)
    expect(await data('frank')).toMatchObject(none)
  })
})
