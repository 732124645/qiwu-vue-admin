// Originality guard: reference-project names + `a:b:c` permission strings. Stdlib only, no exemptions.
// Usage: node scripts/originality-check.mjs [--root <dir>] [--self-test]   (--root: the tree to scan)
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { helpLines, helpProblems } from './check-help.mjs'

const here = fileURLToPath(new URL('..', import.meta.url))
const rootArg = process.argv.indexOf('--root')
const root = rootArg >= 0 ? process.argv[rootArg + 1] : here
const ids = readFileSync(join(here, 'scripts/originality/reference-identifiers.txt'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/#.*/, '').trim())
  .filter(Boolean)
if (!ids.length) throw new Error('reference-identifiers.txt is empty')
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// ASCII names: whole word, case-insensitive. CJK names: plain substring.
const idRe = new RegExp(
  ids.map((id) => (/^[\x20-\x7e]+$/.test(id) ? `\\b${esc(id)}\\b` : esc(id))).join('|'),
  'gi',
)
const permRe = /['"][a-z][a-z-]{2,}:[a-z][a-z-]{2,}:[a-z][a-z-]{2,}['"]/g

// how to fix each kind of hit (scripts/check-help.mjs), printed after the hits
const HELP = [
  {
    match: /permission string/,
    fix: 'Write the permission as <domain>.<resource>.<verb> (iam.user.browse) and take it from the xxxPerms constants in packages/shared.',
    doc: 'docs/design-notes.md#permissions',
  },
  {
    fix: "Rename it in this project's own words (own table prefixes, names and texts); other admin projects are a reference for features only, never for code, names or strings.",
    doc: 'docs/security.md#依赖许可与原创性检查',
  },
]

const check = (line) => [
  ...[...line.matchAll(idRe)].map((m) => `reference identifier "${m[0]}"`),
  ...[...line.matchAll(permRe)].map(
    (m) => `permission string ${m[0]} (use <domain>.<resource>.<verb>)`,
  ),
]

if (process.argv.includes('--self-test')) {
  const cjk = ids.find((id) => /[^\x20-\x7e]/.test(id))
  const cases = [
    ["'HH:mm:ss'", false],
    ["'hh:mm:ss'", false],
    ["'12:00:00'", false],
    ["'iam.user.browse'", false],
    [`${ids[0]}x`, false],
    ["'system:user:list'", true],
    [`from ${ids[0]};`, true],
    [ids[0].toUpperCase(), true],
    ...(cjk ? [[`x${cjk}x`, true]] : []),
  ]
  const bad = cases.filter(([s, fail]) => check(s).length > 0 !== fail)
  for (const [s, fail] of bad)
    console.error(`self-test: ${JSON.stringify(s)} should ${fail ? 'fail' : 'pass'}`)
  // a hit ends with how to fix it and where the rule is explained
  assert.deepEqual(helpProblems(HELP), [])
  const tmp = mkdtempSync(join(tmpdir(), 'qw-originality-'))
  try {
    mkdirSync(join(tmp, 'apps/web/src'), { recursive: true })
    mkdirSync(join(tmp, 'packages'))
    writeFileSync(join(tmp, 'apps/web/src/a.ts'), "const p = 'system:user:list'\n")
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', tmp], {
      encoding: 'utf8',
    })
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.ok(r.stderr.includes(`  fix: ${HELP[0].fix}\n  see: ${HELP[0].doc}\n`), r.stderr)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log(`originality self-test: ${cases.length - bad.length}/${cases.length} ok`)
  process.exit(bad.length ? 1 : 0)
}

// the uni-app client, skipped when absent; PC-only: remove with mobile/ (docs/mobile.md)
const MOBILE = 'mobile/src'
const dirs = ['apps', 'packages']
  .flatMap((d) => readdirSync(join(root, d)).map((p) => join(root, d, p, 'src')))
  .concat(join(root, 'apps/server/codegen-templates'))
  .concat(join(root, MOBILE))
  .filter((d) => existsSync(d))
const files = dirs
  .flatMap((d) => readdirSync(d, { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile())
  .map((e) => relative(root, join(e.parentPath, e.name)))
  .filter((p) => !/(^|[\\/])(node_modules|dist)[\\/]/.test(p))
  .sort()

let hits = 0
const reasons = []
for (const file of files) {
  const buf = readFileSync(join(root, file))
  if (buf.includes(0)) continue // binary asset
  buf
    .toString('utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const reason of check(line)) {
        console.error(`${file}:${i + 1}: ${reason}`)
        reasons.push(reason)
        hits++
      }
    })
}
console.log(`originality: ${files.length} files scanned, ${hits} hit(s)`)
for (const line of helpLines(HELP, reasons)) console.error(line)
process.exit(hits ? 1 : 0)
