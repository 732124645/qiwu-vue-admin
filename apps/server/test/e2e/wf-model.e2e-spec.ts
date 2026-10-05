// wf.model (see docs/design-notes.md#workflow): model CRUD, draft save, publish (the draft or a JSON tree, compiled
// against the form's fields: a custom model's business handler, a dynamic model's bound form (snapshotted with its sanitized schema) or, without one, its sent fields), enabled,
// sort, version list, one version with its tree (the JSON export), initiator scope, managers,
// cancel/withdraw switches; wfPerms.model per route.
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
import { WfHandlers } from '../../src/modules/workflow/runtime/wf-handlers.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfm-'
const URL = '/api/wf/models'
const MISSING = 999_999
/** the business handler's fields of the custom test model */
const FIELDS = { days: 'number', kind: 'string' } as const

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'admin' | 'reader' | 'plain', string> = { admin: '', reader: '', plain: '' }
const userIds: number[] = []
let roleId: number
let adminId: number

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
let seq = 0
const key = (tag = 'm') => `${PREFIX}${tag}-${++seq}`
/** A custom model (its key has the test handler, unless `modelKey` says otherwise). */
const custom = (over: object = {}) => ({
  modelKey: key('custom'),
  name: 'Leave',
  formKind: 'custom',
  createRoute: '/biz/leave/new',
  viewComponent: 'biz/leave/view',
  ...over,
})
const add = async (body: object) => (await call('admin', 'post', '', body).expect(201)).body.data
/** A custom model whose key the test handler is registered under. */
const addCustom = async (over: object = {}) => {
  const row = await add(custom(over))
  handled.add(row.modelKey)
  return row
}
const detail = async (id: number) => (await call('admin', 'get', `/${id}`).expect(200)).body.data
const versionsOf = async (id: number) =>
  (await call('admin', 'get', `/${id}/versions`).expect(200)).body.data
const publish = (id: number, body: object = {}) => call('admin', 'post', `/${id}/versions`, body)

const review = (id: string) => ({
  id,
  type: 'review',
  name: `${id} step`,
  assignee: { kind: 'initiator' },
  sign: 'any',
  whenNobody: 'autoPass',
  whenInitiatorIsReviewer: 'self',
  onReject: 'finish',
})
const tree = (next?: object, name = 'Begin') => ({ id: 'begin', type: 'begin', name, next })
/** days > 3 → r1, else nothing */
const forkOn = (field: string, fallback = true) =>
  tree({
    id: 'f1',
    type: 'fork',
    name: 'Days',
    paths: [
      { id: 'long', name: 'Long', when: [[{ field, op: 'gt', value: 3 }]], child: review('r1') },
      {
        id: 'other',
        name: 'Other',
        fallback,
        when: fallback ? [] : [[{ field, op: 'lte', value: 3 }]],
      },
    ],
  })
/** An object nested `depth` levels (containers), for the JSON size limit. */
const nested = (depth: number) => {
  let v: object = {}
  for (let i = 1; i < depth; i++) v = { a: v }
  return v
}

/** model keys the test handler answers for (`WfHandlers.get` is stubbed: its keys come from decorators) */
const handled = new Set<string>()
const handler = {
  fields: () => ({ ...FIELDS }),
  assertStartable: async () => {},
  loadFormValues: async () => ({}),
  onStateChange: async () => {},
}

async function user(name: string, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  userIds.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

async function cleanup() {
  await ds.query('DELETE FROM wf_version WHERE model_key LIKE ?', [`${PREFIX}%`])
  await ds.query('DELETE FROM wf_model WHERE model_key LIKE ?', [`${PREFIX}%`])
  await ds.query('DELETE FROM wf_form WHERE name LIKE ?', [`${PREFIX}%`])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  vi.spyOn(app.get(WfHandlers), 'get').mockImplementation((k) =>
    handled.has(k) ? handler : undefined,
  )
  await cleanRedis(redis)
  await cleanup()
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  for (const perms of [wfPerms.model.browse, wfPerms.model.view]) {
    const menu = await findId(ds.manager, 'iam_menu', { perms })
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, menu])
  }
  tokens.admin = (await signIn(app)).accessToken
  adminId = (await findId(ds.manager, 'iam_user', { username: 'admin' }))!
  tokens.reader = await user('reader', [roleId])
  tokens.plain = await user('plain', [])
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('access (wfPerms.model)', () => {
  it('no wf permission → 403 on every route; browse + view read but cannot write', async () => {
    const { id } = await add(custom())
    for (const [method, path, body] of [
      ['get', '', undefined],
      ['get', `/${id}`, undefined],
      ['get', `/${id}/versions`, undefined],
      ['get', `/${id}/versions/1`, undefined],
      ['post', '', custom()],
      ['put', `/${id}`, { name: 'x' }],
      ['put', `/${id}/draft`, { tree: tree() }],
      ['put', `/${id}/enabled`, { enabled: false }],
      ['put', '/sort', { items: [{ id, sortNo: 1 }] }],
      ['post', `/${id}/versions`, {}],
      ['delete', `/${id}`, undefined],
    ] as const)
      await call('plain', method, path, body).expect(403)
    await call('reader', 'get').expect(200)
    await call('reader', 'get', `/${id}`).expect(200)
    await call('reader', 'get', `/${id}/versions`).expect(200)
    await call('reader', 'post', '', custom()).expect(403)
    await call('reader', 'put', `/${id}/draft`, { tree: tree() }).expect(403)
    await call('reader', 'post', `/${id}/versions`, {}).expect(403)
    await call('reader', 'delete', `/${id}`).expect(403)
  })
})

describe('CRUD', () => {
  it('create → 201 with defaults; detail adds the draft and the handler fields', async () => {
    const row = await addCustom({ managerUserIds: [1], allowWithdraw: false })
    expect(row).toMatchObject({
      name: 'Leave',
      category: 'other',
      formKind: 'custom',
      flowKind: 'tree',
      createRoute: '/biz/leave/new',
      viewComponent: 'biz/leave/view',
      initiatorScope: null,
      managerUserIds: [1],
      allowCancel: true,
      allowWithdraw: false,
      enabled: true,
      sortNo: 0,
      currentVersionId: null,
    })
    expect(await detail(row.id)).toMatchObject({
      id: row.id,
      draftJson: null,
      draftXml: null,
      fields: FIELDS,
    })
    // a custom model without a handler, a dynamic one: no fields yet
    expect((await detail((await add(custom())).id)).fields).toBeNull()
    const dynamic = await add({ modelKey: key(), name: 'D', formKind: 'dynamic' })
    expect((await detail(dynamic.id)).fields).toBeNull()
  })

  it('a custom model needs its start route and view component, both path-shaped → 400', async () => {
    for (const over of [
      { createRoute: undefined },
      { viewComponent: null },
      { createRoute: 'javascript:alert(1)' },
      { createRoute: '/a?b=1' },
      { viewComponent: '../secret' },
      { modelKey: 'Bad key' },
    ]) {
      const res = await call('admin', 'post', '', custom(over)).expect(400)
      expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
    }
  })

  it('the model key is unique among live models → 409', async () => {
    const { modelKey } = await add(custom())
    // another body: the same one again within 3 s is a duplicate submit (429)
    const res = await call('admin', 'post', '', custom({ modelKey, name: 'Dup' })).expect(409)
    expect(res.body.code).toBe(Err.DUPLICATE.code)
  })

  it('an initiator scope listing nobody is stored as null (everyone), a real one with every list', async () => {
    const none = await add(custom({ initiatorScope: { userIds: [], deptIds: [] } }))
    expect(none.initiatorScope).toBeNull()
    const some = await add(custom({ initiatorScope: { roleIds: [2] } }))
    expect(some.initiatorScope).toEqual({ userIds: [], deptIds: [], roleIds: [2] })
    await call('admin', 'put', `/${some.id}`, { initiatorScope: { deptIds: [0] } }).expect(400)
    await call('admin', 'put', `/${some.id}`, { initiatorScope: {} }).expect(200)
    expect((await detail(some.id)).initiatorScope).toBeNull()
  })

  it('update changes what it is sent, never the key, form kind or flow kind; custom paths cannot be cleared', async () => {
    const row = await add(custom({ flowKind: 'bpmn' }))
    expect(row.flowKind).toBe('bpmn')
    await call('admin', 'put', `/${row.id}`, {
      name: 'Renamed',
      modelKey: key(),
      formKind: 'dynamic',
      flowKind: 'tree',
      allowCancel: false,
      managerUserIds: [1, 2],
      category: 'hr',
    }).expect(200)
    expect(await detail(row.id)).toMatchObject({
      name: 'Renamed',
      modelKey: row.modelKey,
      formKind: 'custom',
      flowKind: 'bpmn',
      allowCancel: false,
      managerUserIds: [1, 2],
      category: 'hr',
    })
    await call('admin', 'put', `/${row.id}`, { createRoute: null }).expect(400)
    await call('admin', 'put', `/${MISSING}`, { name: 'x' }).expect(404)
  })

  it('list filters by key, name, category and enabled, without drafts', async () => {
    const a = await add(custom({ name: `${PREFIX}list`, category: 'finance' }))
    const b = await add(custom({ name: `${PREFIX}list` }))
    await call('admin', 'put', `/${a.id}/draft`, { tree: tree() }).expect(200)
    await call('admin', 'put', `/${b.id}/enabled`, { enabled: false }).expect(200)
    const list = async (q: string) =>
      (await call('admin', 'get', `?${q}`).expect(200)).body.data.items as { id: number }[]
    const found = await list(`name=${PREFIX}list&sort=id`)
    expect(found.map((r) => r.id)).toEqual([a.id, b.id])
    expect(found[0]).not.toHaveProperty('draftJson')
    expect(found[0]).not.toHaveProperty('draftXml')
    expect((await list(`modelKey=${a.modelKey}`)).map((r) => r.id)).toEqual([a.id])
    expect((await list(`name=${PREFIX}list&category=finance`)).map((r) => r.id)).toEqual([a.id])
    expect((await list(`name=${PREFIX}list&enabled=false`)).map((r) => r.id)).toEqual([b.id])
  })

  it('sort sets several sort numbers at once; an unknown id → 404 and nothing changes', async () => {
    const a = await add(custom())
    const b = await add(custom())
    const sort = (items: object[]) => call('admin', 'put', '/sort', { items })
    await sort([
      { id: a.id, sortNo: 7 },
      { id: b.id, sortNo: 3 },
    ]).expect(200)
    expect([(await detail(a.id)).sortNo, (await detail(b.id)).sortNo]).toEqual([7, 3])
    await sort([
      { id: a.id, sortNo: 1 },
      { id: MISSING, sortNo: 1 },
    ]).expect(404)
    expect((await detail(a.id)).sortNo).toBe(7)
  })
})

describe('draft', () => {
  it('any tree-shaped object is saved as is (checked on publish only)', async () => {
    const { id } = await add(custom())
    const draft = forkOn('nope', false)
    await call('admin', 'put', `/${id}/draft`, { tree: draft }).expect(200)
    expect((await detail(id)).draftJson).toEqual(JSON.parse(JSON.stringify(draft)))
    await call('admin', 'put', `/${MISSING}/draft`, { tree: draft }).expect(404)
  })

  it('a draft nested deeper than MySQL takes (100) or not an object → 400, the saved one stays', async () => {
    const { id } = await add(custom())
    await call('admin', 'put', `/${id}/draft`, { tree: tree() }).expect(200)
    // the body `{ tree: … }` adds a level: the tree itself is 100 deep, so it is kept
    await call('admin', 'put', `/${id}/draft`, { tree: nested(100) }).expect(200)
    const res = await call('admin', 'put', `/${id}/draft`, { tree: nested(101) }).expect(400)
    expect(res.body.errors[0]).toMatchObject({ path: 'tree' })
    for (const bad of [[tree()], 'x', null])
      await call('admin', 'put', `/${id}/draft`, { tree: bad }).expect(400)
    // a tree or a BPMN model's XML, never both
    await call('admin', 'put', `/${id}/draft`, { tree: tree(), xml: '' }).expect(400)
    // a tree model takes no BPMN XML: refused at `xml`, never silently dropped (wf-bpmn-model.e2e: BPMN)
    const xml = await call('admin', 'put', `/${id}/draft`, { xml: '<x/>' }).expect(400)
    expect(xml.body.errors[0]).toMatchObject({ path: 'xml' })
    expect((await detail(id)).draftJson).toEqual(nested(100))
  })
})

describe('publish', () => {
  it('the draft of a custom model → version 1 with the handler fields; then the current version', async () => {
    const { id, modelKey } = await addCustom()
    // unknown keys are no part of a node: stripped from the snapshot
    await call('admin', 'put', `/${id}/draft`, { tree: { ...forkOn('days'), junk: 1 } }).expect(200)
    const v1 = (await publish(id).expect(201)).body.data
    expect(v1).toMatchObject({ version: 1, formSnapshot: { fields: FIELDS }, publishedBy: adminId })
    expect(v1).not.toHaveProperty('treeJson')
    const model = await detail(id)
    expect(model.currentVersionId).toBe(v1.id)
    expect(model.draftJson).not.toHaveProperty('junk')
    const [row] = await ds.query('SELECT model_key, tree_json FROM wf_version WHERE id = ?', [
      v1.id,
    ])
    expect(row.model_key).toBe(modelKey)
    expect(row.tree_json).toEqual(JSON.parse(JSON.stringify(forkOn('days'))))
    expect(await versionsOf(id)).toEqual([v1])
  })

  it('a tree compile rejects → 400 located at the node, nothing published', async () => {
    const { id } = await addCustom()
    const res = await publish(id, { tree: forkOn('days', false) }).expect(400)
    expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(res.body.errors).toEqual([
      { path: 'tree.next.paths', msg: expect.stringContaining('f1') },
    ])
    // a tree model takes no BPMN XML: refused at `xml`
    const xml = (await publish(id, { xml: '<x/>' }).expect(400)).body.errors[0]
    expect(xml).toMatchObject({ path: 'xml' })
    // no tree sent and no draft saved: nothing to publish
    const none = await publish(id).expect(400)
    expect(none.body.errors[0].path).toBe('tree')
    expect(await versionsOf(id)).toEqual([])
    expect((await detail(id)).currentVersionId).toBeNull()
  })

  it('custom: conditions only on the handler fields (sent fields are ignored); dynamic: on the sent ones', async () => {
    const c = await addCustom()
    const amount = { tree: forkOn('amount'), fields: { amount: 'number' } }
    const res = await publish(c.id, amount).expect(400)
    expect(res.body.errors[0].path).toBe('tree.next.paths.0.when.0.0.field')
    const d = await add({ modelKey: key(), name: 'D', formKind: 'dynamic' })
    await publish(d.id, { tree: forkOn('amount') }).expect(400)
    const v = (await publish(d.id, amount).expect(201)).body.data
    expect(v.formSnapshot).toEqual({ fields: { amount: 'number' } })
    await publish(d.id, { tree: tree(), fields: { $bad: 'number' } }).expect(400)
  })

  it('a custom model without a registered business handler → 422', async () => {
    const { id, modelKey } = await add(custom())
    const res = await publish(id, { tree: tree() }).expect(422)
    expect(res.body.code).toBe(Err.WF_HANDLER_MISSING.code)
    expect(res.body.msg).toContain(modelKey)
  })

  it('a JSON tree → the next version, which also becomes the draft; newest first in the list', async () => {
    const { id } = await addCustom()
    await publish(id, { tree: tree() }).expect(201)
    await call('admin', 'put', `/${id}/draft`, {
      tree: tree(undefined, 'Work in progress'),
    }).expect(200)
    const v2 = (await publish(id, { tree: forkOn('days') }).expect(201)).body.data
    expect(v2.version).toBe(2)
    expect((await detail(id)).draftJson).toEqual(JSON.parse(JSON.stringify(forkOn('days'))))
    expect((await versionsOf(id)).map((v: { version: number }) => v.version)).toEqual([2, 1])
    await publish(MISSING, { tree: tree() }).expect(404)
    await call('admin', 'get', `/${MISSING}/versions`).expect(404)
  })

  it('concurrent publishes of one model get consecutive versions (model row lock)', async () => {
    const { id } = await addCustom()
    const res = await Promise.all(
      ['A', 'B', 'C'].map((name) => publish(id, { tree: tree(undefined, name) })),
    )
    expect(res.map((r) => r.status)).toEqual([201, 201, 201])
    expect(res.map((r) => r.body.data.version).sort()).toEqual([1, 2, 3])
  })
})

describe('json export and import', () => {
  it('a version with its tree and fields; import = publish that JSON, compiled the same way', async () => {
    const d = await add({ modelKey: key(), name: 'D', formKind: 'dynamic' })
    const fields = { amount: 'number' }
    const v1 = (await publish(d.id, { tree: forkOn('amount'), fields }).expect(201)).body.data
    const got = (await call('admin', 'get', `/${d.id}/versions/${v1.id}`).expect(200)).body.data
    expect(got).toEqual({
      ...v1,
      tree: JSON.parse(JSON.stringify(forkOn('amount'))),
      bpmnXml: null,
    })
    // the export (tree + fields) imported into another model is its next version
    const other = await add({ modelKey: key(), name: 'Copy', formKind: 'dynamic' })
    const exported = { tree: got.tree, fields: got.formSnapshot.fields }
    const copy = (await publish(other.id, exported).expect(201)).body.data
    expect(copy).toMatchObject({ version: 1, formSnapshot: { fields } })
    // the same compile: without the fields its condition names no field
    const res = await publish(other.id, { tree: got.tree }).expect(400)
    expect(res.body.errors[0].path).toBe('tree.next.paths.0.when.0.0.field')
    expect(await versionsOf(other.id)).toHaveLength(1)
  })

  it('403 without view, a reader exports; a version of another model or none → 404', async () => {
    const { id } = await addCustom()
    const v = (await publish(id, { tree: tree() }).expect(201)).body.data
    await call('plain', 'get', `/${id}/versions/${v.id}`).expect(403)
    await call('reader', 'get', `/${id}/versions/${v.id}`).expect(200)
    const other = await addCustom()
    await call('admin', 'get', `/${other.id}/versions/${v.id}`).expect(404)
    await call('admin', 'get', `/${id}/versions/${MISSING}`).expect(404)
    await call('admin', 'get', `/${id}/versions/x`).expect(400)
  })
})

describe('bound form', () => {
  const SCHEMA = {
    rule: [
      { type: 'inputNumber', field: 'days', title: 'Days' },
      { type: 'qw-user-select', field: 'boss', title: 'Boss' },
      { type: 'qw-upload', field: 'files', title: 'Files' },
    ],
  }
  const FORM_FIELDS = { days: 'number', boss: 'user', files: 'string' }
  const forms = (method: 'post' | 'delete', path = '', body?: object) =>
    request(app.getHttpServer())
      [method](`/api/wf/forms${path}`)
      .set(bearer(tokens.admin))
      .send(body)
  const addForm = async () =>
    (await forms('post', '', { name: key('form'), schemaJson: SCHEMA }).expect(201)).body.data
  const dynamic = (formId: number | null) => ({
    modelKey: key(),
    name: 'D',
    formKind: 'dynamic',
    formId,
  })

  it('a dynamic model binds a live form: its fields in the detail; unknown or deleted → 404; unbinding', async () => {
    const form = await addForm()
    const m = await add(dynamic(form.id))
    expect(m.formId).toBe(form.id)
    expect(await detail(m.id)).toMatchObject({ formId: form.id, fields: FORM_FIELDS })
    await call('admin', 'post', '', dynamic(MISSING)).expect(404)
    await call('admin', 'put', `/${m.id}`, { formId: MISSING }).expect(404)
    const gone = await addForm()
    await forms('delete', `/${gone.id}`).expect(200)
    await call('admin', 'put', `/${m.id}`, { formId: gone.id }).expect(404)
    // bound: the form cannot be deleted (409); unbound again, no fields
    await forms('delete', `/${form.id}`).expect(409)
    await call('admin', 'put', `/${m.id}`, { formId: null }).expect(200)
    expect(await detail(m.id)).toMatchObject({ formId: null, fields: null })
  })

  it('publish snapshots the form (sanitized again) and compiles against its fields, not the sent ones', async () => {
    const form = await addForm()
    const m = await add(dynamic(form.id))
    // the stored schema edited by hand: keys outside the whitelist are dropped, not snapshotted
    const store = (schema: object) =>
      ds.query('UPDATE wf_form SET schema_json = ? WHERE id = ?', [JSON.stringify(schema), form.id])
    await store({ rule: SCHEMA.rule.map((r) => ({ ...r, stray: 1 })) })
    const sent = { amount: 'number' }
    const v = (await publish(m.id, { tree: forkOn('days'), fields: sent }).expect(201)).body.data
    expect(v.formSnapshot).toEqual({ fields: FORM_FIELDS, schema: SCHEMA })
    const [row] = await ds.query('SELECT form_snapshot AS s FROM wf_version WHERE id = ?', [v.id])
    expect(row.s).toEqual(v.formSnapshot)
    const res = await publish(m.id, { tree: forkOn('amount'), fields: sent }).expect(400)
    expect(res.body.errors[0].path).toBe('tree.next.paths.0.when.0.0.field')
    // a stored schema the sanitizer refuses now (edited by hand) → 400 at formId, nothing published
    await store({ rule: [{ type: 'input', field: 'x', value: '$FN:alert(1)' }] })
    const bad = await publish(m.id, { tree: tree() }).expect(400)
    expect(bad.body.errors[0].path).toBe('formId.rule.0.value')
    expect(await versionsOf(m.id)).toHaveLength(1)
  })
})

describe('remove', () => {
  it('a never published model is deleted (its key free again); a published one → 409 in_use', async () => {
    const draft = await add(custom())
    await call('admin', 'delete', `/${draft.id}`).expect(200)
    await call('admin', 'get', `/${draft.id}`).expect(404)
    await add(custom({ modelKey: draft.modelKey, name: 'Again' }))
    const published = await addCustom()
    await publish(published.id, { tree: tree() }).expect(201)
    const res = await call('admin', 'delete', `/${published.id}`).expect(409)
    expect(res.body.code).toBe(Err.IN_USE.code)
    await call('admin', 'delete', `/${MISSING}`).expect(404)
  })
})
