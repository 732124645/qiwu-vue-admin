import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createClient } from 'redis'
import { AppConfigService } from '../config/config.module.js'

/** Injection token of the shared node-redis client: `@Inject(REDIS) redis: Redis`. */
export const REDIS = Symbol('REDIS')

const createRedis = (cfg: AppConfigService) =>
  createClient({
    socket: { host: cfg.get('REDIS_HOST'), port: cfg.get('REDIS_PORT') },
    username: cfg.get('REDIS_USERNAME'),
    password: cfg.get('REDIS_PASSWORD'),
    database: cfg.get('REDIS_DB'),
  })
export type Redis = ReturnType<typeof createRedis>

/**
 * One node-redis client from config (ACL user, db number). Keys only via `cache-namespaces.ts`.
 * Connection errors are logged (node-redis reconnects by itself); the client closes on shutdown.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [AppConfigService],
      useFactory: async (cfg: AppConfigService) => {
        const logger = new Logger('Redis')
        const client = createRedis(cfg)
        client.on('error', (err: unknown) => logger.error(err))
        await client.connect()
        return client
      },
    },
  ],
  exports: [REDIS],
})
export class CoreRedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    if (this.redis.isOpen) await this.redis.close()
  }
}
