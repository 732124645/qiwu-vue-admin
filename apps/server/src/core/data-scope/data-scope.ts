import { ClsServiceManager } from 'nestjs-cls'
import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm'
import type { PermRequirement } from '../auth/decorators.js'
import type { Principal, PrincipalRole } from '../auth/principal.js'
import { clsGet } from '../context/cls.js'

/** DB column names the scope filters on; `null` = that dimension does not apply to the entity. */
export interface DataScopeColumns {
  dept: string | null
  owner: string | null
}

const scoped = new WeakMap<object, DataScopeColumns>()

/** Marks an entity as data-scoped (see docs/design-notes.md#data-scope): reads go through `scopedQb`, writes through `lockScopedIds`. */
export const DataScoped =
  (columns: DataScopeColumns): ClassDecorator =>
  (target) => {
    scoped.set(target, columns)
  }

export const dataScopeOf = (entity: object): DataScopeColumns | undefined => scoped.get(entity)

/** One link of the rule chain applied by `applyScopes` (see docs/design-notes.md#data-scope). */
export type ScopeRule = (
  qb: SelectQueryBuilder<ObjectLiteral>,
  alias: string,
  columns: DataScopeColumns,
  principal: Principal,
  checked: PermRequirement | undefined,
) => void

/**
 * The caller's roles in groups whose scopes AND together (see docs/design-notes.md#data-scope); within a group they OR.
 * No `@RequirePerm` → one group, every enabled role. `.all(a, b)` → one group per perm: the roles
 * holding `a` and, separately, those holding `b`, so a write needing both stays inside both scopes
 * (a full-scope browse role cannot widen an own-dept modify role). Any-of → one group, the roles
 * holding any perm the caller passed with: each of those perms alone would pass the route with its
 * own scope, so their union grants nothing a single one would not, and the result never depends on
 * the order the perms are listed in.
 */
const roleGroups = (p: Principal, checked?: PermRequirement): PrincipalRole[][] => {
  if (!checked) return [p.roles]
  const holding = (perms: string[]) => p.roles.filter((r) => perms.some((x) => r.perms.includes(x)))
  return checked.all ? checked.perms.map((x) => holding([x])) : [holding(checked.perms)]
}

/** One condition of a role group's OR: `column` in a list, equal to a value, or under a dept path prefix. */
interface ScopeTerm {
  op: 'in' | 'eq' | 'tree'
  column: string
  value: unknown
  /** its QueryBuilder parameter name */
  key: string
}

/**
 * The department/owner scope, per role group (`roleGroups`, ANDed): `null` = the group has an `all`
 * role (no filter), otherwise the OR of its roles' scopes; an empty OR (an empty group, no picked depts,
 * no own dept) lets nothing in. The one computation behind `deptScopeRule` and `dataScopeSql`.
 */
const scopeGroups = (
  { dept, owner }: DataScopeColumns,
  p: Principal,
  checked: PermRequirement | undefined,
): (ScopeTerm[] | null)[] =>
  roleGroups(p, checked).map((roles, i) => {
    if (roles.some((r) => r.dataScope === 'all')) return null
    const has = (s: PrincipalRole['dataScope']) => roles.some((r) => r.dataScope === s)
    const picked = [
      ...new Set(roles.flatMap((r) => (r.dataScope === 'picked_depts' ? (r.deptIds ?? []) : []))),
    ]
    const terms: ScopeTerm[] = []
    if (dept && picked.length)
      terms.push({ op: 'in', column: dept, value: picked, key: `dsPicked${i}` })
    if (dept && p.deptId !== null && has('own_dept'))
      terms.push({ op: 'eq', column: dept, value: p.deptId, key: 'dsDept' })
    if (dept && p.deptTreePath && has('own_dept_tree'))
      terms.push({ op: 'tree', column: dept, value: `${p.deptTreePath}%`, key: 'dsPrefix' })
    if (owner && has('own_rows'))
      terms.push({ op: 'eq', column: owner, value: p.userId, key: 'dsMe' })
    return terms
  })

/**
 * One role group's condition: the bracketed OR of `terms`, `1=0` for none. `param` gives a term's
 * value its placeholder (`:name` or `?`). Identifiers (alias, columns, table) come from code.
 */
const renderGroup = (
  terms: ScopeTerm[],
  alias: string,
  deptTable: string,
  param: (t: ScopeTerm) => string,
): string => {
  if (!terms.length) return '1=0'
  const or = terms.map((t) => {
    const col = `${alias}.${t.column}`
    if (t.op === 'in') return `${col} IN (${param(t)})`
    if (t.op === 'eq') return `${col} = ${param(t)}`
    // arch-allow: sql-concat alias/column/table identifiers; tenant: tree paths are global dept ids, the prefix reaches the caller's own depts only
    return `${col} IN (SELECT id FROM ${deptTable} WHERE tree_path LIKE ${param(t)} AND deleted_at IS NULL)`
  })
  return `(${or.join(' OR ')})`
}

/**
 * Department/owner rule, per role group (`roleGroups`, ANDed): a group with an `all` role adds no
 * filter; otherwise the OR of its roles' scopes; an empty group or an empty OR (no picked depts, no
 * own dept) → `1=0`. `own_dept_tree` matches the live depts `tree_path LIKE '<my tree_path>%'` (a
 * deleted dept reaches nothing); tree paths end with `/`, so `/1/2/` never matches `/1/23/`.
 * `deptTable` is the tree table (`iam_dept`; fixtures pass their own, with `deleted_at` too).
 * Identifiers (alias, columns, table) come from code; every value is a parameter.
 */
export const deptScopeRule =
  (deptTable = 'iam_dept'): ScopeRule =>
  (qb, alias, columns, p, checked) => {
    for (const terms of scopeGroups(columns, p, checked)) {
      if (!terms) continue
      const params: Record<string, unknown> = {}
      const sql = renderGroup(terms, alias, deptTable, (t) => {
        params[t.key] = t.value
        return t.op === 'in' ? `:...${t.key}` : `:${t.key}`
      })
      qb.andWhere(sql, params)
    }
  }

/**
 * The rule chain every scoped entity gets unless its service replaces it. Tenants are no link of it: the
 * tenant condition sits in the ORM itself (core/db/tenant-filter.ts, docs/design-notes.md#tenancy).
 */
export const defaultScopeRules = (): ScopeRule[] => [deptScopeRule()]

/**
 * Whose scope applies: `undefined` = no filter (`@SkipDataScope`, root), `null` = nothing visible (no
 * caller), else the caller with CLS `checkedPerm`.
 */
const scopeCaller = ():
  { p: Principal; checked: PermRequirement | undefined } | null | undefined => {
  if (clsGet('skipDataScope')) return undefined
  const p = clsGet('principal')
  if (!p) return null
  if (p.root) return undefined
  return { p, checked: clsGet('checkedPerm') }
}

/**
 * The single data-scope hook (see docs/design-notes.md#data-scope): `@SkipDataScope` → no filter; no caller → nothing visible;
 * root (`Principal.root`) → no filter; otherwise every rule of the chain for the caller and CLS `checkedPerm`.
 * Both exemptions skip department rules only: the tenant condition still applies
 * (docs/design-notes.md#tenancy).
 */
export function applyScopes<Q extends SelectQueryBuilder<ObjectLiteral>>(
  qb: Q,
  alias: string,
  columns: DataScopeColumns,
  rules: readonly ScopeRule[],
): Q {
  const c = scopeCaller()
  if (c === null) return qb.andWhere('1=0')
  if (c) for (const rule of rules) rule(qb, alias, columns, c.p, c.checked)
  return qb
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * The data scope for hand-written SQL (see docs/data-scope.md): the condition `applyScopes` adds with
 * the default rule chain, as text with `?` placeholders plus their values, for `tx.query`
 * (`… WHERE <own conditions> AND ${sql}`, the values in the order of the text). `@SkipDataScope` and root
 * → `1=1`, no caller → `1=0`; several role groups come bracketed. `alias`, the columns and `deptTable`
 * are identifiers from code (anything else throws). The tenant condition is no part of it: the statement
 * writes its own. Only the default rule chain (`deptTable` aside): a service that replaces `scopeRules`
 * cannot use it, it goes through `scopedQb` or writes its rules into the SQL itself.
 */
export function dataScopeSql(
  alias: string,
  columns: DataScopeColumns,
  deptTable = 'iam_dept',
): { sql: string; params: unknown[] } {
  for (const id of [alias, columns.dept, columns.owner, deptTable])
    if (id !== null && !IDENT.test(id)) throw new Error(`dataScopeSql: not an identifier: ${id}`)
  const c = scopeCaller()
  if (c === undefined) return { sql: '1=1', params: [] }
  if (c === null) return { sql: '1=0', params: [] }
  const params: unknown[] = []
  const parts: string[] = []
  for (const terms of scopeGroups(columns, c.p, c.checked))
    if (terms)
      parts.push(
        renderGroup(terms, alias, deptTable, (t) => {
          params.push(t.value)
          return '?'
        }),
      )
  if (!parts.length) return { sql: '1=1', params }
  return { sql: parts.length > 1 ? `(${parts.join(' AND ')})` : parts[0]!, params }
}

/** `dataScopeSql` over the columns a `@DataScoped` entity declares (`dataScopeSqlFor(User, 'u')`). */
export const dataScopeSqlFor = (
  entity: object,
  alias: string,
  deptTable?: string,
): { sql: string; params: unknown[] } => {
  const columns = dataScopeOf(entity)
  if (!columns) throw new Error('dataScopeSqlFor: not a @DataScoped entity')
  return dataScopeSql(alias, columns, deptTable)
}

/**
 * Runs `fn` with data scope computed as if the route had checked `checked` (`undefined` = no
 * `@RequirePerm`: every role) instead of the current route's perm: for checks about another perm
 * (GrantPolicy judges a granted role per perm point). A nested CLS context, so the caller and the
 * current transaction stay; build the scoped query inside `fn` (the scope is read when it is built).
 */
export const withCheckedPerm = <T>(checked: PermRequirement | undefined, fn: () => T): T => {
  const cls = ClsServiceManager.getClsService()
  return cls.run(() => {
    cls.set('checkedPerm', checked)
    return fn()
  })
}

/**
 * Runs the method without data scope (system jobs; see docs/design-notes.md#data-scope), in a nested CLS context so the
 * exemption ends with the call. Works outside a request too (the context is created). The tenant
 * condition is not data scope: it stays (docs/design-notes.md#tenancy).
 */
export const SkipDataScope =
  (): MethodDecorator => (_target, _key, descriptor: PropertyDescriptor) => {
    const original = descriptor.value as (...args: unknown[]) => unknown
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const cls = ClsServiceManager.getClsService()
      return cls.run(() => {
        cls.set('skipDataScope', true)
        return original.apply(this, args)
      })
    }
    // keep route/other metadata that decorators below this one attached to the original function
    for (const key of Reflect.getOwnMetadataKeys(original))
      Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, original), wrapped)
    descriptor.value = wrapped
  }
