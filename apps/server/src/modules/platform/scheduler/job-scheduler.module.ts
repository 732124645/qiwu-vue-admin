import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { ScheduleModule } from '@nestjs/schedule'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RedisLock } from '../../../core/guard/redis-lock.js'
import { registerQueue } from '../../../core/queue/queue-registry.js'
import { StorageModule } from '../storage/storage.module.js'
import { BuiltinJobs } from './builtin-jobs.js'
import { JobRegistry } from './job-registry.js'
import { JobScheduler, SCHEDULER_RUN_QUEUE } from './job-scheduler.js'
import { RunOnceProcessor } from './run-once.processor.js'
import { Run } from './run/run.entity.js'
import { Task } from './task/task.entity.js'

/**
 * The scheduler engine: the `@JobHandler` registry and the cron jobs of the enabled tasks.
 * The task module drives it (sync after writes, run once, the handler list); `RunOnceProcessor` runs the
 * "run once" requests an `APP_ROLE=api` process queues.
 */
@Module({
  // StorageModule: audit.purge also drops the files deleted past the retention (BuiltinJobs)
  imports: [
    ScheduleModule.forRoot(),
    DiscoveryModule,
    TypeOrmModule.forFeature([Task, Run]),
    StorageModule,
    // "run once" from an APP_ROLE=api process, run by a worker
    registerQueue({ name: SCHEDULER_RUN_QUEUE, platform: true }),
  ],
  providers: [JobRegistry, JobScheduler, BuiltinJobs, RedisLock, RunOnceProcessor],
  exports: [JobRegistry, JobScheduler],
})
export class JobSchedulerModule {}
