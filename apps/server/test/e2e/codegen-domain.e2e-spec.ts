// Project domains end to end (a temporary ERP table): a project table of a domain of
// its own, from the menu page to a fresh install, in the test database only. A temporary erp_sale_order
// (deleted_at, alive) and the groups erp (top level) and erp-sale (销售管理), built as in the menu page;
// import (`pnpm gen import`) → domain erp, business sale-order, parent erp-sale; render like
// `pnpm gen render --out` into a temp directory outside the repository; then, every menu gone (a fresh
// database), the built-in seeds plus the printed menu-groups.seed.ts lines (a temporary definition) and
// the generated module seed rebuild the group chain with the page and its actions. afterAll drops the
// table, the temp directory and every row this spec made, and puts iam_menu / iam_role_menus back row for
// row (ids included; a reseed would not: seedIam grants `home` to `member` only when it creates the role):
// no ERP code or data stays anywhere.
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Test, type TestingModule } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ClsService } from 'nestjs-cls'
import type { DataSource, EntityManager } from 'typeorm'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreDbModule } from '../../src/core/db/db.module.js'
import { runSeeds } from '../../src/db/seeds/index.js'
import {
  PROJECT_MENU_GROUPS,
  type ProjectMenuGroup,
} from '../../src/db/seeds/project/menu-groups.seed.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { CodegenServiceModule } from '../../src/modules/platform/codegen/codegen.module.js'
import { CodegenService } from '../../src/modules/platform/codegen/codegen.service.js'
import { repoRoot, writeCopy } from '../../src/modules/platform/codegen/workspace.js'

const TABLE = 'erp_sale_order'
const GROUPS = ['erp', 'erp-sale']
const PAGE = 'erp-sale-order'
const ROOT = repoRoot()
const MODULE = 'apps/server/src/modules/erp/sale-order/sale-order'
const GROUPS_FILE = 'apps/server/src/db/seeds/project/menu-groups.seed.ts'
const PROJECT_GROUPS_BEFORE = PROJECT_MENU_GROUPS.length

let moduleRef: TestingModule
let ds: DataSource
let cls: ClsService
let svc: CodegenService
/** the temp directory the module is rendered to, and its linked directories / copied files */
let dir: string | undefined
const links: string[] = []
/** the menu tables the case empties, copied to `test_pd_<table>` in beforeAll */
const SAVED = ['iam_menu', 'iam_role_menus']
let saved = false

const run = <T>(fn: () => Promise<T>) => cls.run(fn)

/** The two groups as the menu page holds them, each with its parent's route name. */
const groupRows = () =>
  ds.query(
    'SELECT g.route_name AS routeName, p.route_name AS parent, g.name, g.name_i18n AS nameI18n,' +
      ' g.route_path AS routePath, g.icon, g.sort_no AS sortNo' +
      ' FROM iam_menu g LEFT JOIN iam_menu p ON p.id = g.parent_id' +
      " WHERE g.route_name IN (?) AND g.kind = 'group' AND g.deleted_at IS NULL ORDER BY g.id",
    [GROUPS],
  )

/**
 * What the rendered seed and schema import from the repository, linked or copied: the other entries
 * of the two source roots (`db/seeds/upsert.ts`, shared `common/`, `validation/`) and shared's
 * node_modules (zod). Only after `writeCopy`, so nothing is ever written through a link.
 */
function linkRepo(out: string) {
  const link = (target: string, path: string) => {
    if (statSync(target).isDirectory()) symlinkSync(target, path, 'junction')
    else cpSync(target, path)
    links.push(path)
  }
  for (const src of ['apps/server/src', 'packages/shared/src'])
    for (const name of readdirSync(join(ROOT, src)))
      if (!existsSync(join(out, src, name))) link(join(ROOT, src, name), join(out, src, name))
  link(join(ROOT, 'packages/shared/node_modules'), join(out, 'packages/shared/node_modules'))
}

/** This spec's table, configs, menus (with any grant of them) and files, for good. */
async function cleanup() {
  PROJECT_MENU_GROUPS.splice(PROJECT_GROUPS_BEFORE)
  // the links first: removing the directory then never reaches the repository behind them
  for (const path of links.splice(0)) unlinkSync(path)
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  await ds.query(`DROP TABLE IF EXISTS ${TABLE}`)
  const configs = await ds.query('SELECT id FROM cg_table WHERE table_name = ?', [TABLE])
  for (const { id } of configs) {
    await ds.query('DELETE FROM cg_column WHERE table_id = ?', [id])
    await ds.query('DELETE FROM cg_table WHERE id = ?', [id])
  }
  const menus: { id: number }[] = await ds.query(
    "SELECT id FROM iam_menu WHERE route_name IN (?) OR perms LIKE 'erp.%'",
    [[...GROUPS, PAGE]],
  )
  if (!menus.length) return
  const ids = menus.map((m) => m.id)
  await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [ids])
  await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [ids])
}

/** The menu tables back exactly as copied (generated columns left out), the copies dropped. */
async function restoreMenus() {
  await ds.query('DELETE FROM iam_role_menus')
  await ds.query('DELETE FROM iam_menu')
  for (const t of SAVED) {
    const cols: { c: string }[] = await ds.query(
      'SELECT column_name AS c FROM information_schema.columns' +
        " WHERE table_schema = DATABASE() AND table_name = ? AND extra NOT LIKE '%GENERATED%'",
      [t],
    )
    const list = cols.map(({ c }) => `\`${c}\``).join(', ')
    await ds.query(`INSERT INTO ${t} (${list}) SELECT ${list} FROM test_pd_${t}`)
    await ds.query(`DROP TABLE test_pd_${t}`)
  }
}

beforeAll(async () => {
  moduleRef = await Test.createTestingModule({
    imports: [CoreContextModule, CoreDbModule, CodegenServiceModule],
  }).compile()
  await moduleRef.init()
  ds = moduleRef.get(getDataSourceToken())
  cls = moduleRef.get(ClsService)
  svc = moduleRef.get(CodegenService)
  await cleanup()
  for (const t of SAVED) {
    await ds.query(`DROP TABLE IF EXISTS test_pd_${t}`)
    await ds.query(`CREATE TABLE test_pd_${t} AS SELECT * FROM ${t}`)
  }
  saved = true
  await ds.query(`CREATE TABLE ${TABLE} (
    id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '订单 ID',
    order_no varchar(32) NOT NULL COMMENT '订单号',
    customer_name varchar(100) NOT NULL COMMENT '客户名称',
    amount decimal(12,2) NOT NULL DEFAULT 0 COMMENT '金额',
    created_by bigint unsigned NULL COMMENT '创建人',
    created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间',
    updated_by bigint unsigned NULL COMMENT '更新人',
    updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间',
    deleted_at datetime(3) NULL COMMENT '删除时间',
    alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1',
    PRIMARY KEY (id),
    UNIQUE KEY uk_erp_sale_order_order_no (order_no, alive)
  ) COMMENT='销售订单'`)
})

afterAll(async () => {
  if (ds?.isInitialized) {
    await cleanup()
    // the menus and grants as they were (the case empties them), none of this spec's
    if (saved) await restoreMenus()
  }
  await moduleRef?.close()
})

it('erp_sale_order: import → erp / sale-order under erp-sale, rendered outside the repository; on a fresh database the seeds with the printed group lines build the chain, the page and its actions', async () => {
  // the groups, built in the menu page (菜单管理)
  const erp = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    route_name: 'erp',
    name: '企业资源',
    name_i18n: { 'zh-CN': '企业资源', 'en-US': 'ERP' },
    route_path: '/erp',
    icon: 'lucide:factory',
    sort_no: 60,
  })
  await insertRow(ds.manager, 'iam_menu', {
    parent_id: erp,
    kind: 'group',
    route_name: 'erp-sale',
    name: '销售管理',
    name_i18n: { 'zh-CN': '销售管理', 'en-US': 'Sales' },
    route_path: '/erp/sale',
    sort_no: 10,
  })
  const built = await groupRows()
  expect(built.map((g: ProjectMenuGroup) => [g.routeName, g.parent])).toEqual([
    ['erp', null],
    ['erp-sale', 'erp'],
  ])

  // `pnpm gen import erp_sale_order`: domain and business from the table name, the longest group
  const {
    ids: [id],
    hints,
  } = await run(() => svc.import([TABLE]))
  expect(hints).toEqual([])
  expect(await run(() => svc.detail(id!))).toMatchObject({
    groupCode: 'biz',
    domain: 'erp',
    business: 'sale-order',
    className: 'SaleOrder',
    parentMenuRouteName: 'erp-sale',
  })

  // `pnpm gen render erp_sale_order --out <temp>`: the files, none of them in the repository
  const { files, registration } = await run(() => svc.render([id!]))
  const paths = files.map((f) => f.path)
  expect(paths).toEqual(
    expect.arrayContaining([
      `${MODULE}.controller.ts`,
      `${MODULE}.seed.ts`,
      'packages/shared/src/erp/sale-order.schema.ts',
      'apps/web/src/api/erp/sale-order.ts',
      'apps/web/src/views/erp/sale-order/index.vue',
      'apps/web/src/locales/zh-CN/erp.sale-order.json',
      'apps/server/test/e2e/erp-sale-order.e2e-spec.ts',
    ]),
  )
  expect(paths.filter((p) => p.includes('biz/') || existsSync(join(ROOT, p)))).toEqual([])
  const content = (path: string) => files.find((f) => f.path === path)!.content
  expect(content(`${MODULE}.controller.ts`)).toContain("@Controller('erp/sale-orders')")
  expect(content('apps/web/src/api/erp/sale-order.ts')).toContain("const BASE = '/erp/sale-orders'")
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'qw-pd-erp-')))
  writeCopy(ROOT, dir, files)
  expect(paths.filter((p) => existsSync(join(ROOT, p)))).toEqual([])

  // the registration: project.module.ts, SEEDS.project, the shared export, then both groups' lines
  expect(registration.slice(0, 6)).toEqual([
    'apps/server/src/modules/project.module.ts:',
    "  import { SaleOrderModule } from './erp/sale-order/sale-order.module.js'  + SaleOrderModule in `imports`",
    'apps/server/src/db/seeds/index.ts:',
    "  import { seedSaleOrder } from '../../modules/erp/sale-order/sale-order.seed.js'  + seedSaleOrder in SEEDS.project",
    'packages/shared/src/index.ts:',
    "  export * from './erp/sale-order.schema.js'",
  ])
  expect(registration[6]).toMatch(new RegExp(`^${GROUPS_FILE}, in PROJECT_MENU_GROUPS`))
  const groupLines = registration.slice(7)
  expect(groupLines).toHaveLength(2)
  // pasted into a temporary definition (the file itself stays empty)
  writeFileSync(join(dir, 'menu-groups.ts'), `export default [\n${groupLines.join('\n')}\n]\n`)
  const groups = (await import(pathToFileURL(join(dir, 'menu-groups.ts')).href))
    .default as ProjectMenuGroup[]

  // the generated seed, run from the copy; `@qiwu/shared` stands for the printed shared export
  linkRepo(dir)
  const seedFile = join(dir, `${MODULE}.seed.ts`)
  const schema = relative(
    dirname(seedFile),
    join(dir, 'packages/shared/src/erp/sale-order.schema.js'),
  ).replaceAll('\\', '/')
  const source = readFileSync(seedFile, 'utf8')
  expect(source).toContain("from '@qiwu/shared'")
  writeFileSync(seedFile, source.replace("from '@qiwu/shared'", `from '${schema}'`))
  const { seedSaleOrder } = (await import(pathToFileURL(seedFile).href)) as {
    seedSaleOrder: (q: EntityManager) => Promise<string[]>
  }

  // a fresh database: no menu at all, then the built-in seeds
  await ds.query('DELETE FROM iam_role_menus')
  await ds.query('DELETE FROM iam_menu')
  await runSeeds(ds)
  // without the group lines the module seed points at menu-groups.seed.ts
  await expect(ds.transaction(seedSaleOrder)).rejects.toThrow(
    `seedSaleOrder: the erp-sale menu group is missing: add it to ${GROUPS_FILE}`,
  )
  // SEEDS.project: the groups (the pasted lines), then the module
  PROJECT_MENU_GROUPS.push(...groups)
  await runSeeds(ds)
  expect(await ds.transaction(seedSaleOrder)).toEqual([])

  // the same chain as built by hand, the page under 销售管理 and its actions
  expect(await groupRows()).toEqual(built)
  const [page] = await ds.query(
    'SELECT p.id, p.kind, p.name, p.route_path AS routePath, p.component, g.name AS parent' +
      ' FROM iam_menu p JOIN iam_menu g ON g.id = p.parent_id' +
      ' WHERE p.route_name = ? AND p.deleted_at IS NULL',
    [PAGE],
  )
  expect(page).toMatchObject({
    kind: 'page',
    name: 'menu.erp.saleOrder',
    routePath: '/erp/sale-orders',
    component: 'erp/sale-order/index',
    parent: '销售管理',
  })
  // the page's name key is the module's web locale fragment's (the view at `component` rendered too)
  expect(
    JSON.parse(content('apps/web/src/locales/zh-CN/erp.sale-order.json')).menu.erp.saleOrder,
  ).toBe('销售订单')
  // one action per perm of the generated schema (the resource camelCase like `audit.actionLog.*`; no
  // import: `with_import` is off by default)
  const actions: { id: number; perms: string }[] = await ds.query(
    "SELECT id, perms FROM iam_menu WHERE parent_id = ? AND kind = 'action' AND deleted_at IS NULL ORDER BY sort_no",
    [page.id],
  )
  expect(actions.map((a) => a.perms)).toEqual(
    ['browse', 'view', 'create', 'modify', 'remove', 'export'].map(
      (verb) => `erp.saleOrder.${verb}`,
    ),
  )
  // granted to no role: that is done in role management
  const granted = await ds.query('SELECT role_id FROM iam_role_menus WHERE menu_id IN (?)', [
    [page.id, ...actions.map((a) => a.id)],
  ])
  expect(granted).toEqual([])
})
