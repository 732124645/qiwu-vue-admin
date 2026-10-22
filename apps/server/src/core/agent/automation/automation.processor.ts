import { Processor } from '@nestjs/bullmq'
import type { Job } from 'bullmq'
import { type QueuedJob, TenantJobProcessor } from '../../queue/tenant-job.processor.js'
import {
  AGENT_AUTOMATION_QUEUE,
  AgentAutomationRunner,
  type HeardEvent,
} from './automation-runner.js'

type Payload = { automationId: number } | HeardEvent

/** 自动化的触发任务（租户队列）：`schedule` 是定时任务的一次触发，`event` 是一个被监听到的业务操作。 */
@Processor(AGENT_AUTOMATION_QUEUE, { concurrency: 4 })
export class AgentAutomationProcessor extends TenantJobProcessor<Payload> {
  constructor(private readonly runner: AgentAutomationRunner) {
    super()
  }

  /** 按任务名分派到定时入口或事件入口。 */
  protected handle(payload: Payload, job: Job<QueuedJob<Payload>>): Promise<void> {
    // 计划时刻（调度器给每次触发记下的时刻）作幂等键：同一次触发被处理两次也只运行一次
    if (job.name === 'schedule' && 'automationId' in payload)
      return this.runner.fire(Number(payload.automationId), job.opts.prevMillis ?? job.timestamp)
    if (job.name === 'event' && 'domain' in payload) return this.runner.onEvent(payload)
    return Promise.resolve()
  }
}
