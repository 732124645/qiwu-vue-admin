import { TENANT_COLUMN } from '@qiwu/shared'
import {
  Column,
  DataSource,
  EntityManager,
  type EntityMetadata,
  InsertQueryBuilder,
  type ObjectLiteral,
  QueryBuilder,
  SelectQueryBuilder,
} from 'typeorm'
import { clsGet } from '../context/cls.js'
import { tenantId, TenantContextMissing, withTenant } from '../context/tenant.js'
import { isTenantTable } from './tenant-tables.js'

/**
 * The tenant condition of the ORM (see docs/design-notes.md#tenancy): every WHERE TypeORM renders for a
 * tenant table (select, update, delete, soft delete, counts, subqueries; every table of the FROM list) and
 * every join of one gets `<alias>.tenant_id = <current tenant>`, ANDed to the bracketed original condition.
 * Added when the SQL is rendered, in the tenant context of that moment; a subquery's SQL is rendered where
 * the outer query embeds it, so build a query in the context that runs it. An insert of a tenant entity
 * gets the context's tenant when rendered too, listeners on or off. Refused for a tenant table: an upsert
 * (`orUpdate`, `repo.upsert`; `ON DUPLICATE KEY UPDATE` has no WHERE and would update the conflicting row
 * of any tenant), `clear()` (TRUNCATE empties every tenant) and, at boot, a many-to-many relation (TypeORM
 * renders its link table's join itself, without the condition; link tables go through `core/db/links.ts`).
 * Root and `@SkipDataScope()` skip only the department rules, never this.
 * `allTenants` adds no condition; no tenant in the context throws `TenantContextMissing` (`tenantId()`).
 * Patches TypeORM internals, so `typeorm` is pinned to one version; the contract spec and the boot check
 * (`assertTenantFilter`) fail when an upgrade moves them.
 */

type ColumnMetadata = NonNullable<ReturnType<EntityMetadata['findColumnWithDatabaseName']>>

const tenantEntities = new WeakSet<object>()

/**
 * Maps the `tenant_id` column of a tenant entity (any base class): marks the entity for the tenant
 * condition, the insert subscriber and the coverage check. Never on platform entities, even when their
 * table has a plain `tenant_id`.
 */
export const TenantColumn =
  (): PropertyDecorator =>
  (target, key): void => {
    Column({ name: TENANT_COLUMN, type: 'bigint', unsigned: true, update: false })(target, key)
    tenantEntities.add(target.constructor)
  }

/** Whether the column was declared with `@TenantColumn()`. */
export const isTenantColumn = (column: ColumnMetadata): boolean =>
  typeof column.target === 'function' && tenantEntities.has(column.target)

/** The mapped `tenant_id` of an entity of a tenant table; undefined for every other entity. */
export function tenantColumnOf(metadata: EntityMetadata): ColumnMetadata | undefined {
  const column = metadata.findColumnWithDatabaseName(TENANT_COLUMN)
  return isTenantTable(metadata.tableName, column !== undefined) ? column : undefined
}

// Kept on the DataSource itself under a registry symbol: one list per database connection, the same
// whichever copy of this module loaded it.
const TABLES = Symbol.for('qiwu.tenant-tables')
type WithTables = DataSource & { [TABLES]?: Set<string> }

/** The tenant tables of `ds` by name (`tenant_id` present, not a platform table); undefined before it is read. */
export const tenantTablesOf = (ds: DataSource): Set<string> | undefined =>
  (ds as WithTables)[TABLES]

/**
 * Re-reads which tables of the database have `tenant_id` (tables without an entity — link tables,
 * joins by name — are recognized by this list). Runs after `initialize()` and after migrations; call it
 * again for a table created later (test fixtures).
 */
export async function refreshTenantTables(ds: DataSource): Promise<void> {
  const rows = await ds.query<{ name: string }[]>(
    `SELECT DISTINCT TABLE_NAME AS name FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = ?`,
    [TENANT_COLUMN],
  )
  ;(ds as WithTables)[TABLES] = new Set(
    rows.map((r) => r.name).filter((t) => isTenantTable(t, true)),
  )
}

/** Either route says tenant table: an entity mapping `tenant_id`, or the table name in the list. */
function tenantTable(
  ds: DataSource,
  metadata: EntityMetadata | undefined,
  table: unknown,
): boolean {
  const tables = tenantTablesOf(ds)
  if (!tables) throw new Error('tenant tables not read yet: initialize the DataSource first')
  if (metadata) return tenantColumnOf(metadata) !== undefined || tables.has(metadata.tableName)
  return typeof table === 'string' && tables.has(table)
}

/** `<alias>.tenant_id = <n>`, or none under `allTenants`. A literal: subqueries cannot see outer params. */
function tenantCondition(alias: string | undefined): string | undefined {
  if (clsGet('allTenants')) return undefined
  const tid = tenantId()
  if (!Number.isSafeInteger(tid)) throw new TenantContextMissing(`not a tenant id: ${String(tid)}`)
  return `${alias ? `${alias}.` : ''}${TENANT_COLUMN} = ${tid}`
}

type WhereBuilder = QueryBuilder<ObjectLiteral> & { createWhereExpression(): string }
type JoinBuilder = SelectQueryBuilder<ObjectLiteral> & { createJoinExpression(): string }
type InsertBuilder = InsertQueryBuilder<ObjectLiteral> & {
  createInsertExpression(): string
  getValueSets(): ObjectLiteral[]
}
interface Patched {
  where: (this: WhereBuilder) => string
  joins: (this: JoinBuilder) => string
  insert: (this: InsertBuilder) => string
  clear: EntityManager['clear']
  initialize: (this: DataSource) => Promise<DataSource>
  runMigrations: DataSource['runMigrations']
  undoLastMigration: DataSource['undoLastMigration']
}
const qbProto = QueryBuilder.prototype as unknown as { createWhereExpression: Patched['where'] }
const selectProto = SelectQueryBuilder.prototype as unknown as {
  createJoinExpression: Patched['joins']
}
const insertProto = InsertQueryBuilder.prototype as unknown as {
  createInsertExpression: Patched['insert']
}
const emProto = EntityManager.prototype
const dsProto = DataSource.prototype
// the originals, on the prototype under a registry symbol: installing twice never wraps twice
const ORIGINALS = Symbol.for('qiwu.tenant-filter.originals')
type Holder = { [ORIGINALS]?: Patched }

function wrapWhere(original: Patched['where']): Patched['where'] {
  return function tenantWhere(this: WhereBuilder) {
    const map = this.expressionMap
    if (!map.mainAlias) return original.call(this)
    // SELECT: every table of the FROM list (`addFrom`, a second `from`); UPDATE / DELETE: the one table,
    // unprefixed (the alias rule of TypeORM's own deleted_at condition)
    const prefixed = map.aliasNamePrefixingEnabled
    const froms = prefixed ? map.aliases.filter((a) => a.type === 'from') : [map.mainAlias]
    const conditions = froms
      .filter(
        (a) =>
          !a.subQuery &&
          tenantTable(this.dataSource, a.hasMetadata ? a.metadata : undefined, a.tablePath),
      )
      .map((a) => tenantCondition(prefixed ? a.name : undefined))
      .filter((c) => c !== undefined)
    if (!conditions.length) return original.call(this)
    const condition = conditions.join(' AND ')
    const extra = map.extraAppendedAndWhereCondition
    // bracketed: TypeORM writes `a AND b OR c AND d` here for paging by a composite key
    map.extraAppendedAndWhereCondition = extra ? `(${extra}) AND ${condition}` : condition
    try {
      return original.call(this)
    } finally {
      map.extraAppendedAndWhereCondition = extra
    }
  }
}

function wrapJoins(original: Patched['joins']): Patched['joins'] {
  return function tenantJoins(this: JoinBuilder) {
    const joins = this.expressionMap.joinAttributes
    const conditions = joins.map((join) => join.condition)
    try {
      for (const join of joins) {
        if (join.alias.subQuery || !tenantTable(this.dataSource, join.metadata, join.tablePath))
          continue
        const condition = tenantCondition(join.alias.name)
        // bracketed: a join by table name puts the condition after ON as written, top-level OR included
        if (condition)
          join.condition = join.condition ? `(${join.condition}) AND ${condition}` : condition
      }
      return original.call(this)
    } finally {
      joins.forEach((join, i) => (join.condition = conditions[i]))
    }
  }
}

function wrapInsert(original: Patched['insert']): Patched['insert'] {
  return function tenantInsert(this: InsertBuilder) {
    const main = this.expressionMap.mainAlias
    const metadata = main?.hasMetadata ? main.metadata : undefined
    if (
      this.expressionMap.onUpdate &&
      main &&
      tenantTable(this.dataSource, metadata, main.tablePath)
    )
      throw new Error(
        `${main.tablePath}: no upsert on a tenant table ` +
          '(ON DUPLICATE KEY UPDATE would update the conflicting row of any tenant); read it by key, then update or insert',
      )
    // the insert subscriber's rule once more, where listeners cannot be switched off
    const column = metadata && tenantColumnOf(metadata)
    if (column) {
      const all = clsGet('allTenants')
      const tid = all ? undefined : tenantId()
      for (const values of this.getValueSets()) {
        if (!all) column.setEntityValue(values, tid)
        else if (column.getEntityValue(values) == null)
          throw new TenantContextMissing(
            `${metadata.tableName}: a new row under allTenants names no tenant`,
          )
      }
    }
    return original.call(this)
  }
}

function wrapClear(original: Patched['clear']): Patched['clear'] {
  return async function tenantClear(this: EntityManager, target, options) {
    const metadata = this.dataSource.getMetadata(target)
    if (tenantTable(this.dataSource, metadata, metadata.tablePath))
      throw new Error(
        `${metadata.tablePath}: no clear() of a tenant table ` +
          '(TRUNCATE empties every tenant); delete through a QueryBuilder',
      )
    return original.call(this, target, options)
  }
}

/** Installs the tenant condition into TypeORM (once per process; `data-source.ts` does it on load). */
export function installTenantFilter(): void {
  const holder = dsProto as unknown as Holder
  if (holder[ORIGINALS]) return
  const originals: Patched = {
    where: qbProto.createWhereExpression,
    joins: selectProto.createJoinExpression,
    insert: insertProto.createInsertExpression,
    clear: emProto.clear,
    initialize: dsProto.initialize,
    runMigrations: dsProto.runMigrations,
    undoLastMigration: dsProto.undoLastMigration,
  }
  holder[ORIGINALS] = originals
  qbProto.createWhereExpression = wrapWhere(originals.where)
  selectProto.createJoinExpression = wrapJoins(originals.joins)
  insertProto.createInsertExpression = wrapInsert(originals.insert)
  emProto.clear = wrapClear(originals.clear)
  dsProto.initialize = async function (this: DataSource) {
    await originals.initialize.call(this)
    await refreshTenantTables(this)
    return this
  }
  dsProto.runMigrations = async function (this: DataSource, ...args) {
    const ran = await originals.runMigrations.apply(this, args)
    await refreshTenantTables(this)
    return ran
  }
  dsProto.undoLastMigration = async function (this: DataSource, ...args) {
    await originals.undoLastMigration.apply(this, args)
    await refreshTenantTables(this)
  }
}

/** Puts TypeORM back as it was: only for the boot-check spec, which proves the check notices. */
export function uninstallTenantFilter(): void {
  const holder = dsProto as unknown as Holder
  const originals = holder[ORIGINALS]
  if (!originals) return
  qbProto.createWhereExpression = originals.where
  selectProto.createJoinExpression = originals.joins
  insertProto.createInsertExpression = originals.insert
  emProto.clear = originals.clear
  dsProto.initialize = originals.initialize
  dsProto.runMigrations = originals.runMigrations
  dsProto.undoLastMigration = originals.undoLastMigration
  delete holder[ORIGINALS]
}

// any tenant id: the check only renders SQL, it runs nothing
const PROBE_TENANT = 7

/**
 * Boot check: refuses to start when no tenant table is known, when a many-to-many relation touches a
 * tenant table, or when the SQL TypeORM renders for one — SELECT, UPDATE, DELETE and a join, for an
 * entity and for a table by name — lacks the tenant condition (a TypeORM change the wrappers no longer reach).
 */
export function assertTenantFilter(ds: DataSource): void {
  const tables = [...(tenantTablesOf(ds) ?? [])]
  if (!tables.length) throw new Error('tenant filter: no tenant table known (run the migrations)')
  const manyToMany = ds.entityMetadatas
    .flatMap((m) => m.manyToManyRelations)
    .filter((r) =>
      [r.entityMetadata, r.inverseEntityMetadata, r.junctionEntityMetadata].some(
        (m) => m && tenantTable(ds, m, m.tablePath),
      ),
    )
  if (manyToMany.length)
    throw new Error(
      `tenant filter: many-to-many on a tenant table (${manyToMany.map((r) => `${r.entityMetadata.name}.${r.propertyPath}`).join(', ')}): ` +
        'TypeORM joins and writes its link table without the tenant condition; map the link table or use core/db/links.ts',
    )
  // by name: a table no entity maps (a link table), so TypeORM keeps it a plain name
  const byName = tables.find((t) => !ds.hasMetadata(t))
  const entity = ds.entityMetadatas.find((m) => tenantColumnOf(m))
  const column = entity?.columns.find((c) => c.isUpdate && !c.isVirtual)
  const has = (sql: string, alias: string) =>
    sql.replaceAll('`', '').includes(`${alias}${TENANT_COLUMN} = ${PROBE_TENANT}`)
  // qw:cross-tenant the boot check renders SQL for a probe tenant and runs none of it
  const missing = withTenant(PROBE_TENANT, () => {
    const qb = () => ds.createQueryBuilder()
    const checks: [string, string, string][] = []
    if (byName)
      checks.push(
        ['select', qb().select('1').from(byName, 't').getQuery(), 't.'],
        ['join', qb().select('1').from(byName, 'x').innerJoin(byName, 'j', '1=1').getQuery(), 'j.'],
        ['update', qb().update(byName).set({ deleted_at: null }).getQuery(), ''],
        ['delete', qb().delete().from(byName).getQuery(), ''],
      )
    if (entity && column) {
      const e = entity.target
      checks.push(
        ['entity select', qb().select('t.id').from(e, 't').getQuery(), 't.'],
        ['entity join', qb().select('1').from(e, 'x').innerJoin(e, 'j', '1=1').getQuery(), 'j.'],
        [
          'entity update',
          qb()
            .update(e)
            .set({ [column.propertyPath]: null })
            .getQuery(),
          '',
        ],
        ['entity delete', qb().delete().from(e).getQuery(), ''],
      )
    }
    return checks.filter(([, sql, alias]) => !has(sql, alias)).map(([name]) => name)
  })
  if (missing.length)
    throw new Error(
      `tenant filter: no tenant condition in ${missing.join(', ')} (TypeORM changed?)`,
    )
}
