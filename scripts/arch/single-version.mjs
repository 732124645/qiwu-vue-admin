// Key toolchain packages resolve to exactly one version across the workspace
// (fix = route every package.json entry through `catalog:` in pnpm-workspace.yaml).
// Self-test: node scripts/arch/single-version.mjs --self-test
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NAMES = ['vitest', '@vitest/coverage-v8', 'typescript', 'vite', 'vue', 'element-plus']

// pnpm 11 `why -r --json a b …` prints one top-level entry per resolved instance: [{ name, version, … }].
const pnpmWhy = (root) =>
  JSON.parse(
    execSync(`pnpm why -r --json ${NAMES.join(' ')}`, {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    }),
  )

export default function check({ root, why = pnpmWhy(root) }) {
  const seen = new Map(NAMES.map((n) => [n, new Set()]))
  for (const { name, version } of why) seen.get(name)?.add(version)
  const out = []
  for (const [name, set] of seen) {
    const versions = [...set].sort()
    console.log(`  ${name} ${versions.join(', ') || '(not installed)'}`)
    if (versions.length > 1)
      out.push(`${name} resolves to ${versions.join(' + ')}; use catalog: everywhere`)
  }
  return out
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--self-test')) {
  const ok = [
    { name: 'vite', version: '8.3.1', peersSuffixHash: 'a' },
    { name: 'vite', version: '8.3.1', peersSuffixHash: 'b' },
    { name: 'vue', version: '3.5.43' },
  ]
  assert.deepEqual(check({ why: ok }), [])
  const bad = check({ why: [...ok, { name: 'vite', version: '7.1.0' }] })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /^vite resolves to 7\.1\.0 \+ 8\.3\.1/)
  console.log('single-version self-test ok')
}
