import { BullModule } from '@nestjs/bullmq'
import type { DynamicModule } from '@nestjs/common'
import type { DefaultJobOptions } from 'bullmq'

/**
 * Options every job gets unless `QueueService.add` overrides them: 3 attempts, 5 s then 10 s between
 * them (exponential), the last 1000 completed and 5000 failed jobs kept per queue (older ones are
 * removed as new ones finish), so the queue page has history without Redis growing without bound.
 */
export const QUEUE_JOB_DEFAULTS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
}

export interface QueueDecl {
  /** the queue name: lowercase kebab-case, unique in the app (it is part of the Redis keys) */
  name: string
  /**
   * Its jobs belong to no tenant (platform work touching only platform tables): `add` writes no tenant
   * and the processor runs them without one. Default: a tenant queue.
   */
  platform?: boolean
}

const QUEUE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const PLATFORM_QUEUES = new Set<string>()

/** Whether `name` was registered with `platform: true`. */
export const isPlatformQueue = (name: string): boolean => PLATFORM_QUEUES.has(name)

/**
 * `imports: [registerQueue({ name: 'im-fanout' })]` in the module owning the queue and its processor
 * (see docs/queue.md). The connection, key prefix and job defaults come from CoreQueueModule.
 */
export function registerQueue(...decls: QueueDecl[]): DynamicModule {
  for (const { name, platform } of decls) {
    if (!QUEUE_NAME.test(name)) throw new Error(`registerQueue: invalid queue name '${name}'`)
    if (platform) PLATFORM_QUEUES.add(name)
  }
  return BullModule.registerQueue(...decls.map(({ name }) => ({ name })))
}
