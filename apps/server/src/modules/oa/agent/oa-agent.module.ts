import { IamModule } from '../../platform/iam/iam.module.js'
import { Module } from '@nestjs/common'
import { LeaveModule } from '../../biz/leave/leave.module.js'
import { StorageModule } from '../../platform/storage/storage.module.js'
import { WorkflowModule } from '../../workflow/workflow.module.js'
import { ExpenseModule } from '../expense/expense.module.js'
import { SealModule } from '../seal/seal.module.js'
import { TripModule } from '../trip/trip.module.js'
import { OaAgentTools } from './oa-agent.tools.js'
import { OaApplicationPreview } from './oa-application-preview.service.js'

/** 办公工具只组合既有业务服务，逐次确认凭证由统一宿主校验。 */
@Module({
  imports: [
    IamModule,
    LeaveModule,
    TripModule,
    ExpenseModule,
    SealModule,
    StorageModule,
    WorkflowModule,
  ],
  providers: [OaAgentTools, OaApplicationPreview],
})
export class OaAgentModule {}
