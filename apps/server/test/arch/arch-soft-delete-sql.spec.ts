// scripts/arch/soft-delete-sql.mjs against a throwaway source tree: raw SQL naming a
// table of the migrations must hold a deleted_at IS [NOT] NULL condition for it (per alias; one bare
// condition per unaliased table; a select-list column or a SET is none), a join by table name on a table without
// an entity too, unless marked qw:include-deleted; the per-file baseline holds, and must shrink. The real
// tree passing is `pnpm arch:check` (pnpm verify).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const MIGRATION = `export class M {
  async up(q) {
    await q.query(\`CREATE TABLE t_user (id bigint)\`)
    await q.query('CREATE TABLE IF NOT EXISTS t_link (user_id bigint)')
    await q.query('SELECT id FROM t_user') // migrations are not checked
  }
}
`
const ENTITY = `@Entity('t_user')
export class TUser {}
`
// line numbers matter: the spec expects the flagged ones
const SQL = `const a = await q.query('SELECT id FROM t_user WHERE id = ?', [id])
const b = await q.query('SELECT id FROM t_user WHERE id = ? AND deleted_at IS NULL', [id])
const c = await q.query(\`SELECT u.id FROM t_user u
  JOIN t_link l ON l.user_id = u.id
  WHERE u.deleted_at IS NULL\`)
const d = await q.query(\`SELECT u.id FROM t_user u
  JOIN t_link l ON l.user_id = u.id AND l.deleted_at IS NULL
  WHERE u.deleted_at IS NULL\`)
// qw:include-deleted a purge takes deleted rows too
await q.query('DELETE FROM t_link WHERE user_id = ?', [id])
await q.query('UPDATE t_user SET name = ? WHERE id = ?', [name, id])
await q.query('INSERT INTO t_link (user_id) VALUES (?)', [id])
qb.innerJoin('t_link', 'l', 'l.user_id = t.id')
qb.innerJoin('t_link', 'l', 'l.user_id = t.id AND l.deleted_at IS NULL')
qb.innerJoin('t_user', 'u', 'u.id = t.user_id')
await q.query('SELECT 1 FROM other_table')
// SELECT id FROM t_user in a comment is not code
const e = await q.query(\`SELECT id FROM t_user WHERE id IN (\${ids})\`, []) // qw:include-deleted
const f = await q.query('SELECT l.user_id FROM t_link l WHERE deleted_at IS NULL')
const g = await q.query('SELECT a.id FROM t_user a JOIN t_user b ON b.id = a.id WHERE deleted_at IS NULL')
const h = await q.query('SELECT id FROM t_user WHERE deleted_at IS NULL AND id IN (SELECT user_id FROM t_link WHERE user_id = ?)')
const i = await q.query('SELECT user_id, deleted_at FROM t_link WHERE user_id = ?')
await q.query('UPDATE t_user SET deleted_at = NULL WHERE id = ?', [id])
const k = await q.query('SELECT deleted_at IS NOT NULL AS gone FROM t_user WHERE id = ?')
const l = await q.query('SELECT id FROM t_user WHERE deleted_at IS NULL AND id IN (SELECT user_id FROM t_link WHERE deleted_at is null)')
qb.innerJoin('t_link', 'l', 'l.user_id = t.id AND l.deleted_at = ?')
`
const ONE = `await q.query('SELECT id FROM t_user')
`

it.each(['native', 'windows'])(
  '%s: flags raw SQL without deleted_at (per table and alias) outside the migrations; the baseline holds and must shrink',
  (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    try {
      put('apps/server/src/db/migrations/1-m.ts', MIGRATION)
      put('apps/server/src/modules/demo/user.entity.ts', ENTITY)
      put('apps/server/src/modules/demo/sql.ts', SQL)
      put('apps/server/src/modules/demo/listed.ts', ONE)
      put('apps/server/src/modules/demo/stale.ts', ONE)
      put(
        'scripts/arch/soft-delete-sql.baseline.json',
        JSON.stringify({
          'apps/server/src/modules/demo/listed.ts': 1,
          'apps/server/src/modules/demo/stale.ts': 2,
          'apps/server/src/modules/demo/gone.ts': 1,
        }),
      )
      const r = spawnSync(
        process.execPath,
        [
          ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
          '../../scripts/arch/run.mjs',
          '--root',
          root,
          '--only',
          'soft-delete-sql',
        ],
        { encoding: 'utf8' },
      )
      expect(r.status).toBe(1)
      const found = [...r.stderr.matchAll(/x (\S+?):? (\S+)/g)].map(
        ([, at, what]) => `${at} ${what}`,
      )
      expect(found).toEqual([
        'apps/server/src/modules/demo/sql.ts:1 t_user:',
        'apps/server/src/modules/demo/sql.ts:3 t_link:',
        'apps/server/src/modules/demo/sql.ts:11 t_user:',
        // two aliases of one table: a bare deleted_at is ambiguous (reported once per line and table)
        'apps/server/src/modules/demo/sql.ts:20 t_user:',
        // one bare condition, two tables: the subquery reads deleted links
        'apps/server/src/modules/demo/sql.ts:21 t_link:',
        // the column in a select list or a SET, not a condition
        'apps/server/src/modules/demo/sql.ts:22 t_link:',
        'apps/server/src/modules/demo/sql.ts:23 t_user:',
        'apps/server/src/modules/demo/sql.ts:24 t_user:',
        'apps/server/src/modules/demo/sql.ts:13 t_link:',
        'apps/server/src/modules/demo/sql.ts:26 t_link:',
        'apps/server/src/modules/demo/stale.ts 1',
        'apps/server/src/modules/demo/gone.ts 0',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)
