// The ORM tenant condition (core/db/tenant-filter.ts, core/db/tenant.subscriber.ts) against the test
// database: the default tenant and a second one hold look-alike rows in the scoped-note fixture tables, and
// every TypeORM path reads, counts and writes the current tenant's rows only. Some rows of one tenant point
// at rows of the other (data that crosses tenants must still not bring the other tenant's rows back).
import { NotFoundException } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { TransactionHost } from '@nestjs-cls/transactional'
import { ClsService } from 'nestjs-cls'
import { DataSource, Entity, type ObjectLiteral, PrimaryColumn, type UpdateEvent } from 'typeorm'
import type { Principal } from '../../src/core/auth/principal.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import {
  allTenants,
  DEFAULT_TENANT_ID,
  TenantContextMissing,
  withTenant,
} from '../../src/core/context/tenant.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import {
  isTenantColumn,
  refreshTenantTables,
  tenantTablesOf,
} from '../../src/core/db/tenant-filter.js'
import { PLATFORM_TABLES } from '../../src/core/db/tenant-tables.js'
import { TenantSubscriber } from '../../src/core/db/tenant.subscriber.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { dataSourceOptions } from '../../src/db/data-source.js'
import { ScopedNote } from '../fixtures/scoped-note/scoped-note.entity.js'
import { ScopedNoteFixtureModule } from '../fixtures/scoped-note/scoped-note.module.js'
import { ScopedNoteService } from '../fixtures/scoped-note/scoped-note.service.js'
import {
  createScopedNoteTables,
  dropScopedNoteTables,
  truncateScopedNoteTables,
} from '../fixtures/scoped-note/setup.js'
import { TestDept } from '../fixtures/scoped-note/test-dept.entity.js'
import { createTenant, type TestTenant } from '../setup/tenants.js'

/**
 * An entity of a tenant table that maps no `tenant_id` (as generated entities did before the generator
 * wrote `@TenantColumn()`): the table list alone makes it filtered. Kept out of the `*.entity.ts` files,
 * so the coverage check below does not count it.
 */
@Entity('test_note_link')
class NoteLink {
  @PrimaryColumn({ name: 'note_id', type: 'bigint', unsigned: true })
  noteId: number

  @PrimaryColumn({ name: 'target_id', type: 'bigint', unsigned: true })
  targetId: number
}

let moduleRef: TestingModule
let ds: DataSource
let cls: ClsService
let svc: ScopedNoteService
let txHost: TransactionHost
let B: TestTenant
let fixturesExisted = false

const A = DEFAULT_TENANT_ID
const notes = () => ds.getRepository(ScopedNote)
const depts = () => ds.getRepository(TestDept)
const inA = <T>(fn: () => T): T => withTenant(A, fn)
const inB = <T>(fn: () => T): T => withTenant(B.id, fn)

/** Raw rows, no ORM and so no tenant condition: what is really stored. */
const stored = (sql: string, params: unknown[] = []) => ds.query<ObjectLiteral[]>(sql, params)
const titlesOf = (rows: { title: string }[]) => rows.map((r) => r.title).sort()

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreDbModule, ScopedNoteFixtureModule],
  }).compile()
  await moduleRef.init()
  ds = moduleRef.get(getDataSourceToken())
  cls = moduleRef.get(ClsService)
  svc = moduleRef.get(ScopedNoteService)
  txHost = moduleRef.get(TransactionHost)
  fixturesExisted = (await ds.query("SHOW TABLES LIKE 'test_scoped_note'")).length > 0
  await createScopedNoteTables(ds)
  B = await createTenant(ds)
})

afterAll(async () => {
  if (!ds?.isInitialized) return
  await B?.dispose()
  if (!fixturesExisted) await dropScopedNoteTables(ds)
  await moduleRef.close()
})

/** Ids of the rows every case starts from. */
let id: { dA: number; dB: number; nA: number; nA2: number; nAx: number; nB: number; nB2: number }

beforeEach(async () => {
  await truncateScopedNoteTables(ds)
  const dept = (name: string) => depts().save(depts().create({ parentId: 0, treePath: '/', name }))
  const note = (title: string, deptId: number | null) =>
    notes().save(notes().create({ title, deptId }))
  const dA = await inA(() => dept('hq'))
  const dB = await inB(() => dept('hq'))
  const nA = await inA(() => note('same', dA.id))
  const nA2 = await inA(() => note('a-only', null))
  // a row of A naming B's dept
  const nAx = await inA(() => note('cross', dB.id))
  const nB = await inB(() => note('same', dB.id))
  const nB2 = await inB(() => note('b-only', dB.id))
  // links: one of A, one of B, and one of B naming A's note nA2
  await ds.query(
    'INSERT INTO test_note_link (note_id, target_id, tenant_id) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
    [nA.id, nA2.id, A, nB.id, nB2.id, B.id, nA2.id, nB2.id, B.id],
  )
  // TestDept keys come back as strings here
  id = {
    dA: Number(dA.id),
    dB: Number(dB.id),
    nA: nA.id,
    nA2: nA2.id,
    nAx: nAx.id,
    nB: nB.id,
    nB2: nB2.id,
  }
})

describe('reads see the current tenant only', () => {
  it('find, findOne, count, exists', async () => {
    expect(titlesOf(await inA(() => notes().find()))).toEqual(['a-only', 'cross', 'same'])
    expect(titlesOf(await inB(() => notes().find()))).toEqual(['b-only', 'same'])
    expect(await inA(() => notes().findOneBy({ id: id.nB }))).toBeNull()
    expect((await inB(() => notes().findOneByOrFail({ id: id.nB }))).tenantId).toBe(B.id)
    expect(await inA(() => notes().count())).toBe(3)
    expect(await inA(() => notes().exists({ where: { title: 'b-only' } }))).toBe(false)
    expect(await inA(() => notes().exists({ where: { title: 'same' } }))).toBe(true)
  })

  it('getMany and a joined, paged getManyAndCount', async () => {
    const same = await inA(() =>
      notes().createQueryBuilder('n').where('n.title = :t', { t: 'same' }).getMany(),
    )
    expect(same.map((n) => n.id)).toEqual([id.nA])
    const [page, total] = await inA(() =>
      notes()
        .createQueryBuilder('n')
        .leftJoinAndSelect('n.dept', 'd')
        .orderBy('n.id', 'DESC')
        .skip(0)
        .take(2)
        .getManyAndCount(),
    )
    expect(total).toBe(3)
    expect(page.map((n) => n.id)).toEqual([id.nAx, id.nA2])
    // nAx names B's dept: the join leaves it out
    expect(page[0].dept).toBeNull()
  })

  it('a subquery is filtered on its own', async () => {
    // A's notes without a link of their own: B's link naming nA2 must not count
    const rows = await inA(() =>
      notes()
        .createQueryBuilder('n')
        .where((qb) => {
          const sub = qb.subQuery().select('l.note_id').from('test_note_link', 'l').getQuery()
          return `n.id NOT IN ${sub}`
        })
        .getMany(),
    )
    expect(titlesOf(rows)).toEqual(['a-only', 'cross'])
  })

  it('relations: a row naming another tenant’s row gets none', async () => {
    const cross = await inA(() =>
      notes().findOneOrFail({ where: { id: id.nAx }, relations: { dept: true } }),
    )
    expect(cross.dept).toBeNull()
    const own = await inA(() =>
      notes().findOneOrFail({ where: { id: id.nA }, relations: { dept: true } }),
    )
    expect(Number(own.dept?.id)).toBe(id.dA)
  })

  it('a join by name of a table without an entity', async () => {
    const rows = await inA(() =>
      notes()
        .createQueryBuilder('n')
        .leftJoin('test_note_link', 'l', 'l.note_id = n.id')
        .select(['n.id AS id', 'l.tenant_id AS lt'])
        .where('n.id = :id', { id: id.nA2 })
        .getRawMany(),
    )
    expect(rows).toEqual([{ id: id.nA2, lt: null }])
  })

  it('a platform table joined to a tenant table', async () => {
    const rows = await inA(() =>
      ds
        .createQueryBuilder()
        .select('n.title', 'title')
        .from('iam_tenant', 't')
        .innerJoin('test_scoped_note', 'n', 'n.tenant_id = t.id')
        .where('t.id IN (:...ids)', { ids: [A, B.id] })
        .getRawMany<{ title: string }>(),
    )
    expect(titlesOf(rows)).toEqual(['a-only', 'cross', 'same'])
  })

  it('a join by name whose condition has a top-level OR', async () => {
    const rows = await inA(() =>
      notes()
        .createQueryBuilder('n')
        .innerJoin('test_note_link', 'l', 'l.note_id = n.id OR l.target_id = :none', { none: 0 })
        .select(['n.id AS id', 'l.tenant_id AS lt'])
        .getRawMany(),
    )
    expect(rows).toEqual([{ id: id.nA, lt: A }])
  })

  it('a relation join whose extra condition has an OR', async () => {
    const cross = await inA(() =>
      notes()
        .createQueryBuilder('n')
        .leftJoinAndSelect('n.dept', 'd', 'd.name = :hq OR d.name = :none', {
          hq: 'hq',
          none: 'none',
        })
        .where('n.id = :id', { id: id.nAx })
        .getOneOrFail(),
    )
    expect(cross.dept).toBeNull()
  })

  it('a WHERE with a top-level OR', async () => {
    const rows = await inA(() =>
      notes()
        .createQueryBuilder('n')
        .where('n.title = :x OR n.title = :y', { x: 'same', y: 'b-only' })
        .getMany(),
    )
    expect(rows.map((n) => n.id)).toEqual([id.nA])
  })

  it('every table of the FROM list', async () => {
    // B's link names A's note nA2: unfiltered, it would bring nA2 back
    const rows = await inA(() =>
      ds
        .createQueryBuilder()
        .select('n.id', 'id')
        .from(ScopedNote, 'n')
        .addFrom('test_note_link', 'l')
        .where('l.note_id = n.id')
        .getRawMany<{ id: number }>(),
    )
    expect(rows.map((r) => r.id)).toEqual([id.nA])
  })

  it('the tenant is the one where the query runs, not where it was built', async () => {
    const qb = notes()
      .createQueryBuilder('n')
      .innerJoin('test_note_link', 'l', 'l.note_id = n.id')
      .select('n.id', 'id')
    expect((await inA(() => qb.getRawMany())).map((r) => r.id)).toEqual([id.nA])
    expect((await inB(() => qb.getRawMany())).map((r) => r.id)).toEqual([id.nB])
  })

  it('a condition TypeORM appends itself (paging by a composite key) is bracketed', async () => {
    const qb = notes().createQueryBuilder('n')
    // what TypeORM writes into this field for a composite key: `a AND b OR c AND d`, unbracketed
    qb.expressionMap.extraAppendedAndWhereCondition = `n.title = 'same' OR n.title = 'b-only'`
    expect((await inA(() => qb.getMany())).map((n) => n.id)).toEqual([id.nA])
    // and the field is left as it was
    expect(qb.expressionMap.extraAppendedAndWhereCondition).toBe(
      `n.title = 'same' OR n.title = 'b-only'`,
    )
  })

  it('an entity that maps no tenant_id, by the table list', async () => {
    // a DataSource of its own: beside the fixtures, it would turn their joins by name into entity joins
    const linkDs = await new DataSource({
      ...dataSourceOptions(),
      entities: [NoteLink],
    }).initialize()
    try {
      const qb = () => linkDs.getRepository(NoteLink).createQueryBuilder('l')
      expect(inA(() => qb().getQuery()).replaceAll('`', '')).toContain(`l.tenant_id = ${A}`)
      expect((await inA(() => qb().getMany())).map((l) => Number(l.noteId))).toEqual([id.nA])
    } finally {
      await linkDs.destroy()
    }
  })

  it('a table created after the DataSource started: by its entity, by name once re-read', async () => {
    expect(tenantTablesOf(ds)).toContain('test_note_link')
    // the entity alone is enough: left out of the list, the fixture table is still filtered
    tenantTablesOf(ds)?.delete('test_scoped_note')
    try {
      expect(inA(() => notes().createQueryBuilder('n').getQuery()).replaceAll('`', '')).toContain(
        `n.tenant_id = ${A}`,
      )
    } finally {
      await refreshTenantTables(ds)
    }
    await ds.query(`CREATE TABLE IF NOT EXISTS test_tenant_probe (
      id bigint unsigned NOT NULL AUTO_INCREMENT, tenant_id bigint unsigned NOT NULL DEFAULT 1,
      PRIMARY KEY (id)) ENGINE=InnoDB COMMENT='Test fixture: tenant filter probe'`)
    try {
      const sql = () =>
        inA(() => ds.createQueryBuilder().select('1').from('test_tenant_probe', 'p').getQuery())
      expect(sql()).not.toContain('tenant_id')
      await refreshTenantTables(ds)
      expect(sql()).toContain(`p.tenant_id = ${A}`)
    } finally {
      await ds.query('DROP TABLE IF EXISTS test_tenant_probe')
      await refreshTenantTables(ds)
    }
  })
})

describe('writes touch the current tenant only', () => {
  const live = async (tid: number) =>
    titlesOf(
      (await stored(
        'SELECT title FROM test_scoped_note WHERE tenant_id = ? AND deleted_at IS NULL',
        [tid],
      )) as { title: string }[],
    )

  it('repository update by criteria, and by another tenant’s id', async () => {
    await inA(() => notes().update({ title: 'same' }, { title: 'renamed' }))
    expect(await live(A)).toEqual(['a-only', 'cross', 'renamed'])
    expect(await live(B.id)).toEqual(['b-only', 'same'])
    const res = await inA(() => notes().update(id.nB, { title: 'taken' }))
    expect(res.affected).toBe(0)
    expect(await live(B.id)).toEqual(['b-only', 'same'])
  })

  it('QueryBuilder update, delete and soft delete without WHERE', async () => {
    await inA(() => ds.createQueryBuilder().update(ScopedNote).set({ deptId: null }).execute())
    const deptOf = async (tid: number) =>
      (await stored('SELECT dept_id FROM test_scoped_note WHERE tenant_id = ?', [tid])).map(
        (r) => r.dept_id,
      )
    expect(await deptOf(A)).toEqual([null, null, null])
    expect(await deptOf(B.id)).toEqual([id.dB, id.dB])

    await inA(() => ds.createQueryBuilder().softDelete().from(ScopedNote).execute())
    expect(await live(A)).toEqual([])
    expect(await live(B.id)).toEqual(['b-only', 'same'])

    await inA(() => ds.createQueryBuilder().delete().from(ScopedNote).execute())
    await inA(() => ds.createQueryBuilder().delete().from('test_note_link').execute())
    expect(await stored('SELECT id FROM test_scoped_note WHERE tenant_id = ?', [A])).toEqual([])
    expect(
      await stored('SELECT id FROM test_scoped_note WHERE tenant_id = ?', [B.id]),
    ).toHaveLength(2)
    expect(await stored('SELECT note_id FROM test_note_link WHERE tenant_id = ?', [A])).toEqual([])
    expect(
      await stored('SELECT note_id FROM test_note_link WHERE tenant_id = ?', [B.id]),
    ).toHaveLength(2)
  })

  it('an empty criteria object is still refused by TypeORM', async () => {
    await expect(inA(() => notes().update({}, { title: 'all' }))).rejects.toThrow(/Empty criteria/)
    await expect(inA(() => notes().delete({}))).rejects.toThrow(/Empty criteria/)
    expect(await live(A)).toEqual(['a-only', 'cross', 'same'])
  })

  it('an insert takes the context’s tenant, whatever the entity carried', async () => {
    const saved = await inA(() => notes().save(notes().create({ title: 'forged', tenantId: B.id })))
    expect(saved.tenantId).toBe(A)
    await inA(() =>
      ds
        .createQueryBuilder()
        .insert()
        .into(ScopedNote)
        .values({ title: 'forged-qb', tenantId: B.id })
        .execute(),
    )
    expect(await live(B.id)).toEqual(['b-only', 'same'])
    expect(await live(A)).toEqual(['a-only', 'cross', 'forged', 'forged-qb', 'same'])
  })

  it('an insert that skips the listeners still takes the context’s tenant', async () => {
    await inA(() =>
      notes().save(notes().create({ title: 'quiet', tenantId: B.id }), { listeners: false }),
    )
    await inA(() =>
      ds
        .createQueryBuilder()
        .insert()
        .into(ScopedNote)
        .values({ title: 'quiet-qb', tenantId: B.id })
        .callListeners(false)
        .execute(),
    )
    expect(await live(B.id)).toEqual(['b-only', 'same'])
    expect(await live(A)).toEqual(['a-only', 'cross', 'quiet', 'quiet-qb', 'same'])
    await expect(
      // qw:cross-tenant the spec checks that an unnamed tenant is refused without the listeners too
      allTenants(() => notes().save(notes().create({ title: 'nobody' }), { listeners: false })),
    ).rejects.toThrow(TenantContextMissing)
  })

  it('clear() of a tenant table is refused', async () => {
    await expect(inA(() => notes().clear())).rejects.toThrow(/no clear\(\) of a tenant table/)
    expect(await live(B.id)).toEqual(['b-only', 'same'])
  })

  it('an upsert of a tenant table is refused', async () => {
    await expect(inA(() => notes().upsert({ id: id.nB, title: 'taken' }, ['id']))).rejects.toThrow(
      /no upsert on a tenant table/,
    )
    expect(await live(B.id)).toEqual(['b-only', 'same'])
  })

  it('under allTenants an insert names its tenant or fails', async () => {
    await expect(
      // qw:cross-tenant the spec checks that an unnamed tenant is refused
      allTenants(() => notes().save(notes().create({ title: 'nobody' }))),
    ).rejects.toThrow(TenantContextMissing)
    // qw:cross-tenant the spec writes a row of a named tenant
    await allTenants(() => notes().save(notes().create({ title: 'named', tenantId: B.id })))
    expect(await live(B.id)).toEqual(['b-only', 'named', 'same'])
  })

  it('an update never moves a row to another tenant', async () => {
    const row = await inA(() => notes().findOneByOrFail({ id: id.nA }))
    row.title = 'moved'
    row.tenantId = B.id
    await inA(() => notes().save(row))
    expect(row.tenantId).toBe(A)
    await inA(() => notes().update(id.nA2, { title: 'moved-2', tenantId: B.id }))
    expect(await live(A)).toEqual(['cross', 'moved', 'moved-2'])
    expect(await live(B.id)).toEqual(['b-only', 'same'])
  })

  it('both guards of an update stand on their own', () => {
    // the column: TypeORM leaves it out of every UPDATE
    const metadata = ds.getMetadata(ScopedNote)
    expect(metadata.findColumnWithDatabaseName('tenant_id')?.isUpdate).toBe(false)
    // the subscriber: a QueryBuilder update's values lose the tenant
    const values = { title: 'moved', tenantId: B.id }
    new TenantSubscriber().beforeUpdate({
      metadata,
      entity: values,
    } as unknown as UpdateEvent<ObjectLiteral>)
    expect(values).toEqual({ title: 'moved' })
  })
})

describe('the department exemptions do not reach the tenant condition', () => {
  const root: Principal = {
    userId: 1,
    deptId: null,
    deptTreePath: null,
    roles: [],
    perms: ['*'],
    root: true,
  }
  const asRoot = <T>(fn: () => Promise<T>) =>
    inA(() =>
      cls.run(() => {
        cls.set('principal', root)
        return fn()
      }),
    )

  it('root sees and finds its own tenant only', async () => {
    expect(titlesOf(await asRoot(() => svc.scopedQb('n').getMany()))).toEqual([
      'a-only',
      'cross',
      'same',
    ])
    await expect(asRoot(() => svc.get(id.nB))).rejects.toThrow(NotFoundException)
    await expect(
      asRoot(() => txHost.withTransaction(() => svc.lockScopedIds([id.nA, id.nB]))),
    ).rejects.toThrow(NotFoundException)
  })

  it('@SkipDataScope() counts its own tenant only', async () => {
    expect(await inA(() => svc.countAll())).toBe(3)
  })

  it('assertUnique checks the current tenant', async () => {
    await expect(inA(() => svc.assertUnique('title', 'b-only'))).resolves.toBeUndefined()
    await expect(inA(() => svc.assertUnique('title', 'a-only'))).rejects.toThrow(BizError)
  })
})

describe('context', () => {
  it('no tenant in the context: queries throw', async () => {
    await expect(notes().find()).rejects.toThrow(TenantContextMissing)
    expect(() =>
      ds
        .createQueryBuilder()
        .select('1')
        .from('iam_tenant', 't')
        .innerJoin('test_scoped_note', 'n', '1=1')
        .getQuery(),
    ).toThrow(TenantContextMissing)
  })

  it('allTenants sees every tenant', async () => {
    // qw:cross-tenant the spec reads both tenants
    expect(titlesOf(await allTenants(() => notes().find()))).toEqual([
      'a-only',
      'b-only',
      'cross',
      'same',
      'same',
    ])
  })
})

describe('coverage', () => {
  it('every entity of a tenant table maps @TenantColumn(), no platform entity does', async () => {
    const entities = Object.values(
      import.meta.glob<Record<string, unknown>>(
        ['../../src/**/*.entity.ts', '../fixtures/**/*.entity.ts'],
        { eager: true },
      ),
    ).flatMap((mod) => Object.values(mod).filter((v) => typeof v === 'function'))
    const all = await new DataSource({
      ...dataSourceOptions(),
      entities: entities as (new () => unknown)[],
    }).initialize()
    try {
      const tenantTables = tenantTablesOf(all) ?? new Set()
      const lacking: string[] = []
      const platformWith: string[] = []
      const neither: string[] = []
      for (const m of all.entityMetadatas) {
        const marked = m.columns.some(isTenantColumn)
        if (PLATFORM_TABLES.includes(m.tableName)) {
          if (marked) platformWith.push(m.tableName)
        } else if (!tenantTables.has(m.tableName)) neither.push(m.tableName)
        else if (!marked) lacking.push(m.tableName)
      }
      expect(platformWith).toEqual([])
      expect(neither).toEqual([])
      // generated entities too: the entity template maps it for a tenant table
      expect(lacking).toEqual([])
    } finally {
      await all.destroy()
    }
  })
})
