import { Global, Module } from '@nestjs/common'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { RealtimeGateway } from './realtime.gateway.js'
import { RealtimeService } from './realtime.service.js'
import { RedisIoAdapter } from './redis-io.adapter.js'

/**
 * Socket.IO pushes (see docs/design-notes.md#layering): RealtimeService for every module (and SessionRevoker, which ends
 * the sockets of revoked sessions); the gateway authenticates through TokenService (CoreAuthModule).
 */
@Global()
@Module({
  providers: [
    RealtimeService,
    RealtimeGateway,
    {
      provide: RedisIoAdapter,
      inject: [REDIS],
      useFactory: (redis: Redis) => RedisIoAdapter.connect(redis),
    },
  ],
  exports: [RealtimeService, RedisIoAdapter],
})
export class CoreRealtimeModule {}
