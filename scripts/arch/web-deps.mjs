// Web is a bundle, and `license:check --prod` only sees "dependencies", so every package
// imported from apps/web/src must be a web dependency (not a devDependency).
// `~icons/<set>/…` (unplugin-icons) → `@iconify-json/<set>`. `import type` is ignored (erased);
// in test files (__tests__/, *.spec.ts) vitest, @vue/test-utils and Vite build tests are exempt.
import { builtinModules } from 'node:module'

const STATIC = /\b(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]/g
const TEST_ONLY = new Set(['vitest', '@vue/test-utils', 'vite'])
const LOCAL = /^(\.|\/|@\/|virtual:|node:)/

export function packageOf(spec) {
  spec = spec.split('?')[0]
  if (LOCAL.test(spec) || builtinModules.includes(spec)) return null
  const icons = spec.match(/^~icons\/([^/]+)/)
  if (icons) return `@iconify-json/${icons[1]}`
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

export function importsOf(src) {
  src = src.replace(/^\s*\/\/.*$/gm, '')
  const specs = [...src.matchAll(STATIC)].filter((m) => !m[1]).map((m) => m[2])
  return [...specs, ...[...src.matchAll(DYNAMIC)].map((m) => m[1])]
}

export default function ({ files, read }) {
  const pkg = JSON.parse(read('apps/web/package.json'))
  const deps = pkg.dependencies ?? {}
  const out = []
  for (const file of files('apps/web/src/**/*.{ts,vue}')) {
    const isTest = /(^|\/)__tests__\/|\.spec\.ts$/.test(file)
    for (const name of new Set(importsOf(read(file)).map(packageOf))) {
      if (!name || deps[name] || (isTest && TEST_ONLY.has(name))) continue
      const where = pkg.devDependencies?.[name] ? 'is a devDependency' : 'is missing'
      out.push(`${file}: '${name}' ${where}; add it to apps/web "dependencies"`)
    }
  }
  return out
}
