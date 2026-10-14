// core/data-scope for hand-written SQL (see docs/data-scope.md): `SELECT … WHERE <dataScopeSql>` over the
// scoped-note fixture returns exactly the rows `scopedQb` returns, for the five scopes, several roles
// (any-of and `.all(a, b)` groups, roles without the checked perm), an empty pick, no own dept, a deleted
// dept in the tree, root, @SkipDataScope and no caller; the dept-row shape ({ dept: 'id', owner: null })
// over the dept table; identifiers that are not plain names throw.
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ClsService } from 'nestjs-cls'
import type { DataSource } from 'typeorm'
import type { PermRequirement } from '../../src/core/auth/decorators.js'
import type { DataScope, Principal, PrincipalRole } from '../../src/core/auth/principal.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import {
  dataScopeOf,
  dataScopeSql,
  dataScopeSqlFor,
  SkipDataScope,
} from '../../src/core/data-scope/data-scope.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import { ScopedNote } from '../fixtures/scoped-note/scoped-note.entity.js'
import { ScopedNoteFixtureModule } from '../fixtures/scoped-note/scoped-note.module.js'
import { ScopedNoteService } from '../fixtures/scoped-note/scoped-note.service.js'
import {
  createScopedNoteTables,
  dropScopedNoteTables,
  truncateScopedNoteTables,
} from '../fixtures/scoped-note/setup.js'
import { TestDept } from '../fixtures/scoped-note/test-dept.entity.js'
import { inTenant1 } from '../setup/tenants.js'

/** 70010's path starts with '/7000/7001' but not '/7000/7001/'; 7003 is deleted. */
const D = { top: 7000, mine: 7001, child: 7002, gone: 7003, lookalike: 70010 }
const ME = 42
const OTHER = 99
// note id → [dept, created_by]
const NOTES: [number, number | null, number][] = [
  [1, D.top, OTHER],
  [2, D.mine, OTHER],
  [3, D.child, OTHER],
  [4, D.lookalike, OTHER],
  [5, D.lookalike, ME],
  [6, D.gone, OTHER],
  [7, null, ME],
]
const ALL = NOTES.map(([id]) => id)
const P = { browse: 'test.note.browse', modify: 'test.note.modify' }

let moduleRef: TestingModule
let ds: DataSource
let cls: ClsService
let svc: ScopedNoteService

const role = (dataScope: DataScope, perms: string[], deptIds?: number[]): PrincipalRole => ({
  code: dataScope,
  dataScope,
  perms,
  ...(deptIds && { deptIds }),
})
const caller = (roles: PrincipalRole[], deptId: number | null = D.mine): Principal => ({
  userId: ME,
  deptId,
  deptTreePath: deptId === null ? null : `/${D.top}/${D.mine}/`,
  roles,
  perms: [...new Set(roles.flatMap((r) => r.perms))],
})
const anyOf = (...perms: string[]): PermRequirement => ({ perms, all: false })
const allOf = (...perms: string[]): PermRequirement => ({ perms, all: true })

class Job {
  @SkipDataScope()
  run<T>(fn: () => Promise<T>): Promise<T> {
    return fn()
  }
}

const sorted = (rows: { id: number | string }[]) =>
  rows.map((r) => Number(r.id)).sort((a, b) => a - b)

/** The ids scopedQb sees and the ids the raw statement with dataScopeSql sees, as `who` with `checked`. */
const both = (who: Principal | undefined, checked?: PermRequirement, skip = false) =>
  inTenant1(() =>
    cls.run(async () => {
      cls.set('principal', who)
      if (checked) cls.set('checkedPerm', checked)
      const read = async () => {
        const qb = sorted(await svc.scopedQb('n').select('n.id', 'id').getRawMany())
        const { sql, params } = dataScopeSql('n', dataScopeOf(ScopedNote)!, 'test_dept')
        const raw = sorted(
          await ds.query(
            `SELECT n.id FROM test_scoped_note n WHERE n.deleted_at IS NULL AND n.tenant_id = ? AND ${sql}`,
            [1, ...params],
          ),
        )
        return { qb, raw }
      }
      return skip ? new Job().run(read) : read()
    }),
  )

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreDbModule, ScopedNoteFixtureModule],
  }).compile()
  await moduleRef.init()
  ds = moduleRef.get(getDataSourceToken())
  cls = moduleRef.get(ClsService)
  svc = moduleRef.get(ScopedNoteService)
  await createScopedNoteTables(ds)
  await truncateScopedNoteTables(ds)
  for (const [id, parent, path] of [
    [D.top, 0, `/${D.top}/`],
    [D.mine, D.top, `/${D.top}/${D.mine}/`],
    [D.child, D.mine, `/${D.top}/${D.mine}/${D.child}/`],
    [D.gone, D.mine, `/${D.top}/${D.mine}/${D.gone}/`],
    [D.lookalike, D.top, `/${D.top}/${D.lookalike}/`],
  ] as const)
    await ds.query(
      'INSERT INTO test_dept (id, parent_id, tree_path, name, tenant_id) VALUES (?, ?, ?, ?, 1)',
      [id, parent, path, `d${id}`],
    )
  await ds.query('UPDATE test_dept SET deleted_at = NOW(3) WHERE id = ?', [D.gone])
  for (const [id, dept, by] of NOTES)
    await ds.query(
      'INSERT INTO test_scoped_note (id, title, dept_id, created_by, tenant_id) VALUES (?, ?, ?, ?, 1)',
      [id, `n${id}`, dept, by],
    )
  // a deleted row and a row of another tenant: neither path sees them
  await ds.query(
    "INSERT INTO test_scoped_note (id, title, dept_id, created_by, tenant_id, deleted_at) VALUES (8, 'n8', ?, ?, 1, NOW(3)), (9, 'n9', ?, ?, 2, NULL)",
    [D.mine, ME, D.mine, ME],
  )
})

afterAll(async () => {
  if (ds?.isInitialized) await dropScopedNoteTables(ds)
  await moduleRef?.close()
})

describe('dataScopeSql sees what scopedQb sees', () => {
  const every = [P.browse, P.modify]
  it.each<[string, Principal | undefined, PermRequirement | undefined, number[]]>([
    ['all', caller([role('all', every)]), anyOf(P.browse), ALL],
    [
      'picked_depts',
      caller([role('picked_depts', every, [D.child, D.lookalike])]),
      anyOf(P.browse),
      [3, 4, 5],
    ],
    ['own_dept', caller([role('own_dept', every)]), anyOf(P.browse), [2]],
    // the deleted sub-dept and the look-alike path stay out
    ['own_dept_tree', caller([role('own_dept_tree', every)]), anyOf(P.browse), [2, 3]],
    ['own_rows', caller([role('own_rows', every)]), anyOf(P.browse), [5, 7]],
    [
      'several roles OR',
      caller([role('own_dept', every), role('own_rows', every)]),
      anyOf(P.browse),
      [2, 5, 7],
    ],
    [
      'any-of: the roles holding any listed perm',
      caller([role('own_dept', [P.modify]), role('own_rows', [P.browse])]),
      anyOf(P.modify, P.browse),
      [2, 5, 7],
    ],
    [
      'a role without the checked perm does not count',
      caller([role('all', [P.browse]), role('own_dept', [P.modify])]),
      anyOf(P.modify),
      [2],
    ],
    [
      '.all(a, b): an all-scope group does not widen the other',
      caller([role('all', [P.browse]), role('own_dept', every)]),
      allOf(P.browse, P.modify),
      [2],
    ],
    [
      '.all(a, b): both groups filter, ANDed',
      caller([
        role('picked_depts', [P.browse], [D.child, D.lookalike]),
        role('own_dept_tree', [P.modify]),
      ]),
      allOf(P.browse, P.modify),
      [3],
    ],
    [
      '.all(a, b): no role holds one of them',
      caller([role('all', [P.browse])]),
      allOf(P.browse, P.modify),
      [],
    ],
    [
      'no @RequirePerm: every role',
      caller([role('own_dept', [P.modify]), role('own_rows', [])]),
      undefined,
      [2, 5, 7],
    ],
    [
      'picked_depts with no dept picked',
      caller([role('picked_depts', every)]),
      anyOf(P.browse),
      [],
    ],
    ['own_dept without a dept', caller([role('own_dept', every)], null), anyOf(P.browse), []],
    ['no roles', caller([]), anyOf(P.browse), []],
    ['root', { ...caller([]), root: true }, anyOf(P.browse), ALL],
    ['no caller', undefined, undefined, []],
  ])('%s', async (_name, who, checked, expected) => {
    const { qb, raw } = await both(who, checked)
    expect(qb).toEqual(expected)
    expect(raw).toEqual(qb)
  })

  it('@SkipDataScope: everything, with or without a caller', async () => {
    for (const who of [undefined, caller([role('own_rows', [P.browse])])]) {
      const { qb, raw } = await both(who, anyOf(P.browse), true)
      expect(qb).toEqual(ALL)
      expect(raw).toEqual(ALL)
    }
  })

  it('renders `?` placeholders in the order of its values, groups bracketed', () =>
    cls.run(() => {
      cls.set(
        'principal',
        caller([role('picked_depts', [P.browse], [D.child]), role('own_rows', [P.modify])]),
      )
      cls.set('checkedPerm', allOf(P.browse, P.modify))
      expect(dataScopeSql('n', { dept: 'dept_id', owner: 'created_by' })).toEqual({
        sql: '((n.dept_id IN (?)) AND (n.created_by = ?))',
        params: [[D.child], ME],
      })
      expect(dataScopeSqlFor(ScopedNote, 'x').sql).toBe(
        '((x.dept_id IN (?)) AND (x.created_by = ?))',
      )
    }))
})

describe("the dept-row shape ({ dept: 'id', owner: null })", () => {
  const depts = (who: Principal) =>
    inTenant1(() =>
      cls.run(async () => {
        cls.set('principal', who)
        cls.set('checkedPerm', anyOf(P.browse))
        const { sql, params } = dataScopeSql('d', { dept: 'id', owner: null }, 'test_dept')
        return sorted(
          await ds.query(
            `SELECT d.id FROM test_dept d WHERE d.deleted_at IS NULL AND d.tenant_id = ? AND ${sql}`,
            [1, ...params],
          ),
        )
      }),
    )

  it('own_rows: no owner column, nothing', async () => {
    expect(await depts(caller([role('own_rows', [P.browse])]))).toEqual([])
  })

  it('own_dept_tree: the own dept and its live sub-depts', async () => {
    expect(await depts(caller([role('own_dept_tree', [P.browse])]))).toEqual([D.mine, D.child])
  })
})

describe('identifiers come from code', () => {
  const cols = { dept: 'dept_id', owner: 'created_by' }
  it.each([
    ['alias', () => dataScopeSql('n; DROP TABLE x', cols)],
    ['alias with a dot', () => dataScopeSql('db.n', cols)],
    ['dept column', () => dataScopeSql('n', { dept: 'dept_id OR 1=1', owner: null })],
    ['owner column', () => dataScopeSql('n', { dept: null, owner: '`created_by`' })],
    ['dept table', () => dataScopeSql('n', cols, 'iam_dept d')],
    ['empty alias', () => dataScopeSql('', cols)],
    ['leading digit', () => dataScopeSql('1n', cols)],
  ])('%s: throws, even for root', (_name, fn) =>
    cls.run(() => {
      cls.set('principal', { ...caller([]), root: true })
      expect(fn).toThrow(/not an identifier/)
    }),
  )

  it('dataScopeSqlFor needs a @DataScoped entity', () => {
    expect(() => dataScopeSqlFor(TestDept, 'd')).toThrow(/not a @DataScoped entity/)
  })
})
