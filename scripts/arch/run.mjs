// Source guards ("源码守卫"): runs every other scripts/arch/*.mjs.
// A check is a module whose default export is `(ctx) => string[] | Promise<string[]>` (violations).
// New checks (scoped-access, action-log, …) are just new files here.
// Usage: node scripts/arch/run.mjs [--root <dir>] [--only name1,name2]
import { globSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const { values } = parseArgs({ options: { root: { type: 'string' }, only: { type: 'string' } } })
const root = resolve(values.root ?? join(here, '../..'))
const only = values.only?.split(',')

const files = (pattern) =>
  globSync(pattern, { cwd: root, exclude: (f) => f.includes('node_modules') })
    .map((f) => f.split('\\').join('/'))
    .sort()
const read = (rel) => readFileSync(join(root, rel), 'utf8')
// Yields every line that is not a comment-only line (`//`, `/*`, ` *`), 1-based line numbers.
function* lines(pattern) {
  for (const file of files(pattern)) {
    const all = read(file).split('\n')
    for (let i = 0; i < all.length; i++) {
      if (!/^\s*(\/\/|\/\*|\*)/.test(all[i])) yield { file, n: i + 1, line: all[i] }
    }
  }
}
const ctx = { root, files, read, lines, only }

const names = readdirSync(here)
  .filter((f) => f.endsWith('.mjs') && f !== 'run.mjs')
  .map((f) => f.slice(0, -4))
  .filter((n) => !only || only.includes(n))
  .sort()

let total = 0
for (const name of names) {
  console.log(`arch: ${name}`)
  let violations
  try {
    const { default: check } = await import(pathToFileURL(join(here, `${name}.mjs`)).href)
    violations = await check(ctx)
  } catch (e) {
    violations = [`check crashed: ${e.message}`]
  }
  for (const v of violations) console.error(`  x ${v}`)
  total += violations.length
}
console.log(total ? `arch: ${total} violation(s)` : `arch: ${names.length} checks ok`)
process.exit(total ? 1 : 0)
