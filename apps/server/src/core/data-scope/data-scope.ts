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
  (qb, alias, { dept, owner }, p, checked) =>
    roleGroups(p, checked).forEach((roles, i) => {
      if (roles.some((r) => r.dataScope === 'all')) return
      const has = (s: PrincipalRole['dataScope']) => roles.some((r) => r.dataScope === s)
      const picked = [
        ...new Set(roles.flatMap((r) => (r.dataScope === 'picked_depts' ? (r.deptIds ?? []) : []))),
      ]
      const or: string[] = []
      if (dept && picked.length) or.push(`${alias}.${dept} IN (:...dsPicked${i})`) // arch-allow: sql-concat alias/column identifiers, group index
      if (dept && p.deptId !== null && has('own_dept')) or.push(`${alias}.${dept} = :dsDept`) // arch-allow: sql-concat alias/column identifiers
      if (dept && p.deptTreePath && has('own_dept_tree'))
        or.push(
          // arch-allow: sql-concat alias/column/table identifiers
          `${alias}.${dept} IN (SELECT id FROM ${deptTable} WHERE tree_path LIKE :dsPrefix AND deleted_at IS NULL)`,
        )
      if (owner && has('own_rows')) or.push(`${alias}.${owner} = :dsMe`) // arch-allow: sql-concat alias/column identifiers
      qb.andWhere(or.length ? `(${or.join(' OR ')})` : '1=0', {
        [`dsPicked${i}`]: picked,
        dsDept: p.deptId,
        dsPrefix: `${p.deptTreePath}%`,
        dsMe: p.userId,
      })
    })

/** Multi-tenancy hook (item 2; see docs/design-notes.md#data-scope): v1 has no tenants, so it adds nothing. */
export const tenantRule: ScopeRule = () => {}

/** The rule chain every scoped entity gets unless its service replaces it. */
export const defaultScopeRules = (): ScopeRule[] => [deptScopeRule(), tenantRule]

/**
 * The single data-scope hook (see docs/design-notes.md#data-scope): `@SkipDataScope` → no filter; no caller → nothing visible;
 * root (`Principal.root`) → no filter; otherwise every rule of the chain for the caller and CLS `checkedPerm`.
 */
export function applyScopes<Q extends SelectQueryBuilder<ObjectLiteral>>(
  qb: Q,
  alias: string,
  columns: DataScopeColumns,
  rules: readonly ScopeRule[],
): Q {
  if (clsGet('skipDataScope')) return qb
  const p = clsGet('principal')
  if (!p) return qb.andWhere('1=0')
  if (p.root) return qb
  const checked = clsGet('checkedPerm')
  for (const rule of rules) rule(qb, alias, columns, p, checked)
  return qb
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
 * exemption ends with the call. Works outside a request too (the context is created).
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
