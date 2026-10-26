// Data-scope and session source guards (TypeScript AST, not regex; docs/design-notes.md#data-scope, #auth-sessions):
//  1. A controller that injects the service of a `@DataScoped` entity: every non-GET route with a path
//     param (`:id`) or an `ids` payload must reach `lockScopedIds` — directly, or through a method of
//     that service that does (its own methods, inherited CRUD methods, or a constructor-injected
//     scoped service's known locking method).
//  2. auth:* Redis keys belong to core/auth: no other server code names an auth namespace
//     (redisKey('auth…')/keyPattern('auth…')/CACHE_NAMESPACES.auth…), so nothing else can delete a
//     session key; everything else ends sessions through SessionRevoker.
// Static heuristic over `this.<field>.<method>()` calls. A route that reaches the service
// only through a local variable or a helper function, or a repository injected straight into a
// controller, is not seen; code review and data-scope e2e specs cover those.
import ts from 'typescript'

export const help = [
  {
    match: /auth:\* keys/,
    fix: 'End sessions through SessionRevoker; only apps/server/src/core/auth may name the auth Redis namespaces.',
    doc: 'docs/design-notes.md#auth-sessions',
  },
  {
    fix: 'Route the write through a service method that calls lockScopedIds(ids) in the transaction before changing the rows (BaseCrudService update/remove already do).',
    doc: 'docs/data-scope.md#查询锁与写入后的范围',
  },
]

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

/** Names of methods reaching a lock, following local, inherited and known injected methods. */
function lockingMethods(cls, inherited = new Set(), injected = new Map()) {
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
        [...c.sup].some((k) => inherited.has(k)) ||
        c.member.some(({ field, method }) => injected.get(field)?.has(method))
      ) {
        locks.add(name)
        changed = true
      }
    }
  }
  return locks
}

/** 构造注入字段仅关联已识别的作用域服务；不凭字段名或无关方法推断持锁。 */
function injectedLocks(cls, services) {
  const ctor = cls.members.find(ts.isConstructorDeclaration)
  return new Map(
    (ctor?.parameters ?? [])
      .filter((p) => ts.isIdentifier(p.name) && services.has(p.type?.getText()))
      .map((p) => [p.name.text, services.get(p.type.getText())]),
  )
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
  const byName = new Map()
  const ambiguousNames = new Set()
  for (const { sf } of parsed)
    for (const cls of classes(sf)) {
      const name = cls.name.text
      if (byName.has(name)) ambiguousNames.add(name)
      byName.set(name, cls)
    }
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
  const scopedClasses = new Map()
  for (const { sf } of parsed)
    for (const c of classes(sf)) {
      if (!scopedEntities.has(extendsOf(c)?.typeArguments?.[0]?.getText())) continue
      const locks = locksOf(c)
      if (locks) {
        scopedServices.set(c.name.text, locks)
        scopedClasses.set(c.name.text, c)
      }
    }

  /** 新增的跨服务证明必须有唯一的完整继承来源，不能借同名父类的缓存锁集合。 */
  const unambiguousHeritage = (name) => {
    const seen = new Set()
    let cls = byName.get(name)
    while (cls) {
      const current = cls.name.text
      if (ambiguousNames.has(current) || seen.has(current)) return false
      seen.add(current)
      if (current === 'BaseCrudService') return true
      cls = byName.get(extendsOf(cls)?.expression.getText())
    }
    return false
  }
  // 当前近似分析不解析import绑定，同名类型及歧义继承都不能为新的服务间调用提供证明。
  const injectableServices = new Map(
    [...scopedServices].filter(([name]) => unambiguousHeritage(name)),
  )
  // 只添加确有可达锁的方法，最多覆盖有限方法集合；无真实锁的服务循环不会自举为持锁。
  for (let changed = true; changed;) {
    changed = false
    for (const [name, cls] of scopedClasses) {
      const parent = byName.get(extendsOf(cls)?.expression.getText())
      const inherited = parent ? locksOf(parent) : new Set()
      const found = lockingMethods(
        cls,
        inherited ?? new Set(),
        injectedLocks(cls, injectableServices),
      )
      const known = scopedServices.get(name)
      for (const method of found) {
        if (known.has(method)) continue
        known.add(method)
        changed = true
      }
    }
  }

  for (const { file, sf } of parsed)
    for (const c of classes(sf)) {
      if (!hasDecorator(c, 'Controller')) continue
      /** injected field → locking methods of its scoped service */
      const fields = injectedLocks(c, scopedServices)
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
