import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { FsObject } from './fs-object.entity.js'
import { StorageConfig } from './config/config.entity.js'
import { StorageConfigModule } from './config/config.module.js'
import { StorageAccess } from './storage-access.js'
import { StorageController } from './storage.controller.js'
import { StorageService } from './storage.service.js'

/**
 * File storage (see docs/design-notes.md#storage): the local driver, upload/download/delete; S3, direct upload, the
 * storage configs (`config/`, generated list + hand-written driver forms) and the file list. Modules owning a private business tag register its download
 * checker with the exported `StorageAccess`; the profile avatar uses `StorageService`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FsObject, StorageConfig]), StorageConfigModule],
  controllers: [StorageController],
  providers: [StorageService, StorageAccess],
  exports: [StorageService, StorageAccess],
})
export class StorageModule {}
