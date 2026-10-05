import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  fieldDomains,
  type ImportMode,
  type ImportResult,
  masked,
  type Page,
  PAGE_SIZE_MAX,
  type PasswordPolicy,
  passwordSchema,
  USER_INITIAL_PASSWORD_PARAM,
  type UserCreate,
  userCreate,
  type UserDetailVo,
  type UserGender,
  type UserOption,
  type UserOptionQuery,
  userPerms,
  type UserQuery,
  userResetPasswordBody,
  type UserUpdate,
  userUpdate,
  type UserVo,
} from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import { I18nService } from 'nestjs-i18n'
import type { SelectQueryBuilder } from 'typeorm'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { BCRYPT_COST } from '../../../../core/auth/password-hash.js'
import { PermVersion } from '../../../../core/auth/perm-version.js'
import { ROOT_ROLE } from '../../../../core/auth/principal.js'
import { PASSWORD_RESET, SessionRevoker } from '../../../../core/auth/session-revoker.js'
import { clsGet } from '../../../../core/context/cls.js'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { withCheckedPerm } from '../../../../core/data-scope/data-scope.js'
import { replaceLinks } from '../../../../core/db/links.js'
import { assertLive } from '../../../../core/db/references.js'
import { contains, paginate } from '../../../../core/db/page.js'
import {
  type ExcelColumn,
  type ExcelOption,
  ExcelService,
} from '../../../../core/excel/excel.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import type { UploadedFileData } from '../../../../core/http/upload.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { currentLocale } from '../../../../core/i18n/locale.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { DeptService } from '../dept/dept.service.js'
import { OtpService } from '../../messaging/sms-otp/sms-otp.service.js'
import { USER_POSITIONS, USER_ROLES } from '../iam-links.js'
import { GrantPolicy } from '../role/grant-policy.js'
import { User } from './user.entity.js'

/** One live role of a user; `root` = the builtin root role. */
interface HeldRole {
  id: number
  name: string
  root: boolean
}

/** What a committed write still has to tell live sessions (only after the commit; see docs/design-notes.md#permissions, #security). */
interface After {
  bump?: boolean
  revoke?: string
  voidMobile?: string
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

/**
 * Export / import template / import columns in list order. The dept column is the dept id (see docs/design-notes.md#api-envelope): exported and offered in the template as `<id> - <path of names>`, imported by the id before
 * ` - ` and checked against the caller's writable scope. Roles and positions are not imported
 * (assigned on the page afterwards, docs/codegen.md); passwords neither (new users get the initial one).
 */
export const userColumns: ExcelColumn[] = [
  { prop: 'username', label: 'field.iam.user.username' },
  { prop: 'displayName', label: 'field.iam.user.displayName' },
  { prop: 'deptId', label: 'field.iam.user.deptId', type: 'number', pick: true, width: 36 },
  { prop: 'mobile', label: 'field.iam.user.mobile' },
  { prop: 'email', label: 'field.iam.user.email', width: 28 },
  { prop: 'gender', label: 'field.iam.user.gender', dict: 'iam.gender' },
  { prop: 'enabled', label: 'field.iam.user.enabled', type: 'boolean', dict: 'core.enabled' },
  { prop: 'lastLoginAt', label: 'field.iam.user.lastLoginAt', type: 'datetime', only: 'export' },
  { prop: 'createdAt', label: 'field.common.createdAt', type: 'datetime', only: 'export' },
  { prop: 'note', label: 'field.iam.user.note', width: 40 },
]

/** One imported row: the editable columns, username and display name required. */
const userImportRow = userUpdate
  .omit({ roleIds: true, positionIds: true })
  .required({ username: true, displayName: true })
  .register(fieldDomains, { domain: 'iam.user' })

/**
 * Users (complex golden sample; see docs/design-notes.md#layering) over BaseCrudService: every read through `scopedQb`, every
 * write by id after `lockScopedIds`, the dept through `assertWritableScope` (see docs/design-notes.md#data-scope); roles only
 * through `GrantPolicy` (see docs/design-notes.md#permissions). Unique username/mobile/email are DB indexes (errno 1062 → 409).
 * Session effects run after the commit: role/dept changes `PermVersion.bumpUser`, disabling
 * `SessionRevoker.revokeUser` (PermVersion's rule: a bump inside the transaction can be reloaded stale).
 */
@Injectable()
export class UserService extends BaseCrudService<User> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly grants: GrantPolicy,
    private readonly permVersion: PermVersion,
    private readonly revoker: SessionRevoker,
    private readonly otp: OtpService,
    private readonly authParams: AuthParams,
    private readonly params: ParamService,
    private readonly excel: ExcelService,
    private readonly depts: DeptService,
    private readonly i18n: I18nService,
  ) {
    super(txHost, User)
  }

  /**
   * List filters (page and export): dept = that dept and its subtree; text filters contain. `mobile`
   * applies only for callers who see contacts unmasked (`plainContacts`): for the others it is
   * ignored, else contains-searches would reveal the masked digits one by one.
   */
  protected override filter(
    qb: SelectQueryBuilder<User>,
    { deptId, keyword, username, mobile, enabled, createdAtFrom, createdAtTo }: Partial<UserQuery>,
  ): SelectQueryBuilder<User> {
    if (deptId)
      // tree paths end with '/', so /1/2/% never matches /1/23/
      qb.andWhere(
        `t.dept_id IN (SELECT c.id FROM iam_dept c
           JOIN iam_dept f ON c.tree_path LIKE CONCAT(f.tree_path, '%') AND f.deleted_at IS NULL
          WHERE f.id = :fDept AND c.deleted_at IS NULL)`,
        { fDept: deptId },
      )
    if (keyword)
      qb.andWhere('(t.username LIKE :kw OR t.display_name LIKE :kw)', { kw: contains(keyword) })
    if (username) qb.andWhere('t.username LIKE :un', { un: contains(username) })
    if (mobile && this.plainContacts()) qb.andWhere('t.mobile LIKE :mob', { mob: contains(mobile) })
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    if (createdAtFrom) qb.andWhere('t.created_at >= :from', { from: new Date(createdAtFrom) })
    if (createdAtTo) qb.andWhere('t.created_at <= :to', { to: new Date(createdAtTo) })
    return qb
  }

  async list(query: UserQuery): Promise<Page<UserVo>> {
    const { items, total } = await paginate(this.filter(this.withDept(), query), query)
    return { items: await this.toVos(items), total }
  }

  /** The row plus its live roles (ids, and named) and position ids; out of scope → 404. */
  async detail(id: number): Promise<UserDetailVo> {
    const row = await this.withDept().andWhere('t.id = :id', { id }).getOne()
    if (!row) throw new NotFoundException()
    const [vo] = await this.toVos([row])
    const positions = await this.txHost.tx.query<{ id: number }[]>(
      'SELECT position_id AS id FROM iam_user_positions WHERE user_id = ? AND deleted_at IS NULL ORDER BY position_id',
      [id],
    )
    const roles = await this.rolesOf(id)
    return {
      ...vo!,
      roleIds: roles.map((r) => r.id),
      roles: roles.map(({ id, name }) => ({ id, name })),
      positionIds: positions.map((p) => Number(p.id)),
    }
  }

  /**
   * POST: the body is checked against the current password policy; no password → the initial password
   * param. `password_changed_at` stays null, so the first sign-in must change it. The dept must be live
   * and in the caller's writable scope (404), the roles pass GrantPolicy (403), unknown roles/positions → 404.
   */
  async createUser(body: unknown): Promise<UserDetailVo> {
    const { policy } = await this.authParams.load()
    const { password, ...dto } = parseOr400(userCreate(policy), body)
    const hash = await bcrypt.hash(password ?? (await this.initialPassword(policy)), BCRYPT_COST)
    return this.detail(await this.insert(dto, hash))
  }

  /** A new user with the bcrypt `hash`, must change it at the next sign-in; returns the id. */
  protected insert(
    { roleIds = [], positionIds = [], ...fields }: Omit<UserCreate, 'password'>,
    hash: string,
  ): Promise<number> {
    return this.txHost.withTransaction(async () => {
      await this.assertLiveDept(fields.deptId)
      const row = await this.create({ ...fields, passwordHash: hash, passwordChangedAt: null })
      await this.grants.assertAssignableRoles(roleIds, fields.deptId ?? null)
      await this.setRoles(row.id, roleIds)
      await this.setPositions(row.id, positionIds)
      return row.id
    })
  }

  /**
   * The list's rows (filters and sort, no paging) as export rows, batch by batch (`exportRows`): masked
   * like the list, dept as `<id> - <path>`.
   */
  async *exportList(query: UserQuery): AsyncGenerator<object[]> {
    const paths = await this.deptPaths()
    for await (const rows of this.exportRows(query))
      yield (await this.toVos(rows)).map((u) => ({
        ...u,
        deptId: u.deptId === null ? null : `${u.deptId} - ${paths.get(u.deptId) ?? ''}`,
      }))
  }

  /** The import template's dept dropdown: enabled depts of the caller's scope, in tree order. */
  async deptOptions(): Promise<ExcelOption[]> {
    const [paths, scoped] = await Promise.all([
      this.deptPaths(),
      this.depts
        .scopedQb('d')
        .select('d.id', 'id')
        .andWhere('d.enabled = :on', { on: true })
        .getRawMany<{ id: number }>(),
    ])
    const ids = new Set(scoped.map((d) => Number(d.id)))
    return [...paths].filter(([id]) => ids.has(id)).map(([value, label]) => ({ value, label }))
  }

  /**
   * POST /import: each valid row on its own, through the same writes as the page (dept scope, 409 on
   * duplicates, root protection). `insert` adds every row (new users get the initial password, one hash
   * for the whole file); `upsert` updates the user with that username when the caller's scope sees it
   * and inserts otherwise, so a same-named user outside the scope fails the row as a duplicate instead of
   * being overwritten (see docs/design-notes.md#data-scope). Failed rows go to the downloadable report.
   */
  async importXlsx(file: UploadedFileData | undefined, mode: ImportMode): Promise<ImportResult> {
    if (!file) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const { rows, failures } = await this.excel.read(file.buffer, userColumns, userImportRow)
    let initial: Promise<string> | undefined
    const initialHash = () =>
      (initial ??= this.authParams
        .load()
        .then(({ policy }) => this.initialPassword(policy))
        .then((pw) => bcrypt.hash(pw, BCRYPT_COST)))
    const counts = { inserted: 0, updated: 0 }
    for (const row of rows)
      try {
        const found =
          mode === 'upsert'
            ? await this.scopedQb('t')
                .select('t.id')
                .andWhere('t.username = :username', { username: row.value.username })
                .getOne()
            : null
        if (found) {
          await this.modify(found.id, row.value)
          counts.updated++
        } else {
          await this.insert(row.value, await initialHash())
          counts.inserted++
        }
      } catch (e) {
        failures.push(this.excel.failure(row, e))
      }
    return this.excel.result(counts, failures, userColumns)
  }

  /** Every live dept → its path of names (seeded names translated), siblings by `sort_no, id`. */
  protected async deptPaths(): Promise<Map<number, string>> {
    const rows = await this.txHost.tx.query<
      { id: number; tree_path: string; name: string; sort_no: number }[]
    >('SELECT id, tree_path, name, sort_no FROM iam_dept WHERE deleted_at IS NULL')
    const byId = new Map(rows.map((r) => [Number(r.id), r]))
    const lang = currentLocale()
    const text = (name: string) =>
      name.startsWith('seed.') ? String(this.i18n.translate(name, { lang })) : name
    const chains = rows.map((r) =>
      r.tree_path
        .split('/')
        .filter(Boolean)
        .map((id) => byId.get(Number(id)))
        .filter((d) => d !== undefined),
    )
    const key = (d: (typeof rows)[number]) => [d.sort_no, Number(d.id)]
    chains.sort((a, b) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const [x, y] = [key(a[i]!), key(b[i]!)]
        if (x[0] !== y[0] || x[1] !== y[1]) return x[0]! - y[0]! || x[1]! - y[1]!
      }
      return a.length - b.length
    })
    return new Map(
      chains
        .filter((c) => c.length)
        .map((c) => [Number(c.at(-1)!.id), c.map((d) => text(d.name)).join(' / ')]),
    )
  }

  /**
   * PUT: the fields sent change. A root user may be edited only by root and keeps the root role; a new
   * dept must be in the caller's writable scope and not widen the relative scopes of the user's roles;
   * added roles pass GrantPolicy. Roles, dept or username changed → bumpUser; disabled → sessions revoked.
   * The mobile signs in (SMS codes): changing another user's needs the reset-password power too (the
   * perm, 403, and the user inside its scope, 404) and ends that user's sessions and unused codes.
   */
  async modify(id: number, dto: UserUpdate): Promise<void> {
    const { roleIds, positionIds, ...columns } = dto
    await this.after(
      this.txHost.withTransaction(async (): Promise<After> => {
        await this.lockScopedIds([id])
        const stored = await this.repo.findOneByOrFail({ id })
        const held = await this.rolesOf(id)
        this.assertManageable(held)
        const mobileChanged = columns.mobile !== undefined && columns.mobile !== stored.mobile
        const principal = clsGet('principal')
        if (mobileChanged && id === principal?.userId)
          throw new BizError(Err.IAM_OWN_MOBILE_IN_PROFILE)
        const changingAnotherMobile = mobileChanged && id !== principal?.userId
        if (changingAnotherMobile && !principal?.root) {
          if (!principal?.perms.includes(userPerms['reset-password']))
            throw new ForbiddenException()
          await withCheckedPerm({ perms: [userPerms['reset-password']], all: false }, () =>
            this.lockScopedIds([id]),
          )
        }
        const disabling = columns.enabled === false && stored.enabled
        if (disabling) this.assertDisablable(id, held)
        const deptId = columns.deptId === undefined ? stored.deptId : columns.deptId
        const moved = deptId !== stored.deptId
        if (moved) await this.assertLiveDept(deptId)
        await this.update(id, columns)
        const current = held.map((r) => r.id)
        let rolesChanged = false
        if (roleIds) {
          const next = [...new Set(roleIds)]
          if (held.some((r) => r.root && !next.includes(r.id)))
            throw new BizError(Err.IAM_USER_PROTECTED)
          const added = next.filter((r) => !current.includes(r))
          await this.grants.assertAssignableRoles(added, deptId, moved ? next : [])
          rolesChanged = added.length > 0 || current.some((r) => !next.includes(r))
          if (rolesChanged) await this.setRoles(id, next)
        } else if (moved) await this.grants.assertAssignableRoles([], deptId, current)
        if (positionIds) await this.setPositions(id, positionIds)
        // sessions carry roles, dept and username (the action log's actor): reload them
        const renamed = columns.username !== undefined && columns.username !== stored.username
        return {
          bump: rolesChanged || moved || renamed,
          revoke: disabling
            ? 'user_disabled'
            : changingAnotherMobile
              ? 'mobile_changed'
              : undefined,
          voidMobile: changingAnotherMobile ? (stored.mobile ?? undefined) : undefined,
        }
      }),
      id,
    )
  }

  /**
   * DELETE / batch-delete: all or nothing. Never the caller (422 user_self) nor a root user (422
   * user_protected); soft delete, the role, position and preference links soft-deleted with it (iam.module
   * references: the user's positions become deletable), then every session of each user ends.
   */
  override async remove(ids: readonly number[]): Promise<void> {
    const byId = [...new Set(ids)]
    await this.txHost.withTransaction(async () => {
      await this.lockScopedIds(byId)
      if (byId.includes(clsGet('principal')?.userId ?? 0)) throw new BizError(Err.IAM_USER_SELF)
      if ((await this.rootIds(byId)).size) throw new BizError(Err.IAM_USER_PROTECTED)
      await this.deleteRows(byId)
    })
    for (const id of byId) await this.revoker.revokeUser(id, 'user_removed')
  }

  /**
   * PUT /:id/password (`reset-password`): a new password under the current policy that the user must
   * change at the next sign-in (`password_changed_at = null`); every session of the user ends. Root users
   * only by root.
   */
  async resetPassword(id: number, body: unknown): Promise<void> {
    const { policy } = await this.authParams.load()
    const { password } = parseOr400(userResetPasswordBody(policy), body)
    const hash = await bcrypt.hash(password, BCRYPT_COST)
    await this.after(
      this.txHost.withTransaction(async (): Promise<After> => {
        await this.lockScopedIds([id])
        this.assertManageable(await this.rolesOf(id))
        await this.repo.update(id, { passwordHash: hash, passwordChangedAt: null })
        return { revoke: PASSWORD_RESET }
      }),
      id,
    )
  }

  /** GET /options (UserPicker): enabled users of the caller's scope, filtered like the list, by username. */
  async options(query: UserOptionQuery): Promise<UserOption[]> {
    const rows = await this.filter(this.withDept(), query)
      .andWhere('t.enabled = :on', { on: true })
      .orderBy('t.username')
      .take(PAGE_SIZE_MAX)
      .getMany()
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName,
      deptName: r.dept?.name ?? null,
    }))
  }

  /** Awaits a write of user `id`, then (committed) runs its session effects. */
  protected async after(write: Promise<After>, id: number): Promise<void> {
    const { bump, revoke, voidMobile } = await write
    if (revoke) await this.revoker.revokeUser(id, revoke)
    else if (bump) await this.permVersion.bumpUser(id)
    if (voidMobile) await this.otp.voidMobile(voidMobile)
  }

  /** Non-root callers never write a root user (its password, contacts or dept are a takeover path). */
  protected assertManageable(held: HeldRole[]): void {
    if (!clsGet('principal')?.root && held.some((r) => r.root))
      throw new BizError(Err.IAM_USER_PROTECTED)
  }

  /** Nobody disables their own account or a root user. */
  protected assertDisablable(id: number, held: HeldRole[]): void {
    if (id === clsGet('principal')?.userId) throw new BizError(Err.IAM_USER_SELF)
    if (held.some((r) => r.root)) throw new BizError(Err.IAM_USER_PROTECTED)
  }

  /** Live roles of the user (links to deleted roles are left out). */
  protected async rolesOf(id: number): Promise<HeldRole[]> {
    const rows = await this.txHost.tx.query<{ id: number; name: string; root: number }[]>(
      `SELECT r.id, r.name, (r.code = ? AND r.is_builtin = 1) AS root
         FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id = ? AND ur.deleted_at IS NULL
        ORDER BY r.sort_no, r.id`,
      [ROOT_ROLE, id],
    )
    return rows.map((r) => ({ id: Number(r.id), name: r.name, root: Number(r.root) === 1 }))
  }

  /** Replaces the roles (checked by the caller: `GrantPolicy.assertAssignableRoles`). */
  protected setRoles(userId: number, roleIds: readonly number[]): Promise<void> {
    return replaceLinks(this.txHost.tx, USER_ROLES, userId, roleIds)
  }

  /**
   * Replaces the positions; an unknown position → 404. The positions are read FOR SHARE: one deleted
   * meanwhile (it locks its row first) is either seen deleted or waits for this commit and sees the link.
   */
  protected async setPositions(userId: number, positionIds: readonly number[]): Promise<void> {
    const ids = [...new Set(positionIds)]
    if (ids.length) {
      const live = await this.txHost.tx.query<unknown[]>(
        'SELECT id FROM iam_position WHERE id IN (?) AND deleted_at IS NULL FOR SHARE',
        [ids],
      )
      if (live.length !== ids.length) throw new NotFoundException()
    }
    await replaceLinks(this.txHost.tx, USER_POSITIONS, userId, ids)
  }

  /**
   * A dept a user is put in (create, move) must be live (404; no foreign key): read FOR SHARE,
   * so a concurrent delete (which locks the dept, then refuses one with users) cannot leave a user in a
   * deleted dept. No dept (null) is fine.
   */
  protected assertLiveDept(deptId: number | null | undefined): Promise<void> {
    return assertLive(this.txHost.tx, 'iam_dept', deptId)
  }

  /** The `iam.user.initial_password` param; unset or failing the policy → 422. */
  protected async initialPassword(policy: PasswordPolicy): Promise<string> {
    const value = await this.params.get(USER_INITIAL_PASSWORD_PARAM)
    if (!value || !passwordSchema(policy).safeParse(value).success)
      throw new BizError(Err.IAM_INITIAL_PASSWORD_UNSET)
    return value
  }

  /** Those of `ids` holding the builtin root role. */
  protected async rootIds(ids: readonly number[]): Promise<Set<number>> {
    if (!ids.length) return new Set()
    const rows = await this.txHost.tx.query<{ id: number }[]>(
      `SELECT DISTINCT ur.user_id AS id
         FROM iam_user_roles ur
         JOIN iam_role r ON r.id = ur.role_id AND r.deleted_at IS NULL
        WHERE ur.user_id IN (?) AND ur.deleted_at IS NULL AND r.code = ? AND r.is_builtin = 1`,
      [ids, ROOT_ROLE],
    )
    return new Set(rows.map((r) => Number(r.id)))
  }

  /** `scopedQb('t')` with the dept joined for its name. */
  protected withDept(): SelectQueryBuilder<User> {
    return this.scopedQb('t').leftJoinAndSelect('t.dept', 'd')
  }

  /** Whoever may edit users (`iam.user.modify`, or root) sees mobile/email unmasked. */
  protected plainContacts(): boolean {
    const p = clsGet('principal')
    return p?.root === true || p?.perms.includes(userPerms.modify) === true
  }

  /**
   * Rows → VOs: mobile/email masked unless `plainContacts`, `root` for holders of the builtin root role.
   */
  protected async toVos(rows: User[]): Promise<UserVo[]> {
    const plain = this.plainContacts()
    const roots = await this.rootIds(rows.map((r) => r.id))
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.displayName,
      deptId: r.deptId,
      deptName: r.dept?.name ?? null,
      mobile: plain ? r.mobile : masked.mobile(r.mobile),
      email: plain ? r.email : masked.email(r.email),
      masked: !plain,
      gender: r.gender as UserGender,
      avatarUrl: r.avatarUrl,
      enabled: r.enabled,
      root: roots.has(r.id),
      lastLoginAt: iso(r.lastLoginAt),
      note: r.note,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      updatedBy: r.updatedBy,
      updatedAt: r.updatedAt.toISOString(),
    }))
  }
}
