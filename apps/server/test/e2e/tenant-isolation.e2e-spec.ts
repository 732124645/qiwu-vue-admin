// Tenant isolation (see docs/design-notes.md#tenancy) through a real CRUD controller (the scoped-note
// fixture) and the real guards. A second tenant holds look-alikes of the default tenant's rows, written
// through the ORM in that tenant: depts of the same names, notes of the same titles naming the default
// tenant's depts and creators (rows every data scope of the default tenant would match but for the tenant),
// links between its notes. Every request runs in the default tenant (there is no multi-tenancy switch
// yet): root and the five data scopes list, get, export, count (@SkipDataScope), update, delete,
// batch-delete, clean and import-upsert without seeing or writing a row of the other tenant (its ids are
// 404 like missing ones, a mixed batch 404 as a whole). After every case the other tenant's rows must be
// exactly as seeded.
import assert from 'node:assert/strict'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import type { DataScope, Principal } from '../../src/core/auth/principal.js'
import { allTenants, withTenant } from '../../src/core/context/tenant.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { notePerms } from '../fixtures/scoped-note/scoped-note.controller.js'
import { ScopedNote } from '../fixtures/scoped-note/scoped-note.entity.js'
import { ScopedNoteFixtureModule } from '../fixtures/scoped-note/scoped-note.module.js'
import { ScopedNoteService } from '../fixtures/scoped-note/scoped-note.service.js'
import {
  createScopedNoteTables,
  dropScopedNoteTables,
  truncateScopedNoteTables,
} from '../fixtures/scoped-note/setup.js'
import { TestDept } from '../fixtures/scoped-note/test-dept.entity.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { createTenant, inTenant1, type TestTenant } from '../setup/tenants.js'

const PREFIX = 'ti-e2e-'
/** Explicit ids of the default tenant's depts, far above the seeded ones. */
const D = { top: 7100, mine: 7101, child: 7102, lookalike: 71010 }
type DeptKey = keyof typeof D
const DEPTS: [key: DeptKey, parent: number, path: string][] = [
  ['top', 0, '/7100/'],
  ['mine', D.top, '/7100/7101/'],
  ['child', D.mine, '/7100/7101/7102/'],
  ['lookalike', D.top, '/7100/71010/'],
]
const OTHER_USER = 999_999
const TITLES = ['top', 'mine', 'child', 'lookalike', 'rows'] as const
type Title = (typeof TITLES)[number]

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let cls: ClsService
let txHost: TransactionHost<TransactionalAdapterTypeOrm>
let svc: ScopedNoteService
let B: TestTenant
const menuIds: number[] = []
const roleIds: Record<string, number> = {}
const userIds: Record<string, number> = {}
const tokens: Record<string, string> = {}
/** The default tenant's note ids by title, written again before each case. */
const a = {} as Record<Title, number>
/** The other tenant's notes (the look-alikes and `b-only`) and depts, by title / key. */
const bNote: Record<string, number> = {}
const bDept = {} as Record<DeptKey, number>
let seededB: Awaited<ReturnType<typeof tenantB>>

/** Notes 1–4 by someone else in each dept; `rows` by the own_rows user, in the look-alike dept. */
const noteRows = (): [Title, number, number][] => [
  ['top', D.top, OTHER_USER],
  ['mine', D.mine, OTHER_USER],
  ['child', D.child, OTHER_USER],
  ['lookalike', D.lookalike, OTHER_USER],
  ['rows', D.lookalike, userIds.rows!],
]

const call = (
  user: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = request(app.getHttpServer())
    [method](`/api/test/scoped-notes${path}`)
    .set(bearer(tokens[user]!))
  return body ? req.send(body) : req
}
const sortIds = (rows: { id: number }[]) => rows.map((r) => Number(r.id)).sort((x, y) => x - y)
const idsOf = (titles: readonly Title[]) => titles.map((t) => a[t]).sort((x, y) => x - y)
const expect404 = (res: request.Response) => {
  expect(res.status).toBe(404)
  expect(res.body.code).toBe(Err.NOT_FOUND.code)
}
const expect409 = (res: request.Response) => {
  expect(res.status).toBe(409)
  expect(res.body.code).toBe(Err.DUPLICATE.code)
}
/** Raw SQL, no ORM and so no tenant condition: what is really stored. */
const aliveA = async () =>
  (
    await ds.query<{ id: number }[]>(
      'SELECT id FROM test_scoped_note WHERE tenant_id = 1 AND deleted_at IS NULL ORDER BY id',
    )
  ).map((r) => Number(r.id))
async function tenantB() {
  const of = (sql: string) => ds.query<object[]>(sql, [B.id])
  return {
    notes: await of(
      'SELECT id, title, dept_id, created_by, updated_by, updated_at, deleted_at FROM test_scoped_note WHERE tenant_id = ? ORDER BY id',
    ),
    depts: await of(
      'SELECT id, parent_id, tree_path, name FROM test_dept WHERE tenant_id = ? ORDER BY id',
    ),
    links: await of(
      'SELECT note_id, target_id, deleted_at FROM test_note_link WHERE tenant_id = ? ORDER BY note_id, target_id',
    ),
  }
}

async function role(name: string, dataScope: DataScope, picked: number[] = []) {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: PREFIX + name,
      name: PREFIX + name,
      data_scope: dataScope,
    }),
  )
  for (const menu of menuIds)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
      id,
      menu,
    ])
  for (const dept of picked)
    await ds.query('INSERT INTO iam_role_depts (role_id, dept_id, tenant_id) VALUES (?, ?, 1)', [
      id,
      dept,
    ])
  roleIds[name] = id
}

async function user(name: string) {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'iam_user', {
      username: PREFIX + name,
      display_name: name,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
      dept_id: D.mine,
    }),
  )
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
    id,
    roleIds[name],
  ])
  userIds[name] = id
  tokens[name] = (await signIn(app, PREFIX + name)).accessToken
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, ScopedNoteFixtureModule],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  cls = app.get(ClsService)
  txHost = app.get(TransactionHost)
  svc = app.get(ScopedNoteService)
  await cleanRedis(redis)
  await createScopedNoteTables(ds)
  await truncateScopedNoteTables(ds)

  for (const [key, parent, path] of DEPTS)
    await ds.query(
      'INSERT INTO iam_dept (id, parent_id, tree_path, name, tenant_id) VALUES (?, ?, ?, ?, 1)',
      [D[key], parent, path, `${PREFIX}${key}`],
    )
  // the fixture resolves own_dept_tree in its own test_dept: mirror the same tree there
  await ds.query(
    'INSERT INTO test_dept (id, parent_id, tree_path, name, tenant_id) SELECT id, parent_id, tree_path, name, tenant_id FROM iam_dept WHERE id IN (?) AND tenant_id = 1',
    [Object.values(D)],
  )
  for (const perm of Object.values(notePerms))
    menuIds.push(
      await inTenant1(() =>
        insertRow(ds.manager, 'iam_menu', {
          parent_id: 0,
          kind: 'action',
          name: `${PREFIX}${perm}`,
          perms: perm,
        }),
      ),
    )
  await role('all', 'all')
  await role('picked', 'picked_depts', [D.child, D.lookalike])
  await role('own-dept', 'own_dept')
  await role('tree', 'own_dept_tree')
  await role('rows', 'own_rows')
  for (const name of Object.keys(roleIds)) await user(name)
  tokens.root = (await signIn(app, 'admin')).accessToken

  B = await createTenant(app)
  // qw:cross-tenant the other tenant's rows, written through the ORM in that tenant
  await withTenant(B.id, async () => {
    const depts = ds.getRepository(TestDept)
    const notes = ds.getRepository(ScopedNote)
    for (const [key, parent, path] of DEPTS) {
      const dept = await depts.save(
        depts.create({ parentId: parent, treePath: path, name: `${PREFIX}${key}` }),
      )
      bDept[key] = Number(dept.id)
    }
    for (const [title, deptId, createdBy] of noteRows())
      bNote[title] = (await notes.save(notes.create({ title, deptId, createdBy }))).id
    bNote['b-only'] = (await notes.save(notes.create({ title: 'b-only', deptId: bDept.mine }))).id
  })
  // the link table has no entity: its rows name their tenant themselves
  await ds.query(
    'INSERT INTO test_note_link (note_id, target_id, tenant_id) VALUES (?, ?, ?), (?, ?, ?)',
    [bNote.top, bNote.mine, B.id, bNote['b-only'], bNote.top, B.id],
  )
  seededB = await tenantB()
  // every row went where it was written: the other tenant's through the ORM, the default's by SQL
  assert.equal(seededB.notes.length, TITLES.length + 1)
  assert.equal(seededB.depts.length, DEPTS.length)
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    const users = Object.values(userIds)
    const roles = Object.values(roleIds)
    if (users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roles])
      await ds.query('DELETE FROM iam_role_depts WHERE role_id IN (?)', [roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
    }
    if (menuIds.length) await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menuIds])
    await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [Object.values(D)])
    await dropScopedNoteTables(ds)
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

beforeEach(async () => {
  await ds.query('DELETE FROM test_scoped_note WHERE tenant_id = 1')
  for (const [title, deptId, createdBy] of noteRows()) {
    const { insertId } = await ds.query<{ insertId: number }>(
      'INSERT INTO test_scoped_note (title, dept_id, created_by, tenant_id) VALUES (?, ?, ?, 1)',
      [title, deptId, createdBy],
    )
    a[title] = Number(insertId)
  }
})

// hooks take node:assert (expect belongs in a case)
afterEach(async () => {
  assert.deepEqual(await tenantB(), seededB)
})

interface Actor {
  who: string
  /** the default tenant's notes in the actor's scope */
  visible: readonly Title[]
  /** one of them to write */
  inside: Title
}

const ACTORS: Actor[] = [
  { who: 'root', visible: TITLES, inside: 'top' },
  { who: 'all', visible: TITLES, inside: 'lookalike' },
  { who: 'picked', visible: ['child', 'lookalike', 'rows'], inside: 'child' },
  { who: 'own-dept', visible: ['mine'], inside: 'mine' },
  { who: 'tree', visible: ['mine', 'child'], inside: 'child' },
  { who: 'rows', visible: ['rows'], inside: 'rows' },
]

describe.each(ACTORS)('$who', (c) => {
  it('list, options, export and the @SkipDataScope() count hold rows of the default tenant only', async () => {
    const list = (await call(c.who, 'get', '?pageSize=50').expect(200)).body.data
    expect(sortIds(list.items)).toEqual(idsOf(c.visible))
    expect(list.total).toBe(c.visible.length)
    expect(sortIds((await call(c.who, 'get', '/options').expect(200)).body.data)).toEqual(
      idsOf(c.visible),
    )
    expect(sortIds((await call(c.who, 'get', '/export').expect(200)).body.data)).toEqual(
      idsOf(c.visible),
    )
    expect((await call(c.who, 'get', '/count').expect(200)).body.data).toBe(TITLES.length)
  })

  it('get, update and delete: an id of the other tenant is 404, like a missing one', async () => {
    await call(c.who, 'get', `/${a[c.inside]}`).expect(200)
    for (const id of Object.values(bNote)) {
      expect404(await call(c.who, 'get', `/${id}`))
      expect404(await call(c.who, 'put', `/${id}`, { title: 'hijacked' }))
      expect404(await call(c.who, 'delete', `/${id}`))
    }
    expect(await aliveA()).toEqual(idsOf(TITLES))
  })

  it('update and delete of an own row leave its look-alike in the other tenant alone', async () => {
    await call(c.who, 'put', `/${a[c.inside]}`, { title: 'renamed' }).expect(200)
    await call(c.who, 'delete', `/${a[c.inside]}`).expect(200)
    expect(await aliveA()).toEqual(idsOf(TITLES.filter((t) => t !== c.inside)))
  })

  it('batch-delete with an id of the other tenant: 404 for the whole batch, nothing deleted', async () => {
    const own = idsOf(c.visible)
    expect404(await call(c.who, 'post', '/batch-delete', { ids: [...own, bNote[c.inside]] }))
    expect(await aliveA()).toEqual(idsOf(TITLES))
    await call(c.who, 'post', '/batch-delete', { ids: own }).expect(200)
    expect(await aliveA()).toEqual(idsOf(TITLES.filter((t) => !c.visible.includes(t))))
  })

  it('clean soft-deletes the rows of the default tenant only', async () => {
    await call(c.who, 'post', '/clean').expect(200)
    expect(await aliveA()).toEqual([])
  })
})

describe('beside another tenant', () => {
  const root: Principal = {
    userId: 1,
    deptId: null,
    deptTreePath: null,
    roles: [],
    perms: ['*'],
    root: true,
  }
  const ownDept: Principal = {
    userId: OTHER_USER - 1,
    deptId: D.mine,
    deptTreePath: '/7100/7101/',
    roles: [{ code: 'own', dataScope: 'own_dept', perms: [notePerms.browse] }],
    perms: [notePerms.browse],
  }
  const as = <T>(p: Principal, fn: () => Promise<T>) =>
    inTenant1(() =>
      cls.run(() => {
        cls.set('principal', p)
        return fn()
      }),
    )

  it('the same title lives in both tenants; twice in one tenant is still 409', async () => {
    await call('root', 'post', '', { title: 'b-only' }).expect(201)
    expect409(await call('root', 'post', '', { title: 'b-only' }))
    expect409(await call('root', 'post', '', { title: 'top' }))
  })

  it('import upsert never matches the row of the same title in the other tenant', async () => {
    // only the other tenant has it: a new row here, not an update there
    await call('root', 'post', '/upsert', { title: 'b-only', deptId: D.top }).expect(200)
    // both have it: this tenant's row is updated
    await call('root', 'post', '/upsert', { title: 'mine', deptId: D.top }).expect(200)
    expect(
      await ds.query(
        "SELECT title, dept_id, tenant_id FROM test_scoped_note WHERE title IN ('b-only', 'mine') AND tenant_id = 1 ORDER BY title",
      ),
    ).toEqual([
      { title: 'b-only', dept_id: D.top, tenant_id: 1 },
      { title: 'mine', dept_id: D.top, tenant_id: 1 },
    ])
    // out of the caller's scope here: a duplicate, whatever the other tenant holds
    expect409(await call('own-dept', 'post', '/upsert', { title: 'top', deptId: D.mine }))
  })

  it('a join brings no row of the other tenant: a note naming its dept lists without one', async () => {
    await ds.query('UPDATE test_scoped_note SET dept_id = ? WHERE id = ? AND tenant_id = 1', [
      bDept.top,
      a.top,
    ])
    const items = (await call('root', 'get', '/with-dept?pageSize=50').expect(200)).body.data
      .items as {
      id: number
      dept: { id: string } | null
    }[]
    const deptOf = (id: number) => items.find((n) => n.id === id)?.dept
    expect(deptOf(a.top)).toBeNull()
    expect(Number(deptOf(a.mine)?.id)).toBe(D.mine)
  })

  it('a tenantId in the data counts for nothing: the row is created in, and stays in, this tenant', async () => {
    const created = await as(root, () => svc.create({ title: 'forged', tenantId: B.id }))
    expect(created.tenantId).toBe(1)
    await as(root, () => svc.update(a.mine, { title: 'moved', tenantId: B.id }))
    expect(
      await ds.query(
        "SELECT title, tenant_id FROM test_scoped_note WHERE title IN ('forged', 'moved') ORDER BY title",
      ),
    ).toEqual([
      { title: 'forged', tenant_id: 1 },
      { title: 'moved', tenant_id: 1 },
    ])
  })

  it('lockScopedIds: a batch holding an id of the other tenant is 404, root included', async () => {
    for (const p of [root, ownDept])
      await expect(
        as(p, () => txHost.withTransaction(() => svc.lockScopedIds([a.mine, bNote.mine!]))),
      ).rejects.toMatchObject({ status: 404 })
  })

  it('allTenants reads both tenants', async () => {
    const rows = await as(root, () =>
      // qw:cross-tenant the spec reads both tenants
      allTenants(() => svc.scopedQb('n').getMany()),
    )
    expect(sortIds(rows)).toEqual([...idsOf(TITLES), ...Object.values(bNote)].sort((x, y) => x - y))
  })
})
