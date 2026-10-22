import { OaAttachmentModule } from '../attachment/oa-attachment.module.js'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WorkflowModule } from '../../workflow/workflow.module.js'
import { SealController } from './seal.controller.js'
import { OaSealRequest } from './seal.entity.js'
import { SealService } from './seal.service.js'
import { SealWfHandler } from './seal-wf.handler.js'

/** 用印只登记业务处理器，不创建独立的审批运行时。 */
@Module({
  imports: [OaAttachmentModule, TypeOrmModule.forFeature([OaSealRequest]), WorkflowModule],
  controllers: [SealController],
  providers: [SealService, SealWfHandler],
  exports: [SealService],
})
export class SealModule {}
