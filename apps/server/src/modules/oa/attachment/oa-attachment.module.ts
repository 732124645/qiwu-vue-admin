import { Module } from '@nestjs/common'
import { StorageModule } from '../../platform/storage/storage.module.js'
import { WorkflowModule } from '../../workflow/workflow.module.js'
import { OaAttachmentService } from './oa-attachment.service.js'

/** 项目层登记固定单据附件；平台与工作流无需反向认识办公业务。 */
@Module({
  imports: [StorageModule, WorkflowModule],
  providers: [OaAttachmentService],
  exports: [OaAttachmentService],
})
export class OaAttachmentModule {}
