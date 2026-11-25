import { OaAttachmentModule } from '../attachment/oa-attachment.module.js'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WorkflowModule } from '../../workflow/workflow.module.js'
import { TripController } from './trip.controller.js'
import { OaTripRequest } from './trip.entity.js'
import { TripService } from './trip.service.js'
import { TripWfHandler } from './trip-wf.handler.js'

/** 出差只注册业务处理器，复用同一工作流运行时。 */
@Module({
  imports: [OaAttachmentModule, TypeOrmModule.forFeature([OaTripRequest]), WorkflowModule],
  controllers: [TripController],
  providers: [TripService, TripWfHandler],
  exports: [TripService],
})
export class TripModule {}
