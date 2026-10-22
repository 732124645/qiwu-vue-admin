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
  type AgentMemorySave,
  agentMemoryForgetAll,
  agentMemoryQuery,
  agentMemorySave,
  agentMemoryVo,
  agentPerms,
  Err,
  pageVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { clientOf } from '../../auth/auth.controller.js'
import { AuthService } from '../../auth/auth.service.js'
import { RequirePerm } from '../../auth/decorators.js'
import { HomeTenant } from '../../auth/tenant-scope.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { RateLimit } from '../../guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { Sensitive } from '../../redact.js'
import { BizError } from '../../http/biz-error.js'
import { AgentMemoryService } from './memory.service.js'

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me(): Principal {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id

/**
 * “我的记忆”接口（`agent.chat.use`）：只操作本人的记忆，别人的与别的租户的一律 404。内容保存前遮蔽密钥类
 * 内容；全部忘记要输入当前密码（与锁屏校验同一套试错计数）。
 */
// 记忆内容是个人信息：请求与返回里的 content 不进操作日志和接口日志
@Sensitive('content')
@ApiTags('agent')
// 个人设置：进入其他租户的平台人员也在本人的租户里读写（不落进那个租户）
@HomeTenant()
@Controller('agent/memories')
@RequirePerm(agentPerms.chat.use)
export class AgentMemoryController {
  constructor(
    private readonly memories: AgentMemoryService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Own memories; keyword matches the content' })
  @ApiEnvelope(pageVo(agentMemoryVo))
  page(@Query({ schema: agentMemoryQuery }) query: z.infer<typeof agentMemoryQuery>) {
    return this.memories.page(me(), query)
  }

  @Post()
  @Idempotent()
  @ActionLog({ domain: 'agent.memory', verb: 'create', bizId: createdId })
  @ApiOperation({
    summary: 'Add a memory (secrets masked); the same content twice or a full memory: 409',
  })
  @ApiEnvelope(agentMemoryVo, 201)
  create(@Body({ schema: agentMemorySave }) dto: AgentMemorySave) {
    return this.memories.create(me(), dto.content)
  }

  @Post('forget-all')
  @HttpCode(200)
  @RateLimit(10, 60_000)
  @ActionLog({ domain: 'agent.memory', verb: 'remove' })
  @ApiOperation({ summary: 'Forget every own memory (current password required)' })
  @ApiEnvelope(z.object({ removed: z.number().int() }))
  async forgetAll(
    @Body({ schema: agentMemoryForgetAll }) dto: z.infer<typeof agentMemoryForgetAll>,
    @Req() req: Request,
  ) {
    const p = me()
    // 试错计数与锁定同锁屏校验：连续输错会结束该用户的全部会话
    await this.auth.verifyPassword(p, dto.currentPassword, clientOf(req))
    return this.memories.forgetAll(p)
  }

  @Put(':id')
  @ActionLog({ domain: 'agent.memory', verb: 'modify' })
  @ApiOperation({ summary: 'Change an own memory (secrets masked)' })
  @ApiEnvelope(agentMemoryVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentMemorySave }) dto: AgentMemorySave,
  ) {
    return this.memories.update(me(), id, dto.content)
  }

  @Delete(':id')
  @ActionLog({ domain: 'agent.memory', verb: 'remove' })
  @ApiOperation({ summary: 'Delete an own memory (for good)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.memories.remove(me(), id)
  }
}
