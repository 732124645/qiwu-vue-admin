import type { TenancyVo } from '@qiwu/shared'

/**
 * DI token of the `TenantLookup` port (see docs/design-notes.md#tenancy, #layering): what core/auth asks
 * about tenants; iam provides it next to `USER_LOOKUP`.
 */
export const TENANT_LOOKUP = Symbol('TENANT_LOOKUP')

/** A tenant's code and brand, as `GET /api/auth/tenancy` shows them. */
export type TenantBrand = NonNullable<TenancyVo['tenant']>

export interface TenantLookup {
  /**
   * The tenant host name `host` is bound to (`iam_tenant_domain`, exact match, case-insensitive) while
   * multi-tenancy is on; null when it is off or the host is bound to none. Cached in-process for
   * 60 seconds: a host bound or unbound reaches every instance within that.
   */
  byHost(host: string): Promise<number | null>
  /** The tenant with code `code` (lower case), whatever its state; null when none has it. */
  byCode(code: string): Promise<number | null>
  /** Code and brand of tenant `tenantId`, whatever its state; null when there is no such tenant. */
  brand(tenantId: number): Promise<TenantBrand | null>
  /**
   * Whether tenant `tenantId` is available: enabled, not expired, and multi-tenancy on unless it is the
   * default tenant. A tenant without a row is not.
   */
  active(tenantId: number): Promise<boolean>
}
