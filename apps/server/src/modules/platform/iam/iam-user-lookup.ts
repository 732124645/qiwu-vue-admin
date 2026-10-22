import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  DEFAULT_TENANT_ID,
  LOCALES,
  type Locale,
  type MenuNode,
  type MeUser,
  PERM_CODE,
} from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import {
  type DataScope,
  type PrincipalRole,
  ROOT_ROLE,
  TENANT_ADMIN_ROLE,
} from '../../../core/auth/principal.js'
import type {
  AuthUser,
  Credentials,
  SignInRecord,
  UserLookup,
} from '../../../core/auth/user-lookup.js'
import { tenantId } from '../../../core/context/tenant.js'
import {
  countedMenus,
  featuresOf,
  type MenuPermRow,
  type MenuRow,
  menuTree,
  platformPerms,
  tenantAdminPerms,
} from './menu-tree.js'
import { packageMenuIds } from './tenant-package/package-menus.js'
import { IamTenantLookup } from './tenant/iam-tenant-lookup.js'

const asLocale = (v: string | null): Locale | null =>
  LOCALES.includes(v as Locale) ? (v as Locale) : null

interface UserRow {
  tenant_id: number
  username: string
  user_type: string
  dept_name: string | null
  dept_id: number | null
  locale: string | null
  tree_path: string | null
}
interface RoleRow {
  id: number
  code: string
  data_scope: DataScope
  is_builtin: number
  tenant_id: number
}
interface GrantRow {
  role_id: number
  menu_id: number
  perms: string
}
interface CredentialRow {
  user_type: string
  id: number
  username: string
  password_hash: string
  enabled: number
  password_changed_at: Date | null
}
interface ProfileRow {
  id: number
  username: string
  display_name: string
  avatar_url: string | null
  dept_id: number | null
  dept_name: string | null
  locale: string | null
  timezone: string | null
}
interface PickedRow {
  role_id: number
  dept_id: number
}

/**
 * Whether role `r` held by a user of tenant `userTenant` makes it root: the builtin root role, the role
 * row and the user row both of the default tenant. Both are checked, so a link across tenants slipping
 * through elsewhere still makes no root (see docs/design-notes.md#tenancy).
 */
export const rootRole = (
  userTenant: number,
  r: Pick<RoleRow, 'code' | 'is_builtin' | 'tenant_id'>,
): boolean =>
  r.code === ROOT_ROLE &&
  Number(r.is_builtin) === 1 &&
  userTenant === DEFAULT_TENANT_ID &&
  Number(r.tenant_id) === DEFAULT_TENANT_ID

const tenantAdminRole = (r: Pick<RoleRow, 'code' | 'is_builtin'>) =>
  r.code === TENANT_ADMIN_ROLE && Number(r.is_builtin) === 1

/**
 * core/auth's `UserLookup` over iam_user / iam_role / iam_menu (enabled, live rows only). `load`,
 * `findCredentials({ userId })` and `menus` read the user by its global id, whatever tenant the caller's
 * context has (a session or a grant carries it), and its roles and grants in the user's own tenant;
 * `recordSignIn`, `profile` and `userIdsOfRole` keep to the data tenant (the sign-in's, the session's,
 * the role's).
 */
@Injectable()
export class IamUserLookup implements UserLookup {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly tenants: IamTenantLookup,
  ) {}

  /** 可由业务事务传入当前读适配器，在确认后复核并冻结完整授权来源。 */
  async load(userId: number, db: Pick<DataSource, 'query'> = this.ds): Promise<AuthUser | null> {
    const [user] = await db.query<UserRow[]>(
      // a deleted dept is no dept: it reaches nothing
      // qw:cross-tenant the user by the global id of its session or grant; its tenant comes from the row
      `SELECT u.tenant_id, u.username, u.user_type, d.id AS dept_id, u.locale, d.tree_path,
              d.name AS dept_name
         FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.tenant_id = u.tenant_id AND d.deleted_at IS NULL
        WHERE u.id = ? AND u.enabled = 1 AND u.deleted_at IS NULL`, // qw:no-data-scope loads a session's own user
      [userId],
    )
    if (!user) return null
    const userTenant = Number(user.tenant_id)
    // a disabled or expired tenant (or another one while multi-tenancy is off) signs nobody in and
    // reloads nobody (see docs/design-notes.md#tenancy)
    const tenant = await this.tenants.activeTenant(userTenant, db)
    if (!tenant) return null
    const roleRows = await db.query<RoleRow[]>(
      `SELECT r.id, r.code, r.data_scope, r.is_builtin, r.tenant_id
         FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id AND r.enabled = 1
              AND r.deleted_at IS NULL
        WHERE ur.user_id = ? AND ur.tenant_id = ? AND ur.deleted_at IS NULL
        ORDER BY r.sort_no, r.id`,
      [userId, userTenant],
    )
    const ids = roleRows.map((r) => r.id)
    const granted = ids.length
      ? await db.query<GrantRow[]>(
          `SELECT rm.role_id, rm.menu_id, m.perms
             FROM iam_role_menus rm
             JOIN iam_menu m ON m.id = rm.menu_id AND m.deleted_at IS NULL
            WHERE rm.role_id IN (?) AND rm.tenant_id = ? AND rm.deleted_at IS NULL
              AND m.perms IS NOT NULL AND m.perms <> ''`,
          [ids, userTenant],
        )
      : []
    const admin = roleRows.some(tenantAdminRole)
    // what the tenant's package opens: a grant outside it gives nothing (kept, it counts again once the
    // package holds the menu again); null = unrestricted, the default tenant (see
    // docs/design-notes.md#tenancy)
    const inPackage = await packageMenuIds(db, userTenant)
    // the menus (few, hundreds at most): which grants count, which perms are the platform's, what a
    // tenant admin holds and which groups the package reaches
    const menus =
      granted.length || admin || inPackage
        ? await db.query<(MenuPermRow & { kind: string; route_name: string | null })[]>(
            `SELECT id, parent_id, kind, route_name, enabled, perms, platform_only
               FROM iam_menu WHERE deleted_at IS NULL ORDER BY sort_no, id`,
          )
        : []
    // same rule as /menus: a menu under a disabled ancestor grants nothing
    const counted = countedMenus(
      menus,
      granted.map((g) => Number(g.menu_id)),
    )
    // another tenant's user never holds a perm of a platform page, whatever its roles were given
    // (see docs/design-notes.md#tenancy)
    const platform = userTenant !== DEFAULT_TENANT_ID ? platformPerms(menus) : new Set<string>()
    const grants = granted.filter(
      (g) =>
        counted.has(Number(g.menu_id)) &&
        !platform.has(g.perms) &&
        (!inPackage || inPackage.has(Number(g.menu_id))),
    )
    const picked = ids.length
      ? await db.query<PickedRow[]>(
          // qw:no-data-scope the picked depts of the user's own roles: the input of its scope
          `SELECT rd.role_id, rd.dept_id FROM iam_role_depts rd
             JOIN iam_dept d ON d.id = rd.dept_id AND d.tenant_id = rd.tenant_id AND d.deleted_at IS NULL
            WHERE rd.role_id IN (?) AND rd.tenant_id = ? AND rd.deleted_at IS NULL`,
          [ids, userTenant],
        )
      : []

    const isRoot = (r: RoleRow) => rootRole(userTenant, r)
    const roles = roleRows.map((r): PrincipalRole => {
      if (isRoot(r)) return { code: r.code, dataScope: 'all', perms: ['*'] }
      const role: PrincipalRole = {
        code: r.code,
        dataScope: r.data_scope,
        // the builtin tenant_admin role holds every menu open to tenants of its package, granted or not
        perms: tenantAdminRole(r)
          ? tenantAdminPerms(menus, inPackage)
          : [
              ...new Set(
                grants
                  .filter((g) => g.role_id === r.id && PERM_CODE.test(g.perms))
                  .map((g) => g.perms),
              ),
            ],
      }
      if (r.data_scope === 'picked_depts')
        role.deptIds = picked.filter((p) => p.role_id === r.id).map((p) => p.dept_id)
      return role
    })
    const root = roleRows.some(isRoot)
    return {
      userId,
      tenantId: userTenant,
      tenantExpAt: tenant.endsAt ?? undefined,
      username: user.username,
      userType: user.user_type,
      deptId: user.dept_id,
      deptName: user.dept_name,
      deptTreePath: user.tree_path,
      roles,
      perms: root ? ['*'] : [...new Set(roles.flatMap((r) => r.perms))],
      root,
      tenantAdmin: admin,
      // `@RequireFeature`, `/me.features`; none recorded = unrestricted
      ...(inPackage && { features: featuresOf(menus, inPackage) }),
      locale: asLocale(user.locale),
    }
  }

  async findCredentials(
    by: { tenantId: number; username: string } | { userId: number },
  ): Promise<Credentials | null> {
    // two statements, each on its index: (tenant_id, username, alive) and the primary key
    const [row] =
      'username' in by
        ? await this.ds.query<CredentialRow[]>(
            // qw:no-data-scope credential check of a sign-in
            `SELECT id, username, user_type, password_hash, enabled, password_changed_at
               FROM iam_user
              WHERE tenant_id = ? AND username = ? AND deleted_at IS NULL
              LIMIT 1`,
            [by.tenantId, by.username],
          )
        : await this.ds.query<CredentialRow[]>(
            // qw:cross-tenant by the global id of a session, a proven sign-in or a credential re-check
            `SELECT id, username, user_type, password_hash, enabled, password_changed_at
               FROM iam_user
              WHERE id = ? AND deleted_at IS NULL`, // qw:no-data-scope credential check by a session's user id
            [by.userId],
          )
    return row
      ? {
          userId: Number(row.id),
          username: row.username,
          userType: row.user_type,
          passwordHash: row.password_hash,
          enabled: Number(row.enabled) === 1,
          passwordChangedAt: row.password_changed_at,
        }
      : null
  }

  async recordSignIn(userId: number, rec: SignInRecord): Promise<void> {
    await this.ds.query(
      `UPDATE iam_user
          SET last_login_ip = ?, last_login_at = ?, timezone = COALESCE(?, timezone)
        WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [rec.ip.slice(0, 64), rec.at, rec.timezone, userId, tenantId()],
    )
  }

  async profile(userId: number): Promise<MeUser | null> {
    const tid = tenantId()
    const [u] = await this.ds.query<ProfileRow[]>(
      // qw:no-data-scope the caller's own profile
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.dept_id, d.name AS dept_name,
              u.locale, u.timezone
         FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.tenant_id = u.tenant_id AND d.deleted_at IS NULL
        WHERE u.id = ? AND u.tenant_id = ? AND u.deleted_at IS NULL`,
      [userId, tid],
    )
    if (!u) return null
    const roles = await this.ds.query<{ name: string }[]>(
      `SELECT r.name
         FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id AND r.enabled = 1
              AND r.deleted_at IS NULL
        WHERE ur.user_id = ? AND ur.tenant_id = ? AND ur.deleted_at IS NULL
        ORDER BY r.sort_no, r.id`,
      [userId, tid],
    )
    return {
      id: Number(u.id),
      username: u.username,
      displayName: u.display_name,
      avatarUrl: u.avatar_url,
      deptId: u.dept_id === null ? null : Number(u.dept_id),
      deptName: u.dept_name,
      roleNames: roles.map((r) => r.name),
      locale: asLocale(u.locale),
      timezone: u.timezone,
    }
  }

  async menus(
    userId: number,
    all: boolean,
    tenantAdmin = false,
    tenantOnly = false,
  ): Promise<MenuNode[]> {
    // the whole table: ancestors of granted rows come from it (menus are few, hundreds at most)
    const rows = await this.ds.query<(MenuRow & { platform_only: number })[]>(
      `SELECT id, parent_id, kind, name, name_i18n, route_path, component, component_name, route_name,
              route_query, link_type, link_url, icon, sort_no, visible, keep_alive, always_show, enabled,
              platform_only
         FROM iam_menu WHERE deleted_at IS NULL ORDER BY sort_no, id`,
    )
    let granted = all ? rows.map((r) => Number(r.id)) : []
    // root is the default tenant's
    let userTenant = DEFAULT_TENANT_ID
    if (!all) {
      const [user] = await this.ds.query<{ tenant_id: number }[]>(
        // qw:cross-tenant the user by its global id, as in load; its tenant comes from the row
        'SELECT tenant_id FROM iam_user WHERE id = ? AND deleted_at IS NULL', // qw:no-data-scope the menus of a session's own user
        [userId],
      )
      // no user: no tenant, no menu
      userTenant = user ? Number(user.tenant_id) : 0
      // its roles and their grants in its own tenant, as in load
      if (user)
        granted = (
          await this.ds.query<{ menu_id: number }[]>(
            `SELECT DISTINCT rm.menu_id
               FROM iam_user_roles ur
               JOIN iam_role r ON r.id = ur.role_id AND r.tenant_id = ur.tenant_id AND r.enabled = 1
                    AND r.deleted_at IS NULL
               JOIN iam_role_menus rm ON rm.role_id = r.id AND rm.tenant_id = ur.tenant_id
                    AND rm.deleted_at IS NULL
              WHERE ur.user_id = ? AND ur.tenant_id = ? AND ur.deleted_at IS NULL`,
            [userId, userTenant],
          )
        ).map((g) => Number(g.menu_id))
      // another tenant's user never sees a platform page, whatever its roles were given: same rule as
      // the perms `load` drops (see docs/design-notes.md#tenancy); nor does a platform user working inside
      // another tenant. Every menu under a platform menu is one too, so no ancestor of what is left brings
      // one back.
      if (userTenant !== DEFAULT_TENANT_ID || tenantOnly) {
        const platform = new Set(
          rows.filter((r) => Number(r.platform_only) === 1).map((r) => Number(r.id)),
        )
        granted = granted.filter((id) => !platform.has(id))
      }
    }
    // a tenant admin: every menu open to tenants as well (never a platform-only one)
    if (tenantAdmin)
      granted.push(...rows.filter((r) => Number(r.platform_only) === 0).map((r) => Number(r.id)))
    // both within the tenant's package, as in load
    const inPackage = await packageMenuIds(this.ds, userTenant)
    if (inPackage) granted = granted.filter((id) => inPackage.has(id))
    return menuTree(rows, granted)
  }

  async platformPerms(): Promise<string[]> {
    const menus = await this.ds.query<MenuPermRow[]>(
      'SELECT id, parent_id, enabled, perms, platform_only FROM iam_menu WHERE deleted_at IS NULL',
    )
    return [...platformPerms(menus)]
  }

  async featureGroups(): Promise<string[]> {
    const rows = await this.ds.query<{ route_name: string }[]>(
      `SELECT route_name FROM iam_menu
        WHERE parent_id = 0 AND kind = 'group' AND route_name IS NOT NULL AND deleted_at IS NULL
        ORDER BY sort_no, id`,
    )
    return rows.map((r) => r.route_name)
  }

  async userIdsOfRole(roleId: number): Promise<number[]> {
    const rows = await this.ds.query<{ user_id: number }[]>(
      'SELECT user_id FROM iam_user_roles WHERE role_id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [roleId, tenantId()],
    )
    return rows.map((r) => r.user_id)
  }
}
