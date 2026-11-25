import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { FsObject } from '../storage/fs-object.entity.js'
import { StorageModule } from '../storage/storage.module.js'
import { DirectoryController } from './directory.controller.js'
import { DirectoryService } from './directory.service.js'
import { EntriesController } from './entries.controller.js'
import { EntriesService } from './entries.service.js'
import { IM_ENTITIES } from './entities/im.entity.js'
import { ImObjectsService } from './im-objects.service.js'
import { ImPurgeJob } from './im-purge.job.js'
import { ImStaffGuard } from './im-staff.guard.js'
import { ImCallMaintenanceModule } from './im-call-maintenance.module.js'
import { ImCallsController } from './im-calls.controller.js'
import { RoomsController } from './rooms.controller.js'
import { RoomsService } from './rooms.service.js'
import { StickersController } from './stickers.controller.js'
import { StickersService } from './stickers.service.js'
import { SyncController } from './sync.controller.js'
import { SyncService } from './sync.service.js'

/**
 * 员工即时通讯（see docs/im.md）：只在 `APP_IM` 打开时由 AppModule 加载；关闭时路由 404、清理任务处理器
 * 不注册。迁移与种子不受开关影响。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([...IM_ENTITIES, FsObject]),
    StorageModule,
    ImCallMaintenanceModule,
  ],
  controllers: [
    SyncController,
    DirectoryController,
    RoomsController,
    EntriesController,
    StickersController,
    ImCallsController,
  ],
  providers: [
    ImStaffGuard,
    SyncService,
    DirectoryService,
    RoomsService,
    EntriesService,
    ImObjectsService,
    StickersService,
    ImPurgeJob,
  ],
})
export class ImModule {}
