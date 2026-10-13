import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import { AppConfigService } from '../../../../core/config/config.module.js'
import { assertTenancyAllowed } from '../../../../core/config/multi-tenant.js'
import { tenantDefaults } from '../../../../db/tenancy-harden.js'

/**
 * The multi-tenancy startup check (see docs/design-notes.md#tenancy): a production start with it on is
 * refused while a tenant column still has its default. With it off, tenants other than the default one that are still
 * enabled get a warning: nobody can use them now, but turning it on again brings them back at once.
 */
@Injectable()
export class TenancyStartup implements OnModuleInit {
  private readonly logger = new Logger('Tenancy')

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly cfg: AppConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const on = this.cfg.get('APP_MULTI_TENANT')
    await assertTenancyAllowed({ NODE_ENV: this.cfg.get('NODE_ENV'), APP_MULTI_TENANT: on }, () =>
      tenantDefaults(this.ds),
    )
    if (on) return
    const rows = await this.ds.query<{ code: string }[]>(
      'SELECT code FROM iam_tenant WHERE id <> 1 AND enabled = 1 AND deleted_at IS NULL ORDER BY id',
    )
    if (!rows.length) return
    const codes = rows.map((r) => r.code).join(' ')
    this.logger.warn(
      `multi-tenancy is off, yet tenants other than the default one are enabled: ${codes}. ` +
        'They become usable again as soon as it is turned on; to disable them run ' +
        `node dist/db/tenant-disable.js ${codes}`,
    )
  }
}
