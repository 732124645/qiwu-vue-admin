// Dependency audit of mobile/: `pnpm audit --json`, split into advisories DCloud's pinned toolchain
// locks (listed, never fail) and the rest (high/critical fail, like the main `pnpm audit --prod
// --audit-level high`). A report, not part of `verify` (it needs the registry): run it before a
// release. Usage: node scripts/audit-report.mjs [<saved pnpm audit --json output>]
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// pinned by uni-app, not by us; anything reached only through @dcloudio/* is locked too
const LOCKED = {
  vite: 'peer 5.2.8 of @dcloudio/vite-plugin-uni',
  'vue-i18n': 'types only: uni swaps in its built-in 9.1.9 runtime at build time',
  vitest: 'vitest 4 needs vite 6 (vite is pinned to 5.2.8)',
  '@vitest/mocker': 'part of vitest',
}

function audit() {
  if (process.argv[2]) return readFileSync(process.argv[2], 'utf8')
  try {
    return execSync('pnpm audit --json', {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    if (e.stdout) return e.stdout // pnpm audit exits 1 when it finds anything
    throw e
  }
}

// a path like `.>@dcloudio/uni-app>…>adm-zip` or `.>vite>esbuild`
const lockedPath = (path) =>
  path
    .split('>')
    .slice(1, -1)
    .some((name) => name.startsWith('@dcloudio/') || name in LOCKED)

const locked = []
const open = []
for (const a of Object.values(JSON.parse(audit()).advisories ?? {})) {
  const paths = a.findings.flatMap((f) => f.paths)
  const why = LOCKED[a.module_name] ?? (paths.every(lockedPath) ? 'via a locked package' : '')
  ;(why ? locked : open).push({ ...a, why })
}
const show = (a) => {
  const versions = [...new Set(a.findings.map((f) => f.version))].join(', ')
  const id = a.github_advisory_id ?? a.url
  return `  ${a.severity.padEnd(8)} ${a.module_name}@${versions} ${id}${a.why ? `  (${a.why})` : ''}`
}
console.log(`audit: DCloud-locked (${locked.length}), not fixable in mobile/:`)
for (const a of locked) console.log(show(a))
console.log(`audit: other (${open.length}):`)
for (const a of open) console.log(show(a))
const bad = open.filter((a) => a.severity === 'high' || a.severity === 'critical')
if (bad.length) {
  console.error(`audit: ${bad.length} high/critical advisor(ies) outside the DCloud-locked set`)
  process.exitCode = 1
}
