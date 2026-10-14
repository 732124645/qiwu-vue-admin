import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { Err, masked, smsResetPasswordBody, type SmsLoginBody } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import type { DataSource } from 'typeorm'
import { AuditWriter } from '../../../../core/audit/audit-writer.js'
import { AuthParams } from '../../../../core/auth/auth-params.js'
import { AuthService, type Client, type SignInVia } from '../../../../core/auth/auth.service.js'
import { LoginTenantResolver } from '../../../../core/auth/login-tenant.js'
import { BCRYPT_COST } from '../../../../core/auth/password-hash.js'
import { PASSWORD_RESET, SessionRevoker } from '../../../../core/auth/session-revoker.js'
import { CONSOLE_CLIENT, type IssuedTokens } from '../../../../core/auth/token.service.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { parseOr400 } from '../../../../core/http/validation.pipe.js'
import { OtpService } from './sms-otp.service.js'

/**
 * SMS sign-in and password reset (see docs/design-notes.md#auth-sessions, #tenancy): the sign-in tenant
 * is resolved first (`resolveLoginTenant`: the host's, else `tenantCode`); a code is spent only by
 * `OtpService.consume` of its own scene in that tenant, and the account is the one holding the number
 * there. A wrong code, an unknown mobile, a disabled user and a tenant that did not resolve (an unknown
 * code, a disabled or expired tenant) all answer 400 `sms_code_invalid` and count an attempt. The reset
 * body is validated before the code is spent and ends every session of the user afterwards.
 */
@Injectable()
export class SmsAuthService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly otp: OtpService,
    private readonly auth: AuthService,
    private readonly params: AuthParams,
    private readonly audit: AuditWriter,
    private readonly revoker: SessionRevoker,
    private readonly loginTenants: LoginTenantResolver,
  ) {}

  /** `via`: a sign-in that also binds (the WeChat bind page's SMS proof). */
  async login(
    body: SmsLoginBody,
    client: Client,
    timezone: string | null,
    via?: SignInVia,
  ): Promise<IssuedTokens> {
    const kind = via?.kind ?? 'sms'
    const at = await this.loginTenants.resolveLoginTenant(
      { hostname: client.host },
      body.tenantCode,
    )
    const invalid = () => {
      this.audit.signin({
        kind,
        userId: null,
        userType: 'admin',
        username: masked.mobile(body.mobile),
        clientId: body.clientId ?? CONSOLE_CLIENT,
        ...client,
        ok: false,
        // an unknown code's attempts belong to no tenant, an unavailable tenant's to that tenant
        ...(at.tenantId === null
          ? { msgKey: 'signin.tenant_unavailable', tenantId: at.logTenantId }
          : { msgKey: 'signin.sms_code_invalid' }),
      })
      throw new BizError(Err.AUTH_SMS_CODE_INVALID)
    }
    if (at.tenantId === null) {
      await this.otp.countAttempt(body.mobile, 'signin', client.ip)
      return invalid()
    }
    if (
      !(await this.otp.consume(
        { mobile: body.mobile, scene: 'signin', code: body.code },
        client.ip,
      ))
    )
      return invalid()
    const [row] = await this.ds.query<Array<{ id: number }>>(
      // qw:no-data-scope sign-in by mobile, no caller
      'SELECT id FROM iam_user WHERE tenant_id = ? AND mobile = ? AND deleted_at IS NULL LIMIT 1',
      [at.tenantId, body.mobile],
    )
    if (!row) return invalid()
    return this.auth.signInVerified(
      Number(row.id),
      {
        kind,
        keepSignedIn: body.keepSignedIn,
        timezone,
        label: masked.mobile(body.mobile),
        clientId: body.clientId,
        ...(via && { beforeIssue: (userId: number) => via.beforeIssue(userId, null) }),
      },
      client,
    )
  }

  /** `host`: the request's host name (`req.hostname`), naming the tenant when bound to one. */
  async resetPassword(body: unknown, ip: string, host?: string): Promise<void> {
    const { policy } = await this.params.load()
    const dto = parseOr400(smsResetPasswordBody(policy), body)
    const invalid = () => new BizError(Err.AUTH_SMS_CODE_INVALID)
    const at = await this.loginTenants.resolveLoginTenant({ hostname: host }, dto.tenantCode)
    if (at.tenantId === null) {
      await this.otp.countAttempt(dto.mobile, 'reset_password', ip)
      throw invalid()
    }
    if (
      !(await this.otp.consume({ mobile: dto.mobile, scene: 'reset_password', code: dto.code }, ip))
    )
      throw invalid()
    const [row] = await this.ds.query<Array<{ id: number }>>(
      // qw:no-data-scope password reset by mobile, no caller
      'SELECT id FROM iam_user WHERE tenant_id = ? AND mobile = ? AND deleted_at IS NULL AND enabled = 1 LIMIT 1',
      [at.tenantId, dto.mobile],
    )
    if (!row) throw invalid()
    const changed = await this.ds.query<{ affectedRows: number }>(
      `UPDATE iam_user SET password_hash = ?, password_changed_at = ?
        WHERE id = ? AND tenant_id = ? AND mobile = ? AND deleted_at IS NULL AND enabled = 1`,
      [
        await bcrypt.hash(dto.newPassword, BCRYPT_COST),
        new Date(),
        row.id,
        at.tenantId,
        dto.mobile,
      ],
    )
    if (changed.affectedRows !== 1) throw invalid()
    await this.revoker.revokeUser(Number(row.id), PASSWORD_RESET)
  }
}
