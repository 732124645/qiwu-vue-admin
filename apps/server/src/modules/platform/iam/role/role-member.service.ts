import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, type Page, type RoleMemberQuery, type RoleMemberVo } from '@qiwu/shared'
import { In } from 'typeorm'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import { ROOT_ROLE } from '../../../../core/auth/principal.js'
import { clsGet } from '../../../../core/context/cls.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { addLinks, removeLinks } from '../../../../core/db/links.js'
import { contains, paginate } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { ROLE_USERS } from '../iam-links.js'
import { User } from '../user/user.entity.js'
import { GrantPolicy } from './grant-policy.js'

/**
 * The members of a role (perm `iam.role.assign-users`) over the users' own data scope (`iam_user` by dept, `own_rows` = the caller's own row; see docs/design-notes.md#data-scope): both lists read through `scopedQb`, every
 * add or remove first `lockScopedIds` on the user ids (any one out of scope → 404, nothing changes). Adding
 * gives a user a role, so it passes `GrantPolicy.assertAssignableRoles` for each user's dept (403);
 * nobody leaves the root role, and non-root callers leave the roles of root users alone (422, as in the user module; see docs/design-notes.md#auth-sessions). The users whose roles changed reload at their next request (`bumpUsers`,
 * after the commit). Only root may add or revoke members of the sign-up role.
 */
@Injectable()
export class RoleMemberService extends BaseCrudService<User> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly grants: GrantPolicy,
    private readonly permVersion: PermVersion,
  ) {
    super(txHost, User)
  }

  /** GET /:id/members: a page of the caller's users holding role `roleId` (or not, `assigned=false`). */
  async members(
    roleId: number,
    { assigned, keyword, ...paging }: RoleMemberQuery,
  ): Promise<Page<RoleMemberVo>> {
    await this.role(roleId)
    const qb = this.scopedQb('t')
      .leftJoinAndSelect('t.dept', 'd')
      .andWhere(
        assigned
          ? 'EXISTS (SELECT 1 FROM iam_user_roles ur WHERE ur.user_id = t.id AND ur.role_id = :roleId AND ur.deleted_at IS NULL)'
          : 'NOT EXISTS (SELECT 1 FROM iam_user_roles ur WHERE ur.user_id = t.id AND ur.role_id = :roleId AND ur.deleted_at IS NULL)',
        { roleId },
      )
    if (keyword)
      qb.andWhere('(t.username LIKE :kw OR t.display_name LIKE :kw)', { kw: contains(keyword) })
    const { items, total } = await paginate(qb, paging)
    return {
      items: items.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        deptId: u.deptId,
        deptName: u.dept?.name ?? null,
        enabled: u.enabled,
        createdAt: u.createdAt.toISOString(),
      })),
      total,
    }
  }

  /** POST /:id/members: gives role `roleId` to the users not holding it yet (the others stay as they are). */
  async add(roleId: number, userIds: readonly number[]): Promise<void> {
    const changed = await this.txHost.withTransaction(async () => {
      await this.role(roleId, true)
      await this.grants.assertNotSignupRole([roleId])
      const ids = [...new Set(userIds)]
      await this.lockScopedIds(ids)
      const held = await this.holding(roleId, ids)
      const toAdd = ids.filter((id) => !held.includes(id))
      if (!toAdd.length) return []
      await this.assertManageable(toAdd)
      const users = await this.repo.find({
        select: { id: true, deptId: true },
        where: { id: In(toAdd) },
      })
      // relative scopes (own_dept*) are judged against the dept of the user who gets the role
      for (const deptId of new Set(users.map((u) => u.deptId)))
        await this.grants.assertAssignableRoles([roleId], deptId)
      await addLinks(this.txHost.tx, ROLE_USERS, roleId, toAdd)
      return toAdd
    })
    await this.permVersion.bumpUsers(changed)
  }

  /** POST /:id/members/revoke: takes role `roleId` from the users holding it; never the root role (422). */
  async revoke(roleId: number, userIds: readonly number[]): Promise<void> {
    const changed = await this.txHost.withTransaction(async () => {
      const { root } = await this.role(roleId, true)
      await this.grants.assertNotSignupRole([roleId])
      const ids = [...new Set(userIds)]
      await this.lockScopedIds(ids)
      const held = await this.holding(roleId, ids)
      if (!held.length) return []
      if (root) throw new BizError(Err.IAM_USER_PROTECTED)
      await this.assertManageable(held)
      await removeLinks(this.txHost.tx, ROLE_USERS, roleId, held)
      return held
    })
    await this.permVersion.bumpUsers(changed)
  }

  /**
   * The live role `id` (else 404); in a write read FOR SHARE, so a delete of the role (FOR UPDATE, then no
   * members allowed) waits for the commit and sees the new members.
   */
  private async role(id: number, lock = false): Promise<{ root: boolean }> {
    const [row] = await this.txHost.tx.query<{ root: number }[]>(
      lock
        ? 'SELECT (code = ? AND is_builtin = 1) AS root FROM iam_role WHERE id = ? AND deleted_at IS NULL FOR SHARE'
        : 'SELECT (code = ? AND is_builtin = 1) AS root FROM iam_role WHERE id = ? AND deleted_at IS NULL',
      [ROOT_ROLE, id],
    )
    if (!row) throw new NotFoundException()
    return { root: Number(row.root) === 1 }
  }

  /** A non-root caller changes no root user's roles (422 `iam.user_protected`, like UserService). */
  private async assertManageable(ids: number[]): Promise<void> {
    if (!ids.length || clsGet('principal')?.root) return
    const [root] = await this.txHost.tx.query<unknown[]>(
      `SELECT ur.user_id FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id IN (?) AND ur.deleted_at IS NULL AND r.code = ? AND r.is_builtin = 1 LIMIT 1`,
      [ids, ROOT_ROLE],
    )
    if (root) throw new BizError(Err.IAM_USER_PROTECTED)
  }

  /** Those of `ids` holding role `roleId`. */
  private async holding(roleId: number, ids: number[]): Promise<number[]> {
    const rows = await this.txHost.tx.query<{ id: number }[]>(
      'SELECT user_id AS id FROM iam_user_roles WHERE role_id = ? AND user_id IN (?) AND deleted_at IS NULL',
      [roleId, ids],
    )
    return rows.map((r) => Number(r.id))
  }
}
