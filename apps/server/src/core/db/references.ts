import { NotFoundException } from '@nestjs/common'
import { Err } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { clsGet } from '../context/cls.js'
import { BizError } from '../http/biz-error.js'

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

/**
 * The writing side of a reference (what the foreign key refused): row `id` of `table` must be live, else
 * 404; null / undefined = no reference. Inside the caller's transaction the row is read FOR SHARE, so a
 * delete of it waits for the write and then finds the new reference (409 `in_use`), and a write waiting
 * for a delete's lock finds the row deleted (404): no live row ever points at a deleted one.
 */
export async function assertLive(q: EntityManager, table: string, id: unknown): Promise<void> {
  if (id == null) return
  const [live] = await q.query(
    // arch-allow: sql-concat the table identifier is a code constant; the id is bound
    `SELECT 1 AS live FROM ${table} WHERE id = ? AND deleted_at IS NULL FOR SHARE`,
    [id],
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
 * ciphertext, the generator's `secret` widget) are set NULL in the same UPDATE.
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
  await q.query(
    // arch-allow: sql-concat table/column identifiers are code constants (entities, referencedBy); values bound
    `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP(3)${audited ? ', updated_by = ?' : ''}${secrets}
      WHERE ${column} IN (?) AND deleted_at IS NULL`,
    audited ? [me, [...ids]] : [[...ids]],
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
 */
export async function softDeleteRows(
  q: EntityManager,
  table: string,
  ids: readonly number[],
): Promise<void> {
  if (!ids.length) return
  const refs = referencesTo(table)
  for (const { table: ref, column } of refs.filter((r) => !r.cascade)) {
    const self = ref === table
    const [hit] = await q.query(
      // arch-allow: sql-concat table/column identifiers are referencedBy code constants; values bound
      `SELECT 1 AS hit FROM ${ref} WHERE ${column} IN (?) AND deleted_at IS NULL${self ? ' AND id NOT IN (?)' : ''}
        LIMIT 1 FOR SHARE`,
      self ? [ids, ids] : [ids],
    )
    if (hit) throw new BizError(Err.IN_USE)
  }
  const cascades = refs.filter((r) => r.cascade)
  const nested = (ref: string) => ref !== table && referencesTo(ref).length > 0
  for (const { table: ref, column } of cascades.filter((r) => nested(r.table))) {
    const rows: { id: number }[] = await q.query(
      // arch-allow: sql-concat table/column identifiers are referencedBy code constants; values bound
      `SELECT id FROM ${ref} WHERE ${column} IN (?) AND deleted_at IS NULL FOR UPDATE`,
      [ids],
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
