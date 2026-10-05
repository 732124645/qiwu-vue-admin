// CodegenService against qiwu_test (see docs/design-notes.md#codegen): import from information_schema (framework, view,
// imported and unknown tables refused, names never reach SQL), the identifier whitelist on import and on
// save, sync keeping manual config, delete, tables without deleted_at refused. Probe tables are
// created here and dropped in afterAll.
import { NotFoundException } from '@nestjs/common'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { type CgParentMenuNode, Err } from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import { type DataSource, QueryFailedError } from 'typeorm'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import { ValidationException } from '../../src/core/http/validation.pipe.js'
import { seedCgConfig } from '../../src/db/seeds/codegen/codegen.seed.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { CodegenServiceModule } from '../../src/modules/platform/codegen/codegen.module.js'
import { CodegenService } from '../../src/modules/platform/codegen/codegen.service.js'

/** Every generator config with its columns, for good (no foreign key cascades them). */
const clearCg = async () => {
  await ds.query('DELETE FROM cg_column')
  await ds.query('DELETE FROM cg_table')
}

let moduleRef: TestingModule
let ds: DataSource
let cls: ClsService
let svc: CodegenService

const PROBES = [
  'demo_cg_probe',
  'demo_cg_counts',
  'demo_cg_bad',
  'demo-cg-bad',
  'demo_9lives',
  'test_cg_excluded',
  'demo_cg_names',
  'demo_cg_hints',
  'demo_cg_alive',
  'pdx_customer',
  'pdy_customer',
  'pdx_user',
  'pdz_sale_order',
  'pdzcourse',
  'pdw_leave',
  'pdw_trip',
]
/** Route names of the menu groups the menu-group cases add (removed for good after each). */
const GROUPS = ['pdz', 'pdz-sale', 'pdz-sale-order', 'pdz-x', 'PDQ', 'pdz-null']
/** Every service call runs in a CLS context, like a request or the CLI's. */
const run = <T>(fn: () => Promise<T>) => cls.run(fn)
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => 'resolved',
    (e: unknown) => e,
  )
const unavailable = (table: string) =>
  expect.objectContaining({ err: Err.CODEGEN_TABLE_UNAVAILABLE, params: { table } })
const noDeletedAt = (table: string) =>
  expect.objectContaining({ err: Err.CODEGEN_NO_DELETED_AT, params: { table } })
/** Live configs (deleting is soft). */
const configCount = async () =>
  (await ds.query('SELECT COUNT(*) AS n FROM cg_table WHERE deleted_at IS NULL'))[0].n

const createProbe = () =>
  ds.query(`CREATE TABLE demo_cg_probe (
    id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '探针 ID',
    title varchar(100) NOT NULL COMMENT '标题（说明）',
    flag int NOT NULL DEFAULT 0 COMMENT '标记',
    old_col varchar(20) NULL COMMENT '旧列',
    created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    deleted_at datetime(3) NULL COMMENT '删除时间',
    alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1',
    PRIMARY KEY (id)
  ) COMMENT='探针表'`)

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreDbModule, CodegenServiceModule],
  }).compile()
  await moduleRef.init()
  ds = moduleRef.get(getDataSourceToken())
  cls = moduleRef.get(ClsService)
  svc = moduleRef.get(CodegenService)
  for (const t of [...PROBES, 'demo_cg_view'])
    await ds.query(`DROP ${t.endsWith('view') ? 'VIEW' : 'TABLE'} IF EXISTS \`${t}\``)
  await createProbe()
  // no text column: nothing to label options with
  await ds.query(`CREATE TABLE demo_cg_counts (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    qty int NOT NULL DEFAULT 0,
    created_by bigint unsigned NULL,
    created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_by bigint unsigned NULL,
    updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    deleted_at datetime(3) NULL,
    PRIMARY KEY (id)
  ) COMMENT='计数'`)
  await ds.query("CREATE TABLE demo_cg_bad (id int PRIMARY KEY, `Bad-Col` int) COMMENT='x'")
  await ds.query("CREATE TABLE `demo-cg-bad` (id int PRIMARY KEY) COMMENT='x'")
  await ds.query("CREATE TABLE demo_9lives (id int PRIMARY KEY) COMMENT='x'")
  await ds.query("CREATE TABLE test_cg_excluded (id int PRIMARY KEY) COMMENT='x'")
  // names the templates use already (a reserved word, a `…Value` taken), a bare enum-code column
  await ds.query(`CREATE TABLE demo_cg_names (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    \`default\` varchar(20) NULL,
    default_value varchar(20) NULL,
    kind varchar(24) NULL,
    deleted_at datetime(3) NULL,
    PRIMARY KEY (id)
  ) COMMENT='x'`)
  // the soft-delete convention missed: no deleted_at, a unique key without alive; only the latter
  await ds.query(`CREATE TABLE demo_cg_hints (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    code varchar(20) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_demo_cg_hints_code (code)
  ) COMMENT='x'`)
  await ds.query(`CREATE TABLE demo_cg_alive (
    id bigint unsigned NOT NULL AUTO_INCREMENT,
    code varchar(20) NOT NULL,
    deleted_at datetime(3) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_demo_cg_alive_code (code)
  ) COMMENT='x'`)
  await ds.query('CREATE VIEW demo_cg_view AS SELECT id FROM demo_cg_probe')
  // one business in two project domains, one beside the built-in iam_user
  // pdw_leave: its short class name `Leave` is the hand-written biz/leave's (`leavePerms` …)
  for (const t of [
    'pdx_customer',
    'pdy_customer',
    'pdx_user',
    'pdz_sale_order',
    'pdzcourse',
    'pdw_leave',
    'pdw_trip',
  ])
    await ds.query(`CREATE TABLE ${t} (
      id bigint unsigned NOT NULL AUTO_INCREMENT,
      name varchar(64) NOT NULL,
      deleted_at datetime(3) NULL,
      PRIMARY KEY (id)
    ) COMMENT='x'`)
})

const clearGroups = () =>
  ds.query('DELETE FROM iam_menu WHERE route_name IN (?) OR name IN (?)', [GROUPS, GROUPS])

afterAll(async () => {
  if (ds?.isInitialized) {
    await clearGroups()
    await clearCg()
    await ds.query('DROP VIEW IF EXISTS demo_cg_view')
    for (const t of PROBES) await ds.query(`DROP TABLE IF EXISTS \`${t}\``)
  }
  await moduleRef?.close()
})

beforeEach(clearCg)

it('lists base tables of this schema only: no framework tables, views or imported tables', async () => {
  const names = (await run(() => svc.importable())).map((t) => t.tableName)
  expect(names).toEqual(expect.arrayContaining(['iam_position', 'demo_book', 'demo_cg_probe']))
  for (const excluded of [
    'meta_migrations',
    'cg_table',
    'cg_column',
    'test_cg_excluded',
    'demo_cg_view',
  ])
    expect(names).not.toContain(excluded)
  const listed = (name: string) =>
    run(() => svc.importable()).then((all) => all.find((t) => t.tableName === name))
  expect(await listed('demo_book')).toEqual({
    tableName: 'demo_book',
    tableComment: '图书（生成器示例）',
    noDeletedAt: false,
  })
  // no deleted_at: listed, marked (the dialog disables it; import refuses it)
  expect(await listed('demo_cg_hints')).toEqual({
    tableName: 'demo_cg_hints',
    tableComment: 'x',
    noDeletedAt: true,
  })

  await run(() => svc.import(['iam_position']))
  expect((await run(() => svc.importable())).map((t) => t.tableName)).not.toContain('iam_position')
})

it('imports iam_position with the rule defaults (the golden sample)', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['iam_position']))
  const t = await run(() => svc.detail(id!))
  expect(t).toMatchObject({
    tableName: 'iam_position',
    tableComment: '岗位',
    groupCode: 'platform',
    domain: 'iam',
    business: 'position',
    className: 'Position',
    featureName: '岗位',
    featureNameI18n: { 'zh-CN': '岗位', 'en-US': 'Position' },
    template: 'crud',
    parentMenuRouteName: 'system',
    formCols: 1,
    withDetailView: false,
    readonly: false,
    options: { withExport: true, withImport: false, menuIcon: 'lucide:table' },
  })
  expect(await run(() => svc.idOf('iam_position'))).toBe(id)
  const byName = Object.fromEntries(t.columns.map((c) => [c.columnName, c]))
  expect(t.columns.map((c) => c.columnName)).toEqual([
    'id',
    'code',
    'name',
    'sort_no',
    'enabled',
    'note',
    'created_by',
    'created_at',
    'updated_by',
    'updated_at',
    'deleted_at',
  ])
  expect(byName.id).toMatchObject({ isPk: true, isAutoInc: true, inList: false, inForm: false })
  expect(byName.code).toMatchObject({
    columnType: 'varchar(64)',
    fieldName: 'code',
    tsType: 'string',
    widget: 'input',
    inQuery: true,
    queryOp: 'like',
    sortable: true,
    required: true,
    labelI18n: { 'zh-CN': '岗位编码', 'en-US': 'Code' },
    options: { unique: true },
  })
  expect(byName.name).toMatchObject({
    queryOp: 'like',
    labelI18n: { 'zh-CN': '岗位名称', 'en-US': 'Name' },
    options: { unique: true },
  })
  expect(byName.sort_no).toMatchObject({
    fieldName: 'sortNo',
    columnDefault: '0',
    widget: 'number',
    required: false,
  })
  expect(byName.enabled).toMatchObject({
    tsType: 'boolean',
    widget: 'switch',
    dictCode: 'core.enabled',
    inQuery: true,
  })
  expect(byName.note).toMatchObject({
    nullable: true,
    widget: 'textarea',
    required: false,
    options: {},
  })
  expect(byName.created_at).toMatchObject({ tsType: 'Date', inList: true, queryOp: 'between' })
  expect(byName.updated_by).toMatchObject({ inList: false, inForm: false })
})

it('marks a column unique when it is alone in a unique index, generated columns aside', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_book']))
  const byName = Object.fromEntries(
    (await run(() => svc.detail(id!))).columns.map((c) => [c.columnName, c]),
  )
  // uk_demo_book_isbn (isbn, alive): unique among live rows
  expect(byName.isbn!.options).toEqual({ unique: true })
  expect(byName.title!.options).toEqual({})
})

it('hints at a unique key without alive, imported anyway', async () => {
  const { ids, hints } = await run(() =>
    svc.import(['demo_cg_alive', 'demo_book', 'iam_position', 'demo_cg_probe']),
  )
  expect(ids).toHaveLength(4)
  expect(hints).toEqual([
    { tableName: 'demo_cg_alive', missing: 'alive', key: 'uk_demo_cg_alive_code' },
  ])
})

it('a table without deleted_at → 422 C3010 and nothing imported, one in a batch → none; defaults too', async () => {
  expect(await rejection(run(() => svc.import(['demo_cg_hints'])))).toEqual(
    noDeletedAt('demo_cg_hints'),
  )
  expect(await rejection(run(() => svc.import(['demo_book', 'demo_cg_hints'])))).toEqual(
    noDeletedAt('demo_cg_hints'),
  )
  expect(await configCount()).toBe(0)
  expect((await ds.query('SELECT COUNT(*) AS n FROM cg_column'))[0].n).toBe(0)
  // what the CLI renders for a table not imported
  expect(await rejection(run(() => svc.defaults('demo_cg_hints')))).toEqual(
    noDeletedAt('demo_cg_hints'),
  )
})

it('deleted_at dropped after the import: sync (config unchanged), render, preview → 422 C3010, a sub table too; the table gone → 422 C3001', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_cg_probe']))
  const before = await run(() => svc.detail(id!))
  const config = await run(() => svc.renderConfig(id!))
  // a master's sub tables are checked too (the stored config itself renders fine here)
  const withSub = { ...config, subs: [{ ...before, tableName: 'demo_cg_hints' }] }
  expect(await rejection(run(() => svc.renderOne(withSub)))).toEqual(noDeletedAt('demo_cg_hints'))
  expect((await run(() => svc.render([id!]))).files.length).toBeGreaterThan(0)
  await ds.query('ALTER TABLE demo_cg_probe DROP COLUMN alive, DROP COLUMN deleted_at')
  try {
    for (const call of [
      (): Promise<unknown> => svc.sync(id!),
      () => svc.render([id!]),
      () => svc.preview(id!),
      () => svc.renderOne(config),
    ])
      expect(await rejection(run(call))).toEqual(noDeletedAt('demo_cg_probe'))
    expect(await run(() => svc.detail(id!))).toEqual(before)
    await ds.query('DROP TABLE demo_cg_probe')
    expect(await rejection(run(() => svc.render([id!])))).toEqual(unavailable('demo_cg_probe'))
  } finally {
    await ds.query('DROP TABLE IF EXISTS demo_cg_probe')
    await createProbe()
  }
})

it('a G0 config (the codegen seed) refuses a table that misses the convention', async () => {
  await expect(
    seedCgConfig(ds.manager, { tableName: 'demo_cg_hints', table: {}, columns: {} }),
  ).rejects.toThrow('codegen seed demo_cg_hints: misses deleted_at, uk_demo_cg_hints_code')
  expect(await configCount()).toBe(0)
})

it('refuses unknown, framework, view, imported and differently spelled tables; all or nothing', async () => {
  for (const name of [
    'nope',
    'meta_migrations',
    'cg_table',
    'test_cg_excluded',
    'demo_cg_view',
    'IAM_POSITION',
    "iam_position' OR '1'='1",
  ])
    expect(await rejection(run(() => svc.import([name])))).toEqual(unavailable(name))

  await run(() => svc.import(['iam_position']))
  expect(await rejection(run(() => svc.import(['iam_position'])))).toEqual(
    unavailable('iam_position'),
  )
  expect(await rejection(run(() => svc.import(['demo_book', 'nope'])))).toEqual(unavailable('nope'))
  expect(await configCount()).toBe(1)
})

it('defaults: the config import would store, unsaved (the CLI renders a table not imported yet)', async () => {
  const preview = await run(() => svc.defaults('demo_book'))
  expect(await configCount()).toBe(0)
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_book']))
  const stored = await run(() => svc.detail(id!))
  // the config itself: no ids, no audit columns; unset (a DB default null) = null
  const AUDIT = ['id', 'tableId', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy']
  const plain = (o: object) =>
    Object.fromEntries(Object.entries(o).filter(([k, v]) => !AUDIT.includes(k) && v != null))
  const config = ({ columns, ...rest }: typeof stored) => ({
    ...plain(rest),
    columns: columns.map(plain),
  })
  expect(config(preview)).toEqual(config(stored))
  expect(preview.id).toBe(0)
  expect(preview.columns.map((c) => c.id)).toEqual(preview.columns.map((_, i) => i + 1))
  // imported now, so no longer importable; framework and unknown tables never were
  for (const name of ['demo_book', 'cg_table', 'nope'])
    expect(await rejection(run(() => svc.defaults(name)))).toEqual(unavailable(name))
})

it('refuses table and column names outside the whitelist, and derived names too', async () => {
  const invalid = (name: string) =>
    expect.objectContaining({ err: Err.CODEGEN_IDENTIFIER_INVALID, params: { name } })
  expect(await rejection(run(() => svc.import(['demo_cg_bad'])))).toEqual(invalid('Bad-Col'))
  expect(await rejection(run(() => svc.import(['demo-cg-bad'])))).toEqual(invalid('demo-cg-bad'))
  // demo_ stripped leaves business / class name "9lives"
  const e = await rejection(run(() => svc.import(['demo_9lives'])))
  expect(e).toBeInstanceOf(ValidationException)
  expect((e as ValidationException).issues.map((i) => i.path.join('.'))).toEqual([
    'business',
    'className',
  ])
  expect(await configCount()).toBe(0)
})

it('project domains: the same business in another domain gets the domain in front of the class name; a clash left, a reserved domain → 422 and nothing saved', async () => {
  const {
    ids: [x, y],
  } = await run(() => svc.import(['pdx_customer', 'pdy_customer']))
  const names = async (id: number) => {
    const { domain, business, className } = await run(() => svc.detail(id))
    return [domain, business, className].join(' ')
  }
  // both qualified, whatever the order: the second is still a table when the first imports
  expect(await names(x!)).toBe('pdx customer PdxCustomer')
  expect(await names(y!)).toBe('pdy customer PdyCustomer')
  // the hand-written iam_user (no config) exports `userPerms` already
  const {
    ids: [u],
  } = await run(() => svc.import(['pdx_user']))
  expect(await names(u!)).toBe('pdx user PdxUser')
  const conflict = (table: string) =>
    expect.objectContaining({ err: Err.CODEGEN_NAME_CONFLICT, params: { table } })
  expect(await rejection(run(() => svc.save(y!, { className: 'PdxCustomer' })))).toEqual(
    conflict('pdx_customer'),
  )
  expect(await rejection(run(() => svc.save(y!, { domain: 'pdx' })))).toEqual(
    conflict('pdx_customer'),
  )
  expect(await rejection(run(() => svc.save(y!, { domain: 'core' })))).toEqual(
    expect.objectContaining({ err: Err.CODEGEN_IDENTIFIER_INVALID, params: { name: 'core' } }),
  )
  expect(await names(y!)).toBe('pdy customer PdyCustomer')
  await run(() => svc.save(y!, { domain: 'demo', className: 'DemoCustomer' }))
  expect(await names(y!)).toBe('demo customer DemoCustomer')
})

it('a class name whose exports @qiwu/shared holds for a hand-written module gets the domain in front, on import and in the defaults; no clash keeps the short one', async () => {
  expect((await run(() => svc.defaults('pdw_leave'))).className).toBe('PdwLeave')
  const {
    ids: [leave, trip],
  } = await run(() => svc.import(['pdw_leave', 'pdw_trip']))
  expect((await run(() => svc.detail(leave!))).className).toBe('PdwLeave')
  expect((await run(() => svc.detail(trip!))).className).toBe('Trip')
})

describe('save', () => {
  it('stores whitelisted edits of the table and its columns, keeps what was not sent', async () => {
    const {
      ids: [id],
    } = await run(() => svc.import(['demo_book']))
    const book = await run(() => svc.detail(id!))
    const genre = book.columns.find((c) => c.columnName === 'genre')!
    await run(() =>
      svc.save(id!, {
        className: 'Novel',
        business: 'novel',
        parentMenuRouteName: 'devtools',
        options: {
          withExport: true,
          withOptions: true,
          menuIcon: 'lucide:book-open',
        },
        columns: [
          {
            id: genre.id,
            widget: 'select',
            dictCode: 'demo.genre',
            inQuery: true,
            labelI18n: { 'zh-CN': '分类', 'en-US': 'Genre' },
            options: { seedName: false },
          },
        ],
      }),
    )
    const saved = await run(() => svc.detail(id!))
    expect(saved).toMatchObject({
      className: 'Novel',
      business: 'novel',
      domain: 'demo',
      parentMenuRouteName: 'devtools',
      options: { menuIcon: 'lucide:book-open', withOptions: true },
    })
    expect(saved.columns.find((c) => c.id === genre.id)).toMatchObject({
      widget: 'select',
      dictCode: 'demo.genre',
      inQuery: true,
      labelI18n: { 'zh-CN': '分类', 'en-US': 'Genre' },
      fieldName: 'genre',
      required: true,
    })
  })

  it('rejects anything outside the whitelist (400) and saves nothing', async () => {
    const {
      ids: [id],
    } = await run(() => svc.import(['demo_book']))
    const before = await run(() => svc.detail(id!))
    const columnId = before.columns[1]!.id
    const bodies: [unknown, string][] = [
      [{ className: 'Book;' }, 'className'],
      [{ className: 'Book`x`' }, 'className'],
      [{ className: 'Book*/evil()/*' }, 'className'],
      [{ className: 'book' }, 'className'],
      [{ business: 'Bad_Biz' }, 'business'],
      [{ business: 'x'.repeat(65) }, 'business'],
      [{ domain: "demo'" }, 'domain'],
      [{ parentMenuRouteName: 'demo;drop' }, 'parentMenuRouteName'],
      [{ groupCode: 'core' }, 'groupCode'],
      [{ options: { menuIcon: 'lucide:x"><script>' } }, 'options.menuIcon'],
      [{ options: { evil: '<%- x %>' } }, 'options'],
      [{ featureNameI18n: { 'zh-CN': '图书' } }, 'featureNameI18n.en-US'],
      [{ evil: 1 }, ''],
      [{ columns: [{ id: columnId, fieldName: 'isbn; drop' }] }, 'columns.0.fieldName'],
      [{ columns: [{ id: columnId, fieldName: 'Isbn' }] }, 'columns.0.fieldName'],
      [{ columns: [{ id: columnId, dictCode: 'demo genre' }] }, 'columns.0.dictCode'],
      [{ columns: [{ id: columnId, widget: 'html' }] }, 'columns.0.widget'],
      [{ columns: [{ id: columnId, options: { raw: true } }] }, 'columns.0.options'],
    ]
    for (const [body, path] of bodies) {
      const e = await rejection(run(() => svc.save(id!, body)))
      expect(e).toBeInstanceOf(ValidationException)
      expect((e as ValidationException).domain).toBe('codegen')
      expect((e as ValidationException).issues[0]!.path.join('.')).toBe(path)
    }
    expect(await run(() => svc.detail(id!))).toEqual(before)
  })

  it('options without a label column (no name, title or text column) → 422 C3003, nothing saved', async () => {
    const {
      ids: [id],
    } = await run(() => svc.import(['demo_cg_counts']))
    const before = await run(() => svc.detail(id!))
    const qty = before.columns.find((c) => c.columnName === 'qty')!
    expect(
      await rejection(run(() => svc.save(id!, { note: 'x', options: { withOptions: true } }))),
    ).toEqual(
      expect.objectContaining({
        err: Err.CODEGEN_OPTIONS_LABEL_MISSING,
        params: { table: 'demo_cg_counts' },
      }),
    )
    expect(await run(() => svc.detail(id!))).toEqual(before)
    // a text column (here by its TS type) labels them
    await run(() =>
      svc.save(id!, {
        options: { withOptions: true },
        columns: [{ id: qty.id, tsType: 'string' }],
      }),
    )
    expect((await run(() => svc.detail(id!))).options).toEqual({ withOptions: true })
  })

  it('referencedBy: a column of a table of this database with deleted_at, else 422 C3009 and nothing saved', async () => {
    const {
      ids: [id],
    } = await run(() => svc.import(['iam_position']))
    const refs = (table: string, column: string) => ({
      options: { referencedBy: [{ table, column, label: '用户岗位' }] },
    })
    for (const [table, column] of [
      ['iam_user_positions', 'nope'],
      ['nope', 'position_id'],
      ['demo_cg_hints', 'code'], // no deleted_at: the check reads live rows
      ['iam_user_positions', 'deleted_at'],
    ] as const)
      expect(await rejection(run(() => svc.save(id!, refs(table, column))))).toEqual(
        expect.objectContaining({ err: Err.CODEGEN_REFERENCE, params: { table, column } }),
      )
    expect((await run(() => svc.detail(id!))).options).not.toHaveProperty('referencedBy')
    // names reach generated SQL: the identifier whitelist first (400)
    const e = await rejection(
      run(() => svc.save(id!, refs('iam_user_positions`--', 'position_id'))),
    )
    expect((e as ValidationException).issues[0]!.path.join('.')).toBe(
      'options.referencedBy.0.table',
    )
    await run(() => svc.save(id!, refs('iam_user_positions', 'position_id')))
    expect((await run(() => svc.detail(id!))).options).toEqual({
      referencedBy: [{ table: 'iam_user_positions', column: 'position_id', label: '用户岗位' }],
    })
  })

  it('a column of another table or a missing config → 404; a duplicate property name → 1062', async () => {
    const {
      ids: [bookId, positionId],
    } = await run(() => svc.import(['demo_book', 'iam_position']))
    const position = await run(() => svc.detail(positionId!))
    expect(
      await rejection(
        run(() => svc.save(bookId!, { columns: [{ id: position.columns[0]!.id, sortNo: 1 }] })),
      ),
    ).toBeInstanceOf(NotFoundException)
    expect(await rejection(run(() => svc.save(999_999, { note: 'x' })))).toBeInstanceOf(
      NotFoundException,
    )
    const book = await run(() => svc.detail(bookId!))
    const e = await rejection(
      run(() => svc.save(bookId!, { columns: [{ id: book.columns[1]!.id, fieldName: 'title' }] })),
    )
    expect(e).toBeInstanceOf(QueryFailedError)
    expect((e as QueryFailedError & { driverError: { errno: number } }).driverError.errno).toBe(
      1062,
    )
  })
})

it('sync: new columns appended, dropped removed, changed facts updated, manual config kept', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_cg_probe']))
  const probe = await run(() => svc.detail(id!))
  // generated `alive` is not imported
  expect(probe.columns.map((c) => c.columnName)).toEqual([
    'id',
    'title',
    'flag',
    'old_col',
    'created_at',
    'deleted_at',
  ])
  const col = (name: string) => probe.columns.find((c) => c.columnName === name)!
  await run(() =>
    svc.save(id!, {
      featureName: '探针',
      columns: [
        {
          id: col('title').id,
          widget: 'textarea',
          inList: false,
          labelI18n: { 'zh-CN': '题目', 'en-US': 'Heading' },
        },
        { id: col('flag').id, widget: 'number', sortNo: 500 },
        { id: col('old_col').id, labelI18n: { 'zh-CN': '旧的', 'en-US': 'Former' }, sortNo: 300 },
      ],
    }),
  )
  expect(await run(() => svc.sync(id!))).toEqual({ added: [], removed: [], changed: [] })

  await ds.query(`ALTER TABLE demo_cg_probe
    ADD COLUMN extra_note varchar(100) NULL COMMENT '附注',
    DROP COLUMN old_col,
    MODIFY title varchar(150) NOT NULL COMMENT '标题（新）',
    MODIFY flag tinyint(1) NOT NULL DEFAULT 1 COMMENT '标记',
    COMMENT = '探针表 v2'`)
  try {
    expect(await run(() => svc.sync(id!))).toEqual({
      added: ['extra_note'],
      removed: ['old_col'],
      changed: ['title', 'flag'],
    })
    // removed = soft-deleted: the row stays, marked deleted
    expect(
      await ds.query(
        "SELECT deleted_at IS NOT NULL AS gone FROM cg_column WHERE table_id = ? AND column_name = 'old_col'",
        [id],
      ),
    ).toEqual([{ gone: 1 }])
    const synced = await run(() => svc.detail(id!))
    expect(synced).toMatchObject({ tableComment: '探针表 v2', featureName: '探针' })
    const after = Object.fromEntries(synced.columns.map((c) => [c.columnName, c]))
    expect(Object.keys(after)).toEqual([
      'id',
      'title',
      'created_at',
      'deleted_at',
      'flag',
      'extra_note',
    ])
    expect(after.title).toMatchObject({
      columnType: 'varchar(150)',
      columnComment: '标题（新）',
      widget: 'textarea',
      inList: false,
      labelI18n: { 'zh-CN': '题目', 'en-US': 'Heading' },
    })
    // a new type brings its TS type; the widget stays what the user chose
    expect(after.flag).toMatchObject({
      columnType: 'tinyint(1)',
      columnDefault: '1',
      tsType: 'boolean',
      widget: 'number',
      sortNo: 500,
    })
    expect(after.extra_note).toMatchObject({
      sortNo: 510,
      widget: 'input',
      labelI18n: { 'zh-CN': '附注', 'en-US': 'Extra note' },
    })
    expect(await run(() => svc.sync(id!))).toEqual({ added: [], removed: [], changed: [] })

    // old_col back (a migration re-applied): its soft-deleted config returns with the new facts
    await ds.query(
      "ALTER TABLE demo_cg_probe ADD COLUMN old_col varchar(40) NULL COMMENT '旧列（回来）'",
    )
    expect(await run(() => svc.sync(id!))).toEqual({ added: ['old_col'], removed: [], changed: [] })
    expect(
      (await run(() => svc.detail(id!))).columns.find((c) => c.columnName === 'old_col'),
    ).toMatchObject({
      id: col('old_col').id,
      columnType: 'varchar(40)',
      columnComment: '旧列（回来）',
      labelI18n: { 'zh-CN': '旧的', 'en-US': 'Former' },
      sortNo: 300,
    })
    expect(
      await ds.query('SELECT COUNT(*) AS n FROM cg_column WHERE table_id = ? AND column_name = ?', [
        id,
        'old_col',
      ]),
    ).toEqual([{ n: 1 }])
    await ds.query('ALTER TABLE demo_cg_probe DROP COLUMN old_col')
    expect(await run(() => svc.sync(id!))).toEqual({ added: [], removed: ['old_col'], changed: [] })

    await ds.query('DROP TABLE demo_cg_probe')
    expect(await rejection(run(() => svc.sync(id!)))).toEqual(unavailable('demo_cg_probe'))
    // a view by that name is no replacement: the config stays as it was
    await ds.query('CREATE VIEW demo_cg_probe AS SELECT id FROM demo_book')
    expect(await rejection(run(() => svc.sync(id!)))).toEqual(unavailable('demo_cg_probe'))
    expect((await run(() => svc.detail(id!))).columns).toHaveLength(6)
  } finally {
    // whichever it is now (a table if an assertion failed early); createProbe fails loudly if neither went
    await ds.query('DROP VIEW IF EXISTS demo_cg_probe').catch(() => undefined)
    await ds.query('DROP TABLE IF EXISTS demo_cg_probe').catch(() => undefined)
    await createProbe()
  }
})

it('field names stay unique and never a reserved word, on import and on sync; a bare kind gets the table in its dict', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_cg_names']))
  const fields = async () =>
    Object.fromEntries(
      (await run(() => svc.detail(id!))).columns.map((c) => [c.columnName, c.fieldName]),
    )
  expect(await fields()).toEqual({
    id: 'id',
    default: 'defaultValue',
    default_value: 'defaultValue2',
    kind: 'kind',
    deleted_at: 'deletedAt',
  })
  const detail = await run(() => svc.detail(id!))
  expect(detail.className).toBe('CgNames')
  const kind = detail.columns.find((c) => c.columnName === 'kind')!
  expect(kind).toMatchObject({ widget: 'select', dictCode: 'demo.cg_names_kind' })
  // a new column whose default name a kept (edited) one has already
  await run(() => svc.save(id!, { columns: [{ id: kind.id, fieldName: 'note' }] }))
  await ds.query('ALTER TABLE demo_cg_names ADD COLUMN note varchar(20) NULL')
  expect((await run(() => svc.sync(id!))).added).toEqual(['note'])
  expect(await fields()).toMatchObject({ kind: 'note', note: 'note2' })
})

it('sync: `required` follows new nullability / default unless edited by hand', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_cg_probe']))
  const col = async (name: string) =>
    (await run(() => svc.detail(id!))).columns.find((c) => c.columnName === name)!
  expect((await col('title')).required).toBe(true)
  expect((await col('old_col')).required).toBe(false)
  // by hand: flag (NOT NULL DEFAULT 0, rule false) required
  const flag = (await col('flag')).id
  await run(() => svc.save(id!, { columns: [{ id: flag, required: true }] }))
  await ds.query(`ALTER TABLE demo_cg_probe
    MODIFY title varchar(100) NULL COMMENT '标题（说明）',
    MODIFY old_col varchar(20) NOT NULL COMMENT '旧列',
    MODIFY flag int NOT NULL DEFAULT 5 COMMENT '标记'`)
  try {
    expect(await run(() => svc.sync(id!))).toMatchObject({ changed: ['title', 'flag', 'old_col'] })
    expect((await col('title')).required).toBe(false) // NOT NULL → NULL
    expect((await col('old_col')).required).toBe(true) // NULL → NOT NULL without a default
    expect((await col('flag')).required).toBe(true) // edited by hand: kept
  } finally {
    await ds.query('DROP TABLE demo_cg_probe')
    await createProbe()
  }
})

it('sync refuses a new column outside the whitelist', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_cg_probe']))
  await ds.query('ALTER TABLE demo_cg_probe ADD COLUMN `Evil*/Col` int NULL')
  try {
    expect(await rejection(run(() => svc.sync(id!)))).toEqual(
      expect.objectContaining({
        err: Err.CODEGEN_IDENTIFIER_INVALID,
        params: { name: 'Evil*/Col' },
      }),
    )
    expect((await run(() => svc.detail(id!))).columns).toHaveLength(6)
  } finally {
    await ds.query('ALTER TABLE demo_cg_probe DROP COLUMN `Evil*/Col`')
  }
})

it('remove deletes the config with its columns (soft); the table is importable again', async () => {
  const {
    ids: [id],
  } = await run(() => svc.import(['demo_book']))
  await run(() => svc.remove([id!]))
  expect(await configCount()).toBe(0)
  expect(
    (await ds.query('SELECT COUNT(*) AS n FROM cg_column WHERE deleted_at IS NULL'))[0].n,
  ).toBe(0)
  expect((await ds.query('SELECT COUNT(*) AS n FROM cg_column'))[0].n).toBeGreaterThan(0)
  expect((await run(() => svc.importable())).map((t) => t.tableName)).toContain('demo_book')
  expect(await rejection(run(() => svc.remove([id!])))).toBeInstanceOf(NotFoundException)
  expect(await rejection(run(() => svc.idOf('demo_book')))).toBeInstanceOf(NotFoundException)
})

describe('menu groups', () => {
  afterEach(clearGroups)
  /** A live group menu (tree_path kept by insertRow) under `parent` (0 = top level). */
  const group = (routeName: string | null, parent = 0, extra: object = {}) =>
    insertRow(ds.manager, 'iam_menu', {
      parent_id: parent,
      kind: 'group',
      route_name: routeName,
      name: routeName ?? 'pdz-null',
      route_path: `/${routeName ?? 'pdz-null'}`,
      ...extra,
    })
  const bizId = async (): Promise<number> =>
    (await ds.query("SELECT id FROM iam_menu WHERE route_name = 'biz' AND deleted_at IS NULL"))[0]
      .id
  /** The parent and hints `table` imports with (configs cleared first). */
  const imported = async (table: string) => {
    await clearCg()
    const {
      ids: [id],
      hints,
    } = await run(() => svc.import([table]))
    return [(await run(() => svc.detail(id!))).parentMenuRouteName, hints]
  }

  it('default parent: the longest pickable group of the leading name segments (never the whole name), else biz with a hint', async () => {
    const hint = (tableName: string, key: string) => ({ tableName, missing: 'parent_menu', key })
    expect(await imported('pdz_sale_order')).toEqual(['biz', [hint('pdz_sale_order', 'pdz')]])
    // a table of domain biz belongs there
    expect(await imported('pdzcourse')).toEqual(['biz', []])
    const pdz = await group('pdz', await bizId())
    expect(await imported('pdz_sale_order')).toEqual(['pdz', []])
    // a deeper group wins, unless a group above it has a route name outside the format
    const sale = await group('pdz-sale', await group('PDQ'))
    expect(await imported('pdz_sale_order')).toEqual(['pdz', []])
    await ds.query('DELETE FROM iam_menu WHERE id = ?', [sale])
    await group('pdz-sale', pdz)
    await group('pdz-sale-order', pdz)
    expect(await imported('pdz_sale_order')).toEqual(['pdz-sale', []])
    // the CLI's defaults of a table not imported: the same; a deleted group is none
    await clearCg()
    expect((await run(() => svc.defaults('pdz_sale_order'))).parentMenuRouteName).toBe('pdz-sale')
    await ds.query("UPDATE iam_menu SET deleted_at = NOW(3) WHERE route_name = 'pdz-sale'")
    expect((await run(() => svc.defaults('pdz_sale_order'))).parentMenuRouteName).toBe('pdz')
    // a built-in prefix's group, or biz when it is gone
    expect(await imported('iam_position')).toEqual(['system', []])
    await ds.query("UPDATE iam_menu SET deleted_at = NOW(3) WHERE route_name = 'system'")
    try {
      expect(await imported('iam_position')).toEqual(['biz', [hint('iam_position', 'system')]])
    } finally {
      await ds.query("UPDATE iam_menu SET deleted_at = NULL WHERE route_name = 'system'")
    }
  })

  it('parent menus: every live group, pickable when its route name and every ancestor one are in the format; save refuses the others (422 C3008)', async () => {
    const pdz = await group('pdz', await bizId())
    await group('pdz-sale', await group('PDQ'))
    await group(null)
    const flat = (nodes: CgParentMenuNode[]): CgParentMenuNode[] =>
      nodes.flatMap((n) => [n, ...flat(n.children)])
    const nodes = flat(await run(() => svc.parentMenus()))
    const state = (name: string) =>
      nodes.filter((n) => n.name === name).map((n) => [n.routeName, n.pickable, n.reason])
    expect(state('pdz')).toEqual([['pdz', true, null]])
    expect(state('PDQ')).toEqual([['PDQ', false, 'route_name']])
    expect(state('pdz-sale')).toEqual([['pdz-sale', false, 'ancestor']])
    expect(state('pdz-null')).toEqual([[null, false, 'route_name']])
    expect(nodes.find((n) => n.routeName === 'biz')!.children.map((n) => n.id)).toContain(pdz)

    const {
      ids: [id],
    } = await run(() => svc.import(['pdz_sale_order']))
    expect(await rejection(run(() => svc.save(id!, { parentMenuRouteName: 'pdz-sale' })))).toEqual(
      expect.objectContaining({ err: Err.CODEGEN_PARENT_MENU, params: { name: 'pdz-sale' } }),
    )
    await run(() => svc.save(id!, { parentMenuRouteName: 'pdz' }))
    expect((await run(() => svc.detail(id!))).parentMenuRouteName).toBe('pdz')
  })

  it('route name clash: the page route name of a group or action (live or deleted) or of its parent → 422 C3012 on save and render', async () => {
    const {
      ids: [id],
    } = await run(() => svc.import(['pdz_sale_order']))
    const clash = expect.objectContaining({
      err: Err.CODEGEN_ROUTE_NAME_CLASH,
      params: { name: 'pdz-sale-order' },
    })
    await run(() => svc.save(id!, { featureName: 'free' }))
    const taken = await group('pdz-sale-order')
    expect(await rejection(run(() => svc.save(id!, { featureName: 'taken' })))).toEqual(clash)
    expect(await rejection(run(() => svc.render([id!])))).toEqual(clash)
    for (const set of ['deleted_at = NOW(3)', "kind = 'action', deleted_at = NULL"]) {
      await ds.query(`UPDATE iam_menu SET ${set} WHERE id = ?`, [taken])
      expect(await rejection(run(() => svc.render([id!])))).toEqual(clash)
    }
    // the module's own page may exist
    await ds.query("UPDATE iam_menu SET kind = 'page' WHERE id = ?", [taken])
    await run(() => svc.save(id!, { featureName: 'page' }))
    // a parent of that name not in this database (menu-groups.seed.ts would add it)
    await ds.query('DELETE FROM iam_menu WHERE id = ?', [taken])
    const config = await run(() => svc.renderConfig(id!))
    expect(
      await rejection(
        run(() => svc.renderOne({ ...config, parentMenuRouteName: 'pdz-sale-order' } as never)),
      ),
    ).toEqual(clash)
  })

  it('registration: project.module.ts, SEEDS.project and the menu-groups.seed.ts lines of the project groups up to the first built-in one', async () => {
    const pdz = await group('pdz', await bizId(), {
      name: '进销存',
      name_i18n: { 'zh-CN': '进销存', 'en-US': 'ERP' },
      icon: 'lucide:package',
      sort_no: 50,
    })
    await group('pdz-sale', pdz, { name: 'Sales "zh"', sort_no: 10 })
    const {
      ids: [id],
    } = await run(() => svc.import(['pdz_sale_order']))
    expect((await run(() => svc.render([id!]))).registration).toEqual([
      'apps/server/src/modules/project.module.ts:',
      "  import { SaleOrderModule } from './pdz/sale-order/sale-order.module.js'  + SaleOrderModule in `imports`",
      'apps/server/src/db/seeds/index.ts:',
      "  import { seedSaleOrder } from '../../modules/pdz/sale-order/sale-order.seed.js'  + seedSaleOrder in SEEDS.project",
      'packages/shared/src/index.ts:',
      "  export * from './pdz/sale-order.schema.js'",
      'apps/server/src/db/seeds/project/menu-groups.seed.ts, in PROJECT_MENU_GROUPS (the groups not there yet, parents first):',
      '  { routeName: "pdz", parent: "biz", name: "进销存", nameI18n: { "zh-CN": "进销存", "en-US": "ERP" }, routePath: "/pdz", icon: "lucide:package", sortNo: 50 },',
      '  { routeName: "pdz-sale", parent: "pdz", name: "Sales \\"zh\\"", nameI18n: { "zh-CN": "Sales \\"zh\\"", "en-US": "Pdz sale" }, routePath: "/pdz-sale", icon: null, sortNo: 10 }, // en-US derived from the route name: check it',
    ])
  })
})
