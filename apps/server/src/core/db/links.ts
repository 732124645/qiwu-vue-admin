import type { EntityManager } from 'typeorm'
import { tenantId } from '../context/tenant.js'
import { andTenant, isTenantTableOf } from './references.js'

/**
 * A join table (`<a>_<b>s`, e.g. `iam_user_roles`) seen from one side: `owner` = the column of
 * the row being edited, `target` = the other one. `(owner, target)` must be unique (the composite primary
 * key): a link is one row for good, soft-deleted when removed and revived when added again.
 * Every link write goes through these helpers. Names are code constants (identifiers in the SQL).
 * Tenants (see docs/design-notes.md#tenancy): a link of a tenant table belongs to its owner's tenant, the
 * current one (the owner row was read in it); removals touch the current tenant's links only. A platform
 * link table has no tenant.
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
  const tid = isTenantTableOf(q, table) ? [tenantId()] : []
  await q.query(
    // arch-allow: sql-concat table/column identifiers are LinkTable code constants; values bound; tenant: the owner's (current) tenant on a tenant table
    `INSERT INTO ${table} (${owner}, ${target}${tid.length ? ', tenant_id' : ''}) VALUES ?
       ON DUPLICATE KEY UPDATE ${revive ? 'deleted_at = NULL' : `${owner} = ${owner}`}`,
    [ids.map((id) => [ownerId, id, ...tid])],
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
  const [tenant, tid] = andTenant(q, table)
  await q.query(
    // arch-allow: sql-concat table/column identifiers are LinkTable code constants; values bound; tenant: andTenant (the current tenant of a tenant table)
    `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP(3)
      WHERE ${owner} = ? AND ${target} IN (?) AND deleted_at IS NULL${tenant}`,
    [ownerId, ids, ...tid],
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
  const [tenant, tid] = andTenant(q, table)
  await q.query(
    // arch-allow: sql-concat table/column identifiers are LinkTable code constants; values bound; tenant: andTenant (the current tenant of a tenant table)
    `UPDATE ${table} SET deleted_at = CURRENT_TIMESTAMP(3)
      WHERE ${owner} = ? AND deleted_at IS NULL${ids.length ? ` AND ${target} NOT IN (?)` : ''}${tenant}`,
    [ownerId, ...(ids.length ? [ids] : []), ...tid],
  )
  await addLinks(q, link, ownerId, ids)
}
