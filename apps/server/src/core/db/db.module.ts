import { Module, type OnModuleInit } from '@nestjs/common'
import { InjectDataSource, TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm'
import { ClsPluginTransactional } from '@nestjs-cls/transactional'
import { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { ClsModule } from 'nestjs-cls'
import type { DataSource } from 'typeorm'
import { dataSourceOptions } from '../../db/data-source.js'
import { assertTenantFilter } from './tenant-filter.js'

/**
 * TypeORM DataSource (env read at bootstrap) + `@Transactional()` / `TransactionHost` over it.
 * Needs CoreContextModule (global ClsModule). Entities register with `TypeOrmModule.forFeature`.
 * Refuses to start when the tenant condition is not in place (`assertTenantFilter`).
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...dataSourceOptions(), autoLoadEntities: true }),
    }),
    ClsModule.registerPlugins([
      new ClsPluginTransactional({
        imports: [TypeOrmModule],
        adapter: new TransactionalAdapterTypeOrm({ dataSourceToken: getDataSourceToken() }),
      }),
    ]),
  ],
})
export class CoreDbModule implements OnModuleInit {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  onModuleInit(): void {
    assertTenantFilter(this.ds)
  }
}
