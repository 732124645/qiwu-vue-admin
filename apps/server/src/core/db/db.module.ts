import { Module } from '@nestjs/common'
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm'
import { ClsPluginTransactional } from '@nestjs-cls/transactional'
import { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { ClsModule } from 'nestjs-cls'
import { dataSourceOptions } from '../../db/data-source.js'

/**
 * TypeORM DataSource (env read at bootstrap) + `@Transactional()` / `TransactionHost` over it.
 * Needs CoreContextModule (global ClsModule). Entities register with `TypeOrmModule.forFeature`.
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
export class CoreDbModule {}
