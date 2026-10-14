import { Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  monitorPerms,
  pageVo,
  queueJobVo,
  type QueueJobsQuery,
  queueJobsQuery,
  queueVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { PlatformOnly } from '../../../core/auth/platform-only.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { QueueMonitorService } from './queue-monitor.service.js'

/** `<queue>:<job id>`, for the action log. */
const jobBizId = (req: Request) => `${req.params.name}:${req.params.id}`

/**
 * The queue page: counts per queue, a state's jobs, retrying and removing a job. The jobs are every
 * tenant's: root only while multi-tenancy is on.
 */
@ApiTags('monitor')
@PlatformOnly('root')
@Controller('monitor/queues')
export class QueueMonitorController {
  constructor(private readonly queues: QueueMonitorService) {}

  @Get()
  @RequirePerm(monitorPerms.queue)
  @ApiOperation({ summary: 'The registered queues with their job counts and paused flag' })
  @ApiEnvelope(z.array(queueVo))
  list() {
    return this.queues.list()
  }

  @Get(':name/jobs')
  @RequirePerm(monitorPerms.queue)
  @ApiOperation({
    summary: 'Page of one state of a queue (data masked and cut); 404 unknown queue',
  })
  @ApiEnvelope(pageVo(queueJobVo))
  jobs(@Param('name') name: string, @Query({ schema: queueJobsQuery }) query: QueueJobsQuery) {
    return this.queues.jobs(name, query)
  }

  @Post(':name/jobs/:id/retry')
  @HttpCode(200)
  @RequirePerm(monitorPerms.queueRetry)
  @ActionLog({ domain: 'monitor.queue', verb: 'retry', bizId: jobBizId })
  @ApiOperation({ summary: 'Run a failed job again (409 when it has not failed)' })
  @ApiEnvelope()
  retry(@Param('name') name: string, @Param('id') id: string) {
    return this.queues.retry(name, id)
  }

  @Delete(':name/jobs/:id')
  @RequirePerm(monitorPerms.queueRemove)
  @ActionLog({ domain: 'monitor.queue', verb: 'remove', bizId: jobBizId })
  @ApiOperation({ summary: 'Remove a job (409 while it runs)' })
  @ApiEnvelope()
  remove(@Param('name') name: string, @Param('id') id: string) {
    return this.queues.remove(name, id)
  }
}
