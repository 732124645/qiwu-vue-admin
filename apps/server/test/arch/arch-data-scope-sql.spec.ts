// scripts/arch/data-scope-sql.mjs (see docs/data-scope.md) against a throwaway source tree: raw SQL reading
// the table of a @DataScoped entity after FROM or JOIN (subqueries, DELETE FROM) is a template literal that
// interpolates a `.sql` in a function whose own body calls dataScopeSql / dataScopeSqlFor (a plain string
// beside it, a template interpolating something else, or a sibling closure of the calling one, is flagged),
// or carries `qw:no-data-scope <reason>` on its lines or a comment line right above (`/* qw:no-data-scope */`
// has no reason); a query builder from / join naming such a table needs the marker; other tables, writes by
// UPDATE / INSERT, comments, migrations and spec files are not checked. The real tree passing is
// `pnpm arch:check` (pnpm verify).
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ENTITIES = `@DataScoped({ dept: 'dept_id', owner: 'created_by' })
@Entity('t_note')
export class Note extends BaseEntity {}

@Entity('t_tree')
@DataScoped({ dept: 'id', owner: null })
export class Tree extends BaseEntity {}

@Entity('t_plain')
export class Plain extends BaseEntity {}
`
// `[line, tables reported on it]`
const CODE: [string, string[]][] = [
  ['export class Sample {', []],
  ["  a() { return q.query('SELECT id FROM t_note WHERE id = ?', [1]) }", ['t_note']],
  ["  b() { return q.query('SELECT id FROM t_plain') }", []],
  ['  c() {', []],
  ["    const s = dataScopeSql('n', cols)", []],
  ['    return q.query(`SELECT n.id FROM t_note n WHERE ${s.sql}`, s.params)', []],
  ['  }', []],
  ['  d() {', []],
  ["    const s = this.scope.dataScopeSqlFor(Note, 'n')", []],
  ['    return run(() => q.query(`SELECT n.id FROM t_note n WHERE ${s.sql}`, s.params))', []],
  ['  }', []],
  [
    "  e() { return q.query('SELECT p.id FROM t_plain p JOIN t_note n ON n.id = p.note_id') }",
    ['t_note'],
  ],
  [
    "  f() { return q.query('SELECT id FROM t_plain WHERE x IN (SELECT dept_id FROM t_tree)') }",
    ['t_tree'],
  ],
  ["  g() { return q.query('DELETE FROM t_note WHERE id = ?', [1]) }", ['t_note']],
  ["  h() { return q.query('UPDATE t_note SET title = ? WHERE id = ?', [t, 1]) }", []],
  ["  i() { return q.query('INSERT INTO t_note (title) VALUES (?)', [t]) }", []],
  [
    "  j() { return q.query('SELECT n.id FROM t_note n JOIN t_tree d ON d.id = n.dept_id') }",
    ['t_note', 't_tree'],
  ],
  ["  k() { return q.query('SELECT id FROM t_note') } // qw:no-data-scope a sign-in", []],
  ['  l() {', []],
  ['    // qw:no-data-scope an in-use check', []],
  ["    return q.query('SELECT id FROM t_note WHERE dept_id = ?', [1])", []],
  ['  }', []],
  ['  m() {', []],
  ['    return q.query(', []],
  ['      `SELECT id', []],
  ['         FROM t_note', []],
  ['        WHERE id = ?`, // qw:no-data-scope the own row', []],
  ['      [1],', []],
  ['    )', []],
  ['  }', []],
  ["  n() { return q.query('SELECT id FROM t_note') } // qw:no-data-scope", ['t_note']],
  ['  o() {', []],
  ['    // qw:no-data-scope two lines above is not right above', []],
  ['    const x = 1', []],
  ["    return q.query('SELECT id FROM t_note')", ['t_note']],
  ['  }', []],
  ['  p() {', []],
  ['    const x = 1 // qw:no-data-scope code above is not a comment line', []],
  ["    return q.query('SELECT id FROM t_note')", ['t_note']],
  ['  }', []],
  ["  q() { dataScopeSql('n', cols) }", []],
  ["  r() { return q.query('SELECT id FROM t_note') }", ['t_note']],
  ['  s(table: string) { return q.query(`SELECT id FROM ${table}`) }', []],
  ['  // SELECT id FROM t_note in a comment is no SQL', []],
  ["  t() { return q.query('SELECT id FROM `t_note` WHERE id = ?', [1]) }", ['t_note']],
  ['  u() {', []],
  ["    const s = dataScopeSql('n', cols)", []],
  ['    const rows = q.query(`SELECT n.id FROM t_note n WHERE ${s.sql}`, s.params)', []],
  ["    const total = q.query('SELECT COUNT(*) AS n FROM t_note')", ['t_note']],
  ['    return [rows, total]', []],
  ['  }', []],
  ['  v(where: string) {', []],
  ["    const s = dataScopeSql('n', cols)", []],
  [
    '    const rows = q.query(`SELECT n.id FROM t_note n WHERE ${where} AND ${s.sql}`, s.params)',
    [],
  ],
  ['    const total = q.query(`SELECT COUNT(*) AS c FROM t_note n WHERE ${where}`)', ['t_note']],
  ['    return [rows, total]', []],
  ['  }', []],
  [
    "  w() { return q.query(`SELECT b.id FROM t_note b WHERE ${dataScopeSqlFor(Note, 'b').sql}`) }",
    [],
  ],
  ["  x() { return q.query('SELECT id FROM t_note') /* qw:no-data-scope */ }", ['t_note']],
  ["  y() { return q.query('SELECT id FROM t_note') /* qw:no-data-scope a sign-in */ }", []],
  [
    "  z() { return ds.createQueryBuilder().from('t_note', 'n').innerJoin('t_tree', 'd', 'd.id = n.dept_id').leftJoin('n.owner', 'o').getMany() }",
    ['t_note', 't_tree'],
  ],
  ["  qb1() { return ds.createQueryBuilder().from('t_plain', 'p').getMany() }", []],
  [
    "  qb2() { return ds.createQueryBuilder().from('t_note', 'n').getMany() } // qw:no-data-scope a sign-in",
    [],
  ],
  ['}', []],
  ["const SQL = { users: 'SELECT id FROM t_note WHERE id IN (?)' }", ['t_note']],
  ['const make = (q: Q) => ({', []],
  ['  list: () => {', []],
  ["    const s = dataScopeSql('n', cols)", []],
  ['    return q.query(`SELECT n.id FROM t_note n WHERE ${s.sql}`, s.params)', []],
  ['  },', []],
  ["  all: () => q.query('SELECT id, title FROM t_note'),", ['t_note']],
  ['  one: (t: number) => q.query(`SELECT id FROM t_note WHERE tenant_id = ${t}`),', ['t_note']],
  ['})', []],
]
const SAMPLE = 'apps/server/src/modules/demo/sample.ts'

it.each(['native', 'windows'])(
  '%s: flags raw SQL on data-scoped tables without dataScopeSql or a marker, nothing else',
  (platform) => {
    const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
    const put = (rel: string, text: string) => {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
    try {
      put('apps/server/src/modules/demo/entities.ts', ENTITIES)
      put(SAMPLE, `${CODE.map(([line]) => line).join('\n')}\n`)
      const unchecked = "await q.query('SELECT id FROM t_note')\n"
      put('apps/server/src/db/migrations/1-m.ts', unchecked)
      put('apps/server/src/modules/demo/sample.spec.ts', unchecked)
      put('apps/server/test/sample.ts', unchecked)
      const r = spawnSync(
        process.execPath,
        [
          ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
          '../../scripts/arch/run.mjs',
          '--root',
          root,
          '--only',
          'data-scope-sql',
        ],
        { encoding: 'utf8' },
      )
      expect(r.stdout + r.stderr).not.toContain('check crashed')
      expect(r.status).toBe(1)
      const found = [...r.stderr.matchAll(/x (\S+):(\d+) (\S+?): /g)].map(
        ([, file, line, table]) => `${file}:${line} ${table}`,
      )
      expect(found.sort()).toEqual(
        CODE.flatMap(([, tables], i) => tables.map((t) => `${SAMPLE}:${i + 1} ${t}`)).sort(),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

it('a @DataScoped class without @Entity(<table>) fails the check', () => {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  try {
    mkdirSync(join(root, 'apps/server/src/modules/demo'), { recursive: true })
    writeFileSync(
      join(root, 'apps/server/src/modules/demo/x.ts'),
      "@DataScoped({ dept: 'dept_id', owner: null })\n@Entity()\nexport class X {}\n",
    )
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--root', root, '--only', 'data-scope-sql'],
      { encoding: 'utf8' },
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(
      "check crashed: apps/server/src/modules/demo/x.ts: @DataScoped X without @Entity('<table>')",
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
