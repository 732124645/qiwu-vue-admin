import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import {
  Err,
  type ErrorDef,
  type SocialBindingVo,
  WX_MP_ENABLED_PARAM,
  type WxMpBindBody,
} from '@qiwu/shared'
import { type DataSource, QueryFailedError, type Repository } from 'typeorm'
import { AuthService, type Client, type SignInVia } from '../../../../core/auth/auth.service.js'
import { LoginTenantResolver } from '../../../../core/auth/login-tenant.js'
import {
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  SessionRevoker,
} from '../../../../core/auth/session-revoker.js'
import { type IssuedTokens, MOBILE_CLIENT } from '../../../../core/auth/token.service.js'
import { clsGet } from '../../../../core/context/cls.js'
import { tenantId, withTenant } from '../../../../core/context/tenant.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { SmsAuthService } from '../../messaging/sms-otp/sms-auth.service.js'
import { IamTenantLookup } from '../tenant/iam-tenant-lookup.js'
import { UserSocial } from './user-social.entity.js'
import { WxMpGateway, type WxMpIdentity } from './wx-mp.gateway.js'

export const WX_MP = 'wx-mp'
/** A bind ticket lives 5 minutes (see docs/design-notes.md#auth-sessions). */
const TICKET_TTL_MS = 5 * 60_000
/** WeChat codes live 5 minutes; a spent one is remembered past that. */
const CODE_TTL_MS = 10 * 60_000
/** WeChat sessions are phone sessions: kept signed in (7-day absolute cap still ends them; see docs/design-notes.md#auth-sessions). */
const MOBILE = { clientId: MOBILE_CLIENT, keepSignedIn: true } as const
/** Revocation reason of an unbind: the caller's other mobile sessions end. */
const UNBOUND = 'wx_mp_unbound'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface Ticket extends WxMpIdentity {
  appid: string
  ip: string
  /**
   * the tenant the issuing request's host is bound to: the ticket binds in that tenant only; absent (a
   * host bound to none: the main domain, the App, the mini program) = the tenant the bind resolves
   */
  tenantId?: number
}

/**
 * WeChat mini program sign-in and binding (see docs/design-notes.md#auth-sessions): a `uni.login` code is spent
 * once here before WeChat sees it; a bound, enabled user gets a `mobile` session (sign-in log `wx-mp`);
 * an unbound identity gets a one-time bind ticket (Redis, hashed key, 5 minutes, this client IP), never a
 * token. Binding spends the ticket first (GETDEL), then proves an account like /login (password: captcha,
 * lockout, fake hash) or /sms/login (a `signin` code) in the sign-in tenant (host, else `tenantCode`; see
 * docs/design-notes.md#tenancy), then writes the row re-checking the proof in the same statement, then
 * signs in. A WeChat identity is bound to one account of one tenant: the sign-in needs no tenant code. Off (param `auth.wx_mp.enabled`, or no AppID/secret) → sign-in and bind
 * 404; the own bindings stay listable and removable. A password change or reset ends the user's bindings
 * whoever bound his WeChat with a leaked password loses it with the password.
 */
@Injectable()
export class WxMpService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(UserSocial) private readonly repo: Repository<UserSocial>,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly gateway: WxMpGateway,
    private readonly params: ParamService,
    private readonly auth: AuthService,
    private readonly sms: SmsAuthService,
    private readonly revoker: SessionRevoker,
    private readonly tenants: IamTenantLookup,
    private readonly loginTenants: LoginTenantResolver,
  ) {
    // only a new password: a kick, a lock or a mobile change leave it, and the bindings made with it;
    // a password is set in the user's tenant (its own, an administrator's or an SMS reset's)
    revoker.onRevokeUser(async (userId, reason) => {
      if (reason !== PASSWORD_CHANGED && reason !== PASSWORD_RESET) return
      await this.ds.query(
        `UPDATE iam_user_social SET deleted_at = NOW(3), updated_by = ?
          WHERE user_id = ? AND tenant_id = ? AND deleted_at IS NULL`,
        [clsGet('principal')?.userId ?? userId, userId, tenantId()],
      )
    })
  }

  async login(
    code: string,
    client: Client,
    timezone: string | null,
  ): Promise<{ tokens: IssuedTokens } | { bindTicket: string }> {
    const appid = await this.appid()
    const fresh = await this.redis.set(redisKey('wxMp', 'code', sha256(code)), '1', {
      condition: 'NX',
      expiration: { type: 'PX', value: CODE_TTL_MS },
    })
    if (fresh !== 'OK') throw new BizError(Err.AUTH_WX_MP_CODE_INVALID)
    const { openid, unionid } = await this.gateway.code2Session(code)
    // An identity is bound once across tenants: its binding names the tenant, its user's (no tenant
    // code; the user's tenant must be available, IamUserLookup.load: see docs/design-notes.md#tenancy).
    const [bound] = await this.ds.query<{ id: number; user_id: number; tenant_id: number }[]>(
      // a deleted user's live binding still names it (the sign-in refuses it)
      // qw:cross-tenant a globally unique identity's binding, before any tenant is known; qw:include-deleted
      `SELECT s.id, s.user_id, u.tenant_id FROM iam_user_social s
         JOIN iam_user u ON u.id = s.user_id
        WHERE s.provider = ? AND s.appid = ? AND s.openid = ? AND s.deleted_at IS NULL`, // qw:no-data-scope sign-in by a WeChat binding, no caller
      [WX_MP, appid, openid],
    )
    if (bound) {
      const refused = Err.AUTH_WX_MP_REFUSED
      const bindingId = Number(bound.id)
      // qw:cross-tenant the sign-in runs in the tenant of the bound user's row
      const tokens = await withTenant(Number(bound.tenant_id), () =>
        this.auth.signInVerified(
          Number(bound.user_id),
          {
            kind: 'wx-mp',
            ...MOBILE,
            timezone,
            label: '',
            refused,
            // again once credver is read: an unbind or password change ends the binding before credver
            // moves, so one racing this sign-in refuses it here or ends its session
            beforeIssue: async () => {
              if (!(await this.repo.existsBy({ id: bindingId }))) throw new BizError(refused)
            },
          },
          client,
        ),
      )
      return { tokens }
    }
    const bindTicket = randomBytes(24).toString('base64url')
    const hostTenant = client.host ? await this.tenants.byHost(client.host) : null
    const ticket: Ticket = {
      appid,
      openid,
      unionid,
      ip: client.ip,
      ...(hostTenant !== null && { tenantId: hostTenant }),
    }
    await this.redis.set(redisKey('wxMp', 'ticket', sha256(bindTicket)), JSON.stringify(ticket), {
      expiration: { type: 'PX', value: TICKET_TTL_MS },
    })
    return { bindTicket }
  }

  async bind(body: WxMpBindBody, client: Client, timezone: string | null): Promise<IssuedTokens> {
    const appid = await this.appid()
    // spent whatever follows: a wrong password or code needs a new WeChat sign-in
    const raw = await this.redis.getDel(redisKey('wxMp', 'ticket', sha256(body.ticket)))
    const ticket = raw ? (JSON.parse(raw) as Ticket) : null
    if (ticket?.ip !== client.ip || ticket.appid !== appid)
      throw new BizError(Err.AUTH_WX_MP_TICKET_INVALID)
    // a ticket of a host bound to a tenant binds in that tenant only (an unknown code names none)
    if (
      ticket.tenantId !== undefined &&
      (await this.loginTenants.resolveLoginTenant({ hostname: client.host }, body.tenantCode))
        .logTenantId !== ticket.tenantId
    )
      throw new BizError(Err.AUTH_WX_MP_TICKET_INVALID)
    if ('username' in body) {
      const via: SignInVia = {
        kind: 'wx-mp',
        beforeIssue: (userId, proof) =>
          this.insert(ticket, userId, { passwordHash: proof!.passwordHash }),
      }
      return this.auth.login({ ...body, ...MOBILE }, client, timezone, via)
    }
    const via: SignInVia = {
      kind: 'wx-mp',
      beforeIssue: (userId) => this.insert(ticket, userId, { mobile: body.mobile }),
    }
    return this.sms.login(
      { mobile: body.mobile, code: body.code, tenantCode: body.tenantCode, ...MOBILE },
      client,
      timezone,
      via,
    )
  }

  /** The caller's live bindings (any provider), oldest first. */
  async list(userId: number): Promise<SocialBindingVo[]> {
    const rows = await this.repo.find({ where: { userId }, order: { id: 'ASC' } })
    return rows.map((r) => ({
      provider: r.provider,
      appid: r.appid,
      boundAt: r.createdAt.toISOString(),
    }))
  }

  /**
   * Unbinds the caller's WeChat (every app), switch on or off; none → 404. Then the caller's other mobile
   * sessions end: one a stranger's WeChat started on the binding must not outlive it; `sid`, the
   * caller's own session, stays.
   */
  async unbind(userId: number, sid: string | undefined): Promise<void> {
    const res = await this.ds.query<{ affectedRows: number }>(
      `UPDATE iam_user_social SET deleted_at = NOW(3), updated_by = ?
        WHERE user_id = ? AND provider = ? AND tenant_id = ? AND deleted_at IS NULL`,
      [userId, userId, WX_MP, tenantId()],
    )
    if (!res.affectedRows) throw new BizError(Err.NOT_FOUND)
    await this.revoker.revokeUser(userId, UNBOUND, { exceptSid: sid, clientId: MOBILE_CLIENT })
  }

  /** The configured app while the switch is on; otherwise the routes do not exist (404). */
  private async appid(): Promise<string> {
    const appid = this.gateway.appid()
    if (!appid || (await this.params.get(WX_MP_ENABLED_PARAM)) !== 'true')
      throw new BizError(Err.NOT_FOUND)
    return appid
  }

  /**
   * Binds the ticket's identity to `userId` while the user is live, enabled and still holds the proof
   * (the password hash the sign-in verified, or the mobile the code went to), all in one statement: a
   * password change, a disable or a mobile change racing the sign-in binds nothing. Unique keys: the
   * identity bound already → 409 `wx_mp_bound`, the user bound for this app already → `wx_mp_user_bound`.
   */
  private async insert(
    t: Ticket,
    userId: number,
    proof: { passwordHash: string } | { mobile: string },
  ): Promise<void> {
    const values = [WX_MP, t.appid, t.openid, t.unionid, userId, tenantId()]
    let refused: ErrorDef
    try {
      const res =
        'mobile' in proof
          ? await this.ds.query<{ affectedRows: number }>(
              // qw:no-data-scope binds the proven user's own account
              `INSERT INTO iam_user_social
                 (provider, appid, openid, unionid, user_id, created_by, updated_by, tenant_id)
               SELECT ?, ?, ?, ?, id, id, id, tenant_id FROM iam_user
                WHERE id = ? AND tenant_id = ? AND enabled = 1 AND deleted_at IS NULL AND mobile = ?`,
              [...values, proof.mobile],
            )
          : await this.ds.query<{ affectedRows: number }>(
              // qw:no-data-scope binds the proven user's own account
              `INSERT INTO iam_user_social
                 (provider, appid, openid, unionid, user_id, created_by, updated_by, tenant_id)
               SELECT ?, ?, ?, ?, id, id, id, tenant_id FROM iam_user
                WHERE id = ? AND tenant_id = ? AND enabled = 1 AND deleted_at IS NULL AND password_hash = ?`,
              [...values, proof.passwordHash],
            )
      if (res.affectedRows === 1) return
      refused = 'mobile' in proof ? Err.AUTH_SMS_CODE_INVALID : Err.AUTH_BAD_CREDENTIALS
    } catch (e) {
      const driver =
        e instanceof QueryFailedError
          ? (e.driverError as { errno?: number; sqlMessage?: string })
          : null
      if (driver?.errno !== 1062) throw e
      refused = driver.sqlMessage?.includes('uk_iam_user_social_openid')
        ? Err.AUTH_WX_MP_BOUND
        : Err.AUTH_WX_MP_USER_BOUND
    }
    throw new BizError(refused)
  }
}
