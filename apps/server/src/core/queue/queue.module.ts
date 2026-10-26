import { BullModule } from '@nestjs/bullmq'
import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { queuePrefix } from '../redis/cache-namespaces.js'
import { REDIS, type Redis } from '../redis/redis.module.js'
import { QUEUE_JOB_DEFAULTS } from './queue-registry.js'
import { QueueService } from './queue.service.js'

/**
 * Warns (never refuses to start) when Redis may evict keys: BullMQ keeps jobs in plain keys, so any
 * `maxmemory-policy` but `noeviction` can silently drop queued jobs under memory pressure. Returns the
 * policy read (undefined when INFO could not be read).
 */
export async function checkEvictionPolicy(
  redis: Pick<Redis, 'sendCommand'>,
  logger: Pick<Logger, 'warn'>,
): Promise<string | undefined> {
  let policy: string | undefined
  try {
    const info = String(await redis.sendCommand(['INFO', 'memory']))
    policy = /^maxmemory_policy:(\S+)/m.exec(info)?.[1]
  } catch (e) {
    logger.warn(`could not read Redis INFO memory: ${(e as Error).message}`)
    return undefined
  }
  if (policy !== 'noeviction')
    logger.warn(
      `Redis maxmemory-policy is '${policy ?? 'unknown'}', not 'noeviction': under memory pressure Redis may evict queued jobs (see docs/queue.md)`,
    )
  return policy
}

/**
 * Job queues on the app's Redis (BullMQ, see docs/queue.md). Queues use the shared node-redis client
 * (`REDIS`); each worker gets BullMQ's own duplicates of it (same server, ACL user and db) for its
 * blocking reads. Every key is under `queuePrefix()` (`qw:queue:`). Modules declare queues with
 * `registerQueue` and processors as `TenantJobProcessor` subclasses; `QueueService.add` adds jobs.
 * Workers stop (finishing the jobs they run) in the first shutdown phase, before the other services'
 * shutdown work, the Socket.IO server and the shared clients close.
 */
@Global()
@Module({
  imports: [
    DiscoveryModule,
    BullModule.forRootAsync({
      inject: [REDIS],
      useFactory: (redis: Redis) => ({
        connection: redis,
        prefix: queuePrefix(),
        defaultJobOptions: QUEUE_JOB_DEFAULTS,
      }),
    }),
  ],
  providers: [QueueService],
  exports: [QueueService],
})
export class CoreQueueModule implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Queue')

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly queues: QueueService,
  ) {}

  async onApplicationBootstrap() {
    // BullMQ reports connection trouble as 'error' events: logged, never thrown
    const log = (e: unknown) => this.logger.error(e)
    for (const q of this.queues.queues().values()) q.on('error', log)
    for (const w of this.queues.workers()) w.on('error', log)
    await checkEvictionPolicy(this.redis, this.logger)
  }

  /**
   * 先停领新任务并有界保存进度；7 秒后强制关 worker，仍未完成的调用保留持久记录供新进程核对。
   * 在共享 Redis 与数据库关闭之前完成这一阶段，不把无限等待交给发布进程。
   */
  async onModuleDestroy() {
    const workers = this.queues.workers()
    let timer: NodeJS.Timeout | undefined
    // pause(false) 停领新任务并等当前任务；超过发布期限后强制关 worker，持久租约负责接管。
    try {
      await Promise.race([
        Promise.all([this.queues.drain(), ...workers.map((w) => w.pause(false))]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 7000)
        }),
      ])
    } finally {
      clearTimeout(timer)
      await Promise.all(workers.map((w) => w.close(true)))
    }
  }
}
