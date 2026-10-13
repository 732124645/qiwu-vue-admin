import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'

/**
 * Tenant packages (`iam_tenant_package`, `iam_tenant_package_menus`), `/api/iam/tenant-packages`: the menus
 * a tenant may use, enforced where a session is loaded (its roles' grants meet the package; a tenant's
 * administrator holds the whole package). Platform pages only (`@PlatformOnly()`), and no route at all
 * while multi-tenancy is off. Field labels `field.iam.tenantPackage.<prop>`. A package holds menus open to
 * tenants only (a platform-only one → 422 `iam.tenant_package_platform_menu`); one a tenant uses is not
 * deleted (409 `in_use`). A tenant other than the default one without an enabled package may use nothing.
 */
export const tenantPackagePerms = {
  browse: 'iam.tenantPackage.browse',
  view: 'iam.tenantPackage.view',
  create: 'iam.tenantPackage.create',
  modify: 'iam.tenantPackage.modify',
  remove: 'iam.tenantPackage.remove',
} as const

/** ids one package may hold (menus are hundreds at most) */
const MENU_IDS_MAX = 5000

/** POST body. `menuIds`: the menus it opens, as the grant tree sends them (with their ancestors). */
export const tenantPackageCreate = z
  .object({
    name: z.string().trim().min(1).max(64),
    enabled: z.boolean().optional(),
    note: z.string().trim().max(500).nullish(),
    menuIds: z.array(z.number().int().positive()).max(MENU_IDS_MAX),
  })
  .register(fieldDomains, { domain: 'iam.tenantPackage' })
export type TenantPackageCreate = z.infer<typeof tenantPackageCreate>

/** PUT /:id body: the fields sent change, the others stay; `menuIds` replaces the package's menus. */
export const tenantPackageUpdate = tenantPackageCreate
  .partial()
  .register(fieldDomains, { domain: 'iam.tenantPackage' })
export type TenantPackageUpdate = z.infer<typeof tenantPackageUpdate>

/** GET query: paging, sort and the list filters (name contains, enabled equals). */
export const tenantPackageQuery = pageQuery(['name', 'createdAt', 'id'])
  .extend({
    name: z.string().trim().max(64).optional(),
    enabled: z.stringbool().optional(),
  })
  .register(fieldDomains, { domain: 'iam.tenantPackage' })
export type TenantPackageQuery = z.output<typeof tenantPackageQuery>

/** A list row; GET /:id adds `menuIds`. */
export const tenantPackageVo = z.object({
  id: z.number().int(),
  name: z.string(),
  enabled: z.boolean(),
  note: z.string().nullable(),
  /** the tenants using it */
  tenantCount: z.number().int(),
  createdBy: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedBy: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
})
export type TenantPackageVo = z.infer<typeof tenantPackageVo>

/** GET /:id: the row and its menus. */
export const tenantPackageDetailVo = tenantPackageVo.extend({ menuIds: z.array(z.number().int()) })
export type TenantPackageDetailVo = z.infer<typeof tenantPackageDetailVo>

/** GET /options: the enabled packages (what a tenant may be given). */
export const tenantPackageOptionVo = tenantPackageVo.pick({ id: true, name: true })
export type TenantPackageOption = z.infer<typeof tenantPackageOptionVo>
