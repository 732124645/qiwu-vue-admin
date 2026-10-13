// Workflow beside another tenant (see docs/design-notes.md#tenancy), multi-tenancy on. The default tenant
// (A) and tenant B (createTenant) each hold this spec's people (a dept headed by the reviewer, a role and
// a position the reviewer holds), a form and a process model under the same name and key, and two
// instances of that model: a running one (the reviewer's pending task, a copy to a third user) and an
// approved one. Each side sees its own tenant only: lists, selectors, the start page, the data page and
// its export, and the admin lists (root's too) hold no row of the other tenant; every read, write and
// action on an id of the other tenant is 404 and changes nothing. A user, role, position or dept of the
// other tenant named by a model (initiator scope, process managers, a published tree or BPMN diagram) is
// 404 like an unknown id; named as an action's target or an initiator's pick it is refused as an unknown
// user is; named by a form value it shows no name. Whatever a version names, the engine gives no task or
// copy to another tenant's user: the org chart it reads keeps to one tenant, link rows naming another
// tenant's rows (left by a bug elsewhere) included.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, treeToXml } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { NotifyDispatcher } from '../../src/core/notify/notify.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { timeoutKey } from '../../src/modules/workflow/engine/timeout.js'
import { WfRemind } from '../../src/modules/workflow/runtime/wf-remind.js'
import { typeormOrg } from '../../src/modules/workflow/typeorm-org.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  addUser,
  bootApp,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'twf-'
/** the model key both tenants use */
const KEY = `${PREFIX}flow`
/** the form name both tenants use */
const FORM = `${PREFIX}form`
const FIELDS = { days: 'number', who: 'user', unit: 'dept' } as const
const SCHEMA = {
  rule: [{ type: 'input', field: 'reason', title: 'Reason', props: { placeholder: 'why' } }],
  option: { form: { labelPosition: 'top' } },
}
const NO_SUCH = 999_999_999
const WF_TABLES = [
  'wf_form',
  'wf_model',
  'wf_version',
  'wf_instance',
  'wf_task',
  'wf_cc',
  'wf_event',
]

type Who = 'boss' | 'ini' | 'rev' | 'ccu'
/** A tenant's rows of this spec. */
interface Org {
  tid: number
  tag: 'a' | 'b'
  dept: number
  role: number
  position: number
  users: Record<Who, number>
  tok: Record<Who, string>
  /** `FORM`, and a form nothing uses */
  form: number
  spare: number
  /** `KEY` (named `<KEY>-<tag>`) and its version */
  model: number
  version: number
  /** a model key only this tenant has */
  only: string
  /** a tree and a BPMN model, never published */
  draft: number
  bpmn: number
  /** running: the reviewer's pending `task`, the copy `cc` to `ccu` */
  inst: number
  task: number
  cc: number
  /** approved by the reviewer (`doneTask`) */
  done: number
  doneTask: number
}

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
const T = { a: {} as Org, b: {} as Org }

const call = (
  token: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  body?: object,
) => {
  const req = request(on.getHttpServer())
    [method](`/api${path}`)
    .set(bearer(token))
    .set('Accept-Language', 'en-US')
  return body ? req.send(body) : req
}
/** The envelope's data of an answer with `status`. */
async function data(req: request.Test, status = 200) {
  const res = await req
  // the body shows in the diff when the status is not the one asked for
  expect({ status: res.status, body: res.body }).toMatchObject({ status })
  return res.body.data
}
const outcome = (res: request.Response) => ({ status: res.status, code: res.body?.code as unknown })
const sorted = (list: number[]) => [...list].sort((x, y) => x - y)
const ids = (rows: { id: number }[]) => sorted(rows.map((r) => Number(r.id)))
const treeIds = (nodes: { id: number; children?: unknown[] }[]): number[] =>
  nodes.flatMap((n) => [Number(n.id), ...treeIds((n.children ?? []) as typeof nodes)])
/** Ids of tenant `tid`'s rows of `table` matching `where`. */
const ownIds = async (table: string, tid: number, where: string, params: unknown[] = []) =>
  ids(await ds.query(`SELECT id FROM ${table} WHERE tenant_id = ? AND ${where}`, [tid, ...params]))
/** The workflow rows of both tenants: what a refused request must leave as it was. */
async function snapshot() {
  const out: Record<string, unknown> = {}
  for (const t of WF_TABLES)
    out[t] = await ds.query(`SELECT * FROM ${t} WHERE tenant_id IN (1, ?) ORDER BY id`, [B.id])
  return JSON.parse(JSON.stringify(out)) as unknown
}

const begin = (next?: object) => ({ id: 'begin', type: 'begin', name: 'Begin', next })
const review = (id: string, assignee: object, more: object = {}) => ({
  id,
  type: 'review',
  name: id,
  assignee,
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'sendBack',
  ...more,
})
const notify = (id: string, userIds: number[]) => ({
  id,
  type: 'notify',
  name: id,
  assignee: { kind: 'users', ids: userIds },
})
/** `steps` one after another */
const chain = (...steps: object[]): object | undefined =>
  steps.reduceRight<object | undefined>((next, s) => ({ ...s, next }), undefined)
/** an exclusive fork: `when` leads to a review by `userId`, the fallback to nothing */
const fork = (when: object, userId: number) => ({
  id: 'f',
  type: 'fork',
  name: 'f',
  paths: [
    { id: 'p1', name: 'p1', when: [[when]], child: review('pr', { kind: 'users', ids: [userId] }) },
    { id: 'p2', name: 'p2', fallback: true, when: [] },
  ],
})

/** A top-level dept of tenant `tid` (`path`: its tree_path given its id; default its own). */
async function dept(tid: number, name: string, path = (id: number) => `/${id}/`) {
  const id = await addRow(on, tid, 'iam_dept', { parent_id: 0, tree_path: '/', name })
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ? AND tenant_id = ?', [
    path(id),
    id,
    tid,
  ])
  return id
}

/** A dynamic model of tenant `o` with one published version of `tree`; its id and the version's. */
async function model(o: Org, key: string, tree: object) {
  const id = await addRow(on, o.tid, 'wf_model', {
    model_key: key,
    name: `${key}-${o.tag}`,
    form_kind: 'dynamic',
    enabled: 1,
  })
  const version = await addRow(on, o.tid, 'wf_version', {
    model_id: id,
    model_key: key,
    version: 1,
    tree_json: tree,
    form_snapshot: { fields: FIELDS },
  })
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [version, id])
  return { id, version }
}

const start = (o: Org, body: object) => call(o.tok.ini, 'post', '/wf/instances', body)
const started = async (o: Org, body: object) => Number((await data(start(o, body), 201)).id)
/** [node, assignee, state] of the instance's tasks */
const tasksOf = async (instanceId: number) =>
  (
    await ds.query<{ node_id: string; assignee_id: number; state: string }[]>(
      'SELECT node_id, assignee_id, state FROM wf_task WHERE instance_id = ? ORDER BY id',
      [instanceId],
    )
  ).map((t) => [t.node_id, Number(t.assignee_id), t.state])
const pendingTask = async (instanceId: number) =>
  Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM wf_task WHERE instance_id = ? AND state = 'pending'",
        [instanceId],
      )
    )[0]!.id,
  )

async function people(tid: number, tag: 'a' | 'b'): Promise<Org> {
  const o = { tid, tag, users: {}, tok: {} } as Org
  o.dept = await dept(tid, `${PREFIX}dept`)
  o.role = await addRow(on, tid, 'iam_role', {
    code: `${PREFIX}role`,
    name: `${PREFIX}role`,
    data_scope: 'own_rows',
  })
  o.position = await addRow(on, tid, 'iam_position', {
    code: `${PREFIX}pos`,
    name: `${PREFIX}pos`,
  })
  for (const who of ['ini', 'rev', 'ccu'] as const)
    o.users[who] = await addUser(on, tid, `${PREFIX}${who}`, { deptId: o.dept })
  await addRow(on, tid, 'iam_user_roles', { user_id: o.users.rev, role_id: o.role })
  await addRow(on, tid, 'iam_user_positions', { user_id: o.users.rev, position_id: o.position })
  await ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ? AND tenant_id = ?', [
    o.users.rev,
    o.dept,
    tid,
  ])
  return o
}

/** The default tenant's rows of this spec, and link rows naming them in any tenant (B's go with B.dispose()). */
async function cleanup() {
  const insts = `SELECT id FROM wf_instance WHERE tenant_id = 1 AND model_key LIKE '${PREFIX}%'`
  for (const t of ['wf_task', 'wf_cc', 'wf_event'])
    await ds.query(`DELETE FROM ${t} WHERE instance_id IN (${insts})`)
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE tenant_id = 1 AND model_key LIKE ?`, [`${PREFIX}%`])
  await ds.query('DELETE FROM wf_form WHERE tenant_id = 1 AND name LIKE ?', [`${PREFIX}%`])
  const own = async (table: string, column: string) =>
    ids(
      await ds.query(`SELECT id FROM ${table} WHERE tenant_id = 1 AND ${column} LIKE ?`, [
        `${PREFIX}%`,
      ]),
    )
  const users = await own('iam_user', 'username')
  const roles = await own('iam_role', 'code')
  const positions = await own('iam_position', 'code')
  const depts = await own('iam_dept', 'name')
  if (users.length) {
    for (const t of ['iam_user_roles', 'iam_user_positions', 'msg_inbox', 'msg_mail_record'])
      await ds.query(`DELETE FROM ${t} WHERE user_id IN (?)`, [users])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
  }
  if (roles.length) {
    await ds.query('DELETE FROM iam_user_roles WHERE role_id IN (?)', [roles])
    await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
  }
  if (positions.length) {
    await ds.query('DELETE FROM iam_user_positions WHERE position_id IN (?)', [positions])
    await ds.query('DELETE FROM iam_position WHERE id IN (?)', [positions])
  }
  if (depts.length) await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [depts])
}

beforeAll(async () => {
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  await cleanup()
  B = await createTenant(on, { users: true })
  T.a = await people(1, 'a')
  T.b = await people(B.id, 'b')
  // the bosses: the default tenant's root, B's administrator (its builtin tenant_admin role)
  T.a.users.boss = Number(
    (await ds.query("SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1"))[0].id,
  )
  T.a.tok.boss = (await signIn(on)).accessToken
  const [admin] = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_role WHERE code = 'tenant_admin' AND is_builtin = 1 AND tenant_id = ?",
    [B.id],
  )
  await addRow(on, B.id, 'iam_user_roles', { user_id: B.users.admin, role_id: admin!.id })
  T.b.users.boss = B.users.admin
  T.b.tok.boss = (await signInDirect(on, B.users.admin))!.accessToken
  for (const o of [T.a, T.b]) {
    for (const who of ['ini', 'rev', 'ccu'] as const)
      o.tok[who] = (await signInDirect(on, o.users[who]))!.accessToken
    o.form = await addRow(on, o.tid, 'wf_form', { name: FORM, schema_json: SCHEMA })
    o.spare = await addRow(on, o.tid, 'wf_form', { name: `${PREFIX}spare`, schema_json: SCHEMA })
    const flow = await model(o, KEY, begin(review('r1', { kind: 'users', ids: [o.users.rev] })))
    o.model = flow.id
    o.version = flow.version
    o.only = `${PREFIX}only-${o.tag}`
    await model(o, o.only, begin())
    for (const kind of ['tree', 'bpmn'] as const)
      o[kind === 'tree' ? 'draft' : 'bpmn'] = await addRow(on, o.tid, 'wf_model', {
        model_key: `${PREFIX}${kind}`,
        name: `${PREFIX}${kind}`,
        form_kind: 'dynamic',
        flow_kind: kind,
      })
  }
  for (const [o, f] of [
    [T.a, T.b],
    [T.b, T.a],
  ] as const) {
    // a form value naming the other tenant's user and dept, then one naming the own ones
    o.inst = await started(o, {
      modelKey: KEY,
      formValues: { days: 1, who: f.users.ini, unit: f.dept },
    })
    o.task = await pendingTask(o.inst)
    await data(call(o.tok.rev, 'post', `/wf/tasks/${o.task}/cc`, { userIds: [o.users.ccu] }))
    o.cc = (await ownIds('wf_cc', o.tid, 'instance_id = ?', [o.inst]))[0]!
    o.done = await started(o, {
      modelKey: KEY,
      formValues: { days: 2, who: o.users.ini, unit: o.dept },
    })
    o.doneTask = await pendingTask(o.done)
    await data(call(o.tok.rev, 'post', `/wf/tasks/${o.doneTask}/approve`, {}))
  }
})

afterAll(async () => {
  if (ds) {
    await on.get(NotifyDispatcher).idle()
    await B?.dispose()
    await cleanup()
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
})

describe.each([
  { who: "the default tenant (root as its boss), B's ids", own: () => T.a, other: () => T.b },
  {
    who: "B (its administrator as its boss), the default tenant's ids",
    own: () => T.b,
    other: () => T.a,
  },
])('$who', ({ own: ownOf, other }) => {
  it('lists, selectors, the start page, the data page and the admin lists hold only the own rows', async () => {
    const own = ownOf()
    const f = other()
    const page = { pageSize: 200 }
    const items = async (token: string, path: string, query: object = {}) =>
      (await data(call(token, 'get', path).query({ ...page, ...query }))).items as {
        id: number
        modelName?: string
        values?: Record<string, unknown>
      }[]
    // models and forms: the shared key and name once, the own row
    const models = await items(own.tok.boss, '/wf/models', { modelKey: PREFIX })
    expect(ids(models)).toEqual(
      await ownIds('wf_model', own.tid, 'model_key LIKE ?', [`${PREFIX}%`]),
    )
    expect(ids(models)).toContain(own.model)
    const forms = await items(own.tok.boss, '/wf/forms', { name: PREFIX })
    expect(ids(forms)).toEqual(await ownIds('wf_form', own.tid, 'name LIKE ?', [`${PREFIX}%`]))
    expect(ids(forms)).toContain(own.form)
    // the pickers: the own tenant's users and depts
    const users = (await data(
      call(own.tok.ini, 'get', '/wf/users/options').query({ keyword: PREFIX }),
    )) as { id: number; deptName: string | null }[]
    expect(ids(users)).toEqual(
      await ownIds(
        'iam_user',
        own.tid,
        'display_name LIKE ? AND enabled = 1 AND deleted_at IS NULL',
        [`${PREFIX}%`],
      ),
    )
    expect(users.find((u) => u.id === own.users.rev)?.deptName).toBe(`${PREFIX}dept`)
    const depts = treeIds(await data(call(own.tok.ini, 'get', '/wf/depts/options')))
    expect(sorted(depts)).toEqual(
      await ownIds('iam_dept', own.tid, 'enabled = 1 AND deleted_at IS NULL'),
    )
    expect(depts).toContain(own.dept)
    // the start page: the shared key once, the own model
    const startable = (await data(call(own.tok.ini, 'get', '/wf/startable-models'))) as {
      modelKey: string
      name: string
    }[]
    expect(
      startable
        .filter((m) => m.modelKey.startsWith(PREFIX))
        .map((m) => m.name)
        .sort(),
    ).toEqual([`${KEY}-${own.tag}`, `${own.only}-${own.tag}`])
    await data(call(own.tok.ini, 'get', `/wf/models/${KEY}/start-info`))
    // the caller's own lists
    const mine = await items(own.tok.ini, '/wf/instances/mine')
    expect(ids(mine)).toEqual(sorted([own.inst, own.done]))
    expect(mine.map((i) => i.modelName)).toEqual([`${KEY}-${own.tag}`, `${KEY}-${own.tag}`])
    expect(ids(await items(own.tok.rev, '/wf/tasks/todo'))).toEqual([own.task])
    expect(ids(await items(own.tok.rev, '/wf/tasks/done'))).toEqual([own.doneTask])
    expect(ids(await items(own.tok.ccu, '/wf/ccs/mine'))).toEqual([own.cc])
    // the admin lists: root too sees its own tenant's instances and tasks only
    expect(ids(await items(own.tok.boss, '/wf/instances', { modelKey: KEY }))).toEqual(
      sorted([own.inst, own.done]),
    )
    expect(ids(await items(own.tok.boss, '/wf/tasks', { modelKey: KEY }))).toEqual(
      await ownIds('wf_task', own.tid, 'instance_id IN (?)', [[own.inst, own.done]]),
    )
    // the data page: the own instances; a form value naming the other tenant's user or dept has no name
    const rows = await items(own.tok.boss, `/wf/models/${KEY}/data`)
    expect(ids(rows)).toEqual(sorted([own.inst, own.done]))
    const values = (id: number) => rows.find((r) => r.id === id)!.values
    expect(values(own.inst)).toMatchObject({
      who: { id: f.users.ini, name: null },
      unit: { id: f.dept, name: null },
    })
    expect(values(own.done)).toMatchObject({
      who: { id: own.users.ini, name: `${PREFIX}ini` },
      unit: { id: own.dept, name: `${PREFIX}dept` },
    })
    const res = await call(own.tok.boss, 'get', `/wf/models/${KEY}/data/export`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0])
    const exported: number[] = []
    const cells: string[] = []
    wb.worksheets[0]!.eachRow((row, n) => {
      if (n > 1) exported.push(Number(row.getCell(1).value))
      row.eachCell((c) => cells.push(String(c.value ?? '')))
    })
    expect(sorted(exported)).toEqual(sorted([own.inst, own.done]))
    expect(cells).toEqual(expect.arrayContaining([`#${f.users.ini}`, `#${f.dept}`]))
  })

  it('every read, write and action on an id of the other tenant is 404 and changes nothing', async () => {
    const own = ownOf()
    const f = other()
    const before = await snapshot()
    const sort = {
      items: [
        { id: own.model, sortNo: 7 },
        { id: f.model, sortNo: 7 },
      ],
    }
    const cases: [Who, 'get' | 'post' | 'put' | 'delete', string, object?][] = [
      // models
      ['boss', 'get', `/wf/models/${f.model}`],
      ['boss', 'get', `/wf/models/${f.model}/versions`],
      ['boss', 'get', `/wf/models/${f.model}/versions/${f.version}`],
      ['boss', 'get', `/wf/models/${own.model}/versions/${f.version}`],
      ['boss', 'put', `/wf/models/${f.model}`, { name: `${PREFIX}x` }],
      ['boss', 'put', `/wf/models/${f.draft}/draft`, { tree: begin() }],
      ['boss', 'put', `/wf/models/${f.model}/enabled`, { enabled: false }],
      ['boss', 'put', '/wf/models/sort', sort],
      ['boss', 'post', `/wf/models/${f.draft}/versions`, { tree: begin(), fields: FIELDS }],
      ['boss', 'delete', `/wf/models/${f.draft}`],
      // forms
      ['boss', 'get', `/wf/forms/${f.form}`],
      ['boss', 'put', `/wf/forms/${f.form}`, { name: `${PREFIX}x` }],
      ['boss', 'put', `/wf/forms/${f.form}/enabled`, { enabled: false }],
      ['boss', 'delete', `/wf/forms/${f.spare}`],
      ['boss', 'post', '/wf/forms/batch-delete', { ids: [own.spare, f.spare] }],
      // a model key only the other tenant has
      ['ini', 'get', `/wf/models/${f.only}/start-info`],
      ['ini', 'post', '/wf/instances', { modelKey: f.only, formValues: { days: 3 } }],
      ['boss', 'get', `/wf/models/${f.only}/data`],
      ['boss', 'get', `/wf/models/${f.only}/data/export`],
      // instances: the initiator's, the admin's
      ['ini', 'get', `/wf/instances/${f.inst}`],
      ['boss', 'get', `/wf/instances/${f.inst}`],
      ['ini', 'post', `/wf/instances/${f.inst}/cancel`, {}],
      ['ini', 'post', `/wf/instances/${f.inst}/urge`],
      ['boss', 'post', `/wf/instances/${f.inst}/terminate`, {}],
      ['boss', 'post', `/wf/tasks/${f.task}/reassign`, { to: own.users.ccu }],
      ['ccu', 'post', `/wf/ccs/${f.cc}/read`],
      // tasks: the reviewer's actions
      ['rev', 'get', `/wf/tasks/${f.task}/back-targets`],
      ['rev', 'post', `/wf/tasks/${f.task}/approve`, {}],
      ['rev', 'post', `/wf/tasks/${f.task}/reject`, {}],
      ['rev', 'post', `/wf/tasks/${f.task}/send-back`, { to: 'begin' }],
      ['rev', 'post', `/wf/tasks/${f.task}/resubmit`, {}],
      ['rev', 'post', `/wf/tasks/${f.task}/transfer`, { userId: own.users.ccu }],
      ['rev', 'post', `/wf/tasks/${f.task}/delegate`, { userId: own.users.ccu }],
      ['rev', 'post', `/wf/tasks/${f.task}/add-sign`, { kind: 'before', userIds: [own.users.ccu] }],
      ['rev', 'post', `/wf/tasks/${f.task}/remove-sign`, { taskIds: [f.task] }],
      ['rev', 'post', `/wf/tasks/${f.task}/cc`, { userIds: [own.users.ccu] }],
      ['rev', 'post', `/wf/tasks/${f.task}/comment`, { comment: 'hello' }],
      ['rev', 'post', `/wf/tasks/${f.doneTask}/withdraw`, {}],
    ]
    for (const [who, method, path, body] of cases) {
      const res = await call(own.tok[who], method, path, body)
      expect([method, path, res.status]).toEqual([method, path, 404])
    }
    expect(await snapshot()).toEqual(before)
  })

  it("a model naming the other tenant's user, role, position or dept is 404 as an unknown id is; the own ones pass", async () => {
    const own = ownOf()
    const f = other()
    const before = await snapshot()
    const key = `${PREFIX}new-${own.tag}`
    const create = (body: object) =>
      call(own.tok.boss, 'post', '/wf/models', {
        modelKey: key,
        name: key,
        formKind: 'dynamic',
        ...body,
      })
    const settings = (o: Org | null) => [
      { managerUserIds: [o?.users.rev ?? NO_SUCH] },
      { initiatorScope: { userIds: [o?.users.ini ?? NO_SUCH] } },
      { initiatorScope: { deptIds: [o?.dept ?? NO_SUCH] } },
      { initiatorScope: { roleIds: [o?.role ?? NO_SUCH] } },
    ]
    for (const body of [...settings(f), ...settings(null), { formId: f.form }]) {
      expect([body, (await create(body)).status]).toEqual([body, 404])
      const res = await call(own.tok.boss, 'put', `/wf/models/${own.draft}`, body)
      expect([body, res.status]).toEqual([body, 404])
    }
    // a published tree or BPMN diagram naming them, every way a tree names people
    const trees = (o: Org | null) => {
      const user = o?.users.rev ?? NO_SUCH
      const unit = o?.dept ?? NO_SUCH
      const role = o?.role ?? NO_SUCH
      return [
        begin(review('x', { kind: 'users', ids: [user] })),
        begin(review('x', { kind: 'roles', ids: [role] })),
        begin(review('x', { kind: 'positions', ids: [o?.position ?? NO_SUCH] })),
        begin(review('x', { kind: 'deptMembers', ids: [unit] })),
        begin(review('x', { kind: 'deptHead', ids: [unit] })),
        begin(review('x', { kind: 'initiator' }, { whenNobody: 'toUser', fallbackUserId: user })),
        begin(notify('x', [user])),
        begin(fork({ field: '$initiator.dept', op: 'inDeptTree', value: [unit] }, own.users.rev)),
        begin(fork({ field: '$initiator.roles', op: 'hasRole', value: [role] }, own.users.rev)),
        begin(fork({ field: 'who', op: 'eq', value: user }, own.users.rev)),
        begin(fork({ field: 'unit', op: 'in', value: [own.dept, unit] }, own.users.rev)),
        begin(fork({ field: 'days', op: 'gt', value: 0 }, user)),
      ]
    }
    const publish = (tree: object) =>
      call(own.tok.boss, 'post', `/wf/models/${own.draft}/versions`, { tree, fields: FIELDS })
    const publishXml = (tree: object) =>
      call(own.tok.boss, 'post', `/wf/models/${own.bpmn}/versions`, {
        xml: treeToXml(tree as Parameters<typeof treeToXml>[0]),
        fields: FIELDS,
      })
    for (const tree of [...trees(f), ...trees(null)])
      expect([tree, (await publish(tree)).status]).toEqual([tree, 404])
    for (const tree of trees(f).slice(0, 2))
      expect([tree, (await publishXml(tree)).status]).toEqual([tree, 404])
    expect(await snapshot()).toEqual(before)
    // the own tenant's ids pass
    const all = {
      managerUserIds: [own.users.rev],
      initiatorScope: { userIds: [own.users.ini], deptIds: [own.dept], roleIds: [own.role] },
    }
    await data(create({ ...all, formId: own.form }), 201)
    await data(call(own.tok.boss, 'put', `/wf/models/${own.draft}`, all))
    for (const tree of trees(own)) await data(publish(tree), 201)
    await data(publishXml(trees(own)[0]!), 201)
  })

  it("an action or a pick naming the other tenant's user is refused as an unknown user is; nothing changes", async () => {
    const own = ownOf()
    const f = other()
    await model(own, `${PREFIX}picks`, begin(review('pick', { kind: 'initiatorPicks' })))
    const before = await snapshot()
    const tries = async (target: number) => {
      const out: unknown[] = []
      for (const [action, body] of [
        ['transfer', { userId: target }],
        ['delegate', { userId: target }],
        ['add-sign', { kind: 'before', userIds: [target] }],
        ['cc', { userIds: [target] }],
      ] as const)
        out.push(outcome(await call(own.tok.rev, 'post', `/wf/tasks/${own.task}/${action}`, body)))
      out.push(
        outcome(await call(own.tok.boss, 'post', `/wf/tasks/${own.task}/reassign`, { to: target })),
      )
      const res = await start(own, {
        modelKey: `${PREFIX}picks`,
        initiatorPicks: { pick: [target] },
      })
      out.push({ ...outcome(res), errors: res.body.errors })
      return out
    }
    const foreign = await tries(f.users.ccu)
    expect(foreign).toEqual(await tries(NO_SUCH))
    for (const o of foreign) expect([400, 422]).toContain((o as { status: number }).status)
    expect(await snapshot()).toEqual(before)
    // the own user is picked
    const id = await started(own, {
      modelKey: `${PREFIX}picks`,
      initiatorPicks: { pick: [own.users.ccu] },
    })
    expect(await tasksOf(id)).toEqual([['pick', own.users.ccu, 'pending']])
  })

  it("the engine gives no task or copy to the other tenant's user, whatever the version names", async () => {
    const own = ownOf()
    const f = other()
    const key = `${PREFIX}reach`
    // a version published before (or seeded) naming the other tenant's people every way, then the own reviewer
    await model(
      own,
      key,
      begin(
        chain(
          review('n1', { kind: 'users', ids: [f.users.rev] }),
          review('n2', { kind: 'roles', ids: [f.role] }),
          review('n3', { kind: 'positions', ids: [f.position] }),
          review('n4', { kind: 'deptMembers', ids: [f.dept] }),
          review('n5', { kind: 'deptHead', ids: [f.dept] }),
          review('n6', { kind: 'formFieldUser', field: 'who' }),
          review('n7', { kind: 'formFieldDeptHead', field: 'unit' }),
          notify('n8', [f.users.ccu]),
          review('last', { kind: 'users', ids: [own.users.rev] }),
        ),
      ),
    )
    const id = await started(own, {
      modelKey: key,
      formValues: { days: 1, who: f.users.rev, unit: f.dept },
    })
    expect(await tasksOf(id)).toEqual([['last', own.users.rev, 'pending']])
    expect(await ds.query('SELECT id FROM wf_cc WHERE instance_id = ?', [id])).toEqual([])
  })
})

it('a model key and a form name live once per tenant; the shared key starts each tenant’s own version', async () => {
  const twin = `${PREFIX}twin`
  for (const o of [T.a, T.b]) {
    const body = { modelKey: twin, name: twin, formKind: 'dynamic' }
    await data(call(o.tok.boss, 'post', '/wf/models', body), 201)
    await data(call(o.tok.boss, 'post', '/wf/forms', { name: twin, schemaJson: SCHEMA }), 201)
  }
  const again = { modelKey: twin, name: `${twin}2`, formKind: 'dynamic' }
  expect((await call(T.b.tok.boss, 'post', '/wf/models', again)).status).toBe(409)
  for (const o of [T.a, T.b]) {
    const [row] = await ds.query<{ v: number; t: number }[]>(
      'SELECT version_id AS v, tenant_id AS t FROM wf_instance WHERE id = ?',
      [o.inst],
    )
    expect([Number(row!.v), Number(row!.t)]).toEqual([o.version, o.tid])
  }
})

describe("the org chart reads one tenant's rows, link rows naming another tenant's included", () => {
  // the default tenant: dept dA headed by uA (dA, role rA, position pA); uX, holding nothing of its own;
  // uY in B's dept dB; dA2 under B's dB2 (tree_path); dA3 headed by B's bU. B: dB with bU (role rB,
  // position pB); bInA in dA; dBx under dA (tree_path); dB2 headed by uA. Link rows across tenants:
  // (uA, rB) and (bU, rA) in the default tenant, (uX, rA) in B; the same for positions.
  const o: Record<string, number> = {}
  const org = () => typeormOrg(ds)
  const ask = <R>(fn: () => Promise<R>) => inTenant1(fn)

  beforeAll(async () => {
    const tb = B.id
    o.dA = await dept(1, `${PREFIX}org-a`)
    o.dB = await dept(tb, `${PREFIX}org-b`)
    o.rA = await addRow(on, 1, 'iam_role', {
      code: `${PREFIX}org-ra`,
      name: 'ra',
      data_scope: 'own_rows',
    })
    o.rB = await addRow(on, tb, 'iam_role', {
      code: `${PREFIX}org-rb`,
      name: 'rb',
      data_scope: 'own_rows',
    })
    o.pA = await addRow(on, 1, 'iam_position', { code: `${PREFIX}org-pa`, name: 'pa' })
    o.pB = await addRow(on, tb, 'iam_position', { code: `${PREFIX}org-pb`, name: 'pb' })
    o.uA = await addUser(on, 1, `${PREFIX}org-ua`, { deptId: o.dA })
    o.uX = await addUser(on, 1, `${PREFIX}org-ux`)
    o.uY = await addUser(on, 1, `${PREFIX}org-uy`, { deptId: o.dB })
    o.bU = await addUser(on, tb, `${PREFIX}org-bu`, { deptId: o.dB })
    o.bInA = await addUser(on, tb, `${PREFIX}org-b-in-a`, { deptId: o.dA })
    o.dBx = await dept(tb, `${PREFIX}org-bx`, (id) => `/${o.dA}/${id}/`)
    o.dB2 = await dept(tb, `${PREFIX}org-b2`)
    o.dA2 = await dept(1, `${PREFIX}org-a2`, (id) => `/${o.dB2}/${id}/`)
    o.dA3 = await dept(1, `${PREFIX}org-a3`)
    const head = (deptId: number, userId: number) =>
      ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ?', [userId, deptId])
    await head(o.dA, o.uA)
    await head(o.dB2, o.uA)
    await head(o.dA3, o.bU)
    for (const [table, column, a, b] of [
      ['iam_user_roles', 'role_id', o.rA, o.rB],
      ['iam_user_positions', 'position_id', o.pA, o.pB],
    ] as const) {
      await addRow(on, 1, table, { user_id: o.uA, [column]: a })
      await addRow(on, tb, table, { user_id: o.bU, [column]: b })
      await addRow(on, 1, table, { user_id: o.uA, [column]: b })
      await addRow(on, 1, table, { user_id: o.bU, [column]: a })
      await addRow(on, tb, table, { user_id: o.uX, [column]: a })
    }
  })

  it('users, roles and positions', async () => {
    expect(await ask(() => org().enabledUsers([o.uA!, o.bU!, o.bInA!]))).toEqual([o.uA])
    expect(await ask(() => org().usersOfRoles([o.rA!]))).toEqual([o.uA])
    expect(await ask(() => org().usersOfRoles([o.rB!]))).toEqual([])
    expect(await ask(() => org().usersOfPositions([o.pA!]))).toEqual([o.uA])
    expect(await ask(() => org().usersOfPositions([o.pB!]))).toEqual([])
  })

  it('depts, their members and heads', async () => {
    expect(await ask(() => org().usersOfDepts([o.dA!]))).toEqual([o.uA])
    expect(await ask(() => org().usersOfDepts([o.dB!]))).toEqual([])
    expect(await ask(() => org().deptOfUser(o.uA!))).toBe(o.dA)
    expect(await ask(() => org().deptOfUser(o.uY!))).toBeNull()
    expect(await ask(() => org().deptOfUser(o.bInA!))).toBeNull()
    expect(await ask(() => org().deptHeads(o.dA!, 1))).toEqual([o.uA])
    expect(await ask(() => org().deptHeads(o.dBx!, 2))).toEqual([])
    expect(await ask(() => org().deptHeads(o.dA2!, 2))).toEqual([])
    expect(await ask(() => org().deptHeads(o.dA3!, 1))).toEqual([])
  })

  it("the initiator's context", async () => {
    expect(await ask(() => org().initiatorCtx(o.uA!))).toEqual({
      deptTreePath: `/${o.dA}/`,
      roleIds: [o.rA],
    })
    expect(await ask(() => org().initiatorCtx(o.uX!))).toEqual({ deptTreePath: null, roleIds: [] })
  })

  it('the user picker names no dept of another tenant', async () => {
    const users = (await data(
      call(T.a.tok.ini, 'get', '/wf/users/options').query({ keyword: `${PREFIX}org-uy` }),
    )) as { id: number; deptName: string | null }[]
    expect(users).toEqual([{ id: o.uY, displayName: `${PREFIX}org-uy`, deptName: null }])
  })
})

describe("rows of the default tenant naming B's (left by a bug elsewhere) show nothing of B", () => {
  // versions: `vi` of the default tenant under B's model, `viii` of B under the default tenant's model;
  // the default tenant's initiator's instances on each (`ii`, `iiii`) and B's instance `ib` started by
  // them; B's task and copy on the default tenant's approved instance, for ccu and `stray`; an event on
  // the default tenant's running instance by B's reviewer
  const r: Record<string, number> = {}
  let stray = ''
  const instance = (tid: number, version: number, key: string, initiator = T.a.users.ini) =>
    addRow(on, tid, 'wf_instance', {
      version_id: version,
      model_key: key,
      initiator_id: initiator,
      state: 'running',
      form_values: {},
      initiator_picks: {},
      initiator_ctx: { deptTreePath: null, roleIds: [] },
      active_node_ids: [],
      started_at: new Date(),
    })
  const version = (tid: number, modelId: number, key: string) =>
    addRow(on, tid, 'wf_version', {
      model_id: modelId,
      model_key: key,
      version: 1,
      tree_json: begin(review('r1', { kind: 'users', ids: [T.a.users.rev] })),
      form_snapshot: { fields: FIELDS },
    })

  beforeAll(async () => {
    r.vi = await version(1, T.b.model, `${PREFIX}bug-i`)
    r.viii = await version(B.id, T.a.model, `${PREFIX}bug-iii`)
    r.ii = await instance(1, r.vi, `${PREFIX}bug-i`)
    r.iiii = await instance(1, r.viii, `${PREFIX}bug-iii`)
    r.ib = await instance(B.id, T.b.version, `${PREFIX}bug-b`)
    r.ibu = await instance(1, T.a.version, KEY, T.b.users.rev)
    const strayId = await addUser(on, 1, `${PREFIX}stray`, { deptId: T.a.dept })
    stray = (await signInDirect(on, strayId))!.accessToken
    await addRow(on, B.id, 'wf_task', {
      instance_id: T.a.done,
      node_id: 'r1',
      node_name: 'r1',
      assignee_id: T.a.users.ccu,
      state: 'canceled',
    })
    await addRow(on, B.id, 'wf_cc', { instance_id: T.a.done, node_id: 'r1', user_id: strayId })
    await addRow(on, 1, 'wf_event', {
      instance_id: T.a.inst,
      node_id: 'r1',
      action: 'comment',
      actor_id: T.b.users.rev,
      comment: `${PREFIX}stray`,
      created_at: new Date(),
    })
  })

  it("model names come from the own tenant's versions and models only", async () => {
    const names = async (token: string, path: string, query: object = {}) =>
      Object.fromEntries(
        (
          (await data(call(token, 'get', path).query({ pageSize: 200, ...query }))).items as {
            modelKey: string
            modelName: string
          }[]
        ).map((i) => [i.modelKey, i.modelName]),
      )
    const keys = [`${PREFIX}bug-i`, `${PREFIX}bug-iii`]
    // no model name found: the key stands in
    expect(await names(T.a.tok.ini, '/wf/instances/mine')).toMatchObject(
      Object.fromEntries(keys.map((k) => [k, k])),
    )
    for (const key of keys)
      expect(await names(T.a.tok.boss, '/wf/instances', { modelKey: key })).toEqual({ [key]: key })
    // the detail has no version of its own tenant to show: an error on such broken rows (a known
    // behaviour, today a server error), never B's model name
    for (const id of [r.ii, r.iiii]) {
      const res = await call(T.a.tok.ini, 'get', `/wf/instances/${id}`)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(res.body)).not.toContain(`${KEY}-b`)
    }
    // an action finds no version: 404
    const res = await call(T.a.tok.ini, 'post', `/wf/instances/${r.iiii}/cancel`, {})
    expect(res.status).toBe(404)
  })

  it('an overdue notice names no model or initiator of B', async () => {
    const mark = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
    const due = new Date(Date.now() - 3_600_000)
    for (const id of [r.ii, r.iiii, r.ibu]) {
      const task = await addRow(on, 1, 'wf_task', {
        instance_id: id,
        node_id: 'r1',
        node_name: 'r1',
        assignee_id: T.a.users.rev,
        state: 'pending',
        due_at: due,
      })
      expect(await inTenant1(() => on.get(WfRemind).remindOne(task, null, new Date()))).toBe(true)
    }
    const rows = await ds.query<
      { params: { instanceId: number; model: object; initiator: string } }[]
    >(
      "SELECT params FROM msg_inbox WHERE id > ? AND user_id = ? AND template_code = 'wf.task.overdue'",
      [mark, T.a.users.rev],
    )
    const seen = new Map(rows.map((x) => [Number(x.params.instanceId), x.params]))
    expect(seen.get(r.ii)).toMatchObject({ model: { i18n: `${PREFIX}bug-i` } })
    expect(seen.get(r.iiii)).toMatchObject({ model: { i18n: `${PREFIX}bug-iii` } })
    expect(seen.get(r.ibu)).toMatchObject({ model: { i18n: `${KEY}-a` }, initiator: '' })
  })

  it("B's model lends no process managers to a version of the default tenant", async () => {
    // B's model names a default-tenant user as its manager; a default-tenant version under it
    // (current version of a default-tenant model) asks the managers of a step nobody reviews
    const lender = await addRow(on, B.id, 'wf_model', {
      model_key: `${PREFIX}lender`,
      name: `${PREFIX}lender`,
      form_kind: 'dynamic',
      manager_user_ids: [T.a.users.ccu],
    })
    const own = await addRow(on, 1, 'wf_model', {
      model_key: `${PREFIX}borrow`,
      name: `${PREFIX}borrow`,
      form_kind: 'dynamic',
      enabled: 1,
    })
    const v = await version(1, lender, `${PREFIX}borrow`)
    await ds.query('UPDATE wf_version SET tree_json = ? WHERE id = ?', [
      JSON.stringify(
        begin(review('r1', { kind: 'users', ids: [NO_SUCH] }, { whenNobody: 'toManager' })),
      ),
      v,
    ])
    await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [v, own])
    const res = await start(T.a, { modelKey: `${PREFIX}borrow`, formValues: { days: 1 } })
    expect(outcome(res)).toEqual({
      status: Err.WF_NO_ASSIGNEE.status,
      code: Err.WF_NO_ASSIGNEE.code,
    })
  })

  it('a timeout notice names no assignee of B', async () => {
    const tree = begin(
      review(
        'r1',
        { kind: 'users', ids: [T.a.users.rev] },
        { timeout: { hours: 1, action: 'autoPass' } },
      ),
    )
    await model(T.a, `${PREFIX}late`, tree)
    const id = await started(T.a, { modelKey: `${PREFIX}late`, formValues: { days: 1 } })
    const task = await pendingTask(id)
    // the task left with B's reviewer, overdue
    await ds.query('UPDATE wf_task SET assignee_id = ?, due_at = ? WHERE id = ?', [
      T.b.users.rev,
      new Date(Date.now() - 3_600_000),
      task,
    ])
    const mark = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM msg_inbox'))[0].n)
    expect(await inTenant1(() => on.get(WfRemind).timeoutOne(task, id, null, new Date()))).toBe(
      'timed out',
    )
    const [row] = await ds.query<{ params: { assignee: string } }[]>(
      "SELECT params FROM msg_inbox WHERE id > ? AND user_id = ? AND template_code = 'wf.task.timeout'",
      [mark, T.a.users.ini],
    )
    expect(row?.params.assignee).toBe('')
  })

  it("B's timeout record never hides a task the own reviewer handled", async () => {
    await addRow(on, B.id, 'wf_event', {
      instance_id: T.a.done,
      task_id: T.a.doneTask,
      node_id: 'r1',
      action: 'timeout',
      comment: timeoutKey('autoPass'),
      created_at: new Date(),
    })
    const done = await data(call(T.a.tok.rev, 'get', '/wf/tasks/done'))
    expect((done.items as { id: number }[]).map((t) => t.id)).toContain(T.a.doneTask)
  })

  it("B's task, copy or instance gives no access to an instance; B's actor has no name", async () => {
    await call(T.a.tok.ini, 'get', `/wf/instances/${r.ib}`).expect(404)
    await call(T.a.tok.ccu, 'get', `/wf/instances/${T.a.done}`).expect(404)
    await call(stray, 'get', `/wf/instances/${T.a.done}`).expect(404)
    const detail = await data(call(T.a.tok.ini, 'get', `/wf/instances/${T.a.inst}`))
    const timeline = detail.timeline as { comment: string; actor: unknown }[]
    expect(timeline.find((e) => e.comment === `${PREFIX}stray`)?.actor).toEqual({
      id: T.b.users.rev,
      name: null,
    })
  })
})

describe('a platform user inside B', () => {
  it("opens and handles the items of its own lists, which run in its own tenant; B's instances open as B's", async () => {
    const root = (await signIn(on)).accessToken
    const flow = `${PREFIX}inside`
    await model(T.a, flow, begin(review('r1', { kind: 'users', ids: [T.a.users.boss] })))
    const inst = await started(T.a, {
      modelKey: flow,
      formValues: { days: 3, who: T.a.users.ini, unit: T.a.dept },
    })
    const task = await pendingTask(inst)
    await data(call(root, 'post', `/iam/tenants/${B.id}/enter`, { reason: 'support case' }))
    const todo = await data(call(root, 'get', '/wf/tasks/todo'))
    expect(todo.items.map((t: { id: number }) => t.id)).toContain(task)
    expect((await data(call(root, 'get', `/wf/instances/${inst}`))).id).toBe(inst)
    await data(call(root, 'get', `/wf/tasks/${task}/back-targets`))
    await data(call(root, 'post', `/wf/tasks/${task}/approve`, {}))
    expect(await tasksOf(inst)).toEqual([['r1', T.a.users.boss, 'approved']])
    // the admin pages' view of the tenant entered
    expect((await data(call(root, 'get', `/wf/instances/${T.b.inst}`))).id).toBe(T.b.inst)
  })
})
