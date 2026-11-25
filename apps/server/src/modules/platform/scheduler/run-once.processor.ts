import { Processor } from '@nestjs/bullmq'
import { TenantJobProcessor } from '../../../core/queue/tenant-job.processor.js'
import { JobScheduler, type QueuedRunOnce, SCHEDULER_RUN_QUEUE } from './job-scheduler.js'

/**
 * `APP_ROLE=api` 进程转来的"执行一次"（平台队列）：在本进程后台触发，立即完成队列任务；执行与记录同本地
 * 触发一样（同一触发时刻只执行一次，关闭时等待执行中的任务）。
 */
@Processor(SCHEDULER_RUN_QUEUE)
export class RunOnceProcessor extends TenantJobProcessor<QueuedRunOnce> {
  constructor(private readonly scheduler: JobScheduler) {
    super()
  }

  /** 交给调度器在后台执行，不在队列任务里等它结束（任务可能运行很久）。 */
  protected handle(payload: QueuedRunOnce): Promise<void> {
    this.scheduler.runQueued(payload)
    return Promise.resolve()
  }
}
