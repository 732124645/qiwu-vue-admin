import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { LOCALES, type Locale, type MenuNode, type MeUser, PERM_CODE } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { type DataScope, type PrincipalRole, ROOT_ROLE } from '../../../core/auth/principal.js'
import type {
  AuthUser,
  Credentials,
  SignInRecord,
  UserLookup,
} from '../../../core/auth/user-lookup.js'
import { countedMenus, type MenuRow, menuTree } from './menu-tree.js'

const asLocale = (v: string | null): Locale | null =>
  LOCALES.includes(v as Locale) ? (v as Locale) : null

interface UserRow {
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

/** core/auth's `UserLookup` over iam_user / iam_role / iam_menu (enabled, live rows only). */
@Injectable()
export class IamUserLookup implements UserLookup {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async load(userId: number): Promise<AuthUser | null> {
    const [user] = await this.ds.query<UserRow[]>(
      // a deleted dept is no dept: it reaches nothing
      `SELECT u.username, u.user_type, d.id AS dept_id, u.locale, d.tree_path, d.name AS dept_name
         FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.deleted_at IS NULL
        WHERE u.id = ? AND u.enabled = 1 AND u.deleted_at IS NULL`,
      [userId],
    )
    if (!user) return null
    const roleRows = await this.ds.query<RoleRow[]>(
      `SELECT r.id, r.code, r.data_scope, r.is_builtin
         FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
        WHERE ur.user_id = ? AND ur.deleted_at IS NULL
        ORDER BY r.sort_no, r.id`,
      [userId],
    )
    const ids = roleRows.map((r) => r.id)
    const granted = ids.length
      ? await this.ds.query<GrantRow[]>(
          `SELECT rm.role_id, rm.menu_id, m.perms
             FROM iam_role_menus rm
             JOIN iam_menu m ON m.id = rm.menu_id AND m.deleted_at IS NULL
            WHERE rm.role_id IN (?) AND rm.deleted_at IS NULL AND m.perms IS NOT NULL AND m.perms <> ''`,
          [ids],
        )
      : []
    // same rule as /menus: a menu under a disabled ancestor grants nothing (menus are few)
    const counted = granted.length
      ? countedMenus(
          await this.ds.query<Pick<MenuRow, 'id' | 'parent_id' | 'enabled'>[]>(
            'SELECT id, parent_id, enabled FROM iam_menu WHERE deleted_at IS NULL',
          ),
          granted.map((g) => Number(g.menu_id)),
        )
      : new Set<number>()
    const grants = granted.filter((g) => counted.has(Number(g.menu_id)))
    const picked = ids.length
      ? await this.ds.query<PickedRow[]>(
          `SELECT rd.role_id, rd.dept_id FROM iam_role_depts rd
             JOIN iam_dept d ON d.id = rd.dept_id AND d.deleted_at IS NULL
            WHERE rd.role_id IN (?) AND rd.deleted_at IS NULL`,
          [ids],
        )
      : []

    const isRoot = (r: RoleRow) => r.code === ROOT_ROLE && Number(r.is_builtin) === 1
    const roles = roleRows.map((r): PrincipalRole => {
      if (isRoot(r)) return { code: r.code, dataScope: 'all', perms: ['*'] }
      const role: PrincipalRole = {
        code: r.code,
        dataScope: r.data_scope,
        perms: [
          ...new Set(
            grants.filter((g) => g.role_id === r.id && PERM_CODE.test(g.perms)).map((g) => g.perms),
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
      username: user.username,
      userType: user.user_type,
      deptId: user.dept_id,
      deptName: user.dept_name,
      deptTreePath: user.tree_path,
      roles,
      perms: root ? ['*'] : [...new Set(roles.flatMap((r) => r.perms))],
      root,
      locale: asLocale(user.locale),
    }
  }

  async findCredentials(
    by: { username: string } | { userId: number },
  ): Promise<Credentials | null> {
    const [row] = await this.ds.query<CredentialRow[]>(
      `SELECT id, username, user_type, password_hash, enabled, password_changed_at
         FROM iam_user
        WHERE (username = ? OR id = ?) AND deleted_at IS NULL
        LIMIT 1`,
      ['username' in by ? by.username : null, 'userId' in by ? by.userId : null],
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
        WHERE id = ? AND deleted_at IS NULL`,
      [rec.ip.slice(0, 64), rec.at, rec.timezone, userId],
    )
  }

  async profile(userId: number): Promise<MeUser | null> {
    const [u] = await this.ds.query<ProfileRow[]>(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.dept_id, d.name AS dept_name,
              u.locale, u.timezone
         FROM iam_user u
         LEFT JOIN iam_dept d ON d.id = u.dept_id AND d.deleted_at IS NULL
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [userId],
    )
    if (!u) return null
    const roles = await this.ds.query<{ name: string }[]>(
      `SELECT r.name
         FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
        WHERE ur.user_id = ? AND ur.deleted_at IS NULL
        ORDER BY r.sort_no, r.id`,
      [userId],
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

  async menus(userId: number, all: boolean): Promise<MenuNode[]> {
    // the whole table: ancestors of granted rows come from it (menus are few, hundreds at most)
    const rows = await this.ds.query<MenuRow[]>(
      `SELECT id, parent_id, kind, name, name_i18n, route_path, component, component_name, route_name,
              route_query, link_type, link_url, icon, sort_no, visible, keep_alive, always_show, enabled
         FROM iam_menu WHERE deleted_at IS NULL ORDER BY sort_no, id`,
    )
    const granted = all
      ? rows.map((r) => Number(r.id))
      : (
          await this.ds.query<{ menu_id: number }[]>(
            `SELECT DISTINCT rm.menu_id
               FROM iam_user_roles ur
               JOIN iam_role r ON r.id = ur.role_id AND r.enabled = 1 AND r.deleted_at IS NULL
               JOIN iam_role_menus rm ON rm.role_id = r.id AND rm.deleted_at IS NULL
              WHERE ur.user_id = ? AND ur.deleted_at IS NULL`,
            [userId],
          )
        ).map((g) => Number(g.menu_id))
    return menuTree(rows, granted)
  }

  async userIdsOfRole(roleId: number): Promise<number[]> {
    const rows = await this.ds.query<{ user_id: number }[]>(
      'SELECT user_id FROM iam_user_roles WHERE role_id = ? AND deleted_at IS NULL',
      [roleId],
    )
    return rows.map((r) => r.user_id)
  }
}
