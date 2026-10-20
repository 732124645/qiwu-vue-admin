import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { userUpdate } from './user.schema.js'

/**
 * Tenants (see docs/design-notes.md#tenancy). A tenant's code is what a sign-in on the main domain names
 * it by: a DNS label (3–32 lowercase letters, digits and inner `-`, starting with a letter), so one can
 * also serve as a subdomain. Upper case input is read as lower case. A code never changes once the tenant
 * exists and a tenant is never deleted, so one code always means one tenant.
 */

/** The default tenant's code (its id is `DEFAULT_TENANT_ID`). */
export const DEFAULT_TENANT_CODE = 'default'

/**
 * Codes no new tenant takes: the default tenant's and the host names a deployment commonly serves
 * beside the tenants' subdomains.
 */
export const RESERVED_TENANT_CODES: readonly string[] = [
  DEFAULT_TENANT_CODE,
  'www',
  'api',
  'admin',
  'app',
  'apps',
  'assets',
  'auth',
  'cdn',
  'console',
  'demo',
  'docs',
  'files',
  'ftp',
  'help',
  'imap',
  'login',
  'mail',
  'mobile',
  'oauth',
  'oauth2',
  'platform',
  'pop3',
  'portal',
  'root',
  'smtp',
  'sso',
  'static',
  'status',
  'support',
  'system',
  'web',
]

/** A tenant code as typed (trimmed, lower-cased), `default` included: the sign-in bodies' field. */
export const tenantCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/)

/** The code of a new tenant: a tenant code that is not reserved. */
export const newTenantCode = tenantCode.refine((c) => !RESERVED_TENANT_CODES.includes(c), {
  message: 'validation.tenant_code_reserved',
})

/**
 * GET /api/auth/tenancy (public): whether multi-tenancy is on, and the tenant the request's host is bound
 * to (only then: no lookup of a code's name or logo, so codes cannot be probed). The sign-in pages show
 * the tenant code field when it is on and the host is bound to none.
 */
export const tenancyVo = z.object({
  enabled: z.boolean(),
  tenant: z
    .object({
      code: z.string(),
      /** i18n key (the default tenant) or plain text: render with `tx()` */
      name: z.string(),
      brandName: z.string().nullable(),
      logoUrl: z.string().nullable(),
    })
    .optional(),
})
export type TenancyVo = z.infer<typeof tenancyVo>

/**
 * `MePayload.tenant`, only while multi-tenancy is on: the session's data tenant. `acting` = a platform
 * user working inside another tenant. A client seeing another `id` than before reloads the page.
 */
export interface MeTenant {
  id: number
  code: string
  /** i18n key (the default tenant) or plain text: render with `tx()` */
  name: string
  brandName: string | null
  logoUrl: string | null
  acting: boolean
}

/**
 * Tenant management (`iam_tenant`, `iam_tenant_domain`), `/api/iam/tenants`: platform pages only
 * (`@PlatformOnly()`), and no route at all while multi-tenancy is off. Field labels `field.iam.tenant.<prop>`.
 * A tenant is never deleted: it is disabled or let expire, its data stays. The default tenant is never
 * disabled, given an end or a package, and keeps its code (422 `iam.tenant_default_fixed`).
 */
export const tenantPerms = {
  browse: 'iam.tenant.browse',
  view: 'iam.tenant.view',
  create: 'iam.tenant.create',
  modify: 'iam.tenant.modify',
  /** work inside another tenant with one's own perms (platform ones left out), audited throughout */
  enter: 'iam.tenant.enter',
  /** a new initial password of the tenant, answered once */
  'reset-password': 'iam.tenant.reset-password',
} as const

/** Host names one tenant may be bound to. */
export const TENANT_DOMAINS_MAX = 20

/** a host name: dot-separated labels of lower-case letters, digits and inner `-`, 253 characters at most */
const HOST_NAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

/**
 * A host name bound to a tenant (`iam_tenant_domain.domain`): a sign-in on it belongs to that tenant. Read in
 * lower case; no scheme, port, path or wildcard. Never the platform's own host name (422
 * `iam.tenant_domain_reserved`, checked by the server); one another tenant holds → 409 `duplicate`.
 */
export const tenantDomain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOST_NAME, { error: 'validation.tenant_domain' })

/** A tenant's host names: replaced as a whole, at most `TENANT_DOMAINS_MAX`, none twice. */
export const tenantDomains = z
  .array(tenantDomain)
  .max(TENANT_DOMAINS_MAX)
  .refine((a) => new Set(a).size === a.length, { error: 'validation.tenant_domain_duplicate' })

const tenantFields = z.object({
  name: z.string().trim().min(1).max(64),
  /** an enabled package (404 otherwise); the default tenant has none (unrestricted) */
  packageId: z.number().int().positive(),
  /** ISO time the tenant ends; null = never. A time not in the future disables it at once. */
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
  /** live users at most, its administrator counted; null = no limit */
  userQuota: z.number().int().min(1).max(1_000_000).nullish(),
  domains: tenantDomains.optional(),
  /** the system name the tenant's pages show; null = the product's */
  brandName: blankAsNull(z.string().trim().max(64)),
  /** a live public `cover` object of the default tenant (the logo); null = none */
  logoObjectId: z.number().int().positive().nullish(),
  note: z.string().trim().max(500).nullish(),
})

/** The administrator a tenant is opened with: holds `tenant_admin`, must change the initial password. */
export const tenantAdminBody = userUpdate
  .pick({ username: true, displayName: true, mobile: true, email: true })
  .required({ username: true, displayName: true })
  .register(fieldDomains, { domain: 'iam.tenant' })

/** POST body (opening a tenant): the tenant, its package, and its administrator. */
export const tenantCreate = tenantFields
  .extend({ code: newTenantCode, admin: tenantAdminBody })
  .register(fieldDomains, { domain: 'iam.tenant' })
export type TenantCreate = z.input<typeof tenantCreate>

/**
 * PUT /:id body: the fields sent change, the others stay; `domains` replaces the tenant's host names as a
 * whole. The code never changes: sending it (or any other unknown field) is a 400.
 */
export const tenantUpdate = z
  .strictObject(tenantFields.shape)
  .partial()
  .register(fieldDomains, { domain: 'iam.tenant' })
export type TenantUpdate = z.input<typeof tenantUpdate>

/**
 * GET query: paging, sort and the list filters (code and name contain, the rest equal; `appId`: the
 * tenant holding a live Official Account of that AppID).
 */
export const tenantQuery = pageQuery(['code', 'name', 'expiresAt', 'createdAt', 'id'])
  .extend({
    code: z.string().trim().max(32).optional(),
    name: z.string().trim().max(64).optional(),
    appId: z.string().trim().max(32).optional(),
    packageId: z.coerce.number().int().positive().optional(),
    enabled: z.stringbool().optional(),
  })
  .register(fieldDomains, { domain: 'iam.tenant' })
export type TenantQuery = z.output<typeof tenantQuery>

/** Every read (list, GET /:id); never the initial password. */
export const tenantVo = z.object({
  id: z.number().int(),
  code: z.string(),
  /** i18n key (the default tenant) or plain text: render with `tx()` */
  name: z.string(),
  /** null: the default tenant (unrestricted) */
  packageId: z.number().int().nullable(),
  packageName: z.string().nullable(),
  enabled: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  userQuota: z.number().int().nullable(),
  /** its live users */
  userCount: z.number().int(),
  domains: z.array(z.string()),
  brandName: z.string().nullable(),
  logoObjectId: z.number().int().nullable(),
  logoUrl: z.string().nullable(),
  /** the administrator it was opened with */
  ownerUserId: z.number().int().nullable(),
  note: z.string().nullable(),
  createdBy: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedBy: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
})
export type TenantVo = z.infer<typeof tenantVo>

/** POST /:id/initial-password answer: the tenant's new initial password, this once only. */
export const tenantInitialPasswordVo = z.object({ initialPassword: z.string() })
export type TenantInitialPasswordVo = z.infer<typeof tenantInitialPasswordVo>

/** POST / answer: the new tenant and its initial password (its administrator's first one), this once only. */
export const tenantCreatedVo = tenantVo.extend(tenantInitialPasswordVo.shape)
export type TenantCreatedVo = z.infer<typeof tenantCreatedVo>

/** GET /options: every tenant, for filters (the API log pages). */
export const tenantOptionVo = tenantVo.pick({ id: true, code: true, name: true })
export type TenantOption = z.infer<typeof tenantOptionVo>

/**
 * POST /:id/enter body: why a platform user enters the tenant (kept in the audit log). The session then
 * works in that tenant with the user's own perms, platform ones left out, until `POST /leave` or two hours.
 */
export const tenantEnterBody = z
  .object({ reason: z.string().trim().min(1).max(200) })
  .register(fieldDomains, { domain: 'iam.tenant' })
export type TenantEnterBody = z.infer<typeof tenantEnterBody>
