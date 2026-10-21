import { Processor } from '@nestjs/bullmq'
import { Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { Job } from 'bullmq'
import { QueueService } from '../../queue/queue.service.js'
import { type QueuedJob, TenantJobProcessor } from '../../queue/tenant-job.processor.js'
import { AGENT_CLEANUP_QUEUE, AGENT_TURN_QUEUE, TurnQueue } from './turn-queue.js'
import { TurnRunner } from './turn-runner.js'

/** 执行轮次的队列任务：在会话所属租户里推进一轮（每个实例同时处理多轮）。 */
@Processor(AGENT_TURN_QUEUE, { concurrency: 8 })
export class AgentTurnProcessor extends TenantJobProcessor<{ turnId: number }> {
  constructor(private readonly runner: TurnRunner) {
    super()
  }

  protected handle({ turnId }: { turnId: number }): Promise<void> {
    return this.runner.run(turnId)
  }
}

/** How often temporary threads are swept. */
const SWEEP_EVERY_MS = 3600_000
/** How often orphaned turns (no job, no lock) are picked up. */
const ORPHANS_EVERY_MS = 60_000

/**
 * 智能体的定时清理（平台队列）：每小时删掉空闲超过 24 小时的临时会话；每分钟接手孤儿轮次
 * （TurnRunner.sweepOrphans）。启动时登记两个定时任务，同名登记在多个实例之间只有一份。
 */
@Processor(AGENT_CLEANUP_QUEUE)
export class AgentCleanupProcessor
  extends TenantJobProcessor<object, number>
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(AgentCleanupProcessor.name)

  constructor(
    private readonly temps: TurnQueue,
    private readonly queues: QueueService,
    private readonly runner: TurnRunner,
  ) {
    super()
  }

  /** 启动时登记两个定时任务（同名的定时任务只存一份）。 */
  async onApplicationBootstrap(): Promise<void> {
    const data: QueuedJob<object> = { tenantId: null, payload: {} }
    const q = this.queues.queues().get(AGENT_CLEANUP_QUEUE)
    await q
      ?.upsertJobScheduler('agent-temp-threads', { every: SWEEP_EVERY_MS }, { name: 'sweep', data })
      .catch((e: unknown) => this.logger.warn(e, 'agent cleanup schedule not registered'))
    await q
      ?.upsertJobScheduler(
        'agent-orphan-turns',
        { every: ORPHANS_EVERY_MS },
        { name: 'orphans', data },
      )
      .catch((e: unknown) => this.logger.warn(e, 'agent orphan schedule not registered'))
  }

  /** 按任务名分派：`orphans` 接手孤儿轮次，其余（`sweep`）清理临时会话。 */
  protected handle(_payload: object, job: Job<QueuedJob<object>>): Promise<number> {
    return job.name === 'orphans' ? this.runner.sweepOrphans() : this.temps.sweepTemporary()
  }
}
