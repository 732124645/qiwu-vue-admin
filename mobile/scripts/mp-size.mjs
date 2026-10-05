// WeChat package limits after `uni build -p mp-weixin`: the main package and every
// subpackage ≤ 2 MB, all together ≤ 30 MB. Each package loads on its own: code and components come
// from the main package or the package itself, never from another subpackage (WeChat downloads a subpackage
// only when one of its pages opens). No code the mini program cannot run: the eval-style global
// lookup of engine.io-client (vite.config.ts swaps its globals) and Node's socket / XHR modules (socket.io's
// Node transports). Usage: node scripts/mp-size.mjs [<build dir>]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

const MB = 1024 * 1024
const dir = process.argv[2] ?? 'dist/build/mp-weixin'
const app = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'))
const roots = (app.subPackages ?? app.subpackages ?? []).map((p) => p.root.replace(/\/?$/, '/'))
const sizes = new Map([['main', 0], ...roots.map((r) => [r, 0])])
const pkgOf = (rel) => roots.find((r) => rel.startsWith(r)) ?? 'main'
const crossed = []
const BANNED = [
  /Function\(\s*["']return this["']\s*\)/,
  /require\(\s*["']ws["']\s*\)/,
  /xmlhttprequest-ssl/,
]
const banned = []
for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!e.isFile()) continue
  const file = join(e.parentPath, e.name)
  const rel = relative(dir, file).split(sep).join('/')
  const pkg = pkgOf(rel)
  sizes.set(pkg, sizes.get(pkg) + statSync(file).size)
  // relative requires in code, components by path in page/component json
  const text = /\.(js|json)$/.test(rel) ? readFileSync(file, 'utf8') : ''
  if (rel.endsWith('.js'))
    banned.push(...BANNED.filter((re) => re.test(text)).map((re) => `${rel}: ${re}`))
  const used = [...text.matchAll(/require\("(\.{1,2}\/[^"]+)"\)/g)].map((m) => m[1])
  if (rel.endsWith('.json'))
    used.push(...Object.values(JSON.parse(text).usingComponents ?? {}).filter((u) => /^[./]/.test(u)))
  for (const u of used) {
    const target = u.startsWith('/') ? u.slice(1) : posix.join(posix.dirname(rel), u)
    const from = pkgOf(target)
    if (from !== 'main' && from !== pkg) crossed.push(`${rel} → ${target}`)
  }
}
const total = [...sizes.values()].reduce((a, b) => a + b, 0)
const bad = [...sizes].filter(([, size]) => size > 2 * MB).map(([pkg]) => pkg)
if (total > 30 * MB) bad.push('total')
for (const [pkg, size] of sizes)
  console.log(`mp-size: ${pkg.padEnd(12)} ${(size / 1024).toFixed(1)} KB`)
console.log(`mp-size: total        ${(total / 1024).toFixed(1)} KB`)
for (const c of crossed) console.error(`mp-size: loads another subpackage's file: ${c}`)
if (crossed.length) process.exitCode = 1
for (const b of banned) console.error(`mp-size: code the mini program cannot run: ${b}`)
if (banned.length) process.exitCode = 1
if (bad.length) {
  console.error(
    `mp-size: over the WeChat limit (2 MB per package, 30 MB in all): ${bad.join(', ')}`,
  )
  process.exitCode = 1
}
