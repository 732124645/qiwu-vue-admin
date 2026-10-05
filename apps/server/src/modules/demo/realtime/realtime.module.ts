import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from '../../platform/iam/user/user.entity.js'
import { DemoRealtimeController } from './realtime.controller.js'
import { DemoRealtimeService } from './realtime.service.js'

/** Realtime push demo: no table; recipients come from `iam_user`. */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [DemoRealtimeController],
  providers: [DemoRealtimeService],
})
export class DemoRealtimeModule {}
