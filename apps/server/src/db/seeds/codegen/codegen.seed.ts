// Generator configs of the G0 modules (see docs/design-notes.md#codegen): each `<table>.cg.ts` beside this file holds the
// edits on top of the import defaults (rules.ts, read from information_schema like `pnpm gen import`),
// applied like the config page's save (a field sent replaces the stored one). The seed stores the result
// in cg_table / cg_column by table / column name, so `pnpm gen render <table>` and `pnpm gen:check-golden`
// re-render the committed module from it. Every `*.cg.ts` here is a G0 module: registered in CG_SEEDS,
// rendered by gen:check-golden (a master_sub module's file holds its sub tables' configs too). Also the
// developer tools menu group (系统工具), home of the generator's pages: the generator page with its
// hidden edit page, the form builder, the API docs page (an iframe on the Swagger UI), the
// generated samples' group (db/seeds/demo), and an external link (the UI library's docs).
import { type CgTableUpdate, cgColumnFields, cgTableFields, codegenPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { readTableInfo } from '../../../core/db/schema-info.js'
import { assertFields, initConfig } from '../../../modules/platform/codegen/codegen.service.js'
import { hasDeletedAt, importHints } from '../../../modules/platform/codegen/rules.js'
import { findId, findRow, upsert } from '../upsert.js'
import { demoBookCg } from './demo_book.cg.js'
import { demoInvoiceCg, demoInvoiceLineCg } from './demo_invoice.cg.js'
import { demoTopicCg } from './demo_topic.cg.js'
import { iamPositionCg } from './iam_position.cg.js'

export interface CgSeed {
  tableName: string
  /** a sub table of a `master_sub` module: the master's table (seeded before it), stored as its config id */
  master?: string
  table: Omit<CgTableUpdate, 'columns' | 'masterTableId'>
  /** by column name */
  columns: Record<string, Omit<NonNullable<CgTableUpdate['columns']>[number], 'id'>>
}

/** Masters before their sub tables. */
export const CG_SEEDS: CgSeed[] = [
  iamPositionCg,
  demoBookCg,
  demoTopicCg,
  demoInvoiceCg,
  demoInvoiceLineCg,
]

/** Entity property → column (`featureNameI18n` → `feature_name_i18n`): cg_* columns are named so. */
const row = (config: object) =>
  Object.fromEntries(
    Object.entries(config).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]),
  )

/** Stores the config of `seed` (whitelisted like a save); returns the cg_table id. */
export async function seedCgConfig(q: EntityManager, seed: CgSeed): Promise<number> {
  const info = await readTableInfo(q, seed.tableName)
  if (!info) throw new Error(`codegen seed: no table ${seed.tableName}`)
  // a G0 table follows the soft-delete convention: what import only hints at is an error here
  const missing = [
    ...(hasDeletedAt(info) ? [] : ['deleted_at']),
    ...importHints(info).map((h) => h.key),
  ]
  if (missing.length)
    throw new Error(
      `codegen seed ${seed.tableName}: misses ${missing.join(', ')} (docs/codegen.md "New tables")`,
    )
  const { table, columns } = initConfig(info)
  const unknown = Object.keys(seed.columns).filter(
    (name) => !columns.some((c) => c.columnName === name),
  )
  if (unknown.length) throw new Error(`codegen seed ${seed.tableName}: no column(s) ${unknown}`)
  const masterTableId = seed.master
    ? await findId(q, 'cg_table', { table_name: seed.master })
    : null
  if (masterTableId === undefined)
    throw new Error(`codegen seed ${seed.tableName}: seed ${seed.master} first`)
  const { tableName, ...fields } = { ...table, ...seed.table, masterTableId }
  assertFields(cgTableFields, fields)
  // a config an administrator deleted stays deleted, its columns with it
  const stored = await findRow(q, 'cg_table', { table_name: tableName })
  if (stored?.deleted) return stored.id
  const id = await upsert(q, 'cg_table', { table_name: tableName }, row(fields))
  for (const column of columns) {
    const { columnName, ...config } = { ...column, ...seed.columns[column.columnName] }
    assertFields(cgColumnFields, config)
    const key = { table_id: id, column_name: columnName }
    // a column back in the table (sync soft-deleted it while a migration was reverted) gets its row
    // back, like sync does: column rows follow the table, no administrator deletes one (that
    // rule is about the config above)
    const found = await findRow(q, 'cg_column', key)
    if (found?.deleted)
      await q.query('UPDATE cg_column SET deleted_at = NULL WHERE id = ?', [found.id]) // qw:include-deleted
    await upsert(q, 'cg_column', key, row(config))
  }
  // columns the table no longer has: soft-deleted, like sync does
  await q.query(
    `UPDATE cg_column SET deleted_at = CURRENT_TIMESTAMP(3)
      WHERE table_id = ? AND column_name NOT IN (?) AND deleted_at IS NULL`,
    [id, columns.map((c) => c.columnName)],
  )
  return id
}

/** The generator page's actions; `modify` sits under the hidden edit page (granting it delivers the route). */
const ACTIONS: [perms: string, name: string][] = [
  [codegenPerms.browse, 'menu.action.browse'],
  [codegenPerms.view, 'menu.action.view'],
  [codegenPerms.import, 'menu.action.import'],
  [codegenPerms.remove, 'menu.action.remove'],
  [codegenPerms.generate, 'menu.action.generate'],
  [codegenPerms.write, 'menu.action.write'],
]

/**
 * The generator page (views/platform/codegen; see docs/design-notes.md#codegen) under 系统工具 and its hidden edit page
 * (`visible = 0`, "生成编辑"; see docs/design-notes.md#layering), upserted by route_name / perms; names in the page's web
 * fragment (codegen.table.json) and menu.json (menu.action.*).
 */
async function seedCodegenPages(q: EntityManager, groupId: number): Promise<void> {
  const pageId = await upsert(
    q,
    'iam_menu',
    { route_name: 'codegen-table' },
    {
      parent_id: groupId,
      kind: 'page',
      name: 'menu.codegen.table',
      route_path: '/codegen/tables',
      component: 'platform/codegen/index',
      component_name: 'CodegenTable',
      keep_alive: 1,
      icon: 'lucide:code-xml',
      sort_no: 10,
    },
  )
  for (const [i, [perms, name]] of ACTIONS.entries())
    await upsert(
      q,
      'iam_menu',
      { kind: 'action', perms },
      { parent_id: pageId, name, sort_no: (i + 1) * 10 },
    )
  const editId = await upsert(
    q,
    'iam_menu',
    { route_name: 'codegen-table-edit' },
    {
      parent_id: pageId,
      kind: 'page',
      name: 'menu.codegen.tableEdit',
      route_path: '/codegen/tables/:id',
      component: 'platform/codegen/edit',
      component_name: 'CodegenTableEdit',
      visible: 0,
      keep_alive: 0,
      icon: 'lucide:file-pen',
      sort_no: (ACTIONS.length + 1) * 10,
    },
  )
  await upsert(
    q,
    'iam_menu',
    { kind: 'action', perms: codegenPerms.modify },
    { parent_id: editId, name: 'menu.action.modify', sort_no: 10 },
  )
}

export async function seedCodegen(q: EntityManager): Promise<string[]> {
  const groupId = await upsert(
    q,
    'iam_menu',
    { route_name: 'devtools' },
    {
      parent_id: 0,
      kind: 'group',
      name: 'menu.devtools.title',
      route_path: '/devtools',
      icon: 'lucide:wrench',
      sort_no: 30,
    },
  )
  await seedCodegenPages(q, groupId)
  // the form builder (see docs/design-notes.md#workflow): no keep-alive, the designer's hotkeys (ctrl+p preview,
  // ctrl+backspace delete, …) listen on the document while it is mounted
  await upsert(
    q,
    'iam_menu',
    { route_name: 'formkit-design' },
    {
      parent_id: groupId,
      kind: 'page',
      name: 'menu.formkit.design',
      route_path: '/formkit/design',
      component: 'platform/formkit/index',
      component_name: 'FormkitDesign',
      keep_alive: 0,
      icon: 'lucide:clipboard-pen-line',
      sort_no: 15,
    },
  )
  // the Swagger UI in an iframe; GET /menus drops it while SWAGGER_ENABLED is off (core/auth/menu-features.ts)
  await upsert(
    q,
    'iam_menu',
    { route_name: 'devtools-api-docs' },
    {
      parent_id: groupId,
      kind: 'page',
      name: 'menu.devtools.apiDocs',
      route_path: '/devtools/api-docs',
      component_name: 'DevtoolsApiDocs',
      link_type: 'iframe',
      link_url: '/api/docs',
      keep_alive: 1,
      icon: 'lucide:braces',
      sort_no: 20,
    },
  )
  // the sample external link (menus: `link_type` external opens a new tab, no route)
  await upsert(
    q,
    'iam_menu',
    { route_name: 'devtools-ui-docs' },
    {
      parent_id: groupId,
      kind: 'page',
      name: 'menu.devtools.uiDocs',
      link_type: 'external',
      link_url: 'https://element-plus.org/',
      icon: 'lucide:book-open-text',
      sort_no: 30,
    },
  )
  for (const seed of CG_SEEDS) await seedCgConfig(q, seed)
  return []
}
