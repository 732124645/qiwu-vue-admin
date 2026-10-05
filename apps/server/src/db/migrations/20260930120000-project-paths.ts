import type { MigrationInterface, QueryRunner } from 'typeorm'

/** The views that moved: old prefix → new prefix below apps/web/src/views. */
const MOVED: [old: string, now: string][] = [
  ['biz/demo/', 'demo/'],
  ['biz/biz/leave/', 'biz/leave/'],
]

/** Every stored view path starting with `from` (exact case) starts with `to` instead; `updated_at` kept. */
async function move(q: QueryRunner, from: string, to: string): Promise<void> {
  const args = [to, from.length + 1, `${from}%`]
  await q.query(
    `UPDATE iam_menu SET component = CONCAT(?, SUBSTRING(component, ?)), updated_at = updated_at
      WHERE component COLLATE utf8mb4_bin LIKE ?`,
    args,
  )
  await q.query(
    `UPDATE wf_model SET view_component = CONCAT(?, SUBSTRING(view_component, ?)), updated_at = updated_at
      WHERE view_component COLLATE utf8mb4_bin LIKE ?`,
    args,
  )
}

/**
 * The samples' views left the `biz` directory (`biz/demo/…` → `demo/…`, the leave
 * pages `biz/biz/leave/…` → `biz/leave/…`), so an existing database's menu components and process view
 * components (the leave model's `view_component`) follow, deleted rows too; a new database gets the new
 * paths from the seeds. `down` moves them back. Before this migration no view existed below `demo/` or
 * `biz/leave/`, so no stored path started with a new prefix and `down` reverts exactly what `up` moved.
 */
export class ProjectPaths20260930120000 implements MigrationInterface {
  name = 'ProjectPaths20260930120000'

  async up(q: QueryRunner): Promise<void> {
    for (const [old, now] of MOVED) await move(q, old, now)
  }

  async down(q: QueryRunner): Promise<void> {
    for (const [old, now] of MOVED) await move(q, now, old)
  }
}
