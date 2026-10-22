import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  agentAutomationEventVo,
  agentAutomationPerms,
  agentAutomationRunVo,
  type AgentAutomationSave,
  agentAutomationSave,
  agentAutomationToolVo,
  agentAutomationVo,
  Err,
  pageQuery,
  pageVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { clientOf } from '../../auth/auth.controller.js'
import { RequirePerm } from '../../auth/decorators.js'
import { HomeTenant } from '../../auth/tenant-scope.js'
import type { Principal } from '../../auth/principal.js'
import { Sensitive } from '../../redact.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { AgentAutomationService } from './automation.service.js'

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me(): Principal {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id
const runsQuery = pageQuery(['startedAt'])
const enabledBody = z.object({ enabled: z.boolean() })

/**
 * 自动化（`agent.automation.use`；共享的另需 `agent.automation.share`）：本人的与本租户共享的自动化，
 * 只有创建人能改、启停、立即运行、看历史与删除。
 */
@ApiTags('agent')
// 个人的自动化：进入其他租户的平台人员也在本人的租户里读写与运行（不落进那个租户）
@HomeTenant()
@Controller('agent')
@RequirePerm(agentAutomationPerms.use)
export class AgentAutomationController {
  constructor(private readonly automations: AgentAutomationService) {}

  @Get('automations')
  @ApiOperation({ summary: "Own automations and the tenant's shared ones" })
  @ApiEnvelope(z.array(agentAutomationVo))
  list() {
    return this.automations.list(me())
  }

  @Post('automations')
  @Idempotent()
  @Sensitive('currentPassword')
  @ActionLog({ domain: 'agent.automation', verb: 'create', bizId: createdId })
  @ApiOperation({
    summary: 'New automation (pre-approving write tools needs the current password)',
  })
  @ApiEnvelope(agentAutomationVo, 201)
  create(@Body({ schema: agentAutomationSave }) dto: AgentAutomationSave, @Req() req: Request) {
    return this.automations.create(me(), dto, clientOf(req))
  }

  @Put('automations/:id')
  @Sensitive('currentPassword')
  @ActionLog({ domain: 'agent.automation', verb: 'modify' })
  @ApiOperation({
    summary: 'Change an own automation (adding pre-approved tools needs the current password)',
  })
  @ApiEnvelope(agentAutomationVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentAutomationSave }) dto: AgentAutomationSave,
    @Req() req: Request,
  ) {
    return this.automations.update(me(), id, dto, clientOf(req))
  }

  @Delete('automations/:id')
  @ActionLog({ domain: 'agent.automation', verb: 'remove' })
  @ApiOperation({ summary: 'Delete an own automation (its runs and hidden threads stay)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.automations.remove(me(), id)
  }

  @Post('automations/:id/enabled')
  @HttpCode(200)
  @ActionLog({ domain: 'agent.automation', verb: 'modify' })
  @ApiOperation({ summary: 'Switch an own automation on or off (its schedule follows)' })
  @ApiEnvelope(agentAutomationVo)
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: enabledBody }) dto: z.infer<typeof enabledBody>,
  ) {
    return this.automations.setEnabled(me(), id, dto.enabled)
  }

  @Post('automations/:id/run')
  @Idempotent()
  @ActionLog({ domain: 'agent.automation', verb: 'run' })
  @ApiOperation({ summary: 'Run an own automation now (in a hidden thread, as its owner)' })
  @ApiEnvelope(agentAutomationRunVo, 201)
  run(@Param('id', ParseIntPipe) id: number) {
    return this.automations.runNow(me(), id)
  }

  @Get('automations/:id/runs')
  @ApiOperation({ summary: "An own automation's runs, newest first" })
  @ApiEnvelope(pageVo(agentAutomationRunVo))
  runs(
    @Param('id', ParseIntPipe) id: number,
    @Query({ schema: runsQuery }) q: z.output<typeof runsQuery>,
  ) {
    return this.automations.runs(me(), id, q)
  }

  @Get('automation-events')
  @ApiOperation({ summary: 'Actions an automation may listen to (those the caller may browse)' })
  @ApiEnvelope(z.array(agentAutomationEventVo))
  events() {
    return this.automations.eventList(me())
  }

  @Get('automation-tools')
  @ApiOperation({ summary: 'Write tools the caller may pre-approve for an automation now' })
  @ApiEnvelope(z.array(agentAutomationToolVo))
  tools() {
    return this.automations.tools(me())
  }
}
