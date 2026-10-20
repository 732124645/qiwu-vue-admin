// scripts/arch/migration-names.mjs against a throwaway source tree: a migration file is
// `<14-digit timestamp>-<kebab-name>.ts`, no two share a timestamp, and its class (and `name`) ends with
// the file's timestamp; files elsewhere are not checked. The real tree passing is `pnpm arch:check`.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const DIR = 'apps/server/src/db/migrations'
const migration = (cls: string, name = cls) =>
  `export class ${cls} implements MigrationInterface {\n  name = '${name}'\n}\n`

/** 在临时目录里按 `files` 建源码树，只跑 migration-names 检查，返回退出码与报出的行。 */
function check(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'qw-arch-migrations-'))
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const r = spawnSync(
      process.execPath,
      ['../../scripts/arch/run.mjs', '--only', 'migration-names', '--root', root],
      { encoding: 'utf8' },
    )
    expect(r.stdout + r.stderr).not.toContain('check crashed')
    return { status: r.status, found: [...r.stderr.matchAll(/ {2}x (.+)/g)].map((m) => m[1]) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('passes distinct 14-digit timestamps whose classes end with them', () => {
  expect(
    check({
      [`${DIR}/20261007100000-tenant.ts`]: migration('Tenancy20261007100000'),
      [`${DIR}/20261018100000-wxoa-tenant.ts`]: migration('WxoaTenant20261018100000'),
      [`${DIR}/20261020153817-crm-order.ts`]: migration('CrmOrder20261020153817'),
      // not a migration directory
      'apps/server/test/fixtures/1790000000000-probe.ts': migration('Probe1790000000000'),
    }),
  ).toEqual({ status: 0, found: [] })
})

it('refuses two files sharing a timestamp, naming both', () => {
  const r = check({
    [`${DIR}/20261018100000-wxoa-tenant.ts`]: migration('WxoaTenant20261018100000'),
    [`${DIR}/20261018100000-hk-order.ts`]: migration('HkOrder20261018100000'),
  })
  expect(r.status).toBe(1)
  expect(r.found).toEqual([
    `${DIR}/20261018100000-hk-order.ts, ${DIR}/20261018100000-wxoa-tenant.ts: share the timestamp 20261018100000; give the unreleased one the current time (seconds included)`,
  ])
})

it.each([
  ['a 13-digit (JavaScript) timestamp', '1790000000000-probe.ts'],
  ['a 15-digit timestamp', '202610201538170-probe.ts'],
  ['no separator', '20261020153817probe.ts'],
  ['upper case', '20261020153817-CrmOrder.ts'],
])('refuses %s', (_, file) => {
  const r = check({ [`${DIR}/${file}`]: migration('Probe20261020153817') })
  expect(r.status).toBe(1)
  expect(r.found).toEqual([
    `${DIR}/${file}: name it <14-digit timestamp>-<kebab-name>.ts (e.g. 20261020153817-crm-order.ts)`,
  ])
})

it("refuses a class or name that does not end with the file's timestamp, and a file without a class", () => {
  const r = check({
    [`${DIR}/20261020153817-crm-order.ts`]: migration('CrmOrder20261020153000'),
    [`${DIR}/20261020153818-crm-line.ts`]: migration(
      'CrmLine20261020153818',
      'CrmLine20261020153000',
    ),
    [`${DIR}/20261020153819-empty.ts`]: 'export const nothing = 1\n',
  })
  expect(r.status).toBe(1)
  expect(r.found).toEqual([
    `${DIR}/20261020153817-crm-order.ts: CrmOrder20261020153000 does not end with the file's timestamp 20261020153817`,
    `${DIR}/20261020153817-crm-order.ts: CrmOrder20261020153000 does not end with the file's timestamp 20261020153817`,
    `${DIR}/20261020153818-crm-line.ts: CrmLine20261020153000 does not end with the file's timestamp 20261020153818`,
    `${DIR}/20261020153819-empty.ts: no exported migration class`,
  ])
})
