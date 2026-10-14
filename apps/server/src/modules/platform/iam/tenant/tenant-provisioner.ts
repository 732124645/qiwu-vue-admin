import { randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { newTenantCode, type PasswordPolicy } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import type { DataSource, EntityManager } from 'typeorm'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { BCRYPT_COST } from '../../../../core/auth/password-hash.js'
import { TENANT_ADMIN_ROLE } from '../../../../core/auth/principal.js'
import { clsGet } from '../../../../core/context/cls.js'
import { SecretBox } from '../../../../core/crypto/secret-box.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { runTenantSeeds } from '../../../../db/seeds/index.js'
import { assertUserQuota } from './tenant-quota.js'

/** What opening a tenant takes. */
export interface TenantProvision {
  /** a new tenant code (`newTenantCode`; 400 otherwise), never changed afterwards */
  code: string
  name: string
  /** live users at most, its administrator counted; null or left out = no limit */
  userQuota?: number | null
  /** its package (the caller checks it); null or left out = none */
  packageId?: number | null
  /** when it ends; null or left out = never */
  expiresAt?: Date | null
  brandName?: string | null
  /** its logo object (the caller binds it) */
  logoObjectId?: number | null
  note?: string | null
  /** its first user: the owner, holding the builtin `tenant_admin` role */
  admin: { username: string; displayName: string; mobile?: string | null; email?: string | null }
}

export interface ProvisionedTenant {
  id: number
  /** the administrator's user id (`iam_tenant.owner_user_id`) */
  adminId: number
  /** the tenant's initial password, the administrator's first one: returned here only, never again */
  initialPassword: string
}

/** A random password every policy takes: all four character classes, 16 characters or the policy's minimum. */
export function randomPassword(policy: PasswordPolicy): string {
  const length = Math.max(16, policy.minLength)
  return `${randomBytes(length)
    .toString('base64url')
    .slice(0, length - 4)}#a1A`
}

/**
 * Opens a tenant (see docs/design-notes.md#tenancy), all in one transaction, so a failing step leaves
 * nothing: the `iam_tenant` row with its own initial password (random, stored only SecretBox-encrypted:
 * new users of the tenant created without a password get it, as the default tenant's get the
 * `iam.user.initial_password` param; one shared value would let one tenant's administrator sign in as
 * another tenant's new users), the tenant seeds (`runTenantSeeds`: root dept, `tenant_admin`, process
 * templates, leave model, the project's), then its administrator within the user quota: in the root dept,
 * holding `tenant_admin`, the initial password to be changed at the first sign-in, recorded as the owner.
 */
@Injectable()
export class TenantProvisioner {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly box: SecretBox,
    private readonly authParams: AuthParams,
  ) {}

  /**
   * `inTx`, given, runs in the transaction right after the tenant row is written (the caller's own checks
   * and rows of the new tenant): what it throws rolls everything back.
   */
  async provision(
    input: TenantProvision,
    inTx?: (q: EntityManager, tenantId: number) => Promise<void>,
  ): Promise<ProvisionedTenant> {
    const code = parseOr400(newTenantCode, input.code)
    const { policy } = await this.authParams.load()
    const initialPassword = randomPassword(policy)
    // hashed before the transaction: no row stays locked through bcrypt
    const hash = await bcrypt.hash(initialPassword, BCRYPT_COST)
    return this.ds.transaction(async (q) => {
      const by = clsGet('principal')?.userId ?? null
      const { insertId } = await q.query<{ insertId: number }>(
        `INSERT INTO iam_tenant (code, name, user_quota, package_id, expires_at, brand_name, logo_object_id,
                                 note, initial_password_enc, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          code,
          input.name,
          input.userQuota ?? null,
          input.packageId ?? null,
          input.expiresAt ?? null,
          input.brandName ?? null,
          input.logoObjectId ?? null,
          input.note ?? null,
          this.box.encrypt(initialPassword),
          by,
          by,
        ],
      )
      const id = Number(insertId)
      await inTx?.(q, id)
      await runTenantSeeds(q, id)
      await assertUserQuota(q, id)
      const [dept] = await q.query<{ id: number }[]>(
        // qw:no-data-scope opening a tenant: its root dept
        'SELECT id FROM iam_dept WHERE parent_id = 0 AND tenant_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1',
        [id],
      )
      const [role] = await q.query<{ id: number }[]>(
        'SELECT id FROM iam_role WHERE code = ? AND is_builtin = 1 AND tenant_id = ? AND deleted_at IS NULL',
        [TENANT_ADMIN_ROLE, id],
      )
      if (!dept || !role)
        throw new Error(`the tenant seeds left tenant ${id} without its root dept or role`)
      const { insertId: adminId } = await q.query<{ insertId: number }>(
        `INSERT INTO iam_user (username, display_name, mobile, email, dept_id, password_hash,
                               password_changed_at, tenant_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        [
          input.admin.username,
          input.admin.displayName,
          input.admin.mobile ?? null,
          input.admin.email ?? null,
          dept.id,
          hash,
          id,
        ],
      )
      await q.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)', [
        adminId,
        role.id,
        id,
      ])
      await q.query('UPDATE iam_tenant SET owner_user_id = ? WHERE id = ? AND deleted_at IS NULL', [
        adminId,
        id,
      ])
      return { id, adminId: Number(adminId), initialPassword }
    })
  }
}
