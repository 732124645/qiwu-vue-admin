import { NotFoundException } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { clsGet } from '../context/cls.js'
import { allTenants, tenantId } from '../context/tenant.js'
import { BizError } from '../http/biz-error.js'
import { tenantTablesOf } from './tenant-filter.js'

/**
 * A column of `table` holding ids of another table's rows (no foreign keys, integrity in the
 * application). Deleting those rows (`softDeleteRows`, which BaseCrudService.remove runs):
 * - restrict (default, the former `ON DELETE RESTRICT`): a live row of `table` holding one of the ids →
 *   409 `in_use`, nothing deleted;
 * - `cascade` (the former `ON DELETE CASCADE`): those rows are soft-deleted in the same transaction.
 * The column keeps its index: the check is a locking read (FOR SHARE) of that index range. Writing
 * `table` (BaseCrudService / BaseTreeService create and update: `assertReferencesLive`) reads the
 * referenced row FOR SHARE: missing or deleted → 404, and a delete running meanwhile either waits for the
 * write (then sees the new reference, 409) or makes the write wait (then 404): no orphan either way.
 * Tenants (see docs/design-notes.md#tenancy): every statement on a tenant table keeps to the current
 * tenant; a platform row (a storage config, an OAuth client) is referenced from every tenant, so its
 * restrict checks and cascades span them all.
 */
export interface Reference {
  table: string
  column: string
  cascade?: boolean
}

const registry = new Map<string, Reference[]>()

/**
 * Registers who references rows of table `parent`. Called at the top level of a file the app loads with
 * the module: the one owning the referencing column (its entity, or the module for a join table) or the
 * referenced table's entity (generated from `cg_table.options.referencedBy`, e.g. position.entity.ts:
 * `referencedBy('iam_position', { table: 'iam_user_positions', column: 'position_id' })`).
 * Table and column names are code constants (they end up in SQL as identifiers). Idempotent.
 */
export function referencedBy(parent: string, ...refs: Reference[]): void {
  const list = registry.get(parent) ?? []
  for (const ref of refs)
    if (!list.some((r) => r.table === ref.table && r.column === ref.column)) list.push(ref)
  registry.set(parent, list)
}

/** The registered references to rows of `parent`. */
export const referencesTo = (parent: string): readonly Reference[] => registry.get(parent) ?? []

/** Whether `table` is a tenant table of the connection (`tenant_id`, no platform table). */
export function isTenantTableOf(q: EntityManager, table: string): boolean {
  const tables = tenantTablesOf(q.connection)
  if (!tables) throw new Error('tenant tables not read yet: initialize the DataSource first')
  return tables.has(table)
}

/**
 * ` AND tenant_id = ?` and its value, for raw SQL on `table`: the current tenant's rows of a tenant table;
 * nothing for a platform table, nor under `allTenants`.
 */
export function andTenant(q: EntityManager, table: string): [sql: string, params: number[]] {
  if (!isTenantTableOf(q, table) || clsGet('allTenants')) return ['', []]
  return [' AND tenant_id = ?', [tenantId()]]
}

/**
 * The writing side of a reference (what the foreign key refused): row `id` of `table` must be live, else
 * 404; null / undefined = no reference. Inside the caller's transaction the row is read FOR SHARE, so a
 * delete of it waits for the write and then finds the new reference (409 `in_use`), and a write waiting
 * for a delete's lock finds the row deleted (404): no live row ever points at a deleted one. A row of a
 * tenant table must be the current tenant's (another tenant's is missing, 404); a platform row is
 * everyone's.
 */
export async function assertLive(q: EntityManager, table: string, id: unknown): Promise<void> {
  if (id == null) return
  const [tenant, tid] = andTenant(q, table)
  const [live] = await q.query(
    // arch-allow: sql-concat the table identifier is a code constant; the id is bound; tenant: andTenant (the current tenant of a tenant table)
    `SELECT 1 AS live FROM ${table} WHERE id = ? AND deleted_at IS NULL${tenant} FOR SHARE`,
    [id, ...tid],
  )
  if (!live) throw new NotFoundException()
}

/**
 * The writing side of every registered reference `table` holds (the registry read the other way): each
 * reference column `row` sets (entity property names, as TypeORM maps the column) must name a live row
 * of its parent (`assertLive`, 404). An update passes `stored` (loads the row as it was, read only when
 * the write sets a reference column): a value it already holds is not judged again, and re-locking that
 * parent could deadlock with the parent's delete (which waits for this row). 0 in a column referencing
 * its own table is the top level of a tree. BaseCrudService / BaseTreeService call it inside the write's
 * transaction, before the row is written.
 */
export async function assertReferencesLive(
  q: EntityManager,
  table: string,
  row: object,
  stored?: () => Promise<object>,
): Promise<void> {
  const meta = q.connection.hasMetadata(table) ? q.connection.getMetadata(table) : undefined
  const valueOf = (of: object, column: string) =>
    (of as Record<string, unknown>)[
      meta?.findColumnWithDatabaseName(column)?.propertyName ?? column
    ]
  for (const [parent, refs] of registry)
    for (const { table: holder, column } of refs) {
      if (holder !== table) continue
      const value = valueOf(row, column)
      if (value == null || (parent === table && Number(value) === 0)) continue
      if (stored && String(valueOf(await stored(), column)) === String(value)) continue
      await assertLive(q, parent, value)
    }
}

/**
 * Soft-deletes the live rows of `table` whose `column` is one of `ids`: `deleted_at` = now and, when
 * the table has `updated_by` (its entity maps it) and a principal is set, `updated_by` = the caller.
 * A secret does not outlive its row: the nullable `*_enc` columns the entity maps (SecretBox
 * ciphertext, the generator's `secret` widget) are set NULL in the same UPDATE. A tenant table: the
 * current tenant's rows only, every tenant's under `allTenants`.
 */
export async function softDeleteWhere(
  q: EntityManager,
  table: string,
  column: string,
  ids: readonly unknown[],
): Promise<void> {
  if (!ids.length) return
  const me = clsGet('principal')?.userId
  const meta = q.connection.hasMetadata(table) ? q.connection.getMetadata(table) : undefined
  const audited = me !== undefined && !!meta?.findColumnWithDatabaseName('updated_by')
  const secrets = (meta?.columns ?? [])
    .filter((c) => c.isNullable && c.databaseName.endsWith('_enc'))
    .map((c) => `, ${c.databaseName} = NULL`)
    .join('')
  const [tenant, tid] = andTenant(q, table)
  await q.query(
    // arch-allow: sql-concat table/column identifiers are code constants (entities, referencedBy); values bound; tenant: andTenant (the current tenant of a tenant table)
    `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP(3)${audited ? ', updated_by = ?' : ''}${secrets}
      WHERE ${column} IN (?) AND deleted_at IS NULL${tenant}`,
    [...(audited ? [me, [...ids]] : [[...ids]]), ...tid],
  )
}

/**
 * Deletes rows `ids` of `table` (/3), inside the caller's transaction with the rows already
 * locked: every restrict reference first (a live referencing row → 409 `in_use`; a table referencing
 * itself does not count the rows deleted in the same call, so a parent goes with its children), then
 * the cascaded rows, then the rows themselves, all soft. A cascaded table that is referenced itself
 * (a master-sub's lines another table points at) is deleted the same way, recursively: its rows are
 * locked (FOR UPDATE) and go through their own restrict and cascade references, so a line still in use
 * refuses the whole delete (409; the caller's transaction rolls back what was already written). Other
 * cascaded tables (links, receipts) are one UPDATE.
 * The rows of a tenant table are the current tenant's (locked in it), and so are the rows referencing
 * them. A platform row is referenced from every tenant: its restrict checks and cascades run across all
 * of them, else a reference in another tenant would be left pointing at a deleted row.
 */
export async function softDeleteRows(
  q: EntityManager,
  table: string,
  ids: readonly number[],
): Promise<void> {
  if (!ids.length) return
  if (isTenantTableOf(q, table)) return deleteRows(q, table, ids)
  // qw:cross-tenant a platform row is referenced from every tenant
  return allTenants(() => deleteRows(q, table, ids))
}

async function deleteRows(q: EntityManager, table: string, ids: readonly number[]): Promise<void> {
  const refs = referencesTo(table)
  for (const { table: ref, column } of refs.filter((r) => !r.cascade)) {
    const self = ref === table
    const [tenant, tid] = andTenant(q, ref)
    const [hit] = await q.query(
      // arch-allow: sql-concat table/column identifiers are referencedBy code constants; values bound; tenant: andTenant (the current tenant of a tenant table)
      `SELECT 1 AS hit FROM ${ref} WHERE ${column} IN (?) AND deleted_at IS NULL${self ? ' AND id NOT IN (?)' : ''}${tenant}
        LIMIT 1 FOR SHARE`,
      [...(self ? [ids, ids] : [ids]), ...tid],
    )
    if (hit) throw new BizError(Err.IN_USE)
  }
  const cascades = refs.filter((r) => r.cascade)
  const nested = (ref: string) => ref !== table && referencesTo(ref).length > 0
  for (const { table: ref, column } of cascades.filter((r) => nested(r.table))) {
    const [tenant, tid] = andTenant(q, ref)
    const rows: { id: number }[] = await q.query(
      // arch-allow: sql-concat table/column identifiers are referencedBy code constants; values bound; tenant: andTenant (the current tenant of a tenant table)
      `SELECT id FROM ${ref} WHERE ${column} IN (?) AND deleted_at IS NULL${tenant} FOR UPDATE`,
      [ids, ...tid],
    )
    await softDeleteRows(
      q,
      ref,
      rows.map((r) => Number(r.id)),
    )
  }
  for (const { table: ref, column } of cascades.filter((r) => !nested(r.table)))
    await softDeleteWhere(q, ref, column, ids)
  await softDeleteWhere(q, table, 'id', ids)
}
