// core/db against the test database: the ORM criteria (TypeORM 1.1 under ESM; see docs/adr/002-orm.md),
// plus AppModule wiring, assertUnique, paginate and the soft delete (remove, the
// reference registry, the link helpers). Criterion f (scopedQb, the
// five data scopes, lockScopedIds) lives in data-scope.e2e since core/data-scope. The scoped-note
// fixture tables are created here and dropped in afterAll; nothing lands in src migrations.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NotFoundException } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, pageQuery } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import { DataSource, type EntityManager, QueryFailedError, type Repository } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import { EXPORT_BATCH } from '../../src/core/db/base-crud.service.js'
import { BaseTreeService } from '../../src/core/db/base-tree.service.js'
import { addLinks, type LinkTable, removeLinks, replaceLinks } from '../../src/core/db/links.js'
import { referencesTo, softDeleteRows } from '../../src/core/db/references.js'
import { paginate } from '../../src/core/db/page.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { readTableInfo } from '../../src/core/db/schema-info.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { migrationsGlob } from '../../src/core/paths.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { TestMigrationProbe1790000000000 } from '../fixtures/scoped-note/1790000000000-test-migration-probe.js'
import { ScopedNote } from '../fixtures/scoped-note/scoped-note.entity.js'
import { ScopedNoteFixtureModule } from '../fixtures/scoped-note/scoped-note.module.js'
import { ScopedNoteService } from '../fixtures/scoped-note/scoped-note.service.js'
import {
  createScopedNoteTables,
  dropScopedNoteTables,
  truncateScopedNoteTables,
} from '../fixtures/scoped-note/setup.js'
import { TestDept } from '../fixtures/scoped-note/test-dept.entity.js'

let moduleRef: TestingModule
let ds: DataSource
let cls: ClsService
let svc: ScopedNoteService
let notes: Repository<ScopedNote>

/** Runs fn in a fresh CLS context as `principal` (what AuthGuard/PermGuard will set per request). */
const as = <T>(principal: Principal | undefined, fn: () => Promise<T>, perm?: string) =>
  cls.run(() => {
    cls.set('principal', principal)
    if (perm) cls.set('checkedPerm', { perms: [perm], all: false })
    return fn()
  })
const user = (userId: number): Principal => ({
  userId,
  deptId: null,
  deptTreePath: null,
  roles: [],
  perms: [],
})

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreDbModule, ScopedNoteFixtureModule],
  }).compile()
  await moduleRef.init()
  ds = moduleRef.get(getDataSourceToken())
  cls = moduleRef.get(ClsService)
  svc = moduleRef.get(ScopedNoteService)
  notes = ds.getRepository(ScopedNote)
  await createScopedNoteTables(ds)
})

afterAll(async () => {
  if (ds?.isInitialized) await dropScopedNoteTables(ds)
  await moduleRef?.close()
})

beforeEach(() => truncateScopedNoteTables(ds))

it('a) DataSource from env: the test database, UTC session, numeric bigints, meta_migrations, no sync', async () => {
  expect(ds.options).toMatchObject({
    type: 'mysql',
    database: process.env.DB_NAME,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    migrationsTableName: 'meta_migrations',
    synchronize: false,
  })
  const [session] = await ds.query('SELECT DATABASE() AS db, @@session.time_zone AS tz')
  expect(session).toEqual({ db: process.env.DB_NAME, tz: '+00:00' })
  expect(process.env.DB_NAME).toMatch(/^qiwu_(\w+_)?test$/)
  // created_at comes from the column DEFAULT CURRENT_TIMESTAMP(3): only right if the session is UTC
  const { id } = await notes.save(notes.create({ title: 'utc' }))
  const loaded = await notes.findOneByOrFail({ id })
  expect(typeof loaded.id).toBe('number')
  expect(Math.abs(loaded.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
})

it('b) circular Relation<T> entities load in both directions under ESM', async () => {
  await ds.query(
    "INSERT INTO test_dept (id, parent_id, tree_path, name) VALUES (1, 0, '/1/', 'hq')",
  )
  await notes.save([
    notes.create({ title: 'n1', deptId: 1 }),
    notes.create({ title: 'n2', deptId: 1 }),
  ])
  const note = await notes.findOneOrFail({ where: { title: 'n1' }, relations: { dept: true } })
  expect(note.dept?.name).toBe('hq')
  const dept = await ds
    .getRepository(TestDept)
    .findOneOrFail({ where: { id: 1 }, relations: { notes: true } })
  expect(dept.notes.map((n) => n.title).sort()).toEqual(['n1', 'n2'])
  const relation = ds.getMetadata(ScopedNote).findRelationWithPropertyPath('dept')
  expect(relation?.inverseEntityMetadata.target).toBe(TestDept)
})

describe('c) migrations', () => {
  it('a test-only migration runs and reverts through the DataSource API (meta_migrations)', async () => {
    const name = TestMigrationProbe1790000000000.name
    const mds = await new DataSource({
      ...dataSourceOptions(),
      migrations: [TestMigrationProbe1790000000000],
    }).initialize()
    const tracked = async () =>
      (await mds.query('SELECT COUNT(*) AS n FROM meta_migrations WHERE name = ?', [name]))[0].n
    try {
      expect(await mds.showMigrations()).toBe(true)
      const ran = await mds.runMigrations({ transaction: 'each' })
      expect(ran.map((m) => m.name)).toEqual([name])
      expect((await readTableInfo(mds, 'test_migration_probe'))?.comment).toBe(
        'Test fixture: migration probe',
      )
      expect(await tracked()).toBe(1)
      expect(await mds.showMigrations()).toBe(false)
      await mds.undoLastMigration({ transaction: 'each' })
      expect(await readTableInfo(mds, 'test_migration_probe')).toBeNull()
      expect(await tracked()).toBe(0)
    } finally {
      await mds.query('DROP TABLE IF EXISTS test_migration_probe')
      await mds.query('DELETE FROM meta_migrations WHERE name = ?', [name])
      await mds.destroy()
    }
  })

  // `pnpm -r build` runs before the tests in ci:local; a bare `test` run without dist skips this
  it('compiled dist/db/migrate.js runs (show)', ({ skip }) => {
    skip(!existsSync('dist/db/migrate.js'), 'no dist: pnpm --filter @qiwu/server build first')
    const r = spawnSync(process.execPath, ['dist/db/migrate.js', 'show'], { encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })
})

it('d) soft delete + unique(title, alive): deleted duplicates allowed, live duplicate rejected', async () => {
  expect(ds.getMetadata(ScopedNote).columns.map((c) => c.databaseName)).not.toContain('alive')
  for (let i = 0; i < 2; i++)
    await notes.softDelete((await notes.save(notes.create({ title: 'dup' }))).id)
  await notes.save(notes.create({ title: 'dup' }))
  const err = await notes.save(notes.create({ title: 'dup' })).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(QueryFailedError)
  expect((err as QueryFailedError & { driverError: { code: string } }).driverError.code).toBe(
    'ER_DUP_ENTRY',
  )
  expect(await notes.countBy({ title: 'dup' })).toBe(1)
  expect(await notes.count({ where: { title: 'dup' }, withDeleted: true })).toBe(3)
})

it('e) AuditSubscriber fills created_by/updated_by from the CLS principal', async () => {
  const { id } = await as(user(7), () => notes.save(notes.create({ title: 'audit' })))
  expect(await notes.findOneByOrFail({ id })).toMatchObject({ createdBy: 7, updatedBy: 7 })
  await as(user(8), () => notes.update(id, { title: 'audit-qb' }))
  expect(await notes.findOneByOrFail({ id })).toMatchObject({ createdBy: 7, updatedBy: 8 })
  await as(user(9), async () => {
    const note = await notes.findOneByOrFail({ id })
    note.title = 'audit-save'
    await notes.save(note)
  })
  expect(await notes.findOneByOrFail({ id })).toMatchObject({ createdBy: 7, updatedBy: 9 })
  // forged audit values from a client payload never survive
  const forged = await as(user(10), () =>
    notes.save(notes.create({ title: 'forged', createdBy: 999, updatedBy: 999 })),
  )
  expect(await notes.findOneByOrFail({ id: forged.id })).toMatchObject({
    createdBy: 10,
    updatedBy: 10,
  })
  await as(user(11), async () => {
    const note = await notes.findOneByOrFail({ id: forged.id })
    note.createdBy = 999
    await notes.save(note)
  })
  await as(user(12), () => notes.update(forged.id, { createdBy: 999, title: 'forged-qb' }))
  expect(await notes.findOneByOrFail({ id: forged.id })).toMatchObject({
    createdBy: 10,
    updatedBy: 12,
  })
  const anon = await notes.save(notes.create({ title: 'no-principal' }))
  expect(await notes.findOneByOrFail({ id: anon.id })).toMatchObject({
    createdBy: null,
    updatedBy: null,
  })
})

it('g) @Transactional() rolls back when the method throws', async () => {
  await expect(as(user(7), () => svc.createThenFail('tx-probe'))).rejects.toThrow(
    'rows seen inside the transaction: 1',
  )
  expect(await notes.countBy({ title: 'tx-probe' })).toBe(0)
})

it('h) information_schema: table + column comments, parameterized name, current schema only', async () => {
  const info = await readTableInfo(ds, 'test_scoped_note')
  expect(info?.comment).toBe('Test fixture: data-scoped note')
  expect(info?.columns.map((c) => c.name)).toEqual([
    'id',
    'title',
    'dept_id',
    'created_by',
    'created_at',
    'updated_by',
    'updated_at',
    'deleted_at',
    'alive',
  ])
  expect(info?.columns[2]).toEqual({
    name: 'dept_id',
    columnType: 'bigint unsigned',
    nullable: true,
    comment: 'Owning dept',
    default: null,
    isPk: false,
    autoIncrement: false,
    generated: false,
    unique: false,
  })
  expect(info?.columns[0]).toMatchObject({ isPk: true, autoIncrement: true, generated: false })
  expect(info?.columns.at(-1)).toMatchObject({ name: 'alive', generated: true })
  expect(await readTableInfo(ds, "test_scoped_note' OR '1'='1")).toBeNull()
  expect(await readTableInfo(ds, 'user')).toBeNull() // mysql.user exists, but not in DATABASE()
  await ds.query('CREATE OR REPLACE VIEW test_scoped_note_v AS SELECT id FROM test_scoped_note')
  try {
    expect(await readTableInfo(ds, 'test_scoped_note_v')).toBeNull() // base tables only
  } finally {
    await ds.query('DROP VIEW test_scoped_note_v')
  }
})

it('AppModule: CoreDbModule DataSource (UTC session, migrations from paths.ts) + TransactionHost', async () => {
  const ref = await Test.createTestingModule({ imports: [AppModule] }).compile()
  try {
    const appDs = ref.get<DataSource>(getDataSourceToken())
    expect(migrationsGlob()).toBe(join(process.cwd(), 'dist/db/migrations/*.js'))
    expect(appDs.options).toMatchObject({
      migrations: [migrationsGlob()],
      migrationsTableName: 'meta_migrations',
    })
    const [session] = await appDs.query('SELECT @@session.time_zone AS tz')
    expect(session.tz).toBe('+00:00')
    const tx = ref.get<TransactionHost<TransactionalAdapterTypeOrm>>(TransactionHost)
    expect(
      await ref.get(ClsService).run(() => tx.withTransaction(async () => tx.isTransactionActive())),
    ).toBe(true)
  } finally {
    await ref.close()
  }
})

it('assertUnique: 409 DUPLICATE for a live duplicate; soft-deleted rows and excludeId do not count', async () => {
  const kept = await notes.save(notes.create({ title: 'u1' }))
  await notes.softDelete((await notes.save(notes.create({ title: 'u2' }))).id)
  await as(user(1), async () => {
    const err = await svc.assertUnique('title', 'u1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BizError)
    expect(err).toMatchObject({ err: Err.DUPLICATE, params: { title: 'u1' } })
    // same collation as the unique index: case-insensitive
    await expect(svc.assertUnique('title', 'U1')).rejects.toThrow(BizError)
    await expect(svc.assertUnique('title', 'u1', kept.id)).resolves.toBeUndefined()
    await expect(svc.assertUnique('title', 'u2')).resolves.toBeUndefined()
    await expect(svc.assertUnique('title', 'u1', undefined, Err.CONFLICT)).rejects.toMatchObject({
      err: Err.CONFLICT,
    })
  })
})

describe('soft delete: remove, the reference registry, link helpers', () => {
  const LINK: LinkTable = { table: 'test_note_link', owner: 'note_id', target: 'target_id' }
  const note = async (title: string) => (await notes.save(notes.create({ title }))).id
  const state = async (id: number) =>
    (
      await ds.query(
        'SELECT deleted_at IS NOT NULL AS gone, updated_by FROM test_scoped_note WHERE id = ?',
        [id],
      )
    )[0]
  /** note_id → target_id of the live links (all: soft-deleted ones too, marked `-`). */
  const links = async (all = false) =>
    (
      await ds.query(
        `SELECT note_id, target_id, deleted_at IS NOT NULL AS gone FROM test_note_link
          ${all ? '' : 'WHERE deleted_at IS NULL'} ORDER BY note_id, target_id`,
      )
    ).map(
      (l: { note_id: number; target_id: number; gone: number }) =>
        `${l.gone ? '-' : ''}${l.note_id}>${l.target_id}`,
    )
  const tx = <T>(fn: (q: EntityManager) => Promise<T>) => ds.transaction(fn)
  /** Sees every note (data scope `all`). */
  const admin = (userId: number): Principal => ({
    ...user(userId),
    roles: [{ code: 'all', dataScope: 'all', perms: [] }],
  })

  it('remove: soft (deleted_at + updated_by = the caller), reads leave the row out, its unique value is free again', async () => {
    const id = await note('soft')
    await as(admin(7), () => svc.remove([id]))
    expect(await state(id)).toEqual({ gone: 1, updated_by: 7 })
    expect(await notes.findOneBy({ id })).toBeNull()
    await expect(as(admin(7), () => svc.get(id))).rejects.toThrow(NotFoundException)
    await note('soft')
    expect(await notes.count({ where: { title: 'soft' }, withDeleted: true })).toBe(2)
  })

  it('restrict: a live referencing row → 409 in_use, nothing deleted; a soft-deleted one does not count', async () => {
    const [a, b] = [await note('a'), await note('b')]
    await tx((q) => addLinks(q, LINK, a, [b]))
    const err = await as(admin(1), () => svc.remove([b])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BizError)
    expect(err).toMatchObject({ err: Err.IN_USE })
    expect(await state(b)).toMatchObject({ gone: 0 })
    await tx((q) => removeLinks(q, LINK, a, [b]))
    await as(admin(1), () => svc.remove([b]))
    expect(await state(b)).toMatchObject({ gone: 1 })
  })

  it('cascade: the referencing rows are soft-deleted with their parent; a refused delete cascades nothing', async () => {
    const [a, b, c] = [await note('a'), await note('b'), await note('c')]
    await tx((q) => addLinks(q, LINK, a, [b, c]))
    await tx((q) => addLinks(q, LINK, c, [b]))
    await as(admin(1), () => svc.remove([a]))
    expect(await links(true)).toEqual([`-${a}>${b}`, `-${a}>${c}`, `${c}>${b}`])
    // d is linked to by e: refused before its own links are touched
    const [d, e] = [await note('d'), await note('e')]
    await tx((q) => addLinks(q, LINK, d, [b]))
    await tx((q) => addLinks(q, LINK, e, [d]))
    await expect(as(admin(1), () => svc.remove([d]))).rejects.toMatchObject({ err: Err.IN_USE })
    expect(await links()).toEqual([`${c}>${b}`, `${d}>${b}`, `${e}>${d}`])
    expect(await state(d)).toMatchObject({ gone: 0 })
  })

  it('a table referencing itself: rows deleted in the same call do not count', async () => {
    await ds.query(
      "INSERT INTO test_dept (id, parent_id, tree_path, name) VALUES (1, 0, '/1/', 'hq'), (2, 1, '/1/2/', 'rd')",
    )
    await expect(tx((q) => softDeleteRows(q, 'test_dept', [1]))).rejects.toMatchObject({
      err: Err.IN_USE,
    })
    await tx((q) => softDeleteRows(q, 'test_dept', [1, 2]))
    expect(await ds.query('SELECT id FROM test_dept WHERE deleted_at IS NULL')).toEqual([])
  })

  it('cascade into a referenced table: its own restrict references refuse the whole delete (409, nothing deleted), its own cascades follow (two levels)', async () => {
    await ds.query(
      "INSERT INTO test_dept (id, parent_id, tree_path, name) VALUES (1, 0, '/1/', 'hq')",
    )
    const a = (await notes.save(notes.create({ title: 'a', deptId: 1 }))).id
    const [b, c] = [await note('b'), await note('c')]
    await tx((q) => addLinks(q, LINK, b, [a])) // a is in use
    await tx((q) => addLinks(q, LINK, a, [c])) // a's own link
    await expect(tx((q) => softDeleteRows(q, 'test_dept', [1]))).rejects.toMatchObject({
      err: Err.IN_USE,
    })
    expect(await ds.query('SELECT id FROM test_dept WHERE deleted_at IS NULL')).toEqual([{ id: 1 }])
    expect(await state(a)).toMatchObject({ gone: 0 })
    expect(await links()).toEqual([`${a}>${c}`, `${b}>${a}`])
    await tx((q) => removeLinks(q, LINK, b, [a]))
    await tx((q) => softDeleteRows(q, 'test_dept', [1]))
    expect(await state(a)).toMatchObject({ gone: 1 })
    expect(await links(true)).toEqual([`-${a}>${c}`, `-${b}>${a}`])
  })

  it('write side: create / update naming a missing or deleted referenced row → 404, nothing written; live, null and unchanged values pass', async () => {
    await ds.query(
      "INSERT INTO test_dept (id, parent_id, tree_path, name, deleted_at) VALUES (1, 0, '/1/', 'hq', NULL), (2, 0, '/2/', 'gone', NOW(3))",
    )
    const create = (title: string, deptId: number | null) =>
      as(admin(1), () => svc.create({ title, deptId }))
    await expect(create('deleted', 2)).rejects.toThrow(NotFoundException)
    await expect(create('missing', 99)).rejects.toThrow(NotFoundException)
    expect(await notes.count({ withDeleted: true })).toBe(0)
    const { id } = await create('kept', 1)
    await create('none', null)
    await expect(as(admin(1), () => svc.update(id, { deptId: 2 }))).rejects.toThrow(
      NotFoundException,
    )
    expect(await notes.findOneBy({ id })).toMatchObject({ deptId: 1 })
    // a value the row already holds is not judged again (nor locked: see the race below)
    await ds.query('UPDATE test_dept SET deleted_at = NOW(3) WHERE id = 1')
    await as(admin(1), () => svc.update(id, { deptId: 1, title: 'renamed' }))
    expect(await notes.findOneBy({ id })).toMatchObject({ title: 'renamed', deptId: 1 })
  })

  it('write side of a tree (BaseTreeService): a parent that is gone → 404, top level (0) is no reference', async () => {
    class DeptTree extends BaseTreeService<TestDept> {}
    const tree = new DeptTree(moduleRef.get(TransactionHost), TestDept)
    // TestDept maps no deleted_at: the tree's own parent lookup still sees a deleted parent
    await ds.query(
      "INSERT INTO test_dept (id, parent_id, tree_path, name, deleted_at) VALUES (1, 0, '/1/', 'hq', NULL), (2, 0, '/2/', 'gone', NOW(3))",
    )
    await expect(as(admin(1), () => tree.create({ name: 'x', parentId: 2 }))).rejects.toThrow(
      NotFoundException,
    )
    const { id } = await as(admin(1), () => tree.create({ name: 'top', parentId: 0 }))
    await expect(as(admin(1), () => tree.update(id, { parentId: 2 }))).rejects.toThrow(
      NotFoundException,
    )
    await as(admin(1), () => tree.update(id, { parentId: 1 }))
    expect(await ds.query('SELECT name FROM test_dept WHERE parent_id = 1')).toEqual([
      { name: 'top' },
    ])
  })

  it("a write racing its parent's delete waits for the delete's lock, then finds the parent gone: no orphan", async () => {
    await ds.query(
      "INSERT INTO test_dept (id, parent_id, tree_path, name) VALUES (1, 0, '/1/', 'hq')",
    )
    const deleting = ds.createQueryRunner()
    await deleting.startTransaction()
    try {
      // what a dept delete does: lock the row (lockScopedIds), then softDeleteRows; not committed yet
      await deleting.query('SELECT id FROM test_dept WHERE id = 1 FOR UPDATE')
      await softDeleteRows(deleting.manager, 'test_dept', [1])
      const write = as(admin(1), () => svc.create({ title: 'late', deptId: 1 })).catch(
        (e: unknown) => e,
      )
      await new Promise((r) => setTimeout(r, 300)) // the create reads the dept meanwhile, and waits
      await deleting.commitTransaction()
      expect(await write).toBeInstanceOf(NotFoundException)
    } finally {
      await deleting.release()
    }
    expect(await notes.count({ withDeleted: true })).toBe(0)
  })

  it('the registry stands in for every dropped foreign key (RESTRICT → restrict, CASCADE → cascade) and the iam links and OAuth2 consents that go with their user, role or client', () => {
    // registered where the referencing column lives, loaded with AppModule (imported above)
    const of = (parent: string) =>
      referencesTo(parent).map((r) => `${r.table}.${r.column}${r.cascade ? ' cascade' : ''}`)
    expect(
      Object.fromEntries(
        [
          'iam_position',
          'iam_user',
          'iam_role',
          'iam_dept',
          'fs_storage',
          'cg_table',
          'msg_bulletin',
          'msg_mail_account',
          'msg_sms_channel',
          'demo_invoice',
          'oauth_client',
        ].map((t) => [t, of(t)]),
      ),
    ).toEqual({
      iam_position: ['iam_user_positions.position_id'],
      iam_user: [
        'iam_user_pref.user_id cascade',
        'iam_user_roles.user_id cascade',
        'iam_user_positions.user_id cascade',
        'iam_user_social.user_id cascade',
        'oauth_consent.user_id cascade',
      ],
      iam_role: ['iam_role_menus.role_id cascade', 'iam_role_depts.role_id cascade'],
      iam_dept: ['demo_book.dept_id'],
      fs_storage: ['fs_object.storage_id'],
      cg_table: ['cg_table.master_table_id', 'cg_column.table_id cascade'],
      msg_bulletin: ['msg_bulletin_receipt.bulletin_id cascade'],
      msg_mail_account: ['msg_mail_template.account_id'],
      msg_sms_channel: ['msg_sms_template.channel_id'],
      demo_invoice: ['demo_invoice_line.invoice_id cascade'],
      oauth_client: ['oauth_consent.client_id cascade'],
    })
  })

  it('links: replace soft-deletes the removed, revives the deleted, inserts the new; add revives unless revive: false', async () => {
    const [a, b, c, d] = [await note('a'), await note('b'), await note('c'), await note('d')]
    await tx((q) => replaceLinks(q, LINK, a, [b, c]))
    expect(await links(true)).toEqual([`${a}>${b}`, `${a}>${c}`])
    await tx((q) => replaceLinks(q, LINK, a, [c, d]))
    expect(await links(true)).toEqual([`-${a}>${b}`, `${a}>${c}`, `${a}>${d}`])
    await tx((q) => replaceLinks(q, LINK, a, [b, d]))
    expect(await links(true)).toEqual([`${a}>${b}`, `-${a}>${c}`, `${a}>${d}`])
    await tx((q) => addLinks(q, LINK, a, [c], { revive: false }))
    expect(await links()).toEqual([`${a}>${b}`, `${a}>${d}`])
    await tx((q) => addLinks(q, LINK, a, [c]))
    expect(await links()).toEqual([`${a}>${b}`, `${a}>${c}`, `${a}>${d}`])
    await tx((q) => replaceLinks(q, LINK, a, []))
    expect(await links()).toEqual([])
    expect(await links(true)).toHaveLength(3) // one row per link, for good
  })
})

describe('paginate: shared pageQuery → LIMIT/OFFSET + whitelisted ORDER BY', () => {
  const NoteQuery = pageQuery(['title', 'dept', 'id'])
  const titles = (q: Record<string, string>, columns?: { dept: string }) =>
    paginate(notes.createQueryBuilder('n'), NoteQuery.parse(q), columns).then((p) => ({
      total: p.total,
      titles: p.items.map((n) => n.title),
    }))

  beforeEach(async () => {
    for (const [title, deptId] of [
      ['t1', 3],
      ['t2', 1],
      ['t3', 5],
      ['t4', 2],
      ['t5', 4],
    ] as const)
      await notes.save(notes.create({ title, deptId }))
  })

  it('pages by page/pageSize and reports the total', async () => {
    expect(await titles({ page: '2', pageSize: '2', sort: '-title' })).toEqual({
      total: 5,
      titles: ['t3', 't2'],
    })
    expect(await titles({ page: '9' })).toEqual({ total: 5, titles: [] })
    expect((await titles({ sort: 'id' })).titles).toEqual(['t1', 't2', 't3', 't4', 't5'])
  })

  it('defaults to id DESC; id DESC also breaks ties after the requested order', async () => {
    expect((await titles({})).titles).toEqual(['t5', 't4', 't3', 't2', 't1'])
    await notes.update({ title: 't2' }, { deptId: 3 }) // t1 and t2 now share dept 3
    // dept ASC via the columns map (1 is gone), ties (dept 3) by id DESC
    expect((await titles({ sort: 'dept' }, { dept: 'n.deptId' })).titles).toEqual([
      't4',
      't2',
      't1',
      't5',
      't3',
    ])
  })
})

it('exportRows: the scoped, filtered, sorted query in batches of EXPORT_BATCH, never the whole table', async () => {
  const n = 2 * EXPORT_BATCH + 5
  await notes.insert([
    ...Array.from({ length: n }, (_, i) => ({ title: `e${i}`, deptId: 1 })),
    ...Array.from({ length: 10 }, (_, i) => ({ title: `out${i}`, deptId: 2 })),
  ])
  const picker: Principal = {
    ...user(1),
    roles: [{ code: 'p', dataScope: 'picked_depts', deptIds: [1], perms: ['n.export'] }],
    perms: ['n.export'],
  }
  const batches = await as(
    picker,
    async () => {
      const out: ScopedNote[][] = []
      for await (const batch of svc.exportRows(pageQuery(['id']).parse({ sort: 'id' })))
        out.push(batch)
      return out
    },
    'n.export',
  )
  expect(batches.map((b) => b.length)).toEqual([EXPORT_BATCH, EXPORT_BATCH, 5])
  const rows = batches.flat()
  expect(rows.every((r) => Number(r.deptId) === 1)).toBe(true) // the scope holds in every batch
  const ids = rows.map((r) => r.id)
  expect(ids).toEqual(ids.toSorted((a, b) => a - b))
  expect(new Set(ids).size).toBe(n)
})

// An export of a table that grows meanwhile (the action log writing the export's own line) neither
// repeats nor skips a row at a batch boundary — keyset batches on the default id order, a ceiling on the id
// (the highest before the first batch) under any other sort
it.each([
  ['the default order (id DESC, keyset)', {}],
  ['id ascending (keyset)', { sort: 'id' }],
  ['title descending (offset under the ceiling)', { sort: '-title' }],
  ['title ascending (offset under the ceiling)', { sort: 'title' }],
])('exportRows: rows written between batches never shift one, %s', async (_, sort) => {
  const n = EXPORT_BATCH + 5
  const inserted = await notes.insert(
    Array.from({ length: n }, (_, i) => ({ title: `m${String(i).padStart(5, '0')}`, deptId: 1 })),
  )
  const before = inserted.identifiers.map((r) => Number(r.id)).sort((a, b) => a - b)
  const picker: Principal = {
    ...user(1),
    roles: [{ code: 'p', dataScope: 'picked_depts', deptIds: [1], perms: ['n.export'] }],
    perms: ['n.export'],
  }
  const ids = await as(
    picker,
    async () => {
      const out: number[] = []
      for await (const batch of svc.exportRows(pageQuery(['id', 'title']).parse(sort))) {
        out.push(...batch.map((r) => Number(r.id)))
        // after each batch: rows that sort first either way ('a…' ascending, 'z…' descending, newest ids)
        if (out.length <= EXPORT_BATCH)
          await notes.insert(['a0', 'a1', 'z0', 'z1'].map((title) => ({ title, deptId: 1 })))
      }
      return out
    },
    'n.export',
  )
  expect(new Set(ids).size).toBe(ids.length) // nothing twice
  expect(ids.filter((id) => id <= before.at(-1)!).sort((a, b) => a - b)).toEqual(before) // nothing skipped
  // rows written meanwhile stay out, but at the end of an ascending id export (after every row before them)
  expect(ids.length).toBe('sort' in sort && sort.sort === 'id' ? n + 4 : n)
})
