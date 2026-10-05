// core/data-scope (IDOR; see docs/design-notes.md#data-scope, #security): the five role data scopes through a real CRUD controller
// (the scoped-note fixture) and the real guards, for list/get/update/delete/batch-delete/export/options:
// out-of-scope ids → 404 with nothing written, create/update with an out-of-scope dept → 404, empty
// scopes → empty lists, `/7000/7001/` never matching `/7000/70010/` (the `/1/2/` vs `/1/23/` case),
// roles counted only when they hold the checked perm, root exempt, @SkipDataScope, lockScopedIds locks.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource, QueryFailedError } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import type { DataScope, Principal, PrincipalRole } from '../../src/core/auth/principal.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { notePerms } from '../fixtures/scoped-note/scoped-note.controller.js'
import { ScopedNoteFixtureModule } from '../fixtures/scoped-note/scoped-note.module.js'
import { ScopedNoteService } from '../fixtures/scoped-note/scoped-note.service.js'
import { createScopedNoteTables, dropScopedNoteTables } from '../fixtures/scoped-note/setup.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'ds-e2e-'
/** Explicit ids far above the seeded depts. 70010's path starts with '/7000/7001' but not '/7000/7001/'. */
const D = { top: 7000, mine: 7001, child: 7002, lookalike: 70010 }
const DEPTS: [id: number, parent: number, path: string][] = [
  [D.top, 0, '/7000/'],
  [D.mine, D.top, '/7000/7001/'],
  [D.child, D.mine, '/7000/7001/7002/'],
  [D.lookalike, D.top, '/7000/70010/'],
]
const OTHER_USER = 999_999
const MISSING = 999_999

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let cls: ClsService
let txHost: TransactionHost<TransactionalAdapterTypeOrm>
let svc: ScopedNoteService
const menuIds: number[] = []
const roleIds: Record<string, number> = {}
const userIds: Record<string, number> = {}
const tokens: Record<string, string> = {}

const http = () => request(app.getHttpServer())
const call = (
  user: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = http()[method](`/api/test/scoped-notes${path}`).set(bearer(tokens[user]!))
  return body ? req.send(body) : req
}
const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b)
const alive = async () =>
  (
    await ds.query<{ id: number }[]>(
      'SELECT id FROM test_scoped_note WHERE deleted_at IS NULL ORDER BY id',
    )
  ).map((r) => Number(r.id))
const expect404 = (res: request.Response) => {
  expect(res.status).toBe(404)
  expect(res.body.code).toBe(Err.NOT_FOUND.code)
}

async function role(name: string, dataScope: DataScope, perms: string[], picked: number[] = []) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + name,
    name: PREFIX + name,
    data_scope: dataScope,
  })
  for (const perm of perms)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      id,
      menuIds[Object.values(notePerms).indexOf(perm as never)],
    ])
  for (const dept of picked)
    await ds.query('INSERT INTO iam_role_depts (role_id, dept_id) VALUES (?, ?)', [id, dept])
  roleIds[name] = id
}

async function user(name: string, roles: string[], deptId: number | null = D.mine) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
    dept_id: deptId,
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, roleIds[r]])
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

  for (const [id, parent, path] of DEPTS)
    await ds.query('INSERT INTO iam_dept (id, parent_id, tree_path, name) VALUES (?, ?, ?, ?)', [
      id,
      parent,
      path,
      `${PREFIX}${id}`,
    ])
  // the fixture resolves own_dept_tree in its own test_dept: mirror the same tree there
  await ds.query('DELETE FROM test_dept')
  await ds.query(
    'INSERT INTO test_dept (id, parent_id, tree_path, name) SELECT id, parent_id, tree_path, name FROM iam_dept WHERE id IN (?)',
    [Object.values(D)],
  )
  for (const perm of Object.values(notePerms))
    menuIds.push(
      await insertRow(ds.manager, 'iam_menu', {
        parent_id: 0,
        kind: 'action',
        name: `${PREFIX}${perm}`,
        perms: perm,
      }),
    )

  const every = Object.values(notePerms)
  await role('all', 'all', every)
  await role('picked', 'picked_depts', every, [D.child, D.lookalike])
  await role('own-dept', 'own_dept', every)
  await role('tree', 'own_dept_tree', every)
  await role('rows', 'own_rows', every)
  await role('picked-none', 'picked_depts', every)
  await role('all-browse-only', 'all', [notePerms.browse])

  await user('all', ['all'])
  await user('picked', ['picked'])
  await user('own-dept', ['own-dept'])
  await user('tree', ['tree'])
  await user('rows', ['rows'])
  await user('picked-none', ['picked-none'])
  await user('no-dept', ['own-dept'], null)
  await user('mixed', ['own-dept', 'all-browse-only'])
  await user('none', [])
  tokens.root = (await signIn(app, 'admin')).accessToken
})

afterAll(async () => {
  if (ds) {
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

// notes 1–4 by someone else in each dept; note 5 by the own_rows user, in the look-alike dept
beforeEach(async () => {
  await ds.query('TRUNCATE TABLE test_scoped_note')
  await ds.query(
    'INSERT INTO test_scoped_note (id, title, dept_id, created_by) VALUES (1, ?, ?, ?), (2, ?, ?, ?), (3, ?, ?, ?), (4, ?, ?, ?), (5, ?, ?, ?)',
    [
      ['top', D.top, OTHER_USER],
      ['mine', D.mine, OTHER_USER],
      ['child', D.child, OTHER_USER],
      ['lookalike', D.lookalike, OTHER_USER],
      ['rows', D.lookalike, userIds.rows],
    ].flat(),
  )
})

interface ScopeCase {
  scope: DataScope
  user: string
  visible: number[]
  /** a visible note to write */
  inside: number
  /** a live note outside the scope (all: none → a missing id) */
  outside: number
  /** a dept the user may write into (own_rows: none needed, the row is theirs) */
  deptIn: number | null
  /** a dept outside the scope (all, own_rows: none) */
  deptOut: number | null
}

const CASES: ScopeCase[] = [
  {
    scope: 'all',
    user: 'all',
    visible: [1, 2, 3, 4, 5],
    inside: 4,
    outside: MISSING,
    deptIn: D.lookalike,
    deptOut: null,
  },
  {
    scope: 'picked_depts',
    user: 'picked',
    visible: [3, 4, 5],
    inside: 3,
    outside: 2,
    deptIn: D.lookalike,
    deptOut: D.mine,
  },
  {
    scope: 'own_dept',
    user: 'own-dept',
    visible: [2],
    inside: 2,
    outside: 3,
    deptIn: D.mine,
    deptOut: D.child,
  },
  {
    scope: 'own_dept_tree',
    user: 'tree',
    visible: [2, 3],
    inside: 3,
    outside: 4,
    deptIn: D.child,
    deptOut: D.lookalike,
  },
  {
    scope: 'own_rows',
    user: 'rows',
    visible: [5],
    inside: 5,
    outside: 2,
    deptIn: null,
    deptOut: null,
  },
]

describe.each(CASES)('$scope', (c) => {
  it('list, options and export return exactly the rows in scope', async () => {
    const list = (await call(c.user, 'get', '?pageSize=50').expect(200)).body.data
    expect(ids(list.items)).toEqual(c.visible)
    expect(list.total).toBe(c.visible.length)
    expect(ids((await call(c.user, 'get', '/options').expect(200)).body.data)).toEqual(c.visible)
    expect(ids((await call(c.user, 'get', '/export').expect(200)).body.data)).toEqual(c.visible)
  })

  it('get: 200 in scope; 404 out of scope or missing', async () => {
    for (const id of c.visible) await call(c.user, 'get', `/${id}`).expect(200)
    expect404(await call(c.user, 'get', `/${c.outside}`))
    expect404(await call(c.user, 'get', `/${MISSING}`))
  })

  it('update: 200 in scope; 404 out of scope or into a dept outside, nothing written', async () => {
    await call(c.user, 'put', `/${c.inside}`, { title: 'renamed' }).expect(200)
    expect404(await call(c.user, 'put', `/${c.outside}`, { title: 'hijacked' }))
    if (c.deptOut !== null)
      expect404(await call(c.user, 'put', `/${c.inside}`, { title: 'moved', deptId: c.deptOut }))
    const titles = await ds.query<{ id: number; title: string }[]>(
      "SELECT id, title FROM test_scoped_note WHERE title IN ('renamed', 'hijacked', 'moved')",
    )
    expect(titles).toEqual([{ id: c.inside, title: 'renamed' }])
  })

  it('delete: 404 out of scope (row kept); in scope soft-deleted', async () => {
    expect404(await call(c.user, 'delete', `/${c.outside}`))
    expect(await alive()).toEqual([1, 2, 3, 4, 5])
    await call(c.user, 'delete', `/${c.inside}`).expect(200)
    expect(await alive()).toEqual([1, 2, 3, 4, 5].filter((id) => id !== c.inside))
  })

  it('batch-delete: any out-of-scope id → 404 and nothing deleted; in-scope ids deleted', async () => {
    expect404(await call(c.user, 'post', '/batch-delete', { ids: [...c.visible, c.outside] }))
    expect(await alive()).toEqual([1, 2, 3, 4, 5])
    await call(c.user, 'post', '/batch-delete', { ids: c.visible }).expect(200)
    expect(await alive()).toEqual([1, 2, 3, 4, 5].filter((id) => !c.visible.includes(id)))
  })

  it('create: 201 with a dept in scope (or none); 404 with a dept outside, nothing inserted', async () => {
    const res = await call(c.user, 'post', '', { title: 'new', deptId: c.deptIn }).expect(201)
    // the creator sees the new row (own_rows: through created_by = me)
    await call(c.user, 'get', `/${res.body.data.id}`).expect(200)
    if (c.deptOut !== null)
      expect404(await call(c.user, 'post', '', { title: 'planted', deptId: c.deptOut }))
    expect(await ds.query("SELECT id FROM test_scoped_note WHERE title = 'planted'")).toEqual([])
  })
})

describe('edge scopes', () => {
  it('picked_depts with no depts picked, or own_dept without a dept → empty lists, every id 404', async () => {
    for (const user of ['picked-none', 'no-dept']) {
      const list = (await call(user, 'get').expect(200)).body.data
      expect(list).toEqual({ items: [], total: 0 })
      expect((await call(user, 'get', '/options').expect(200)).body.data).toEqual([])
      expect404(await call(user, 'get', '/2'))
      expect404(await call(user, 'post', '', { title: 'x', deptId: D.mine }))
    }
  })

  it('only roles holding the checked perm count: browse sees `all`, view/export/modify only own_dept', async () => {
    // role own-dept holds every note perm; role all-browse-only holds only test.note.browse
    expect(ids((await call('mixed', 'get', '?pageSize=50').expect(200)).body.data.items)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(ids((await call('mixed', 'get', '/export').expect(200)).body.data)).toEqual([2])
    await call('mixed', 'get', '/2').expect(200)
    expect404(await call('mixed', 'get', '/1'))
    expect404(await call('mixed', 'put', '/1', { title: 'x' }))
  })

  it('@RequirePerm.all(browse, modify): the scopes of both perms apply, not just the first one', async () => {
    // browse comes with `all` (all-browse-only), modify only with own_dept: the write stays in own_dept
    expect404(await call('mixed', 'put', '/1/strict', { title: 'widened' }))
    await call('mixed', 'put', '/2/strict', { title: 'kept' }).expect(200)
    expect(
      await ds.query("SELECT id FROM test_scoped_note WHERE title IN ('widened', 'kept')"),
    ).toEqual([{ id: 2 }])
    // a caller whose roles give both perms the same scope is not narrowed
    await call('all', 'put', '/1/strict', { title: 'widened' }).expect(200)
  })

  it('any-of: the union over every held perm, whatever order they are listed in', async () => {
    // @RequirePerm(view, browse): view alone → own_dept, browse alone → all; holding both → all
    expect(ids((await call('mixed', 'get', '/any-of').expect(200)).body.data)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(ids((await call('own-dept', 'get', '/any-of').expect(200)).body.data)).toEqual([2])
  })

  it('root is exempt: sees and writes every row, into any dept', async () => {
    expect(ids((await call('root', 'get', '?pageSize=50').expect(200)).body.data.items)).toEqual([
      1, 2, 3, 4, 5,
    ])
    await call('root', 'put', '/4', { deptId: D.top }).expect(200)
    await call('root', 'post', '/batch-delete', { ids: [1, 5] }).expect(200)
    expect(await alive()).toEqual([2, 3, 4])
  })

  it('a caller without the route perm → 403 before any scope applies', async () => {
    expect((await call('none', 'get')).status).toBe(403)
    expect((await call('none', 'delete', '/2')).status).toBe(403)
  })

  it('the written row must stay visible: an unset or null dept leaves a dept scope → 404', async () => {
    expect404(await call('own-dept', 'put', '/2', { deptId: null }))
    expect404(await call('own-dept', 'post', '', { title: 'no-dept' }))
    expect404(await call('own-dept', 'post', '', { title: 'null-dept', deptId: null }))
    expect(await ds.query('SELECT dept_id FROM test_scoped_note WHERE id = 2')).toEqual([
      { dept_id: D.mine },
    ])
    expect(await ds.query("SELECT id FROM test_scoped_note WHERE title LIKE '%-dept'")).toEqual([])
  })

  it("own_rows: rows stay the caller's (created_by), whatever dept they carry", async () => {
    await call('rows', 'put', '/5', { deptId: D.top }).expect(200)
    const res = await call('rows', 'post', '', { title: 'mine-elsewhere', deptId: D.top }).expect(
      201,
    )
    await call('rows', 'get', `/${res.body.data.id}`).expect(200)
  })
})

describe('the hook in code (ScopedNoteService)', () => {
  const PERM = notePerms.browse
  const me = (...roles: PrincipalRole[]): Principal => ({
    // never a real user's id: an inserted user (note 5's creator) can be id 101 in a long run
    userId: OTHER_USER - 1,
    deptId: D.mine,
    deptTreePath: '/7000/7001/',
    roles,
    perms: roles.flatMap((r) => r.perms),
  })
  const scopeRole = (dataScope: DataScope, perms: string[] = [PERM]): PrincipalRole => ({
    code: dataScope,
    dataScope,
    perms,
  })
  const as = <T>(p: Principal | undefined, fn: () => Promise<T>, perm?: string) =>
    cls.run(() => {
      cls.set('principal', p)
      if (perm) cls.set('checkedPerm', { perms: [perm], all: false })
      return fn()
    })
  const visible = (p: Principal | undefined, perm?: string) =>
    as(p, async () => ids(await svc.scopedQb('n').getMany()), perm)

  it('several roles OR together; no @RequirePerm → every enabled role applies', async () => {
    expect(await visible(me(scopeRole('own_dept'), scopeRole('own_rows')), PERM)).toEqual([2])
    const other = scopeRole('all', ['test.other.browse'])
    expect(await visible(me(other, scopeRole('own_dept')), PERM)).toEqual([2])
    expect(await visible(me(other), PERM)).toEqual([])
    expect(await visible(me(other))).toEqual([1, 2, 3, 4, 5])
  })

  it('no caller → nothing; @SkipDataScope → everything, for that call only', async () => {
    expect(await visible(undefined)).toEqual([])
    expect(await svc.countAll()).toBe(5) // outside any request context, like a job
    await as(me(scopeRole('own_dept')), async () => {
      expect(await svc.countAll()).toBe(5)
      expect(await svc.scopedQb('n').getCount()).toBe(1)
    })
  })

  it('values are bound parameters, never SQL text', async () => {
    const [sql, params] = await as(me(scopeRole('own_dept_tree')), async () =>
      svc.scopedQb('n').getQueryAndParameters(),
    )
    expect(sql).not.toContain('/7000/7001/')
    expect(params).toContain('/7000/7001/%')
  })

  it('assertWritableScope judges the whole resulting row (dept OR owner), unset = NULL', async () => {
    const rows = { ...me(scopeRole('own_rows')), userId: 55 }
    await as(rows, () => svc.assertWritableScope({ deptId: D.top, createdBy: 55 }))
    const outside = { status: 404 }
    await expect(as(rows, () => svc.assertWritableScope({ createdBy: 56 }))).rejects.toMatchObject(
      outside,
    )
    const dept = me(scopeRole('own_dept'))
    await as(dept, () => svc.assertWritableScope({ deptId: D.mine, createdBy: 56 }))
    await expect(as(dept, () => svc.assertWritableScope({ title: 'x' }))).rejects.toMatchObject(
      outside,
    )
    await expect(
      as(undefined, () => svc.assertWritableScope({ deptId: D.mine })),
    ).rejects.toMatchObject(outside)
  })

  it('update: a forged createdBy cannot carry a row out of scope (created_by is write-once)', async () => {
    const p = me(scopeRole('own_dept'), scopeRole('own_rows'))
    await expect(
      as(p, () => svc.update(2, { createdBy: p.userId, deptId: D.lookalike })),
    ).rejects.toMatchObject({ status: 404 })
    expect(await ds.query('SELECT dept_id, created_by FROM test_scoped_note WHERE id = 2')).toEqual(
      [{ dept_id: D.mine, created_by: OTHER_USER }],
    )
  })

  it('create always inserts: an id in the DTO cannot overwrite a row', async () => {
    const p = me(scopeRole('own_dept'))
    const created = await as(p, () => svc.create({ id: 4, title: 'insert-only', deptId: D.mine }))
    expect(created.id).not.toBe(4)
    expect(await ds.query('SELECT title FROM test_scoped_note WHERE id = 4')).toEqual([
      { title: 'lookalike' },
    ])
  })

  it('lockScopedIds holds FOR UPDATE row locks for the transaction and needs one', async () => {
    const p = me(scopeRole('own_dept_tree'))
    await as(p, () =>
      txHost.withTransaction(async () => {
        await svc.lockScopedIds([2, 3, 3])
        // a second connection cannot take the same row lock
        const err = await ds
          .query('SELECT id FROM test_scoped_note WHERE id = ? FOR UPDATE NOWAIT', [2])
          .catch((e: QueryFailedError & { driverError: { code: string } }) => e)
        expect(err.driverError.code).toBe('ER_LOCK_NOWAIT')
      }),
    )
    await expect(as(p, () => svc.lockScopedIds([2]))).rejects.toThrow('needs a transaction')
  })
})
