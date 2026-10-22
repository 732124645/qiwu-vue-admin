import { OaAgentModule } from './agent/oa-agent.module.js'
import { AttendanceModule } from './attendance/attendance.module.js'
import { OaAttachmentModule } from './attachment/oa-attachment.module.js'
import { SealModule } from './seal/seal.module.js'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { OaExpenseClaim } from './expense/expense.entity.js'
import { OaExpenseItem } from './expense/expense-item.entity.js'
import { OaSealRequest } from './seal/seal.entity.js'
import { OaTripRequest } from './trip/trip.entity.js'
import { ExpenseModule } from './expense/expense.module.js'
import { TripModule } from './trip/trip.module.js'

/** 办公业务登记在项目域，复用工作流模块而不向引擎注入业务依赖。 */
@Module({
  imports: [
    AttendanceModule,
    OaAgentModule,
    OaAttachmentModule,
    TripModule,
    ExpenseModule,
    SealModule,
    TypeOrmModule.forFeature([OaTripRequest, OaExpenseClaim, OaExpenseItem, OaSealRequest]),
  ],
})
export class OaModule {}
