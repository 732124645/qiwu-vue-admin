// The reserved names of packages/shared/src/common/reserved-names.ts must
// hold every name the template's own code takes as a first segment, so no project domain can clash with
// one: every controller root, locale namespace and top-level code directory (server modules/, web views/
// and api/, shared src/) is reserved or a project domain. Project domains = the top-level directories of
// apps/server/src/modules that are not reserved (none in the template; a derived project's `erp`): their
// namespaces and directories pass, their controllers may use their own root, a template controller
// (core, platform, workflow, the built-in biz / demo) only reserved ones.
// The web router's static route names too (a generated page's route name `<domain>-<business>` must never
// replace one): each, or its first hyphen segment, is reserved, and WEB_STATIC_ROUTE_NAMES of that file
// lists exactly them (the menu schema refuses those as a menu's route name).
// A new top-level modules/ directory that is not reserved counts as a project domain; the
// template adds none without extending the lists.
import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const LISTS = 'packages/shared/src/common/reserved-names.ts'
const DOMAIN = /^[a-z][a-z0-9]{0,31}$/
const CONTROLLER = /@Controller\(\s*['"`]\/?([^'"`/]*)/g
const LOCALE_DIRS = ['apps/web/src/locales', 'apps/server/src/i18n', 'packages/shared/src/i18n']
const CODE_DIRS = ['apps/web/src/views', 'apps/web/src/api', 'packages/shared/src']
const ROUTER = 'apps/web/src/core/router/index.ts'

/** The `name:` of every route in the router's `staticRoutes` array (a `const` name resolved). */
export function staticRouteNames(text) {
  const block = /export const staticRoutes\b[^=]*=\s*\[([\s\S]*?)\n\]/.exec(text)?.[1] ?? ''
  return [...block.matchAll(/\bname: (?:'([^']+)'|(\w+))/g)].map(
    ([, name, id]) => name ?? new RegExp(`const ${id} = '([^']+)'`).exec(text)?.[1] ?? id,
  )
}

/** The quoted names of `WEB_STATIC_ROUTE_NAMES` in reserved-names.ts. */
export function listedRouteNames(text) {
  const list = /WEB_STATIC_ROUTE_NAMES\b[^=]*=\s*\[([^\]]*)\]/.exec(text)?.[1] ?? ''
  return [...list.matchAll(/'([^']+)'/g)].map(([, name]) => name)
}

/** `{ layers: ['core', …], … }` from the backquoted lists of reserved-names.ts. */
export function reservedLists(text) {
  const lists = {}
  for (const m of text.matchAll(/^\s*(\w+): `([^`]*)`/gm)) lists[m[1]] = m[2].trim().split(/\s+/)
  return lists
}

export default function ({ root, files, read }) {
  const reserved = new Set(Object.values(reservedLists(read(LISTS))).flat())
  if (!reserved.has('core')) return [`${LISTS}: no reserved name lists found`]
  const dirs = (dir) => {
    try {
      return readdirSync(join(root, dir), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  const out = []
  const project = new Set(dirs('apps/server/src/modules').filter((d) => !reserved.has(d)))
  for (const d of project)
    if (!DOMAIN.test(d))
      out.push(`apps/server/src/modules/${d}/: neither a reserved name nor a project domain name`)
  const allowed = (name) => reserved.has(name) || project.has(name)

  for (const file of files('apps/server/src/**/*.controller.ts')) {
    const own = /^apps\/server\/src\/modules\/([^/]+)\//.exec(file)?.[1]
    for (const [, name] of read(file).matchAll(CONTROLLER))
      if (name && !reserved.has(name) && !(project.has(own) && name === own))
        out.push(`${file}: controller root '${name}' is not in ${LISTS}`)
  }
  for (const dir of LOCALE_DIRS)
    for (const file of files(`${dir}/*/**/*.json`)) {
      const name = basename(file, '.json')
      const namespaces = name.includes('.') ? Object.keys(JSON.parse(read(file))) : [name]
      for (const ns of namespaces.filter((n) => !allowed(n)))
        out.push(`${file}: locale namespace '${ns}' is not in ${LISTS}`)
    }
  for (const dir of CODE_DIRS)
    for (const d of dirs(dir).filter((n) => !allowed(n)))
      out.push(`${dir}/${d}/: '${d}' is neither in ${LISTS} nor a project domain`)

  const routes = staticRouteNames(read(ROUTER))
  if (!routes.length) out.push(`${ROUTER}: no staticRoutes names found`)
  for (const name of routes.filter((n) => !reserved.has(n.split('-')[0])))
    out.push(`${ROUTER}: static route '${name}' (or its first segment) is not in ${LISTS}`)
  const sorted = (a) => [...new Set(a)].sort().join(' ')
  if (sorted(routes) !== sorted(listedRouteNames(read(LISTS))))
    out.push(`${LISTS}: WEB_STATIC_ROUTE_NAMES is not the static route names of ${ROUTER}`)
  return out
}
