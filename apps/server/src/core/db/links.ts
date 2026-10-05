import type { EntityManager } from 'typeorm'

/**
 * A join table (`<a>_<b>s`, e.g. `iam_user_roles`) seen from one side: `owner` = the column of
 * the row being edited, `target` = the other one. `(owner, target)` must be unique (the composite primary
 * key): a link is one row for good, soft-deleted when removed and revived when added again.
 * Every link write goes through these helpers. Names are code constants (identifiers in the SQL).
 */
export interface LinkTable {
  table: string
  owner: string
  target: string
}

const uniq = (ids: readonly number[]) => [...new Set(ids)]

/**
 * Links `ownerId` to `targetIds`: missing links are inserted, soft-deleted ones revived — or, with
 * `revive: false` (seeds, an administrator's removal stays), left deleted.
 */
export async function addLinks(
  q: EntityManager,
  { table, owner, target }: LinkTable,
  ownerId: number,
  targetIds: readonly number[],
  { revive = true }: { revive?: boolean } = {},
): Promise<void> {
  const ids = uniq(targetIds)
  if (!ids.length) return
  await q.query(
    // arch-allow: sql-concat table/column identifiers are LinkTable code constants; values bound
    `INSERT INTO ${table} (${owner}, ${target}) VALUES ?
       ON DUPLICATE KEY UPDATE ${revive ? 'deleted_at = NULL' : `${owner} = ${owner}`}`,
    [ids.map((id) => [ownerId, id])],
  )
}

/** Soft-deletes the live links of `ownerId` to `targetIds`. */
export async function removeLinks(
  q: EntityManager,
  { table, owner, target }: LinkTable,
  ownerId: number,
  targetIds: readonly number[],
): Promise<void> {
  const ids = uniq(targetIds)
  if (!ids.length) return
  await q.query(
    // arch-allow: sql-concat table/column identifiers are LinkTable code constants; values bound
    `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP(3)
      WHERE ${owner} = ? AND ${target} IN (?) AND deleted_at IS NULL`,
    [ownerId, ids],
  )
}

/**
 * The live links of `ownerId` become exactly `targetIds`: links not among them are soft-deleted, deleted
 * ones among them revived, missing ones inserted.
 */
export async function replaceLinks(
  q: EntityManager,
  link: LinkTable,
  ownerId: number,
  targetIds: readonly number[],
): Promise<void> {
  const ids = uniq(targetIds)
  const { table, owner, target } = link
  await q.query(
    // arch-allow: sql-concat table/column identifiers are LinkTable code constants; values bound
    `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP(3)
      WHERE ${owner} = ? AND deleted_at IS NULL${ids.length ? ` AND ${target} NOT IN (?)` : ''}`,
    ids.length ? [ownerId, ids] : [ownerId],
  )
  await addLinks(q, link, ownerId, ids)
}
