// Platform and workflow code never imports a project domain. Every import (static,
// dynamic, `export … from`, `import.meta.glob`) of a file below server modules/{platform,workflow}, web
// views/ or api/{platform,workflow} or shared src/{platform,workflow} must not reach into a directory of
// server modules/, web views/ or api/, or shared src/ that is not one of the reserved `layers` / `pages`
// (packages/shared/src/common/reserved-names.ts): `biz`, `demo` and every project domain are off limits,
// and so is server modules/project.module.ts, which imports them all.
// Relative paths and the web `@/` alias are resolved; a path with `${…}` is text (a template), not an import.
import { dirname, posix } from 'node:path'
import { reservedLists } from './reserved-names.mjs'

const LISTS = 'packages/shared/src/common/reserved-names.ts'
const SOURCES = [
  'apps/server/src/modules/{platform,workflow}/**/*.ts',
  'apps/web/src/{views,api}/{platform,workflow}/**/*.{ts,vue}',
  'packages/shared/src/{platform,workflow}/**/*.ts',
]
const ROOTS = [
  'apps/server/src/modules/',
  'apps/web/src/views/',
  'apps/web/src/api/',
  'packages/shared/src/',
]
const PROJECT_MODULE = /^apps\/server\/src\/modules\/project\.module(\.[jt]s)?$/
const IMPORT = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]/g
const GLOB = /\bimport\.meta\.glob(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g

/** Repository path an import of `file` names, or null (a package, a template text). */
export function resolveImport(file, spec) {
  if (spec.includes('${')) return null
  if (spec.startsWith('@/')) return `apps/web/src/${spec.slice(2)}`
  if (spec.startsWith('/src/')) return `apps/web${spec}`
  if (spec.startsWith('.')) return posix.join(dirname(file), spec)
  return null
}

export default function ({ files, read }) {
  const lists = reservedLists(read(LISTS))
  const open = new Set([...(lists.layers ?? []), ...(lists.pages ?? [])])
  if (!open.has('platform')) return [`${LISTS}: no reserved name lists found`]
  const out = []
  for (const file of SOURCES.flatMap((p) => files(p))) {
    const src = read(file).replace(/^\s*\/\/.*$/gm, '')
    for (const re of [IMPORT, DYNAMIC, GLOB])
      for (const [, spec] of src.matchAll(re)) {
        const path = resolveImport(file, spec)
        const root = path && ROOTS.find((r) => path.startsWith(r))
        const dir = root && path.slice(root.length).split('/')
        // a directory below one of the roots (a file right in it, like api/auth-extra.ts, is none)
        if (dir && dir.length > 1 && !open.has(dir[0]))
          out.push(
            `${file}: imports '${spec}' of the project domain '${dir[0]}' (docs/design-notes.md#layering)`,
          )
        // the project domains' registration point
        else if (path && PROJECT_MODULE.test(path))
          out.push(
            `${file}: imports '${spec}', the project domains' module (docs/design-notes.md#layering)`,
          )
      }
  }
  return out
}
