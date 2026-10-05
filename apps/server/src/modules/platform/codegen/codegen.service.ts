import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  CG_IDENT,
  CG_RESERVED,
  cgDomainAllowed,
  type CgFileLanguage,
  type CgImportVo,
  type CgParentMenuNode,
  type CgPreviewVo,
  cgColumnFields,
  type CgTableQuery,
  cgTableFields,
  type CgTableUpdate,
  cgTableUpdate,
  Err,
} from '@qiwu/shared'
import { IsNull, Not, type SelectQueryBuilder } from 'typeorm'
import type { z } from 'zod'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { contains } from '../../../core/db/page.js'
import { softDeleteRows } from '../../../core/db/references.js'
import { readTableInfo, type TableInfo } from '../../../core/db/schema-info.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { CgColumn } from './cg-column.entity.js'
import { CgTable } from './cg-table.entity.js'
import { assertTemplateColumns, crudRegistration, type RenderConfig, renderCrud } from './crud.js'
import { defaultParent, groupForest, groupLines, liveGroups, pickableGroups } from './groups.js'
import type { RenderedFile } from './render.js'
import {
  assertDeletedAt,
  assertNamesFree,
  type ColumnConfig,
  type ColumnFacts,
  EXCLUDED_TABLE,
  freeName,
  importHints,
  initColumn,
  initTable,
  qualifyNames,
  requiredByRule,
  type TableConfig,
} from './rules.js'
import { hasMobile } from './workspace.js'

export interface ImportableTable {
  tableName: string
  tableComment: string
  /** no `deleted_at` column: import refuses it (422 C3010) */
  noDeletedAt: boolean
}

export interface SyncResult {
  /** new DB columns, appended with the rules' defaults */
  added: string[]
  /** columns gone from the table, their config deleted */
  removed: string[]
  /**
   * columns whose type, comment, default, nullability or key changed (manual config kept; `required`
   * follows the new facts unless it was edited by hand)
   */
  changed: string[]
}

export type CgTableDetail = CgTable & { columns: CgColumn[] }

/** The files of one or more configs and the lines to register their modules by hand. */
export interface Rendered {
  files: RenderedFile[]
  registration: string[]
}

/** shiki language of a generated file (the preview's code viewer), by extension. */
const LANGUAGES: Record<string, CgFileLanguage> = {
  ts: 'typescript',
  vue: 'vue',
  json: 'json',
}
const languageOf = (path: string): CgFileLanguage =>
  LANGUAGES[path.slice(path.lastIndexOf('.') + 1)] ?? 'typescript'

/** The DB facts sync refreshes; everything else of a column is config the user owns. */
const FACTS: (keyof ColumnFacts)[] = [
  'columnType',
  'columnComment',
  'columnDefault',
  'nullable',
  'isPk',
  'isAutoInc',
]

/** Validates the editable part (the schema's keys) of a derived config that also holds DB facts. */
export const assertFields = (schema: z.ZodObject, config: object) =>
  parseOr400(
    schema,
    Object.fromEntries(
      Object.keys(schema.shape).map((k) => [k, (config as Record<string, unknown>)[k]]),
    ),
  )

/** A table / column name from information_schema that templates may use (whitelist; see docs/design-notes.md#codegen). */
function assertDbName(name: string): void {
  if (!CG_IDENT.dbName.test(name))
    throw new BizError(Err.CODEGEN_IDENTIFIER_INVALID, { name: name.slice(0, 64) })
}

/** rules.ts defaults of a table, every name and derived identifier whitelisted (import, the cg seeds). */
export function initConfig(info: TableInfo): { table: TableConfig; columns: ColumnConfig[] } {
  assertDbName(info.name)
  const table = initTable(info)
  assertFields(cgTableFields, table)
  return { table, columns: initColumns(info, table) }
}

/**
 * rules.ts defaults of the imported columns (generated ones are skipped), whitelisted; field names made
 * unique within the table (`a_b` and `a__b`, `default` and `default_value`).
 */
function initColumns(
  info: TableInfo,
  { domain, business }: Pick<TableConfig, 'domain' | 'business'>,
): ColumnConfig[] {
  const columns: ColumnConfig[] = []
  const used = new Set<string>()
  for (const col of info.columns) {
    const config = initColumn(col, domain, (columns.length + 1) * 10, business)
    if (!config) continue
    config.fieldName = freeName(config.fieldName, used)
    assertDbName(col.name)
    assertFields(cgColumnFields, config)
    columns.push(config)
  }
  return columns
}

/**
 * Generator config (see docs/design-notes.md#codegen): imports tables of the connected schema with the rules.ts
 * defaults, syncs them with later DDL changes, saves edits (whitelisted) and deletes configs (the
 * base `remove`). Table and column names only ever come from information_schema: a requested name is
 * matched against the listed ones, never put into SQL.
 */
@Injectable()
export class CodegenService extends BaseCrudService<CgTable> {
  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>) {
    super(txHost, CgTable)
  }

  private get columns() {
    return this.txHost.tx.getRepository(CgColumn)
  }

  /** GET / filters: table name and comment contain (wildcards literal). */
  protected override filter(
    qb: SelectQueryBuilder<CgTable>,
    { tableName, tableComment }: CgTableQuery,
  ): SelectQueryBuilder<CgTable> {
    if (tableName) qb.andWhere('t.table_name LIKE :tableName', { tableName: contains(tableName) })
    if (tableComment)
      qb.andWhere('t.table_comment LIKE :tableComment', { tableComment: contains(tableComment) })
    return qb
  }

  /**
   * Base tables of this schema that can be imported: no framework table, none imported yet; the ones
   * without `deleted_at` marked (`noDeletedAt`: import refuses them).
   */
  async importable(): Promise<ImportableTable[]> {
    const tables: { tableName: string; tableComment: string; noDeletedAt: number | string }[] =
      await this.txHost.tx.query(
        'SELECT t.table_name AS tableName, t.table_comment AS tableComment, NOT EXISTS (SELECT 1' +
          ' FROM information_schema.columns c WHERE c.table_schema = t.table_schema' +
          " AND c.table_name = t.table_name AND c.column_name = 'deleted_at') AS noDeletedAt" +
          " FROM information_schema.tables t WHERE t.table_schema = DATABASE() AND t.table_type = 'BASE TABLE'" +
          ' ORDER BY t.table_name',
      )
    const imported = new Set(
      (await this.repo.find({ select: { tableName: true } })).map((t) => t.tableName),
    )
    return tables
      .filter((t) => !EXCLUDED_TABLE.test(t.tableName) && !imported.has(t.tableName))
      .map((t) => ({ ...t, noDeletedAt: Number(t.noDeletedAt) === 1 }))
  }

  /**
   * Imports `tableNames` (each must be listed by `importable`, exact name) with the rules.ts defaults,
   * all or none (one without `deleted_at` → 422 C3010, nothing imported). Returns the new config ids in
   * order and the hints (`importHints`, a missing default parent group: imported anyway).
   */
  import(tableNames: readonly string[]): Promise<CgImportVo> {
    return this.txHost.withTransaction(async () => {
      const available = new Set((await this.importable()).map((t) => t.tableName))
      const out: CgImportVo = { ids: [], hints: [] }
      for (const name of new Set(tableNames)) {
        const { table, columns, hints } = await this.initImportable(name, available)
        const { id } = await this.repo.save(this.repo.create(table))
        if (columns.length) await this.columns.insert(columns.map((c) => ({ ...c, tableId: id })))
        out.ids.push(id)
        out.hints.push(...hints)
      }
      return out
    })
  }

  /**
   * The config `import` would store for `tableName` (listed by `importable`), not saved: what the CLI
   * renders for a table not imported yet. Ids are placeholders (0 for the table, columns 1…n).
   */
  async defaults(tableName: string): Promise<CgTableDetail> {
    const available = new Set((await this.importable()).map((t) => t.tableName))
    const { table, columns } = await this.initImportable(tableName, available)
    return Object.assign(this.repo.create({ ...table, id: 0 }), {
      columns: columns.map((c, i) => this.columns.create({ ...c, id: i + 1, tableId: 0 })),
    })
  }

  /**
   * rules.ts defaults of an importable table, its class name qualified beside the stored configs' and
   * the other importable tables' derivations (`qualifyNames`: 422 C3011 when still taken by a config),
   * its parent the longest matching group of this database (`defaultParent`, `biz` with a
   * hint when none); not in `available` (or gone meanwhile) → 422 C3001, no `deleted_at` → 422 C3010.
   */
  private async initImportable(name: string, available: Set<string>) {
    const info = available.has(name) ? await readTableInfo(this.txHost.tx, name) : null
    if (!info) throw new BizError(Err.CODEGEN_TABLE_UNAVAILABLE, { table: name.slice(0, 64) })
    const { table, columns } = initConfig(info)
    assertDeletedAt(info)
    const tables = [...available]
      .filter((n) => n !== name)
      .map((n) => initTable({ name: n, comment: '' }))
    const { parent, hint } = defaultParent(table, await this.pickableGroups())
    return {
      table: { ...qualifyNames(table, await this.names(), tables), parentMenuRouteName: parent },
      columns,
      hints: [...importHints(info), ...(hint ? [hint] : [])],
    }
  }

  /** Route names of the groups a generated page may hang under (`GET /parent-menus` pickable). */
  private async pickableGroups(): Promise<Set<string>> {
    return pickableGroups(groupForest(await liveGroups(this.txHost.tx)))
  }

  /** The names of every stored config but `id` (`qualifyNames`, `assertNamesFree`). */
  private names(id = 0) {
    return this.repo.find({
      select: { tableName: true, domain: true, business: true, className: true },
      where: { id: Not(id) },
    })
  }

  /** A config with its columns in sort order; missing → 404. */
  async detail(id: number): Promise<CgTableDetail> {
    const table = await this.get(id)
    const columns = await this.columns.find({
      where: { tableId: id },
      order: { sortNo: 'ASC', id: 'ASC' },
    })
    return Object.assign(table, { columns })
  }

  /** What renders config `id`: its detail; a `master_sub` master's with its sub tables' (config id order). */
  async renderConfig(id: number): Promise<RenderConfig> {
    const t = await this.detail(id)
    if (t.template !== 'master_sub') return t
    const subs: CgTableDetail[] = []
    for (const { id: subId } of await this.repo.find({
      select: { id: true },
      where: { masterTableId: id },
      order: { id: 'ASC' },
    }))
      subs.push(await this.detail(subId))
    return Object.assign(t, { subs })
  }

  /**
   * The files of configs `ids` (each once, in order: a master-sub master with its sub tables) and their
   * registration lines, all rendered before any is used; a config the templates refuse → 422 C3002 /
   * C3003 / C3004 / C3007, a table without `deleted_at` → 422 C3010 (`renderOne`), an unknown id → 404, two configs rendering one path (same group, domain and
   * business) → 422 C3006.
   */
  async render(ids: readonly number[]): Promise<Rendered> {
    const out: Rendered = { files: [], registration: [] }
    for (const id of new Set(ids)) {
      const { files, registration } = await this.renderOne(await this.renderConfig(id))
      out.files.push(...files)
      out.registration.push(...registration)
    }
    const seen = new Set<string>()
    for (const { path } of out.files) {
      if (seen.has(path)) throw new BizError(Err.CODEGEN_PATH_CONFLICT, { path })
      seen.add(path)
    }
    return out
  }

  /**
   * The files of one config (stored, or the CLI's import defaults) and its registration: the module and
   * seed lines (`crudRegistration`) and the menu-groups.seed.ts lines of its parent chain, read from this
   * database (`groupLines`; the files never depend on it). Its table or a sub table gone → 422 C3001,
   * without `deleted_at` (dropped since the import) → 422 C3010; a page route name taken → 422 C3012.
   */
  async renderOne(config: RenderConfig): Promise<Rendered> {
    for (const { tableName } of [config, ...(config.subs ?? [])]) {
      const info = await readTableInfo(this.txHost.tx, tableName)
      if (!info) throw new BizError(Err.CODEGEN_TABLE_UNAVAILABLE, { table: tableName })
      assertDeletedAt(info)
    }
    await this.assertRouteNameFree(config)
    // the uni-app pages of a withMobile config: only where the repository has the client
    const mobile = hasMobile()
    return {
      files: await renderCrud(config, mobile),
      registration: [
        ...crudRegistration(config, mobile),
        ...groupLines(await liveGroups(this.txHost.tx), config.parentMenuRouteName),
      ],
    }
  }

  /**
   * The generated page's route name (`<domain>-<business>`) is no group's or action's (live
   * or deleted: its seed upserts the page by that name and would take the row over) and not its parent's
   * (the chain above it is groups); else 422 C3012.
   */
  private async assertRouteNameFree(
    t: Pick<CgTable, 'domain' | 'business' | 'parentMenuRouteName'>,
  ) {
    const name = `${t.domain}-${t.business}`
    const [taken] = await this.txHost.tx.query(
      // qw:include-deleted a deleted row still holds its route name for the seeds
      "SELECT id FROM iam_menu WHERE route_name = ? AND kind <> 'page' LIMIT 1",
      [name],
    )
    if (taken || name === t.parentMenuRouteName)
      throw new BizError(Err.CODEGEN_ROUTE_NAME_CLASH, { name })
  }

  /** GET /:id/preview: what `pnpm gen render` prints for config `id`, each file with its language. */
  async preview(id: number): Promise<CgPreviewVo> {
    const { files, registration } = await this.render([id])
    return { files: files.map((f) => ({ ...f, language: languageOf(f.path) })), registration }
  }

  /**
   * GET /parent-menus: every live group menu as a forest, siblings by `sort_no, id`, each marked pickable
   * or not (`groupForest`). Read straight from iam_menu (read-only; the menu module's lists are scoped to
   * the menu page's own perms).
   */
  async parentMenus(): Promise<CgParentMenuNode[]> {
    return groupForest(await liveGroups(this.txHost.tx))
  }

  /** Config id of an imported table; not imported → 404. */
  async idOf(tableName: string): Promise<number> {
    const row = await this.repo.findOne({ select: { id: true }, where: { tableName } })
    if (!row) throw new NotFoundException()
    return row.id
  }

  /**
   * Saves edits (`cgTableUpdate`: the table fields and the columns by id sent are changed, the rest
   * kept). Anything outside the whitelist → 400 and nothing is saved; a class or field name the templates
   * use already (CG_RESERVED) or a reserved project domain (`cgDomainAllowed`) → 422 C3002; the class
   * name or module (domain + business) of another config → 422 C3011 (`assertNamesFree`); a parent menu
   * that is no pickable group (`GET /parent-menus`) → 422 C3008; a page route name taken (a group's, an
   * action's, the parent's) → 422 C3012 (`assertRouteNameFree`); a
   * `referencedBy` column not in this database or of a table without `deleted_at` → 422 C3009; a column of
   * another table → 404; options without a label
   * column → 422 C3003, a tree without its columns → 422 C3004, a bad master-sub link → 422 C3007
   * (`assertTemplateColumns`, the master's template, `releaseLinks`), nothing saved either.
   */
  async save(id: number, body: unknown): Promise<void> {
    const { columns, ...fields } = parseOr400(cgTableUpdate, body)
    for (const name of [fields.className, ...(columns ?? []).map((c) => c.fieldName)])
      if (name && (CG_RESERVED.className.has(name) || CG_RESERVED.fieldName.has(name)))
        throw new BizError(Err.CODEGEN_IDENTIFIER_INVALID, { name })
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const before = await this.repo.findOneByOrFail({ id })
      const refuse = () =>
        new BizError(Err.CODEGEN_SUB_TABLES, { table: before.tableName.slice(0, 64) })
      // a sub's master: another live config of template master_sub (FOR SHARE: kept until this commits,
      // a delete of it waits and then sees the link: 409 in_use); unknown or deleted → 422 like the rest
      if (fields.masterTableId) {
        const master = await this.repo.findOne({
          select: { id: true, template: true },
          where: { id: fields.masterTableId },
          lock: { mode: 'pessimistic_read' },
        })
        if (master?.template !== 'master_sub') throw refuse()
      }
      // the page's parent: a pickable group (what the menu seed looks for, its chain printable)
      if (
        fields.parentMenuRouteName &&
        !(await this.pickableGroups()).has(fields.parentMenuRouteName)
      )
        throw new BizError(Err.CODEGEN_PARENT_MENU, { name: fields.parentMenuRouteName })
      // references: a column of a table of this database with deleted_at (the delete's check
      // reads its live rows), never a name typed into generated SQL unchecked
      for (const { table, column } of fields.options?.referencedBy ?? []) {
        const [{ n }] = await this.txHost.tx.query(
          'SELECT COUNT(*) AS n FROM information_schema.columns' +
            ' WHERE table_schema = DATABASE() AND table_name = ? AND column_name IN (?, ?)',
          [table, column, 'deleted_at'],
        )
        if (Number(n) < 2) throw new BizError(Err.CODEGEN_REFERENCE, { table, column })
      }
      if (Object.keys(fields).length) await this.repo.update(id, fields)
      if (columns?.length) await this.saveColumns(id, columns)
      const after = await this.detail(id)
      if (!cgDomainAllowed(after.groupCode, after.domain))
        throw new BizError(Err.CODEGEN_IDENTIFIER_INVALID, { name: after.domain })
      assertNamesFree(after, await this.names(id))
      await this.assertRouteNameFree(after)
      await this.releaseLinks(before, after, refuse)
      assertTemplateColumns(after)
    })
  }

  /**
   * Links a save gives up (422 C3007 via `refuse`): a master switched to another template releases its
   * sub tables; a sub never leaves a `master_sub` master without any (the master locked first, so two
   * subs leaving at once see each other). A master saved before its first sub is linked (the page links
   * a sub from the sub's side) renders only once one is (render: 422 C3007).
   * A sub and its master saved at the same moment can deadlock (sub → master vs master → its
   * subs); InnoDB aborts one of them.
   */
  private async releaseLinks(before: CgTable, after: CgTableDetail, refuse: () => BizError) {
    if (before.template === 'master_sub' && after.template !== 'master_sub')
      await this.repo.update({ masterTableId: after.id }, { masterTableId: null, subFkCol: null })
    const left = before.masterTableId
    if (left === null || left === after.masterTableId) return
    const master = await this.repo.findOne({
      select: { id: true, template: true },
      where: { id: left },
      lock: { mode: 'pessimistic_write' },
    })
    const rest = await this.repo.count({
      where: { masterTableId: left },
      lock: { mode: 'pessimistic_read' },
    })
    if (master?.template === 'master_sub' && rest === 0) throw refuse()
  }

  /** The columns sent (by id) of config `id`; a column of another table → 404. */
  private async saveColumns(id: number, columns: NonNullable<CgTableUpdate['columns']>) {
    const own = new Set(
      (await this.columns.find({ select: { id: true }, where: { tableId: id } })).map((c) => c.id),
    )
    if (columns.some((c) => !own.has(c.id))) throw new NotFoundException()
    for (const { id: columnId, ...set } of columns)
      if (Object.keys(set).length) await this.columns.update(columnId, set)
  }

  /**
   * Re-reads the table (see docs/design-notes.md#codegen): new columns are appended with the rules' defaults (one it had before
   * gets its soft-deleted config back, with the new facts), dropped ones soft-deleted, changed ones get
   * the new DB facts (a new type also its TS type) and keep their config; a
   * `required` still at the rule's value for the old facts (not edited by hand) follows the new ones.
   * The table gone from the database → 422 C3001, without `deleted_at` → 422 C3010; the config
   * stays as it was either way.
   */
  sync(id: number): Promise<SyncResult> {
    return this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const table = await this.repo.findOneByOrFail({ id })
      const info = await readTableInfo(this.txHost.tx, table.tableName)
      if (!info) throw new BizError(Err.CODEGEN_TABLE_UNAVAILABLE, { table: table.tableName })
      assertDeletedAt(info)
      const stored = await this.columns.findBy({ tableId: id })
      const fresh = initColumns(info, table)
      const names = new Set(fresh.map((c) => c.columnName))
      const result: SyncResult = { added: [], removed: [], changed: [] }

      // deletes (soft) first: a re-created column may reuse a dropped one's property name
      const gone = stored.filter((c) => !names.has(c.columnName))
      await softDeleteRows(
        this.txHost.tx,
        'cg_column',
        gone.map((c) => c.id),
      )
      result.removed = gone.map((c) => c.columnName)

      const byName = new Map(stored.map((c) => [c.columnName, c]))
      // a column back in the table (a migration reverted, then re-applied) gets its config back: the
      // last soft-deleted row of that name is restored with its manual settings, the new facts applied
      const dropped = new Map(
        (
          await this.columns.find({
            withDeleted: true,
            where: { tableId: id, deletedAt: Not(IsNull()) },
            order: { id: 'ASC' },
          })
        ).map((c) => [c.columnName, c]),
      )
      // a new column's property name must not be one a kept column has (maybe edited by hand)
      const used = new Set(stored.filter((c) => names.has(c.columnName)).map((c) => c.fieldName))
      let sortNo = Math.max(0, ...stored.map((c) => c.sortNo))
      /** The new DB facts for `old`; a new type also its TS type, a `required` still at the rule's value follows. */
      const refreshed = (old: CgColumn, col: (typeof fresh)[number]) => ({
        ...Object.fromEntries(FACTS.map((k) => [k, col[k]])),
        ...(old.columnType === col.columnType ? {} : { tsType: col.tsType }),
        ...(old.required === requiredByRule(old) ? { required: col.required } : {}),
      })
      for (const col of fresh) {
        const old = byName.get(col.columnName)
        const back = old ? undefined : dropped.get(col.columnName)
        if (back) {
          await this.columns.restore(back.id)
          const fieldName = freeName(back.fieldName, used)
          await this.columns.update(back.id, { ...refreshed(back, col), fieldName })
          result.added.push(col.columnName)
        } else if (!old) {
          sortNo += 10
          const fieldName = freeName(col.fieldName, used)
          await this.columns.insert({ ...col, fieldName, sortNo, tableId: id })
          result.added.push(col.columnName)
        } else if (FACTS.some((k) => old[k] !== col[k])) {
          await this.columns.update(old.id, refreshed(old, col))
          result.changed.push(col.columnName)
        }
      }
      if (table.tableComment !== info.comment)
        await this.repo.update(id, { tableComment: info.comment })
      return result
    })
  }
}
