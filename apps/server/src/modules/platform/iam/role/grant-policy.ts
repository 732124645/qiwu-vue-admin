import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err } from '@qiwu/shared'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import type { PermRequirement } from '../../../../core/auth/decorators.js'
import { type DataScope, type Principal, ROOT_ROLE } from '../../../../core/auth/principal.js'
import { clsGet } from '../../../../core/context/cls.js'
import { withCheckedPerm } from '../../../../core/data-scope/data-scope.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { DeptService } from '../dept/dept.service.js'
import { countedMenus } from '../menu-tree.js'

interface RoleRow {
  id: number
  code: string
  is_builtin: number
  data_scope: DataScope
}

/** A role's data scope and its picked depts (`picked_depts` only). */
export interface ScopeGrant {
  scope: DataScope
  depts: readonly number[]
}

const exceeds = () => new BizError(Err.IAM_GRANT_EXCEEDS_OWN)
const RELATIVE: ReadonlySet<DataScope> = new Set(['own_dept', 'own_dept_tree'])

/** The non-root caller; null = root (exempt). No caller → 403. */
function caller(): Principal | null {
  const p = clsGet('principal')
  if (p?.root) return null
  if (!p) throw exceeds()
  return p
}

/**
 * The live depts scope `scope` reaches for a holder in dept `dept` (see docs/design-notes.md#data-scope): `all` every one, picked
 * depts whoever holds it, `own_dept` the holder's dept, `own_dept_tree` that dept and every dept under it
 * (`subtrees`), `own_rows` and a holder without dept none.
 */
function reach(
  { scope, depts }: ScopeGrant,
  dept: number | null,
  subtrees: ReadonlyMap<number, number[]>,
): number[] | 'all' {
  if (scope === 'all') return 'all'
  if (scope === 'picked_depts') return [...depts]
  if (dept === null) return []
  if (scope === 'own_dept') return [dept]
  return scope === 'own_dept_tree' ? (subtrees.get(dept) ?? []) : []
}

/**
 * Anti-escalation grants ("防越权授予"; see docs/design-notes.md#permissions): one class every grant entry point calls,
 * root callers exempt, 403 `grant_exceeds_own` otherwise. The three rules share one data-scope judgement
 * (`fits`, rule ②): a grant that lets a role reach dept D under perm point P needs D inside the caller's
 * own scope for P (the scope a route checking P would give it; see docs/design-notes.md#data-scope), and for routes checking no perm
 * (every role). Judged per perm point, so a wide scope for one perm (say assigning roles) never lets the
 * caller hand out that reach for another (viewing users). Only what a request adds
 * is judged: keeping or removing a grant gives nothing.
 * ① `assertMenus` — the role menu grant, and `assertMenuWrite` — a menu edit making perms effective for
 * the roles granted it; ② `assertDataScope` — the role data scope; ③ `assertAssignableRoles` — a role
 * given to a user (user create / edit, assign roles, role members); `assertEnabling` — a role enabled
 * again hands out its whole grant (① + ②). Reads of roles, their menus and picked depts are locking reads
 * (FOR SHARE): a concurrent grant on the same role (which locks the role FOR UPDATE first) is either seen
 * or waits for this commit. The current sign-up role is root-managed at every role write entry.
 */
@Injectable()
export class GrantPolicy {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly depts: DeptService,
    private readonly authParams: AuthParams,
  ) {}

  /** Refuse non-root writes to the current sign-up role, after the role lock is held. */
  async assertNotSignupRole(ids: readonly number[]): Promise<void> {
    if (!caller()) return
    const { defaultRoleId } = await this.authParams.signup()
    if (defaultRoleId !== null && ids.includes(defaultRoleId)) throw exceeds()
  }

  /**
   * ③ May the caller give the roles `added` to a user of dept `deptId`? Each must exist (else 404). For a
   * non-root caller each must also not be root nor `all`, hold only perms the caller holds, and reach
   * (at `deptId`) only depts that `fits` every perm point it carries. Keeping or removing a role grants
   * nothing, so pass only the added ones; `kept` = the roles a user keeps while moving to `deptId`: their
   * relative scopes (`own_dept*`) follow the user and are judged the same way (a leaf-dept
   * `own_dept_tree` role would otherwise widen by moving its holder up).
   */
  async assertAssignableRoles(
    added: readonly number[],
    deptId: number | null,
    kept: readonly number[] = [],
  ): Promise<void> {
    const ids = [...new Set(added)]
    const roles = ids.length ? await this.roles(ids) : []
    if (roles.length !== ids.length) throw new NotFoundException()
    const p = caller()
    if (!p) return
    if (roles.some((r) => r.data_scope === 'all' || (r.code === ROOT_ROLE && r.is_builtin)))
      throw exceeds()
    // kept roles: only the relative scopes move with the user (`all`/picked ones stay where they were)
    const keptIds = kept.filter((id) => !ids.includes(id))
    const relative = (keptIds.length && deptId !== null ? await this.roles(keptIds) : []).filter(
      (r) => RELATIVE.has(r.data_scope),
    )
    const judged = [...roles, ...relative]
    if (!judged.length) return
    const perms = await this.perms(judged.map((r) => r.id))
    // every perm of the role's menus, enabled or not: a menu enabled later must not widen the grant
    if (roles.some((r) => perms.get(r.id)?.some((x) => !p.perms.includes(x)))) throw exceeds()
    const picked = await this.picked(
      judged.filter((r) => r.data_scope === 'picked_depts').map((r) => r.id),
    )
    const tree = judged.some((r) => r.data_scope === 'own_dept_tree') && deptId !== null
    const subtrees = await this.subtrees(tree ? [deptId] : [])
    for (const r of judged) {
      const scope = { scope: r.data_scope, depts: picked.get(r.id) ?? [] }
      // never `all` here: refused above, and kept roles are relative ones
      await this.fits(p, reach(scope, deptId, subtrees) as number[], perms.get(r.id) ?? [])
    }
  }

  /**
   * ① The role menu grant, called after role `roleId`'s menus were replaced (the role locked): a non-root
   * caller may add only menus whose perms it holds itself; groups and pages without perms pass (judged
   * by the actions chosen below them). Each such perm then reaches what the role's scope reaches (its
   * picked depts, whoever holds it; each holder's dept for the relative scopes), which must `fits` it:
   * nobody hands out "the same perm over a wider scope" by adding a button to a wider role; a role of
   * scope `all` takes no perm from a non-root caller. `added` = the menus the role did not grant yet;
   * their perms are judged even when another menu of the role carries them too (that one may be
   * disabled, and enabling menus is not a grant).
   */
  async assertMenus(roleId: number, added: readonly number[]): Promise<void> {
    const p = caller()
    if (!p || !added.length) return
    const rows = await this.txHost.tx.query<{ perms: string }[]>(
      `SELECT DISTINCT perms FROM iam_menu
        WHERE id IN (?) AND perms IS NOT NULL AND perms <> '' AND deleted_at IS NULL FOR SHARE`,
      [added],
    )
    const perms = rows.map((r) => r.perms)
    if (perms.some((x) => !p.perms.includes(x))) throw exceeds()
    if (perms.length) await this.judge(p, roleId, await this.scopeOf(roleId), perms)
  }

  /**
   * ① for menu edits: `write` (a menu update, inside the caller's transaction) runs
   * between two reads of what every enabled role but root gets from its menus (`countedMenus`: the menu
   * and each ancestor enabled). A perm the write makes effective for a role — a menu's new perms, a menu
   * or ancestor enabled, a subtree moved out of a disabled branch — is a grant of that perm to that role
   * by a non-root caller, judged like `assertMenus`. Every role is locked FOR UPDATE first, then every
   * menu (the order the role grants take: role, then menus): no member, data scope or enabled flag of a
   * role changes under the judgement (member changes read the role FOR SHARE first; of this
   * fix), and menu edits judged this way run one at a time and never miss each other's changes. Root
   * callers are exempt and lock nothing more. Disabled roles are judged when enabled (`assertEnabling`).
   * Locks every role and reads every menu and grant twice per edit; fine for admin-sized
   * tables, narrow it to the roles granted the edited subtree if menu writes ever get hot.
   */
  async assertMenuWrite(write: () => Promise<void>): Promise<void> {
    const p = caller()
    if (!p) return write()
    await this.txHost.tx.query(
      'SELECT id FROM iam_role WHERE deleted_at IS NULL ORDER BY id FOR UPDATE',
    )
    const before = await this.effective()
    await write()
    for (const [roleId, perms] of await this.effective()) {
      const added = [...perms].filter((x) => !before.get(roleId)?.has(x))
      if (!added.length) continue
      await this.assertNotSignupRole([roleId])
      if (added.some((x) => !p.perms.includes(x))) throw exceeds()
      await this.judge(p, roleId, await this.scopeOf(roleId), added)
    }
  }

  /**
   * Enabling role `roleId` gives its holders its whole grant again, so a non-root
   * caller must be able to grant all of it: no scope `all`, every perm of its menus (enabled or not) held,
   * and what the role reaches (picked depts; its holders' depts for the relative scopes) inside the
   * caller's scope for each of them and for routes checking none (`fits`). Disabling needs no check.
   */
  async assertEnabling(roleId: number): Promise<void> {
    const p = caller()
    if (!p) return
    const perms = (await this.perms([roleId])).get(roleId) ?? []
    if (perms.some((x) => !p.perms.includes(x))) throw exceeds()
    await this.judge(p, roleId, await this.scopeOf(roleId), perms)
  }

  /**
   * ② The role data scope, called after role `roleId`'s picked depts were replaced (the role locked): a
   * non-root caller never sets `all`, and what the change adds must `fits` every perm of the role: for
   * each current holder, what `next` reaches beyond what `prev` reached for it (its dept or subtree for
   * the relative scopes, the picked depts); for a role nobody holds yet, the picked depts not reached
   * before (②: picked depts inside the caller's scope; see docs/design-notes.md#permissions). Narrowing adds nothing, so it passes.
   */
  async assertDataScope(roleId: number, next: ScopeGrant, prev: ScopeGrant): Promise<void> {
    const p = caller()
    if (!p) return
    if (next.scope === 'all') throw exceeds()
    if (next.scope === 'own_rows') return
    const holders = await this.holderDepts(roleId)
    const tree = next.scope === 'own_dept_tree' || prev.scope === 'own_dept_tree'
    const subtrees = await this.subtrees(tree ? holders : [])
    // nobody holds it yet: judged as for a holder without dept (the picked depts, whoever gets it)
    const depts = (holders.length ? holders : [null]).flatMap((d) => {
      const before = reach(prev, d, subtrees)
      if (before === 'all') return []
      return (reach(next, d, subtrees) as number[]).filter((x) => !before.includes(x))
    })
    if (depts.length) await this.fits(p, depts, (await this.perms([roleId])).get(roleId) ?? [])
  }

  /**
   * Role `roleId` of scope `role` getting `perms` (the caller holds them): never scope `all`, and what the
   * role reaches must `fits` them — the picked depts whoever holds it, each holder's dept or subtree for
   * the relative scopes.
   */
  private async judge(p: Principal, roleId: number, role: ScopeGrant, perms: readonly string[]) {
    if (role.scope === 'all') throw exceeds()
    const holders = RELATIVE.has(role.scope) ? await this.holderDepts(roleId) : [null]
    const subtrees = await this.subtrees(role.scope === 'own_dept_tree' ? holders : [])
    await this.fits(
      p,
      holders.flatMap((d) => reach(role, d, subtrees) as number[]),
      perms,
    )
  }

  /**
   * Role id → the perms its menus give it now (`countedMenus`, the rule the sessions load by), for every
   * enabled role but the builtin root (which holds `*` anyway). Locks every menu FOR UPDATE.
   */
  private async effective(): Promise<Map<number, Set<string>>> {
    const tx = this.txHost.tx
    const menus = await tx.query<
      { id: number; parent_id: number; enabled: number; perms: string }[]
    >('SELECT id, parent_id, enabled, perms FROM iam_menu WHERE deleted_at IS NULL FOR UPDATE')
    const grants = await tx.query<{ role_id: number; menu_id: number }[]>(
      `SELECT rm.role_id, rm.menu_id FROM iam_role_menus rm
         JOIN iam_role r ON r.id = rm.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
        WHERE rm.deleted_at IS NULL AND NOT (r.code = ? AND r.is_builtin = 1)`,
      [ROOT_ROLE],
    )
    const permsOf = new Map(menus.map((m) => [Number(m.id), m.perms]))
    const byRole = new Map<number, number[]>()
    for (const g of grants)
      byRole.set(Number(g.role_id), [...(byRole.get(Number(g.role_id)) ?? []), Number(g.menu_id)])
    const out = new Map<number, Set<string>>()
    for (const [roleId, ids] of byRole) {
      const counted = countedMenus(menus, ids)
      const live = ids.filter((id) => counted.has(id) && permsOf.get(id))
      out.set(roleId, new Set(live.map((id) => permsOf.get(id)!)))
    }
    return out
  }

  /**
   * The data-scope judgement of all three rules: every dept of `depts` inside the caller's dept scope for
   * each perm point of `perms` and for routes checking none; else 403. A perm the caller does not hold
   * gives it no scope at all.
   */
  private async fits(p: Principal, depts: readonly number[], perms: readonly string[]) {
    const wanted = [...new Set(depts)]
    if (!wanted.length) return
    // the caller's roles holding a perm decide its scope: the same roles → the same scope, one query
    const checks = new Map<string, PermRequirement | undefined>()
    for (const perm of [undefined, ...perms]) {
      const key = p.roles.flatMap((o, i) => (!perm || o.perms.includes(perm) ? [i] : [])).join()
      if (!checks.has(key)) checks.set(key, perm ? { perms: [perm], all: false } : undefined)
    }
    for (const checked of checks.values()) {
      const inScope = await withCheckedPerm(checked, () =>
        this.depts
          .scopedQb('d')
          .select('d.id', 'id')
          .andWhere('d.id IN (:...wanted)', { wanted })
          .getRawMany<{ id: number }>(),
      )
      if (inScope.length !== wanted.length) throw exceeds()
    }
  }

  /** Perms of the menus of each role in `ids` (enabled or not). */
  private async perms(ids: readonly number[]): Promise<Map<number, string[]>> {
    const rows = await this.txHost.tx.query<{ role_id: number; perms: string }[]>(
      `SELECT DISTINCT rm.role_id, m.perms
         FROM iam_role_menus rm
         JOIN iam_menu m ON m.id = rm.menu_id AND m.deleted_at IS NULL
        WHERE rm.role_id IN (?) AND rm.deleted_at IS NULL AND m.perms IS NOT NULL AND m.perms <> ''
        FOR SHARE`,
      [ids],
    )
    const out = new Map<number, string[]>()
    for (const r of rows)
      out.set(Number(r.role_id), [...(out.get(Number(r.role_id)) ?? []), r.perms])
    return out
  }

  /** Live roles among `ids`. */
  private roles(ids: readonly number[]): Promise<RoleRow[]> {
    return this.txHost.tx.query<RoleRow[]>(
      'SELECT id, code, is_builtin, data_scope FROM iam_role WHERE id IN (?) AND deleted_at IS NULL FOR SHARE',
      [ids],
    )
  }

  /** Role id → its live picked depts, for the roles `ids`. */
  private async picked(ids: readonly number[]): Promise<Map<number, number[]>> {
    const rows = ids.length
      ? await this.txHost.tx.query<{ role_id: number; id: number }[]>(
          `SELECT rd.role_id, d.id FROM iam_role_depts rd
             JOIN iam_dept d ON d.id = rd.dept_id AND d.deleted_at IS NULL
            WHERE rd.role_id IN (?) AND rd.deleted_at IS NULL FOR SHARE`,
          [ids],
        )
      : []
    const out = new Map<number, number[]>()
    for (const r of rows)
      out.set(Number(r.role_id), [...(out.get(Number(r.role_id)) ?? []), Number(r.id)])
    return out
  }

  /** The stored scope of role `id` with its picked depts. */
  private async scopeOf(id: number): Promise<ScopeGrant> {
    const [row] = await this.roles([id])
    if (!row) throw new NotFoundException()
    return { scope: row.data_scope, depts: (await this.picked([id])).get(id) ?? [] }
  }

  /**
   * The distinct depts (null: none) of the live users holding role `id`. A plain read: every caller holds
   * the role FOR UPDATE, so no member joins or leaves meanwhile (member changes read it FOR SHARE first).
   */
  private async holderDepts(id: number): Promise<(number | null)[]> {
    const rows = await this.txHost.tx.query<{ dept_id: number | null }[]>(
      `SELECT DISTINCT u.dept_id FROM iam_user_roles ur
         JOIN iam_user u ON u.id = ur.user_id AND u.deleted_at IS NULL
        WHERE ur.role_id = ? AND ur.deleted_at IS NULL`,
      [id],
    )
    return rows.map((r) => (r.dept_id === null ? null : Number(r.dept_id)))
  }

  /** Dept → itself and every live dept under it, for the depts `ids` (nulls skipped). */
  private async subtrees(ids: readonly (number | null)[]): Promise<Map<number, number[]>> {
    const roots = [...new Set(ids.filter((d): d is number => d !== null))]
    const rows = roots.length
      ? await this.txHost.tx.query<{ root: number; id: number }[]>(
          // tree paths end with '/', so the prefix never matches a sibling like /1/23/ for /1/2/
          `SELECT p.id AS root, c.id FROM iam_dept p
             JOIN iam_dept c ON c.tree_path LIKE CONCAT(p.tree_path, '%') AND c.deleted_at IS NULL
            WHERE p.id IN (?) AND p.deleted_at IS NULL`,
          [roots],
        )
      : []
    const out = new Map<number, number[]>()
    for (const r of rows)
      out.set(Number(r.root), [...(out.get(Number(r.root)) ?? []), Number(r.id)])
    return out
  }
}
