import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import type { TenantBrand } from '../../../../core/auth/tenant-lookup.js'
import { tenantId, withTenant } from '../../../../core/context/tenant.js'

/**
 * A tenant's code, name and brand as the sign-in pages (`GET /api/auth/tenancy`, the host's tenant) and
 * `/me.tenant` (the session's) show them (see docs/design-notes.md#tenancy). The brand lives on the tenant
 * row; its logo is a public object of the default tenant, read there whatever the request's tenant (a
 * deleted object has no URL).
 */
@Injectable()
export class TenantBrandReader {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Code and brand of tenant `id`, whatever its state; null when there is no such tenant. */
  async brand(id: number): Promise<TenantBrand | null> {
    type Row = { code: string; name: string; brand_name: string | null; logo_url: string | null }
    // qw:cross-tenant logos are uploaded by the platform: objects of the default tenant
    const [row] = await withTenant(DEFAULT_TENANT_ID, () =>
      this.ds.query<Row[]>(
        `SELECT t.code, t.name, t.brand_name, o.public_url AS logo_url
           FROM iam_tenant t
           LEFT JOIN fs_object o
             ON o.id = t.logo_object_id AND o.tenant_id = ? AND o.deleted_at IS NULL
          WHERE t.id = ? AND t.deleted_at IS NULL`,
        [tenantId(), id],
      ),
    )
    return row
      ? { code: row.code, name: row.name, brandName: row.brand_name, logoUrl: row.logo_url }
      : null
  }
}
