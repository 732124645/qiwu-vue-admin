// wf start (发起; see docs/design-notes.md#workflow): GET /wf/models/:key/start-info and POST /wf/instances;
// GET /wf/startable-models (the start page's cards).
// Sign-in only; a model the caller may not start (unknown, disabled, unpublished, outside its initiator
// scope: user / dept subtree / role) is 404. dynamic: the client's values checked against the version's
// fields (synthetic snapshot); custom: the client's values ignored, the handler's assertStartable (locks the
// business row: own + draft + no instance) runs in the start transaction before loadFormValues;
// initiatorPicks missing / unknown → 400; initiator_ctx and initiator_dept_id resolved from the org chart.
import { Injectable } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type WfFields } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource, EntityManager } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { WfBusinessHandler } from '../../src/modules/workflow/runtime/wf-handlers.js'
import type { WfInstanceRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfs-'
const LEAVE = `${PREFIX}leave`
const REASON = 'wf-start-e2e'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The custom test model's handler: a leave request of the initiator, in draft, not started yet. */
@WfBusinessHandler(LEAVE)
@Injectable()
class LeaveHandler implements WfBusinessHandler {
  /** what the handler was asked, in order (`assert:<in a transaction>`) */
  calls: string[] = []
  /** ms to hold the row lock in assertStartable (the concurrency test) */
  hold = 0

  fields = (): WfFields => ({ days: 'number', leaveKind: 'string' })

  async assertStartable(key: string, initiatorId: number, tx: EntityManager) {
    this.calls.push(`assert:${tx.queryRunner?.isTransactionActive === true}`)
    const [row] = await tx.query<{ user_id: number; state: string; instance_id: number | null }[]>(
      `SELECT user_id, state, instance_id FROM biz_leave_request
        WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      [Number(key)],
    )
    if (!row || Number(row.user_id) !== initiatorId) throw new BizError(Err.NOT_FOUND)
    if (row.state !== 'draft' || row.instance_id !== null) throw new BizError(Err.CONFLICT)
    if (this.hold) await sleep(this.hold)
  }

  async loadFormValues(key: string, tx: EntityManager) {
    this.calls.push('load')
    const [row] = await tx.query<{ days: string; leave_kind: string }[]>(
      'SELECT days, leave_kind FROM biz_leave_request WHERE id = ? AND deleted_at IS NULL',
      [Number(key)],
    )
    return { days: Number(row!.days), leaveKind: row!.leave_kind }
  }

  async onStateChange(inst: WfInstanceRow, tx: EntityManager) {
    await tx.query(
      'UPDATE biz_leave_request SET instance_id = ?, state = ? WHERE id = ? AND deleted_at IS NULL',
      [inst.id, inst.state === 'running' ? 'in_review' : inst.state, Number(inst.businessKey)],
    )
  }
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let handler: LeaveHandler
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const d: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[], iam_role: [] as number[] }
let roleId: number
let seq = 0

type Who = 'alice' | 'bob' | 'carol'
const info = (who: Who, key: string) =>
  request(app.getHttpServer()).get(`/api/wf/models/${key}/start-info`).set(bearer(tokens[who]!))
const start = (who: Who, body: object) =>
  request(app.getHttpServer()).post('/api/wf/instances').set(bearer(tokens[who]!)).send(body)

const review = (id: string, assignee: object, name = `${id} step`) => ({
  id,
  type: 'review',
  name,
  assignee,
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})
const users = (...ids: number[]) => ({ kind: 'users', ids })
const PICKS = { kind: 'initiatorPicks' }
const tree = (next?: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })
/** `field` > 2 → step `long` (carol), else step `short` (bob) */
const forkOn = (field: string) =>
  tree({
    id: 'f',
    type: 'fork',
    name: 'Fork',
    paths: [
      {
        id: 'p-long',
        name: 'Long',
        when: [[{ field, op: 'gt', value: 2 }]],
        child: review('long', users(u.carol!)),
      },
      {
        id: 'p-other',
        name: 'Other',
        fallback: true,
        when: [],
        child: review('short', users(u.bob!)),
      },
    ],
  })

interface ModelOpts {
  key?: string
  kind?: 'dynamic' | 'custom'
  fields?: WfFields
  scope?: object | null
  enabled?: boolean
  published?: boolean
}

/** A model with one published version of `root` (unless `published: false`); its key. */
async function model(root: object, opts: ModelOpts = {}): Promise<string> {
  const key = opts.key ?? `${PREFIX}m${++seq}`
  const m = await ds.query(
    `INSERT INTO wf_model (model_key, name, form_kind, initiator_scope, enabled)
     VALUES (?, ?, ?, ?, ?)`,
    [
      key,
      key,
      opts.kind ?? 'dynamic',
      // as the model API stores it: every list present
      JSON.stringify(opts.scope ? { userIds: [], deptIds: [], roleIds: [], ...opts.scope } : null),
      opts.enabled ?? true,
    ],
  )
  if (opts.published === false) return key
  const v = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, 1, ?, ?)`,
    [m.insertId, key, JSON.stringify(root), JSON.stringify({ fields: opts.fields ?? {} })],
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [
    v.insertId,
    m.insertId,
  ])
  return key
}

const instanceRow = async (id: number) =>
  (
    await ds.query<Record<string, unknown>[]>(
      `SELECT business_key, initiator_id, initiator_dept_id, state, form_values, initiator_picks,
              initiator_ctx, active_node_ids
         FROM wf_instance WHERE id = ? AND deleted_at IS NULL`,
      [id],
    )
  )[0]
const openTasks = (instanceId: number) =>
  ds.query<{ node_id: string; assignee_id: number }[]>(
    `SELECT node_id, assignee_id FROM wf_task
      WHERE instance_id = ? AND state = 'pending' AND deleted_at IS NULL ORDER BY id`,
    [instanceId],
  )
const leave = (userId: number, days: number) =>
  insertRow(ds.manager, 'biz_leave_request', {
    user_id: userId,
    leave_kind: 'annual',
    start_at: new Date(),
    end_at: new Date(),
    days,
    reason: REASON,
  })
const leaveRow = async (id: number) =>
  (
    await ds.query<{ state: string; instance_id: number | null }[]>(
      'SELECT state, instance_id FROM biz_leave_request WHERE id = ? AND deleted_at IS NULL',
      [id],
    )
  )[0]

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

async function user(name: string, dept: number | null, extra: object = {}) {
  u[name] = await add('iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: dept,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
    ...extra,
  })
}

async function cleanup() {
  const sub = `SELECT id FROM wf_instance WHERE model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${sub})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
  await ds.query('DELETE FROM biz_leave_request WHERE reason = ?', [REASON])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    providers: [LeaveHandler],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  handler = app.get(LeaveHandler)
  await cleanRedis(redis)
  await cleanup()
  await dept('top', null)
  await dept('sub', 'top')
  await dept('other', null)
  roleId = await add('iam_role', { code: `${PREFIX}r`, name: `${PREFIX}r`, data_scope: 'own_rows' })
  await user('alice', d.sub)
  await user('bob', d.other)
  await user('carol', d.other)
  await user('dave', d.other, { enabled: false })
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [u.alice, roleId])
  for (const who of ['alice', 'bob', 'carol'])
    tokens[who] = (await signIn(app, PREFIX + who)).accessToken
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    if (made.iam_user.length)
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [made.iam_user])
    for (const t of ['iam_user', 'iam_role', 'iam_dept'] as const)
      if (made[t].length) await ds.query(`DELETE FROM ${t} WHERE id IN (?)`, [made[t]])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('start-info', () => {
  it('lists the steps whose users the initiator picks, in process order; sign-in only', async () => {
    const key = await model(
      tree({
        id: 'cc',
        type: 'notify',
        name: 'Copy',
        assignee: PICKS,
        next: { ...review('pick', PICKS), next: review('fixed', users(u.carol!)) },
      }),
    )
    const res = await info('bob', key).expect(200)
    expect(res.body.data).toEqual({
      schema: null,
      picks: [
        { id: 'cc', name: 'Copy', type: 'notify' },
        { id: 'pick', name: 'pick step', type: 'review' },
      ],
    })
    const none = await model(tree(review('fixed', users(u.carol!))))
    expect((await info('bob', none).expect(200)).body.data).toEqual({ schema: null, picks: [] })
    await request(app.getHttpServer()).get(`/api/wf/models/${key}/start-info`).expect(401)
    await request(app.getHttpServer()).post('/api/wf/instances').send({ modelKey: key }).expect(401)
  })

  it('404 for a model that is unknown, disabled or never published (start too)', async () => {
    const root = tree(review('fixed', users(u.carol!)))
    const keys = [
      `${PREFIX}missing`,
      await model(root, { enabled: false }),
      await model(root, { published: false }),
    ]
    for (const key of keys) {
      await info('alice', key).expect(404)
      await start('alice', { modelKey: key }).expect(404)
    }
    expect(await ds.query('SELECT id FROM wf_instance WHERE model_key IN (?)', [keys])).toEqual([])
  })
})

describe('startable models', () => {
  it('lists the enabled, published models the caller may start, in sort order; sign-in only', async () => {
    const root = tree(review('fixed', users(u.carol!)))
    const everyone = await model(root)
    const mine = await model(root, { scope: { userIds: [u.alice] } })
    const theirs = await model(root, { scope: { userIds: [u.bob] } })
    const keys = [
      everyone,
      mine,
      theirs,
      await model(root, { enabled: false }),
      await model(root, { published: false }),
    ]
    await ds.query('UPDATE wf_model SET sort_no = 1 WHERE model_key = ?', [everyone])
    await ds.query(
      `UPDATE wf_model SET form_kind = 'custom', create_route = '/biz/leave/new', category = 'hr',
              icon = 'lucide:plane', description = 'Days off' WHERE model_key = ?`,
      [mine],
    )
    const listed = async (who: Who) =>
      (
        (
          await request(app.getHttpServer())
            .get('/api/wf/startable-models')
            .set(bearer(tokens[who]!))
            .expect(200)
        ).body.data as { modelKey: string }[]
      ).filter((m) => keys.includes(m.modelKey))
    const card = { category: 'other', icon: null, description: null, createRoute: null }
    expect(await listed('alice')).toEqual([
      {
        modelKey: mine,
        name: mine,
        category: 'hr',
        icon: 'lucide:plane',
        description: 'Days off',
        formKind: 'custom',
        createRoute: '/biz/leave/new',
      },
      { ...card, modelKey: everyone, name: everyone, formKind: 'dynamic' },
    ])
    expect((await listed('bob')).map((m) => m.modelKey)).toEqual([theirs, everyone])
    await request(app.getHttpServer()).get('/api/wf/startable-models').expect(401)
  })
})

describe('initiator scope', () => {
  const root = () => tree(review('fixed', users(u.carol!)))
  /** `inside` may read and start the model, `outside` gets 404 for both */
  async function check(scope: object, inside: Who, outside: Who) {
    const key = await model(root(), { scope })
    await info(inside, key).expect(200)
    await start(inside, { modelKey: key }).expect(201)
    await info(outside, key).expect(404)
    await start(outside, { modelKey: key }).expect(404)
  }

  it('a listed dept holds its sub-depts', () => check({ deptIds: [d.top] }, 'alice', 'bob'))
  it('a listed role', () => check({ roleIds: [roleId] }, 'alice', 'bob'))
  it('a listed user', () => check({ userIds: [u.bob] }, 'bob', 'alice'))
  it('null = everyone', async () => {
    const key = await model(root(), { scope: null })
    for (const who of ['alice', 'bob'] as const) await start(who, { modelKey: key }).expect(201)
  })
})

describe('dynamic form', () => {
  it('values are checked against the version fields: a condition field of the wrong type → 400', async () => {
    const key = await model(forkOn('amount'), { fields: { amount: 'number', note: 'string' } })
    const res = await start('alice', { modelKey: key, formValues: { amount: '5' } }).expect(400)
    expect(res.body.errors).toEqual([{ path: 'formValues.amount', msg: expect.any(String) }])
    const { body } = await start('alice', {
      modelKey: key,
      businessKey: 'ignored',
      formValues: { amount: 5, note: 'x', extra: 1 },
    }).expect(201)
    expect(body.data).toEqual({ id: expect.any(Number), state: 'running' })
    expect(await instanceRow(body.data.id)).toEqual({
      business_key: null,
      initiator_id: u.alice,
      initiator_dept_id: d.sub,
      state: 'running',
      form_values: { amount: 5, note: 'x' },
      initiator_picks: {},
      initiator_ctx: { deptTreePath: `/${d.top}/${d.sub}/`, roleIds: [roleId] },
      active_node_ids: ['long'],
    })
    expect(await openTasks(body.data.id)).toEqual([{ node_id: 'long', assignee_id: u.carol }])
    // the value decides the path
    const short = await start('alice', { modelKey: key, formValues: { amount: 1 } }).expect(201)
    expect(await openTasks(short.body.data.id)).toEqual([{ node_id: 'short', assignee_id: u.bob }])
  })

  // no business row to lock: the duplicate-submit guard is all that stops a double click
  it('the same start submitted twice within 3 s → 429 (@Idempotent), one instance', async () => {
    const key = await model(tree(review('fixed', users(u.carol!))))
    await start('alice', { modelKey: key }).expect(201)
    const again = await start('alice', { modelKey: key }).expect(429)
    expect(again.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
    expect(await ds.query('SELECT id FROM wf_instance WHERE model_key = ?', [key])).toHaveLength(1)
  })
})

describe('initiatorPicks', () => {
  // a seeded step name (an i18n key) is translated in the message
  const picked = () => tree(review('pick', PICKS, 'seed.role.staff'))

  it('missing or empty → 400 naming the step', async () => {
    const key = await model(picked())
    for (const initiatorPicks of [undefined, {}, { pick: [] }, { other: [u.carol] }]) {
      const res = await start('alice', { modelKey: key, initiatorPicks })
        .query({ lang: 'en-US' })
        .expect(400)
      expect(res.body.errors).toEqual([
        { path: 'initiatorPicks.pick', msg: 'Pick the users of step Staff' },
      ])
    }
  })

  it('a disabled or unknown user → 400', async () => {
    const key = await model(picked())
    for (const ids of [[u.dave], [u.carol, 999_999_999]]) {
      const res = await start('alice', { modelKey: key, initiatorPicks: { pick: ids } })
        .query({ lang: 'en-US' })
        .expect(400)
      expect(res.body.errors).toEqual([
        { path: 'initiatorPicks.pick', msg: 'Step Staff can only take enabled users' },
      ])
    }
    await start('alice', { modelKey: key, initiatorPicks: { pick: ['x'] } }).expect(400)
    expect(await ds.query('SELECT id FROM wf_instance WHERE model_key = ?', [key])).toEqual([])
  })

  it('valid picks are stored (steps outside the process dropped) and assign the step', async () => {
    const key = await model(picked())
    const { body } = await start('alice', {
      modelKey: key,
      initiatorPicks: { pick: [u.carol, u.carol], other: [u.bob] },
    }).expect(201)
    expect(await instanceRow(body.data.id)).toMatchObject({ initiator_picks: { pick: [u.carol] } })
    expect(await openTasks(body.data.id)).toEqual([{ node_id: 'pick', assignee_id: u.carol }])
  })
})

describe('no assignee', () => {
  it('a step nobody can take → 422 naming it; a seeded step name in the request language', async () => {
    const step = {
      ...review('none', users(u.dave!), 'seed.wf.node.director'),
      whenNobody: 'toManager',
    }
    const key = await model(tree(step))
    for (const [lang, name] of [
      ['zh-CN', '节点“总监审批”没有可用的审批人'],
      ['en-US', 'Step Director approval has no available approver'],
    ]) {
      const res = await start('alice', { modelKey: key }).query({ lang }).expect(422)
      expect(res.body).toMatchObject({ code: Err.WF_NO_ASSIGNEE.code })
      expect(res.body.msg).toContain(name)
    }
    expect(await ds.query('SELECT id FROM wf_instance WHERE model_key = ?', [key])).toEqual([])
  })
})

describe('custom form', () => {
  const fields: WfFields = { days: 'number', leaveKind: 'string' }
  beforeAll(() => model(forkOn('days'), { key: LEAVE, kind: 'custom', fields }))
  afterEach(() => {
    handler.hold = 0
  })

  it('client values are ignored: a 3-day request sent as 1 day takes the > 2 days path', async () => {
    const id = await leave(u.alice!, 3)
    handler.calls = []
    const { body } = await start('alice', {
      modelKey: LEAVE,
      businessKey: String(id),
      formValues: { days: 1, leaveKind: 'sick' },
    }).expect(201)
    // the row is locked and checked inside the start transaction, then read
    expect(handler.calls).toEqual(['assert:true', 'load'])
    expect(await instanceRow(body.data.id)).toMatchObject({
      business_key: String(id),
      form_values: { days: 3, leaveKind: 'annual' },
      active_node_ids: ['long'],
    })
    expect(await openTasks(body.data.id)).toEqual([{ node_id: 'long', assignee_id: u.carol }])
    expect(await leaveRow(id)).toEqual({ state: 'in_review', instance_id: body.data.id })
  })

  it("another user's row or none → 404, a started one → 409, no businessKey → 400", async () => {
    const id = await leave(u.alice!, 1)
    await start('bob', { modelKey: LEAVE, businessKey: String(id) }).expect(404)
    await start('alice', { modelKey: LEAVE, businessKey: '999999999' }).expect(404)
    const res = await start('alice', { modelKey: LEAVE }).expect(400)
    expect(res.body.errors).toEqual([{ path: 'businessKey', msg: expect.any(String) }])
    await start('alice', { modelKey: LEAVE, businessKey: String(id) }).expect(201)
    // another body: not the duplicate-submit guard's 429
    await start('alice', {
      modelKey: LEAVE,
      businessKey: String(id),
      formValues: { days: 2 },
    }).expect(409)
    expect(
      await ds.query('SELECT id FROM wf_instance WHERE business_key = ?', [String(id)]),
    ).toHaveLength(1)
  })

  it('two concurrent starts of one row: one instance, the other 409', async () => {
    const id = await leave(u.alice!, 1)
    handler.hold = 300
    const statuses = await Promise.all(
      [1, 2].map(async (n) => {
        const res = await start('alice', {
          modelKey: LEAVE,
          businessKey: String(id),
          formValues: { n },
        })
        return res.status
      }),
    )
    expect(statuses.sort()).toEqual([201, 409])
    expect(
      await ds.query('SELECT id FROM wf_instance WHERE business_key = ?', [String(id)]),
    ).toHaveLength(1)
  })

  it('a custom model without a registered handler → 422', async () => {
    const key = await model(tree(review('fixed', users(u.carol!))), { kind: 'custom', fields })
    const res = await start('alice', { modelKey: key, businessKey: '1' }).expect(422)
    expect(res.body.code).toBe(Err.WF_HANDLER_MISSING.code)
  })
})
