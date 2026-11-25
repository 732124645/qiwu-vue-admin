import { OaAttachmentModule } from '../attachment/oa-attachment.module.js'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { WorkflowModule } from '../../workflow/workflow.module.js'
import { TripModule } from '../trip/trip.module.js'
import { ExpenseController } from './expense.controller.js'
import { OaExpenseItem } from './expense-item.entity.js'
import { ExpenseService } from './expense.service.js'
import { ExpenseWfHandler } from './expense-wf.handler.js'
import { OaExpenseClaim } from './expense.entity.js'

/** 报销模块使用既有流程与出差引用校验，不新增审批运行时。 */
@Module({
  imports: [
    OaAttachmentModule,
    TypeOrmModule.forFeature([OaExpenseClaim, OaExpenseItem]),
    WorkflowModule,
    TripModule,
  ],
  controllers: [ExpenseController],
  providers: [ExpenseService, ExpenseWfHandler],
  exports: [ExpenseService],
})
export class ExpenseModule {}
