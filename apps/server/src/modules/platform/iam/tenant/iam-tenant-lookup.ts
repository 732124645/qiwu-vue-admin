import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import type { TenantBrand, TenantLookup } from '../../../../core/auth/tenant-lookup.js'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { TenantBrandReader } from '../tenant-brand/tenant-brand.reader.js'

const HOST_TTL_MS = 60_000
// Hosts come from request headers: the cache is dropped whole at this size (an LRU if an install ever
// binds more domains than that)
const HOST_CACHE_MAX = 1000

/** core/auth's `TenantLookup` over the platform tables `iam_tenant` / `iam_tenant_domain`. */
@Injectable()
export class IamTenantLookup implements TenantLookup {
  private readonly hosts = new Map<string, { tenantId: number | null; until: number }>()

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly cfg: AppConfigService,
    private readonly brands: TenantBrandReader,
  ) {}

  async byHost(host: string): Promise<number | null> {
    if (!this.cfg.get('APP_MULTI_TENANT')) return null
    const name = host.toLowerCase()
    const now = Date.now()
    const hit = this.hosts.get(name)
    if (hit && hit.until > now) return hit.tenantId
    const [row] = await this.ds.query<{ tenant_id: number }[]>(
      'SELECT tenant_id FROM iam_tenant_domain WHERE domain = ? AND deleted_at IS NULL LIMIT 1',
      [name],
    )
    const tenantId = row ? Number(row.tenant_id) : null
    if (this.hosts.size >= HOST_CACHE_MAX) this.hosts.clear()
    this.hosts.set(name, { tenantId, until: now + HOST_TTL_MS })
    return tenantId
  }

  /** Drops the cached answers for `hosts` (bound or released): this instance at once, others within the TTL. */
  forget(hosts: readonly string[]): void {
    for (const host of hosts) this.hosts.delete(host)
  }

  async byCode(code: string): Promise<number | null> {
    const [row] = await this.ds.query<{ id: number }[]>(
      'SELECT id FROM iam_tenant WHERE code = ? AND deleted_at IS NULL',
      [code],
    )
    return row ? Number(row.id) : null
  }

  brand(tenantId: number): Promise<TenantBrand | null> {
    return this.brands.brand(tenantId)
  }

  async active(tenantId: number): Promise<boolean> {
    return (await this.activeTenant(tenantId)) !== null
  }

  /**
   * Tenant `tenantId` when it is available (`active`), with its end (epoch ms, null = none); null when
   * it is not. Reads the row every time: callers run when a user is loaded, not per request.
   */
  async activeTenant(tenantId: number): Promise<{ endsAt: number | null } | null> {
    if (tenantId !== DEFAULT_TENANT_ID && !this.cfg.get('APP_MULTI_TENANT')) return null
    const [row] = await this.ds.query<{ enabled: number; expires_at: Date | null }[]>(
      'SELECT enabled, expires_at FROM iam_tenant WHERE id = ? AND deleted_at IS NULL',
      [tenantId],
    )
    const endsAt = row?.expires_at ? row.expires_at.getTime() : null
    return row && Number(row.enabled) === 1 && (endsAt === null || endsAt > Date.now())
      ? { endsAt }
      : null
  }
}
