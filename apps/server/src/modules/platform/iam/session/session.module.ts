import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { User } from '../user/user.entity.js'
import { SessionController } from './session.controller.js'
import { SessionService } from './session.service.js'

/**
 * Online sessions and kicks; sessions live in Redis (core/auth), no table. Scoped by
 * their users' `iam_user` rows.
 */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [SessionController],
  providers: [SessionService],
})
export class SessionModule {}
