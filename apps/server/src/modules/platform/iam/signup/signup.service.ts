import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID, Err, type SignupBody, signupBody, type Locale } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import type { DataSource } from 'typeorm'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { BCRYPT_COST } from '../../../../core/auth/password-hash.js'
import { ROOT_ROLE } from '../../../../core/auth/principal.js'
import { addLinks } from '../../../../core/db/links.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { USER_ROLES } from '../iam-links.js'
import { assertUserQuota } from '../tenant/tenant-quota.js'

@Injectable()
export class SignupService {
  private readonly logger = new Logger(SignupService.name)

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly authParams: AuthParams,
  ) {}

  /** The body under the current password policy (400 with translated messages otherwise). */
  async parse(body: unknown): Promise<SignupBody> {
    const { policy } = await this.authParams.load()
    return parseOr400(signupBody(policy), body)
  }

  /**
   * Creates a user of the default tenant (the only one taking sign-ups; SignupController resolved it),
   * within its user quota (409 `B1013`), in one transaction: the `auth.signup.default_role_id` role of
   * that tenant must exist, be enabled, not builtin/root and not have `all` data scope (unsafe settings
   * refuse sign-up, 403). The `auth.signup.default_dept_id` dept of that tenant is used only when live
   * and enabled (else none); the chosen password counts as changed now; a taken username → 409 (unique
   * index). Role and dept are read FOR SHARE: a concurrent delete of either (which locks the row first)
   * waits for the new user or is seen.
   */
  async signup({ username, password, displayName }: SignupBody, locale?: Locale): Promise<void> {
    const settings = await this.authParams.signup()
    if (!settings.enabled) throw new BizError(Err.AUTH_SIGNUP_DISABLED)
    const hash = await bcrypt.hash(password, BCRYPT_COST)

    const tid = DEFAULT_TENANT_ID
    await this.ds.transaction(async (q) => {
      await assertUserQuota(q, tid)
      const [role] = await q.query<
        { id: number; code: string; is_builtin: number; data_scope: string }[]
      >(
        'SELECT id, code, is_builtin, data_scope FROM iam_role WHERE id = ? AND tenant_id = ? AND enabled = 1 AND deleted_at IS NULL LIMIT 1 FOR SHARE',
        [settings.defaultRoleId, tid],
      )
      if (
        !role ||
        role.code === ROOT_ROLE ||
        Number(role.is_builtin) === 1 ||
        role.data_scope === 'all'
      ) {
        this.logger.warn(`Unsafe sign-up default role: ${settings.defaultRoleId}`)
        throw new BizError(Err.AUTH_SIGNUP_DISABLED)
      }
      let deptId: number | null = null
      if (settings.defaultDeptId !== null) {
        const [dept] = await q.query<{ id: number }[]>(
          'SELECT id FROM iam_dept WHERE id = ? AND tenant_id = ? AND enabled = 1 AND deleted_at IS NULL LIMIT 1 FOR SHARE',
          [settings.defaultDeptId, tid],
        )
        if (dept) deptId = Number(dept.id)
        else this.logger.warn(`Invalid sign-up default dept: ${settings.defaultDeptId}`)
      }
      const result = await q.query<{ insertId: number }>(
        `INSERT INTO iam_user
           (username, password_hash, display_name, dept_id, enabled, password_changed_at, locale, tenant_id)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        [username, hash, displayName ?? username, deptId, new Date(), locale ?? null, tid],
      )
      await addLinks(q, USER_ROLES, result.insertId, [Number(role.id)])
    })
  }
}
