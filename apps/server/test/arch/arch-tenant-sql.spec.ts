// scripts/arch/tenant-sql.mjs against a throwaway source tree built from the samples in
// fixtures/tenant-sql-samples.json: raw SQL on a tenant table holds a tenant_id condition of its own,
// ANDed at every level, in its own query (joins and subqueries included, the main table being a platform
// table too; an ON clause filters the table its JOIN brings in, never a RIGHT JOIN's); INSERT / REPLACE
// lists tenant_id; qw:cross-tenant with a reason on the statement or a comment line right above lets a
// statement through; withTenant( / allTenants( outside core/context carry a reason; only core/context and
// core/auth write the tenant keys of the context; `arch-allow: sql-concat` says how it stays in its tenant;
// platform tables, migrations' SQL and comments are not checked. The per-file baseline counts raw SQL
// only (any other hit fails whatever the count), fails on more, never on fewer, and --update-baseline only
// lowers it, deleting the file once empty;
// a missing file reads as an empty baseline. The real tree passing is `pnpm arch:check`.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

interface Sample {
  name: string
  file?: string
  code: string[]
  expect: string[]
}
const SAMPLES: {
  migration: string[]
  migrationExpect: string[]
  platformTables: string[]
  samples: Sample[]
} = JSON.parse(readFileSync('test/arch/fixtures/tenant-sql-samples.json', 'utf8'))

const MIGRATION = 'apps/server/src/db/migrations/1-m.ts'
const TABLES = `// fixture
const TEMPLATE_PLATFORM_TABLES: readonly string[] = [
${SAMPLES.platformTables.map((t) => `  '${t}',`).join('\n')}
]
`
const BASELINE = 'scripts/arch/tenant-sql.baseline.json'
const fileOf = (s: Sample, i: number) => s.file ?? `apps/server/src/modules/demo/sample-${i}.ts`

function tree(migration = SAMPLES.migration) {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-'))
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put(MIGRATION, migration.join('\n'))
  put('apps/server/src/core/db/tenant-tables.ts', TABLES)
  return { root, put }
}

function run(root: string, args: string[], platform = 'native') {
  return spawnSync(
    process.execPath,
    [
      ...(platform === 'windows' ? ['--import', './test/arch/fixtures/windows-paths.mjs'] : []),
      ...args,
      '--root',
      root,
    ],
    { encoding: 'utf8' },
  )
}

/** `<file> → ["<line> <what>"]` of the violations reported. */
function reported(stderr: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [, file, line, what] of stderr.matchAll(/x (\S+):(\d+) (\S+?): /g))
    out.set(file, [...(out.get(file) ?? []), `${line} ${what}`])
  return out
}

describe.each(['native', 'windows'])('%s', (platform) => {
  it('every sample reports exactly the lines it expects', () => {
    const { root, put } = tree()
    try {
      SAMPLES.samples.forEach((s, i) => put(fileOf(s, i), `${s.code.join('\n')}\n`))
      const r = run(root, ['../../scripts/arch/run.mjs', '--only', 'tenant-sql'], platform)
      expect(r.stdout + r.stderr).not.toContain('check crashed')
      expect(r.status).toBe(1)
      const found = reported(r.stderr)
      const got = SAMPLES.samples.map((s, i) => ({
        name: s.name,
        lines: [...(found.get(fileOf(s, i)) ?? [])].sort(),
      }))
      expect(got).toEqual(
        SAMPLES.samples.map((s) => ({ name: s.name, lines: [...s.expect].sort() })),
      )
      expect(found.get(MIGRATION) ?? []).toEqual(SAMPLES.migrationExpect)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

it("a project's own platform tables (db/project-tables.ts) are left alone like the template's", () => {
  const { root, put } = tree(SAMPLES.migration.filter((l) => !l.includes('arch-allow')))
  const file = 'apps/server/src/modules/demo/project.ts'
  try {
    put(file, "await q.query('SELECT id FROM t_user')\n")
    const before = run(root, ['../../scripts/arch/run.mjs', '--only', 'tenant-sql'])
    expect(Object.fromEntries(reported(before.stderr))).toEqual({ [file]: ['1 t_user'] })
    put(
      'apps/server/src/db/project-tables.ts',
      "export const PROJECT_PLATFORM_TABLES: readonly string[] = ['t_user']\n",
    )
    const after = run(root, ['../../scripts/arch/run.mjs', '--only', 'tenant-sql'])
    expect(after.stdout + after.stderr).not.toContain('check crashed')
    expect(after.status).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('the baseline fails a file over its count, never one under it, counts raw SQL only; --update-baseline only lowers', () => {
  // the migration without its own violation: only the sample files count here
  const { root, put } = tree(SAMPLES.migration.filter((l) => !l.includes('arch-allow')))
  const one = "await q.query('SELECT id FROM t_user')\n"
  const dir = 'apps/server/src/modules/demo'
  try {
    put(`${dir}/listed.ts`, one)
    put(`${dir}/fewer.ts`, one)
    put(`${dir}/more.ts`, one + one)
    put(`${dir}/new.ts`, one)
    // at its count, one statement traded for a call without a reason: not covered by the baseline
    put(`${dir}/swapped.ts`, `${one}allTenants(() => purge())\n`)
    const baseline = {
      [`${dir}/fewer.ts`]: 2,
      [`${dir}/gone.ts`]: 1,
      [`${dir}/listed.ts`]: 1,
      [`${dir}/more.ts`]: 1,
      [`${dir}/swapped.ts`]: 2,
    }
    put(BASELINE, JSON.stringify(baseline))
    const r = run(root, ['../../scripts/arch/run.mjs', '--only', 'tenant-sql'])
    expect(r.status).toBe(1)
    expect(Object.fromEntries(reported(r.stderr))).toEqual({
      [`${dir}/more.ts`]: ['1 t_user', '2 t_user'],
      [`${dir}/new.ts`]: ['1 t_user'],
      [`${dir}/swapped.ts`]: ['2 allTenants'],
    })
    expect(JSON.parse(readFileSync(join(root, BASELINE), 'utf8'))).toEqual(baseline)

    // the check on its own, as the squash runs it: lowered and dropped, never raised nor added
    const u = run(root, ['../../scripts/arch/tenant-sql.mjs', '--update-baseline'])
    expect(u.status).toBe(1)
    expect(JSON.parse(readFileSync(join(root, BASELINE), 'utf8'))).toEqual({
      [`${dir}/fewer.ts`]: 1,
      [`${dir}/listed.ts`]: 1,
      [`${dir}/more.ts`]: 1,
      [`${dir}/swapped.ts`]: 1,
    })

    rmSync(join(root, dir, 'more.ts'))
    rmSync(join(root, dir, 'new.ts'))
    rmSync(join(root, dir, 'swapped.ts'))
    expect(run(root, ['../../scripts/arch/run.mjs', '--only', 'tenant-sql']).status).toBe(0)

    // nothing left: the file goes, and without it any statement fails
    rmSync(join(root, dir, 'fewer.ts'))
    rmSync(join(root, dir, 'listed.ts'))
    expect(run(root, ['../../scripts/arch/tenant-sql.mjs', '--update-baseline']).status).toBe(0)
    expect(existsSync(join(root, BASELINE))).toBe(false)
    put(`${dir}/new.ts`, one)
    const none = run(root, ['../../scripts/arch/run.mjs', '--only', 'tenant-sql'])
    expect(none.status).toBe(1)
    expect(Object.fromEntries(reported(none.stderr))).toEqual({ [`${dir}/new.ts`]: ['1 t_user'] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
