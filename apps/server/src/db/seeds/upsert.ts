import type { EntityManager } from 'typeorm'

/** Column → value. Plain objects/arrays go to `json` columns (serialized here); Dates stay Dates. */
export type Row = Record<string, unknown>

/**
 * Tree tables whose `tree_path` these helpers keep in step with `parent_id` (the menu rows
 * every module seeds and tests add); iam_dept's seed writes its own paths.
 */
const TREE_PATH = new Set(['iam_menu'])

const bind = (row: Row): Row =>
  Object.fromEntries(
    Object.entries(row).map(([c, v]) => [
      c,
      v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v,
    ]),
  )

/**
 * The row whose `key` columns match, NULL-safe: the live one, else the last soft-deleted one (every table
 * is soft-deleted, a natural key an administrator deleted stays taken for the seeds).
 * Table/column names are seed constants.
 */
export async function findRow(
  q: EntityManager,
  table: string,
  key: Row,
): Promise<{ id: number; deleted: boolean } | undefined> {
  const where = Object.keys(key).map((c) => `${c} <=> ?`)
  const [row] = await q.query(
    // arch-allow: sql-concat table and column names are seed-code constants; every value is bound
    `SELECT id, deleted_at IS NOT NULL AS deleted FROM ${table} WHERE ${where.join(' AND ')}
      ORDER BY deleted_at IS NULL DESC, id DESC LIMIT 1`,
    Object.values(bind(key)),
  )
  return row ? { id: Number(row.id), deleted: Number(row.deleted) === 1 } : undefined
}

/** Id of the row `findRow` finds (the live one, else a soft-deleted one). */
export const findId = async (
  q: EntityManager,
  table: string,
  key: Row,
): Promise<number | undefined> => (await findRow(q, table, key))?.id

/**
 * Plain SQL by table and column names (not the query builder: once a table has an entity, TypeORM maps
 * `into('<table>')` to it and silently drops values keyed by column name).
 */
export async function insertRow(q: EntityManager, table: string, row: Row): Promise<number> {
  const tree = TREE_PATH.has(table) && !('tree_path' in row)
  // '/' until the id is known (the path ends with it)
  const values = bind(tree ? { ...row, tree_path: '/' } : row)
  const columns = Object.keys(values)
  const res = await q.query(
    // arch-allow: sql-concat table and column names are seed/test-code constants; every value is bound
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    Object.values(values),
  )
  const id = Number((res as { insertId: number }).insertId)
  if (tree) await placeInTree(q, table, id)
  return id
}

/**
 * Sets the path of row `id` of a TREE_PATH table from its parent's (a missing parent = top level) and moves
 * the paths of the rows below it along (a re-seed may move a page to another group).
 */
async function placeInTree(q: EntityManager, table: string, id: number): Promise<void> {
  const [row] = await q.query(
    // arch-allow: sql-concat the table name is a TREE_PATH constant; every value is bound
    `SELECT c.tree_path AS old, CONCAT(COALESCE(p.tree_path, '/'), c.id, '/') AS path
       FROM ${table} c LEFT JOIN ${table} p ON p.id = c.parent_id WHERE c.id = ?`,
    [id],
  )
  if (row.old === row.path) return
  // a new row ('/') has nothing below it yet
  await q.query(
    // arch-allow: sql-concat the table name is a TREE_PATH constant; every value is bound
    `UPDATE ${table} SET tree_path = CONCAT(?, SUBSTRING(tree_path, ?))
      WHERE ${row.old === '/' ? 'id = ?' : 'tree_path LIKE ?'}`,
    [row.path, row.old.length + 1, row.old === '/' ? id : `${row.old}%`],
  )
}

/**
 * Idempotent seed write by natural key: inserts `key + values + onInsert` when no row
 * matches `key`, otherwise updates `values` only. `onInsert` is for what admins own after seeding
 * (param values, …); re-seeding never resets it. Columns seeds never write (e.g. `enabled`) keep their
 * DB default on insert and the admin's choice afterwards. A row an administrator deleted (soft) stays
 * deleted and untouched: never revived nor inserted again. Returns the row id.
 * A row a later release adds below a parent an admin deleted is inserted live (an orphan the
 * tree lists at top level); give insertRow the parent's deleted_at if releases ever do that.
 */
export async function upsert(
  q: EntityManager,
  table: string,
  key: Row,
  values: Row = {},
  onInsert: Row = {},
): Promise<number> {
  const found = await findRow(q, table, key)
  if (!found) return insertRow(q, table, { ...key, ...values, ...onInsert })
  const { id, deleted } = found
  if (deleted) return id
  const set = bind(values)
  if (Object.keys(set).length)
    await q.query(
      // arch-allow: sql-concat table and column names are seed-code constants; every value is bound
      `UPDATE ${table} SET ${Object.keys(set)
        .map((c) => `${c} = ?`)
        .join(', ')} WHERE id = ?`,
      [...Object.values(set), id],
    )
  if (TREE_PATH.has(table) && 'parent_id' in set) await placeInTree(q, table, id)
  return id
}
