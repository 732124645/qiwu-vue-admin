import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type AgentBatchCreate,
  agentBatchCreate,
  agentBatchDecide,
  agentBatchVo,
  agentPerms,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { AgentBatchService } from './batch.service.js'

const me = (): Principal => clsGet('principal')!

/**
 * 批量执行的接口（`agent.batch.run`，see docs/agent.md）：对选中的记录逐条跑一个技能、看批次、一次确认或
 * 拒绝批次里所有等待中的审批。只作用于本人的批次，别人的与别的租户的 404。
 */
@ApiTags('agent')
@Controller('agent/batches')
@RequirePerm(agentPerms.batch.run)
export class AgentBatchController {
  constructor(private readonly batches: AgentBatchService) {}

  @Post()
  @Idempotent()
  @ActionLog({
    domain: 'agent.batch',
    verb: 'create',
    bizId: (_req, r) => (r as { id?: number } | undefined)?.id,
  })
  @ApiOperation({
    summary:
      'Run a skill on selected records: one thread and turn per record, started within the concurrency limit',
  })
  @ApiEnvelope(agentBatchVo, 201)
  create(@Body({ schema: agentBatchCreate }) dto: AgentBatchCreate) {
    return this.batches.create(me(), dto)
  }

  @Get(':id')
  @ApiOperation({
    summary: 'An own batch: each record’s thread, turn status and pending approvals',
  })
  @ApiEnvelope()
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.batches.detail(me(), id)
  }

  @Post(':id/decide')
  @HttpCode(200)
  @ActionLog({ domain: 'agent.batch', verb: 'handle' })
  @ApiOperation({
    summary:
      "Approve or reject every pending approval of an own batch that writes the row's own record; the others stay pending (skipped)",
  })
  @ApiEnvelope(z.object({ decided: z.number().int(), skipped: z.number().int() }))
  decide(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentBatchDecide }) dto: z.infer<typeof agentBatchDecide>,
  ) {
    return this.batches.decide(me(), id, dto.decision)
  }
}
