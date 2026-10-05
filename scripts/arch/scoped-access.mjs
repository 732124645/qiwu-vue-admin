// Data-scope and session source guards (TypeScript AST, not regex; docs/design-notes.md#data-scope, #auth-sessions):
//  1. A controller that injects the service of a `@DataScoped` entity: every non-GET route with a path
//     param (`:id`) or an `ids` payload must reach `lockScopedIds` — directly, or through a method of
//     that service that does (its own methods, else the inherited ones of BaseCrudService or of a base
//     extending it, e.g. BaseTreeService).
//  2. auth:* Redis keys belong to core/auth: no other server code names an auth namespace
//     (redisKey('auth…')/keyPattern('auth…')/CACHE_NAMESPACES.auth…), so nothing else can delete a
//     session key; everything else ends sessions through SessionRevoker.
// Static heuristic over `this.<field>.<method>()` calls. A route that reaches the service
// only through a local variable or a helper function, or a repository injected straight into a
// controller, is not seen; code review and data-scope e2e specs cover those.
import ts from 'typescript'

const SOURCES = 'apps/server/{src,test/fixtures}/**/*.ts'
const BASE_FILE = 'apps/server/src/core/db/base-crud.service.ts'
const WRITE = new Set(['Post', 'Put', 'Patch', 'Delete'])
const AUTH_KEY = /\b(?:redisKey|keyPattern)\s*\(\s*['"`]auth|\bCACHE_NAMESPACES\s*\.\s*auth/

const decoratorsOf = (node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [])
const callName = (d) =>
  (ts.isCallExpression(d.expression) ? d.expression.expression : d.expression).getText()
const hasDecorator = (node, name) => decoratorsOf(node).some((d) => callName(d) === name)

/** Every call inside `node`: `this.m()` / `super.m()` → self, `this.f.m()` → member, `lockScopedIds(` → lock. */
function callsIn(node) {
  const out = { self: new Set(), sup: new Set(), member: [], lock: false }
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const { expression: obj, name } = n.expression
      if (name.text === 'lockScopedIds') out.lock = true
      if (obj.kind === ts.SyntaxKind.ThisKeyword) out.self.add(name.text)
      else if (obj.kind === ts.SyntaxKind.SuperKeyword) out.sup.add(name.text)
      else if (
        ts.isPropertyAccessExpression(obj) &&
        obj.expression.kind === ts.SyntaxKind.ThisKeyword
      )
        out.member.push({ field: obj.name.text, method: name.text })
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

const methods = (cls) =>
  new Map(
    cls.members
      .filter((m) => ts.isMethodDeclaration(m) && m.body && ts.isIdentifier(m.name))
      .map((m) => [m.name.text, m]),
  )

/** Names of the methods of `cls` that reach lockScopedIds (fixpoint over this./super. calls). */
function lockingMethods(cls, inherited = new Set()) {
  const own = methods(cls)
  const calls = new Map([...own].map(([name, m]) => [name, callsIn(m.body)]))
  const locks = new Set([...inherited].filter((name) => !own.has(name)))
  if (inherited.size) locks.add('lockScopedIds')
  for (let changed = true; changed;) {
    changed = false
    for (const [name, c] of calls) {
      if (locks.has(name)) continue
      if (
        c.lock ||
        [...c.self].some((k) => locks.has(k)) ||
        [...c.sup].some((k) => inherited.has(k))
      ) {
        locks.add(name)
        changed = true
      }
    }
  }
  return locks
}

const classes = (sf) => sf.statements.filter((s) => ts.isClassDeclaration(s) && s.name)

export default function ({ files, read, lines }) {
  const out = []
  const parsed = files(SOURCES)
    .filter((f) => !f.endsWith('.d.ts'))
    .map((file) => ({
      file,
      sf: ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true),
    }))

  const base = parsed.find((p) => p.file === BASE_FILE)
  const baseClass = base && classes(base.sf).find((c) => c.name.text === 'BaseCrudService')
  if (!baseClass) return [`${BASE_FILE}: BaseCrudService not found`]
  const baseLocks = lockingMethods(baseClass)
  baseLocks.add('lockScopedIds')

  const scopedEntities = new Set(
    parsed.flatMap(({ sf }) =>
      classes(sf)
        .filter((c) => hasDecorator(c, 'DataScoped'))
        .map((c) => c.name.text),
    ),
  )
  // base classes by name: BaseCrudService and those extending it (BaseTreeService), any depth
  const byName = new Map(parsed.flatMap(({ sf }) => classes(sf).map((c) => [c.name.text, c])))
  const extendsOf = (c) =>
    c.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
  const lockMemo = new Map([['BaseCrudService', baseLocks]])
  /** locking methods of a class below BaseCrudService (null: not a CRUD service) */
  const locksOf = (c, depth = 0) => {
    if (lockMemo.has(c.name.text)) return lockMemo.get(c.name.text)
    const parent = byName.get(extendsOf(c)?.expression.getText())
    const inherited = parent && depth < 8 ? locksOf(parent, depth + 1) : null
    const locks = inherited ? lockingMethods(c, inherited) : null
    lockMemo.set(c.name.text, locks)
    return locks
  }
  /** service class name → methods that lock */
  const scopedServices = new Map()
  for (const { sf } of parsed)
    for (const c of classes(sf)) {
      if (!scopedEntities.has(extendsOf(c)?.typeArguments?.[0]?.getText())) continue
      const locks = locksOf(c)
      if (locks) scopedServices.set(c.name.text, locks)
    }

  for (const { file, sf } of parsed)
    for (const c of classes(sf)) {
      if (!hasDecorator(c, 'Controller')) continue
      const ctor = c.members.find(ts.isConstructorDeclaration)
      /** injected field → locking methods of its scoped service */
      const fields = new Map(
        (ctor?.parameters ?? [])
          .filter((p) => ts.isIdentifier(p.name) && scopedServices.has(p.type?.getText()))
          .map((p) => [p.name.text, scopedServices.get(p.type.getText())]),
      )
      if (!fields.size) continue
      for (const m of c.members) {
        if (!ts.isMethodDeclaration(m) || !m.body) continue
        const route = decoratorsOf(m).find((d) => WRITE.has(callName(d)))
        if (!route) continue
        const path = ts.isCallExpression(route.expression)
          ? (route.expression.arguments[0]?.getText() ?? '')
          : ''
        const byId = path.includes(':') || /\bids\b/.test(m.getText())
        if (!byId) continue
        const calls = callsIn(m.body)
        // routes that never call the scoped service write something else
        if (!calls.lock && !calls.member.some(({ field }) => fields.has(field))) continue
        if (calls.lock || calls.member.some(({ field, method }) => fields.get(field)?.has(method)))
          continue
        const line = sf.getLineAndCharacterOfPosition(m.getStart()).line + 1
        out.push(
          `${file}:${line} ${c.name.text}.${m.name.getText()}: write by id on a @DataScoped entity must go through lockScopedIds (docs/design-notes.md#data-scope)`,
        )
      }
    }

  for (const { file, n, line } of lines('apps/server/src/**/*.ts')) {
    if (
      file.startsWith('apps/server/src/core/auth/') ||
      file.endsWith('core/redis/cache-namespaces.ts')
    )
      continue
    if (AUTH_KEY.test(line))
      out.push(
        `${file}:${n} auth:* keys belong to core/auth; end sessions through SessionRevoker (docs/design-notes.md#auth-sessions)`,
      )
  }
  return out
}
