import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TenantPackageController } from './tenant-package.controller.js'
import { TenantPackage } from './tenant-package.entity.js'
import { TenantPackageService } from './tenant-package.service.js'

/** Tenant packages: their pages' API and the menus a tenant may use (`TenantPackageService.menusOf`). */
@Module({
  imports: [TypeOrmModule.forFeature([TenantPackage])],
  controllers: [TenantPackageController],
  providers: [TenantPackageService],
  exports: [TenantPackageService],
})
export class TenantPackageModule {}
