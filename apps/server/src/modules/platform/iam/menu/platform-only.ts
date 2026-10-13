import { PLATFORM_ONLY_ROUTES } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'

interface FlagRow {
  id: number
  parent_id: number
  route_name: string | null
  platform_only: number
}

/** Deeper than any sane menu: a longer parent chain is a cycle. */
const MAX_DEPTH = 32

/**
 * Rewrites `iam_menu.platform_only` of the live menus by the one rule (see docs/design-notes.md#tenancy):
 * a menu is platform-only when its route name is in `PLATFORM_ONLY_ROUTES` or an ancestor's is. The
 * flag is the code's, never an administrator's: every seed run and every menu create or edit applies it
 * again (a page added below a platform page is platform-only at once). Menus are few: one read, then
 * only the rows whose flag changes are written.
 */
export async function syncPlatformOnly(q: EntityManager): Promise<void> {
  const rows = await q.query<FlagRow[]>(
    'SELECT id, parent_id, route_name, platform_only FROM iam_menu WHERE deleted_at IS NULL',
  )
  const byId = new Map(rows.map((r) => [Number(r.id), r]))
  const listed = new Set(PLATFORM_ONLY_ROUTES)
  const platform = (r: FlagRow): boolean => {
    let row: FlagRow | undefined = r
    for (let depth = 0; row && depth < MAX_DEPTH; depth++) {
      if (row.route_name !== null && listed.has(row.route_name)) return true
      row = byId.get(Number(row.parent_id))
    }
    return false
  }
  const set: Record<0 | 1, number[]> = { 0: [], 1: [] }
  for (const r of rows) {
    const flag = platform(r) ? 1 : 0
    if (Number(r.platform_only) !== flag) set[flag].push(Number(r.id))
  }
  for (const flag of [0, 1] as const)
    if (set[flag].length)
      await q.query(
        'UPDATE iam_menu SET platform_only = ? WHERE id IN (?) AND deleted_at IS NULL',
        [flag, set[flag]],
      )
}
