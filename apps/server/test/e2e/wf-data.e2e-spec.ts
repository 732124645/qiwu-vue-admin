// wf approval data: GET /wf/models/:key/data and /data/export. Behind wfPerms.data (browse,
// export); rows limited to the caller's data scope for the route's perm on wf_instance.initiator_dept_id (out of
// scope never listed). Columns = the chosen version's form fields (form order, titles in the reader's language)
// after the fixed ones; filters by state, initiator, start time and field values (type-checked against the
// chosen snapshot: a field outside it → 400). The export has the page's columns and the same filters. Field access:
// root and the model's process admins see every field; anyone else not the ones a step of the version hides
// (begin included): no column, no value, not in the export, a filter by one → 400 like an unknown field.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { WF_DATA_BASE_COLUMNS, wfPerms } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import { I18nService } from 'nestjs-i18n'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfd-'
const KEY = `${PREFIX}m`
const EN = { 'Accept-Language': 'en-US' }

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let i18n: I18nService
const tokens: Record<string, string> = {}
const u: Record<string, number> = {}
const d: Record<string, number> = {}
const inst: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[], iam_role: [] as number[] }

const get = (who: string, path: string, query: object = {}) => {
  const req = request(app.getHttpServer()).get(`/api/wf/models/${path}`).set(EN).query(query)
  return tokens[who] ? req.set(bearer(tokens[who])) : req
}
const data = (who: string, query: object = {}, key = KEY) => get(who, `${key}/data`, query)
const filters = (...list: object[]) => ({ filters: JSON.stringify(list) })
/** ids of a 200 page, in order */
const ids = async (who: string, query: object = {}) =>
  ((await data(who, query).expect(200)).body.data.items as { id: number }[]).map((r) => r.id)

/** A binary (xlsx) response body as a Buffer. */
const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  r.on('data', (c: Buffer) => chunks.push(c))
  r.on('end', () => cb(null, Buffer.concat(chunks)))
}
async function exported(who: string, query: object = {}) {
  const res = await get(who, `${KEY}/data/export`, query).buffer(true).parse(binary)
  if (res.status !== 200) return { res, rows: [] as unknown[][] }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.worksheets[0]!
  const rows: unknown[][] = []
  ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)))
  return { res, rows }
}

async function add(table: keyof typeof made, row: Record<string, unknown>) {
  const id = await insertRow(ds.manager, table, row)
  made[table].push(id)
  return id
}
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
async function user(name: string, dept: string, roles: number[] = []) {
  u[name] = await add('iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: d[dept],
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [u[name], r])
  tokens[name] = (await signIn(app, PREFIX + name)).accessToken
}

/** A published version of model `modelId` (`tree`: a lone begin by default); returns its id. */
async function version(
  modelId: number,
  key: string,
  n: number,
  form: object,
  tree: object = { id: 'begin', type: 'begin', name: 'Begin' },
) {
  const res = await ds.query(
    `INSERT INTO wf_version (model_id, model_key, version, tree_json, form_snapshot)
     VALUES (?, ?, ?, ?, ?)`,
    [modelId, key, n, JSON.stringify(tree), JSON.stringify(form)],
  )
  return Number(res.insertId)
}
/** An instance row as the engine would leave it. */
async function instance(
  name: string,
  versionId: number,
  who: string,
  dept: string,
  state: string,
  startedAt: string,
  formValues: object,
  key = KEY,
) {
  const res = await ds.query(
    `INSERT INTO wf_instance (version_id, model_key, initiator_id, initiator_dept_id, state, form_values,
       initiator_picks, initiator_ctx, active_node_ids, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', '{"deptTreePath":null,"roleIds":[]}', '[]', ?, ?)`,
    [
      versionId,
      key,
      u[who],
      d[dept],
      state,
      JSON.stringify(formValues),
      new Date(startedAt),
      state === 'running' ? null : new Date(startedAt),
    ],
  )
  inst[name] = Number(res.insertId)
}

async function cleanup() {
  for (const t of ['wf_instance', 'wf_version', 'wf_model'])
    await ds.query(`DELETE FROM ${t} WHERE model_key LIKE ?`, [`${PREFIX}%`])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  i18n = app.get(I18nService)
  await cleanRedis(redis)
  await cleanup()
  for (const [name, parent] of [
    ['top', ''],
    ['sub', '/top'],
    ['other', ''],
  ] as const) {
    const parentPath = parent ? `/${d.top}/` : '/'
    d[name] = await add('iam_dept', {
      parent_id: parent ? d.top : 0,
      name: PREFIX + name,
      tree_path: parentPath,
    })
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [
      `${parentPath}${d[name]}/`,
      d[name],
    ])
  }
  const { browse, export: exp } = wfPerms.data
  const narrow = await role('narrow', 'own_dept_tree', [browse, exp])
  const reader = await role('reader', 'all', [browse])
  const staff = (await findId(ds.manager, 'iam_role', { code: 'staff' }))!
  await user('alice', 'sub')
  await user('bob', 'other')
  await user('lead', 'top', [narrow])
  await user('reader', 'other', [reader])
  await user('staffer', 'other', [staff])
  // a process admin of the model with the same role as lead
  await user('boss', 'top', [narrow])
  tokens.admin = (await signIn(app)).accessToken

  const m = await ds.query(
    'INSERT INTO wf_model (model_key, name, form_kind, manager_user_ids) VALUES (?, ?, ?, ?)',
    [KEY, `${PREFIX}name`, 'dynamic', JSON.stringify([u.boss])],
  )
  const v1 = await version(m.insertId, KEY, 1, { fields: { days: 'number', reason: 'string' } })
  // v2: form order differs from the (sorted) JSON keys; titles as the designer writes them, one plain
  // (starting like a formula) and one missing; a detail table's total titled by its column; a field name
  // with a dot is a key, never a JSON path (`items.total` is not `items` → `total`)
  const t = (id: string) => `{{$t.${id}}}`
  // its tree hides `approver` from the initiator (begin) and `days` from one review step
  const hiding = {
    id: 'begin',
    type: 'begin',
    name: 'Begin',
    access: { approver: 'hide', reason: 'edit' },
    next: {
      id: 'r1',
      type: 'review',
      name: 'Check',
      assignee: { kind: 'users', ids: [u.bob] },
      sign: 'any',
      whenNobody: 'autoPass',
      whenInitiatorIsReviewer: 'self',
      onReject: 'finish',
      access: { days: 'hide', start: 'read' },
    },
  }
  const v2 = await version(
    m.insertId,
    KEY,
    2,
    {
      fields: {
        reason: 'string',
        days: 'number',
        start: 'date',
        approver: 'user',
        team: 'dept',
        items: 'string',
        'items.total': 'number',
      },
      schema: {
        rule: [
          { type: 'input', field: 'reason', title: '=Reason text' },
          { type: 'inputNumber', field: 'days', title: t('days') },
          { type: 'datePicker', field: 'start', title: t('start') },
          { type: 'qw-user-select', field: 'approver', title: t('approver') },
          { type: 'qw-dept-select', field: 'team' },
          {
            type: 'qw-detail-table',
            field: 'items',
            title: t('items'),
            props: { columns: [{ prop: 'amount', label: t('amount'), sum: 'items.total' }] },
          },
        ],
        option: {
          language: {
            'zh-cn': {
              days: '天数',
              start: '开始',
              approver: '审批人',
              items: '明细',
              amount: '金额',
            },
            en: {
              days: 'Days',
              start: 'Start',
              approver: 'Approver',
              items: 'Items',
              amount: 'Amount',
            },
          },
        },
      },
    },
    hiding,
  )
  await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [v2, m.insertId])
  await instance('trip', v2, 'alice', 'sub', 'running', '2026-09-01T08:00:00Z', {
    reason: 'Trip abroad',
    days: 5,
    start: '2026-10-01',
    approver: u.bob,
    team: d.other,
    items: '[{"amount":12.5}]',
    'items.total': 12.5,
  })
  await instance('sick', v2, 'bob', 'other', 'approved', '2026-09-02T08:00:00Z', {
    reason: 'Sick',
    days: 2,
    start: '2026-10-03T09:00:00+08:00',
    approver: u.alice,
  })
  // an older version's instance, `days` stored as text: no number filter matches it
  await instance('old', v1, 'alice', 'sub', 'rejected', '2026-08-01T08:00:00Z', {
    reason: 'Old one',
    days: '7',
  })
  // another model's instance never shows
  await instance(
    'stranger',
    v2,
    'alice',
    'sub',
    'running',
    '2026-09-05T08:00:00Z',
    {},
    `${PREFIX}x`,
  )
})

afterAll(async () => {
  if (ds) {
    await cleanup()
    const users = made.iam_user
    if (users.length) await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
    if (made.iam_role.length)
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [made.iam_role])
    for (const t of ['iam_user', 'iam_role', 'iam_dept'] as const)
      if (made[t].length) await ds.query(`DELETE FROM ${t} WHERE id IN (?)`, [made[t]])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('access (wfPerms.data)', () => {
  it('no perm → 403, no session → 401; browse without export → export 403', async () => {
    await data('staffer').expect(403)
    await get('staffer', `${KEY}/data/export`).expect(403)
    await data('nobody').expect(401)
    await data('reader').expect(200)
    expect((await exported('reader')).res.status).toBe(403)
  })

  it("the page's model pick: browse lists the models without wf.model.browse", async () => {
    const models = (who: string) =>
      request(app.getHttpServer())
        .get('/api/wf/models')
        .query({ modelKey: KEY })
        .set(bearer(tokens[who]!))
    const { body } = await models('reader').expect(200)
    expect(body.data.items.map((m: { modelKey: string }) => m.modelKey)).toEqual([KEY])
    await models('staffer').expect(403)
  })

  it('unknown model or version → 404', async () => {
    await data('admin', {}, `${PREFIX}missing`).expect(404)
    await data('admin', { version: 9 }).expect(404)
  })
})

describe('page', () => {
  it('every instance of the model (all versions), newest first; columns = the current version form fields', async () => {
    const { body } = await data('admin').expect(200)
    expect(body.data).toMatchObject({ version: 2, versions: [2, 1], total: 3, withheld: 0 })
    expect(body.data.columns).toEqual([
      { field: 'reason', type: 'string', label: '=Reason text' },
      { field: 'days', type: 'number', label: 'Days' },
      { field: 'start', type: 'date', label: 'Start' },
      { field: 'approver', type: 'user', label: 'Approver' },
      { field: 'team', type: 'dept', label: 'team' },
      { field: 'items', type: 'string', label: 'Items' },
      { field: 'items.total', type: 'number', label: 'Amount' },
    ])
    expect(body.data.items.map((r: { id: number }) => r.id)).toEqual([
      inst.sick,
      inst.trip,
      inst.old,
    ])
    expect(body.data.items[1]).toEqual({
      id: inst.trip,
      version: 2,
      state: 'running',
      initiator: { id: u.alice, name: 'alice' },
      dept: { id: d.sub, name: `${PREFIX}sub` },
      startedAt: '2026-09-01T08:00:00.000Z',
      endedAt: null,
      values: {
        reason: 'Trip abroad',
        days: 5,
        start: '2026-10-01',
        approver: { id: u.bob, name: 'bob' },
        team: { id: d.other, name: `${PREFIX}other` },
        items: '[{"amount":12.5}]',
        'items.total': 12.5,
      },
    })
    // stored values as they are (no user lookup for a mistyped one); a column without a value is absent
    expect(body.data.items[2]).toMatchObject({
      version: 1,
      values: { reason: 'Old one', days: '7' },
    })
    // the zh-CN titles from the form's own texts
    const zh = await data('admin').set('Accept-Language', 'zh-CN').expect(200)
    expect(zh.body.data.columns.map((c: { label: string }) => c.label)).toEqual([
      '=Reason text',
      '天数',
      '开始',
      '审批人',
      'team',
      '明细',
      '金额',
    ])
  })

  it('version picks the columns: version 1 has its own fields', async () => {
    const { body } = await data('admin', { version: 1 }).expect(200)
    expect(body.data.version).toBe(1)
    expect(body.data.columns.map((c: { field: string }) => c.field).sort()).toEqual([
      'days',
      'reason',
    ])
    expect(body.data.total).toBe(3)
  })

  it('data scope on initiator_dept_id: an instance out of scope never appears', async () => {
    // lead's own dept tree is top + sub: bob's (other) instance is out of it
    expect(await ids('lead')).toEqual([inst.trip, inst.old])
    expect((await data('lead').expect(200)).body.data.total).toBe(2)
    expect(await ids('lead', filters({ field: 'reason', op: 'eq', value: 'Sick' }))).toEqual([])
    const { rows } = await exported('lead')
    expect(rows.slice(1).map((r) => r[0])).toEqual([inst.trip, inst.old])
  })

  it('filters: state, initiator, start time', async () => {
    expect(await ids('admin', { state: 'approved' })).toEqual([inst.sick])
    expect(await ids('admin', { initiatorId: u.alice })).toEqual([inst.trip, inst.old])
    expect(await ids('admin', { startedAtFrom: '2026-09-01T09:00:00Z' })).toEqual([inst.sick])
    expect(await ids('admin', { startedAtTo: '2026-09-01T08:00:00Z' })).toEqual([
      inst.trip,
      inst.old,
    ])
  })

  it('field filters compare by the field type; a stored value of another type never matches', async () => {
    const by = (...list: object[]) => ids('admin', filters(...list))
    expect(await by({ field: 'days', op: 'gte', value: 3 })).toEqual([inst.trip])
    // `ne` skips the text '7' too
    expect(await by({ field: 'days', op: 'ne', value: 2 })).toEqual([inst.trip])
    expect(await by({ field: 'days', op: 'in', value: [2, 7] })).toEqual([inst.sick])
    expect(await by({ field: 'items.total', op: 'eq', value: 12.5 })).toEqual([inst.trip])
    expect(await by({ field: 'reason', op: 'contains', value: 'abroad' })).toEqual([inst.trip])
    // case-sensitive, like fork conditions
    expect(await by({ field: 'reason', op: 'contains', value: 'ABROAD' })).toEqual([])
    expect(await by({ field: 'reason', op: 'in', value: ['Sick', 'Old one'] })).toEqual([
      inst.sick,
      inst.old,
    ])
    // exact text: a trailing blank is no match (`===`), nor excluded by `ne`
    expect(await by({ field: 'reason', op: 'eq', value: 'Sick ' })).toEqual([])
    expect(await by({ field: 'reason', op: 'ne', value: 'Sick ' })).toEqual([
      inst.sick,
      inst.trip,
      inst.old,
    ])
    // dates as instants: 2026-10-03T09:00+08:00 = 01:00 UTC
    expect(await by({ field: 'start', op: 'gt', value: '2026-10-03' })).toEqual([inst.sick])
    expect(await by({ field: 'start', op: 'lt', value: '2026-10-03T01:00:00Z' })).toEqual([
      inst.trip,
    ])
    expect(await by({ field: 'start', op: 'eq', value: '2026-10-03T01:00:00Z' })).toEqual([
      inst.sick,
    ])
    expect(await by({ field: 'approver', op: 'eq', value: u.alice })).toEqual([inst.sick])
    expect(await by({ field: 'team', op: 'in', value: [d.other, d.top] })).toEqual([inst.trip])
    // several filters: all of them
    expect(
      await by({ field: 'days', op: 'gt', value: 1 }, { field: 'reason', op: 'eq', value: 'Sick' }),
    ).toEqual([inst.sick])
  })

  it('a field filter outside the chosen version (or not type-checking) → 400, page and export alike', async () => {
    const bad = async (query: object, path: string) => {
      const res = await data('admin', query).expect(400)
      expect(res.body.errors).toEqual([{ path, msg: expect.any(String) }])
      expect((await exported('admin', query)).res.status).toBe(400)
    }
    await bad(filters({ field: 'nope', op: 'eq', value: 'x' }), 'filters.0.field')
    // `start` is a v2 field: not in version 1's form
    await bad(
      { version: 1, ...filters({ field: 'start', op: 'eq', value: '2026-10-01' }) },
      'filters.0.field',
    )
    // a JSON path never comes from the request: `$`-led and path-like names are just unknown fields
    await bad(filters({ field: '$.days', op: 'eq', value: 1 }), 'filters.0.field')
    await bad(filters({ field: 'days" OR 1=1 --', op: 'eq', value: 1 }), 'filters.0.field')
    await bad(filters({ field: 'days', op: 'contains', value: '5' }), 'filters.0.op')
    await bad(filters({ field: 'days', op: 'eq', value: '5' }), 'filters.0.value')
    await bad(filters({ field: 'start', op: 'gt', value: 'tomorrow' }), 'filters.0.value')
    await bad({ filters: '{not json' }, 'filters')
    const res = await data('admin', filters({ field: 'nope', op: 'eq', value: 'x' })).expect(400)
    expect(res.body.errors[0].msg).toBe("The chosen version's form has no field nope to filter by")
  })
})

describe('export', () => {
  it('the page columns (fixed + form fields, same labels) and its filtered rows, user / dept by name', async () => {
    const query = filters({ field: 'days', op: 'gt', value: 0 })
    const page = (await data('admin', query).expect(200)).body.data
    const { res, rows } = await exported('admin', query)
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="wfData.xlsx"')
    // a title starting like a formula is escaped like the cells
    const header = [
      ...WF_DATA_BASE_COLUMNS.map((c) => i18n.t(`field.wf.data.${c}`, { lang: 'en-US' })),
      ...page.columns.map((c: { label: string }) => c.label.replace(/^=/, "'=")),
    ]
    expect(header[0]).toBe('No.')
    expect(header[WF_DATA_BASE_COLUMNS.length]).toBe("'=Reason text")
    expect(rows[0]).toEqual(header)
    expect(rows.slice(1).map((r) => r[0])).toEqual(page.items.map((r: { id: number }) => r.id))
    const trip = rows.find((r) => r[0] === inst.trip)!
    expect(trip.slice(2, 4)).toEqual(['alice', `${PREFIX}sub`])
    expect(trip.slice(6)).toEqual([
      'Trip abroad',
      5,
      '2026-10-01',
      'bob',
      `${PREFIX}other`,
      '[{"amount":12.5}]',
      12.5,
    ])
  })
})

describe('field access', () => {
  const fieldsOf = (body: { data: { columns: { field: string }[] } }) =>
    body.data.columns.map((c) => c.field)
  const ALL = ['reason', 'days', 'start', 'approver', 'team', 'items', 'items.total']

  it("root and the model's process admin see the fields a step hides", async () => {
    for (const who of ['admin', 'boss']) {
      const { body } = await data(who).expect(200)
      expect(fieldsOf(body)).toEqual(ALL)
      expect(body.data.withheld).toBe(0)
      const trip = body.data.items.find((r: { id: number }) => r.id === inst.trip)
      expect(trip.values).toMatchObject({ days: 5, approver: { id: u.bob, name: 'bob' } })
      expect(await ids(who, filters({ field: 'days', op: 'gte', value: 3 }))).toEqual([inst.trip])
    }
    // read per request: off the model's admins, boss is withheld them like anyone else
    await ds.query('UPDATE wf_model SET manager_user_ids = NULL WHERE model_key = ?', [KEY])
    try {
      expect((await data('boss').expect(200)).body.data.withheld).toBe(2)
      await data('boss', filters({ field: 'days', op: 'gte', value: 3 })).expect(400)
    } finally {
      await ds.query('UPDATE wf_model SET manager_user_ids = ? WHERE model_key = ?', [
        JSON.stringify([u.boss]),
        KEY,
      ])
    }
  })

  // Process managers see every field, so appointing them is wf.model.managers — wf.model.modify alone
  // cannot add its holder nor drop one (create or update; the managers sent unchanged still pass)
  it('appointing process managers needs wf.model.managers, then the appointee sees every field', async () => {
    const { modify, create, managers } = wfPerms.model
    const base = [modify, create, wfPerms.data.browse]
    await user('modder', 'top', [await role('modder', 'all', base)])
    await user('appointer', 'top', [await role('appointer', 'all', [...base, managers])])
    const [{ id }] = await ds.query('SELECT id FROM wf_model WHERE model_key = ?', [KEY])
    const send = (who: string, req: request.Test, body: object) =>
      req.set(bearer(tokens[who]!)).set(EN).send(body)
    const put = (who: string, managerUserIds: number[]) =>
      send(who, request(app.getHttpServer()).put(`/api/wf/models/${id}`), { managerUserIds })
    const post = (who: string, key: string, more: object) =>
      send(who, request(app.getHttpServer()).post('/api/wf/models'), {
        modelKey: `${PREFIX}${key}`,
        name: key,
        formKind: 'dynamic',
        ...more,
      })
    try {
      await put('modder', [u.boss!, u.modder!]).expect(403)
      await put('modder', [u.modder!]).expect(403)
      await put('modder', []).expect(403) // removing one is appointing too
      await put('modder', [u.boss!, u.boss!]).expect(200) // the stored managers: unchanged
      expect((await data('modder').expect(200)).body.data.withheld).toBe(2)
      await post('modder', 'by-modder', { managerUserIds: [u.modder] }).expect(403)
      await post('modder', 'by-modder', { managerUserIds: [] }).expect(201)
      await post('appointer', 'by-appointer', { managerUserIds: [u.appointer] }).expect(201)

      await put('appointer', [u.boss!, u.appointer!]).expect(200)
      const { body } = await data('appointer').expect(200)
      expect([fieldsOf(body), body.data.withheld]).toEqual([ALL, 0])
    } finally {
      await ds.query('UPDATE wf_model SET manager_user_ids = ? WHERE model_key = ?', [
        JSON.stringify([u.boss]),
        KEY,
      ])
    }
  })

  it('anyone else with wf.data.*: no column, value, export cell or filter for a field hidden on any step', async () => {
    const { body } = await data('lead').expect(200)
    expect(fieldsOf(body)).toEqual(ALL.filter((f) => f !== 'days' && f !== 'approver'))
    expect(body.data.withheld).toBe(2)
    const trip = body.data.items.find((r: { id: number }) => r.id === inst.trip)
    expect(trip.values).toEqual({
      reason: 'Trip abroad',
      start: '2026-10-01',
      team: { id: d.other, name: `${PREFIX}other` },
      items: '[{"amount":12.5}]',
      'items.total': 12.5,
    })
    // the export: the same columns, no hidden value (not bob's name either)
    const { res, rows } = await exported('lead')
    expect(res.status).toBe(200)
    expect(rows[0]).not.toContain('Days')
    expect(rows[0]).not.toContain('Approver')
    const cells = rows.find((r) => r[0] === inst.trip)!
    expect(cells.slice(6)).toEqual([
      'Trip abroad',
      '2026-10-01',
      `${PREFIX}other`,
      '[{"amount":12.5}]',
      12.5,
    ])
    expect(cells).not.toContain('bob')
    // filtering by a hidden field is filtering by an unknown one: 400, page and export
    for (const f of [
      { field: 'days', op: 'gte', value: 3 },
      { field: 'approver', op: 'eq', value: u.bob },
    ]) {
      const bad = await data('lead', filters(f)).expect(400)
      expect(bad.body.errors).toEqual([{ path: 'filters.0.field', msg: expect.any(String) }])
      expect(bad.body.errors[0].msg).toBe(
        `The chosen version's form has no field ${f.field} to filter by`,
      )
      expect((await exported('lead', filters(f))).res.status).toBe(400)
    }
  })

  it('a version that hides nothing shows that role every field, but not a value the row version hides', async () => {
    const { body } = await data('lead', { version: 1 }).expect(200)
    expect(fieldsOf(body).sort()).toEqual(['days', 'reason'])
    expect(body.data.withheld).toBe(0)
    const values = (id: number) =>
      body.data.items.find((r: { id: number }) => r.id === id).values as object
    // the old (v1) instance shows its days; the trip runs on v2, which hides them
    expect(values(inst.old)).toEqual({ reason: 'Old one', days: '7' })
    expect(values(inst.trip)).toEqual({ reason: 'Trip abroad' })
    const v1 = (...list: object[]) => ({ version: 1, ...filters(...list) })
    // nor does a filter match by it (root's does)
    expect(await ids('admin', v1({ field: 'days', op: 'eq', value: 5 }))).toEqual([inst.trip])
    expect(await ids('lead', v1({ field: 'days', op: 'eq', value: 5 }))).toEqual([])
    expect(await ids('lead', v1({ field: 'reason', op: 'eq', value: 'Trip abroad' }))).toEqual([
      inst.trip,
    ])
    const { rows } = await exported('lead', { version: 1 })
    expect(rows.find((r) => r[0] === inst.trip)!.slice(6)).not.toContain(5)
  })

  it('a version whose tree no longer compiles withholds every field (its access is unknown)', async () => {
    const key = `${PREFIX}y`
    const m = await ds.query('INSERT INTO wf_model (model_key, name, form_kind) VALUES (?, ?, ?)', [
      key,
      key,
      'dynamic',
    ])
    const v = await version(m.insertId, key, 1, { fields: { days: 'number' } }, { type: 'nope' })
    await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [v, m.insertId])
    const lead = (await data('lead', {}, key).expect(200)).body
    expect([fieldsOf(lead), lead.data.withheld]).toEqual([[], 1])
    expect(fieldsOf((await data('admin', {}, key).expect(200)).body)).toEqual(['days'])
    // its rows under a version that shows every field: no value, not even one its snapshot lacks (a custom
    // form handler's), and no filter matches them
    await version(m.insertId, key, 2, { fields: { days: 'number', note: 'string' } })
    await instance(
      'broken',
      v,
      'alice',
      'sub',
      'running',
      '2026-09-07T08:00:00Z',
      {
        days: 3,
        note: 'x',
      },
      key,
    )
    const v2 = (who: string, ...list: object[]) =>
      data(who, { version: 2, ...(list.length ? filters(...list) : {}) }, key).expect(200)
    expect((await v2('lead')).body.data.items.map((r: { values: object }) => r.values)).toEqual([
      {},
    ])
    expect((await v2('lead', { field: 'note', op: 'eq', value: 'x' })).body.data.total).toBe(0)
    expect((await v2('admin', { field: 'note', op: 'eq', value: 'x' })).body.data.total).toBe(1)
  })

  it("a row on a version not the model's own withholds every value (its access is unknown)", async () => {
    const key = `${PREFIX}z`
    const m = await ds.query('INSERT INTO wf_model (model_key, name, form_kind) VALUES (?, ?, ?)', [
      key,
      key,
      'dynamic',
    ])
    const v = await version(m.insertId, key, 1, { fields: { reason: 'string' } })
    await ds.query('UPDATE wf_model SET current_version_id = ? WHERE id = ?', [v, m.insertId])
    // a version id of the other model (KEY's version 1, which hides nothing)
    const [{ id: foreign }] = await ds.query(
      'SELECT id FROM wf_version WHERE model_key = ? AND version = 1',
      [KEY],
    )
    await instance(
      'foreign',
      Number(foreign),
      'alice',
      'sub',
      'running',
      '2026-09-06T08:00:00Z',
      {
        reason: 'Foreign',
      },
      key,
    )
    const values = async (who: string) =>
      ((await data(who, {}, key).expect(200)).body.data.items as { values: object }[]).map(
        (r) => r.values,
      )
    expect(await values('lead')).toEqual([{}])
    expect(await values('admin')).toEqual([{ reason: 'Foreign' }])
  })
})
