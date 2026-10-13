import { Logger } from '@nestjs/common'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import { ClsServiceManager } from 'nestjs-cls'
import { multiTenant } from '../config/multi-tenant.js'
import type { AppClsStore } from './cls.js'

/** The default tenant: the platform operator, owner of every row while multi-tenancy is off. */
export { DEFAULT_TENANT_ID }

/**
 * Tenant-scoped data was read or written with no tenant in the context: an entry point or a background
 * callback chose neither `withTenant` nor `allTenants` (a coding error, answered 500).
 */
export class TenantContextMissing extends Error {
  override name = 'TenantContextMissing'
}

const logger = new Logger('Tenancy')
const cls = () => ClsServiceManager.getClsService<AppClsStore>()

/**
 * The data tenant of the current context (see docs/design-notes.md#tenancy). Throws
 * `TenantContextMissing` when the context has none, and inside `allTenants` (no single tenant there, a
 * nested `withTenant` names one). The one fallback: in production with multi-tenancy off a context
 * without any tenant gets the default tenant, with an error log naming the caller, since every row
 * belongs to it then; with it on, and in development and tests, it throws, so a missing context fails.
 */
export function tenantId(): number {
  const c = cls()
  const active = c.isActive()
  if (active && c.get('allTenants'))
    throw new TenantContextMissing('allTenants has no single tenant: name one with withTenant')
  const tid = active ? c.get('tenantId') : undefined
  if (tid !== undefined) return tid
  // the process env holds the validated config (CoreConfigModule writes it back)
  if (process.env.NODE_ENV !== 'production' || multiTenant())
    throw new TenantContextMissing('no tenant in context')
  logger.error('no tenant in context: the default tenant is used', new Error().stack)
  return DEFAULT_TENANT_ID
}

/**
 * `tenantId()` for writers that may run without a tenant on purpose (an action log row of a public
 * route whose sign-in tenant did not resolve): undefined where `tenantId()` throws `TenantContextMissing`.
 */
export function tenantIdIfAny(): number | undefined {
  try {
    return tenantId()
  } catch (e) {
    if (e instanceof TenantContextMissing) return undefined
    throw e
  }
}

/**
 * Runs `fn` in tenant `tid`: a nested context (the caller's other keys and transaction stay) that ends
 * with `fn`, out of any `allTenants`. Outside `core/context` every call carries a
 * `qw:cross-tenant <reason>` marker: it decides which tenant's rows the code sees.
 */
export function withTenant<T>(tid: number, fn: () => T): T {
  if (!Number.isSafeInteger(tid) || tid < 1) throw new TypeError(`not a tenant id: ${tid}`)
  const c = cls()
  return c.run(() => {
    c.set('tenantId', tid)
    c.set('allTenants', undefined)
    return fn()
  })
}

/**
 * Runs `fn` across every tenant (no tenant condition) in a nested context ending with `fn`; a nested
 * `withTenant` goes back to one tenant. Marked like `withTenant` outside `core/context`.
 */
export function allTenants<T>(fn: () => T): T {
  const c = cls()
  return c.run(() => {
    c.set('allTenants', true)
    return fn()
  })
}

/**
 * Entry points write all three tenant keys of their context, whatever it inherited (an HTTP connection
 * keeps the context `listen()` ran in, a nested run copies the outer store): none of them set. The
 * entry then names its tenant, if any, through `withTenant`.
 */
export function clearTenantContext(): void {
  const c = cls()
  c.set('tenantId', undefined)
  c.set('allTenants', undefined)
  c.set('actorTenantId', undefined)
}

/** Runs `fn` in a nested context with the tenant keys cleared: entries inside another context. */
export function tenantEntry<T>(fn: () => T): T {
  return cls().run(() => {
    clearTenantContext()
    return fn()
  })
}
