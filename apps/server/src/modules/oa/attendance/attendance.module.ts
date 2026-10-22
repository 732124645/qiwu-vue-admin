import { ClockQueryController, ClockSummaryController } from './clock-query.controller.js'
import { ClockQueryService } from './clock-query.service.js'
import { ClockRetentionJob } from './clock-retention.job.js'
import { ClockController } from './clock.controller.js'
import { ClockService } from './clock.service.js'
import { ClockTime } from './clock-time.js'
import { AttendancePolicyController } from './attendance-policy.controller.js'
import { AttendancePolicyService } from './attendance-policy.service.js'
import { AttendanceSiteController } from './attendance-site.controller.js'
import { AttendanceSiteService } from './attendance-site.service.js'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AttendancePolicy } from './policy.entity.js'
import { AttendanceSite } from './site.entity.js'
import { ClockRecord } from './clock-record.entity.js'

/** 原生考勤的租户实体注册；接口、定位判定与保留期任务由业务入口接入。 */
@Module({
  imports: [TypeOrmModule.forFeature([AttendancePolicy, AttendanceSite, ClockRecord])],
  controllers: [
    ClockController,
    AttendancePolicyController,
    AttendanceSiteController,
    ClockQueryController,
    ClockSummaryController,
  ],
  providers: [
    ClockService,
    ClockTime,
    AttendancePolicyService,
    AttendanceSiteService,
    ClockQueryService,
    ClockRetentionJob,
  ],
  exports: [ClockService, ClockTime],
})
export class AttendanceModule {}
