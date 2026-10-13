import { Inject, Injectable } from '@nestjs/common'
import { DEFAULT_TENANT_CODE, DEFAULT_TENANT_ID, Err } from '@qiwu/shared'
import { AppConfigService } from '../config/config.module.js'
import { clsGet, clsSet } from '../context/cls.js'
import { BizError } from '../http/biz-error.js'
import { TENANT_LOOKUP, type TenantLookup } from './tenant-lookup.js'

/** Where a sign-in checks its credentials (`resolveLoginTenant`). */
export interface LoginTenant {
  /**
   * The tenant whose users the credentials are checked against; null = not resolved: an unknown code,
   * or a disabled or expired tenant. Every entry answers that like its unknown account.
   */
  tenantId: number | null
  /**
   * The sign-in log's tenant: the resolved one, or the unavailable tenant the host or code names; null
   * for an unknown code (a row no tenant's log shows).
   */
  logTenantId: number | null
  /**
   * The failed sign-in counters' tenant code: the host's tenant's, else the typed one (an unknown one
   * too), else `default`; `default` whenever multi-tenancy is off.
   */
  code: string
  /**
   * the host is bound to none (multi-tenancy on): the sign-in page asks for a code, blank included
   * (then the default tenant's)
   */
  byCode: boolean
}

/**
 * The tenant of a sign-in before anyone is signed in (see docs/design-notes.md#tenancy): the one place
 * that writes the request context's tenant before a session exists; entry points in modules call it and
 * never write the tenant themselves.
 */
@Injectable()
export class LoginTenantResolver {
  constructor(
    @Inject(TENANT_LOOKUP) private readonly tenants: TenantLookup,
    private readonly cfg: AppConfigService,
  ) {}

  /**
   * Multi-tenancy off → the default tenant (the host and the body's code ignored). On → the tenant the
   * request's host name (`req.hostname`, after `trust proxy`) is bound to, else the body's `tenantCode`,
   * else the default tenant; a code contradicting the host's tenant → 400 `A1041`. An unknown code and
   * an unavailable tenant resolve to nothing alike (no error of their own: codes cannot be probed).
   * Writes the result (or no tenant) into the request context: it only says where the credentials are
   * checked; the identity is the user row they match. Only before a session exists: on a signed-in
   * request it throws.
   */
  async resolveLoginTenant(req: { hostname?: string }, bodyCode?: string): Promise<LoginTenant> {
    // a signed-in request's tenant is its session's: rewriting it is a coding error (500)
    if (clsGet('principal')) throw new Error('resolveLoginTenant on a signed-in request')
    if (!this.cfg.get('APP_MULTI_TENANT'))
      return this.into({
        tenantId: DEFAULT_TENANT_ID,
        logTenantId: DEFAULT_TENANT_ID,
        code: DEFAULT_TENANT_CODE,
        byCode: false,
      })
    const host = req.hostname ? await this.tenants.byHost(req.hostname) : null
    let named: number | null
    let code: string
    if (host !== null) {
      const brand = await this.tenants.brand(host)
      if (!brand) throw new Error(`a host is bound to tenant ${host}, which has no row`)
      if (bodyCode !== undefined && bodyCode !== brand.code)
        throw new BizError(Err.AUTH_TENANT_HOST_MISMATCH)
      named = host
      code = brand.code
    } else {
      code = bodyCode ?? DEFAULT_TENANT_CODE
      named = await this.tenants.byCode(code)
    }
    const tenantId = named !== null && (await this.tenants.active(named)) ? named : null
    return this.into({ tenantId, logTenantId: named, code, byCode: host === null })
  }

  private into(t: LoginTenant): LoginTenant {
    clsSet('tenantId', t.tenantId ?? undefined)
    return t
  }
}
