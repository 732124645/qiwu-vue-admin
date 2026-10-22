import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type AgentProfileSave,
  agentPerms,
  agentProfileSave,
  agentProfileVo,
  Err,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { HomeTenant } from '../../auth/tenant-scope.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { AgentProfileService } from './profile.service.js'

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me(): Principal {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id

/**
 * 配置方案接口（`agent.chat.use`）：本人的与全租户共用的方案；全租户共用的增改删要 `agent.skill.modify`，
 * 别人的个人方案一律 404。
 */
@ApiTags('agent')
// 个人设置：进入其他租户的平台人员也在本人的租户里读写（不落进那个租户）
@HomeTenant()
@Controller('agent/profiles')
@RequirePerm(agentPerms.chat.use)
export class AgentProfileController {
  constructor(private readonly profiles: AgentProfileService) {}

  @Get()
  @ApiOperation({ summary: 'Own and tenant-wide profiles (tenant-wide ones first)' })
  @ApiEnvelope(z.array(agentProfileVo))
  list() {
    return this.profiles.list(me())
  }

  @Post()
  @Idempotent()
  @ActionLog({ domain: 'agent.profile', verb: 'create', bizId: createdId })
  @ApiOperation({
    summary:
      'New profile: model, reasoning, approval mode (one the platform offers), allowed tools, instructions; tenant-wide ones need agent.skill.modify',
  })
  @ApiEnvelope(agentProfileVo, 201)
  create(@Body({ schema: agentProfileSave }) dto: AgentProfileSave) {
    return this.profiles.create(me(), dto)
  }

  @Put(':id')
  @ActionLog({ domain: 'agent.profile', verb: 'modify' })
  @ApiOperation({ summary: 'Change a profile (tenant-wide ones need agent.skill.modify)' })
  @ApiEnvelope(agentProfileVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentProfileSave }) dto: AgentProfileSave,
  ) {
    return this.profiles.update(me(), id, dto)
  }

  @Delete(':id')
  @ActionLog({ domain: 'agent.profile', verb: 'remove' })
  @ApiOperation({
    summary: 'Delete a profile; threads using it fall back to the default behaviour',
  })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.profiles.remove(me(), id)
  }
}
