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
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  agentExternalToolUpdate,
  agentExternalToolVo,
  type AgentMcpServerSave,
  agentMcpServerSave,
  agentMcpServerVo,
  agentPerms,
  Err,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { PlatformOnly } from '../../auth/platform-only.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { Sensitive } from '../../redact.js'
import { AgentMcpServerService } from './mcp-server.service.js'
import { AgentRootOnly } from '../tools/root-only.js'

const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me() {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

/**
 * 平台页“智能体设置 · 外部 MCP”：外部服务器对所有租户生效，所以是平台页，改动只有 root。鉴权信息只写
 * 不读：请求里的 `auth` 整个在日志里遮蔽（`@Sensitive`），响应只有 `hasAuth`。
 */
@ApiTags('agent')
@Controller('agent/mcp-servers')
@AgentRootOnly()
@Sensitive('auth')
export class AgentMcpServerController {
  constructor(private readonly servers: AgentMcpServerService) {}

  @Get()
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly()
  @ApiOperation({ summary: 'External MCP servers and their tools (credentials never returned)' })
  @ApiEnvelope(z.array(agentMcpServerVo))
  list() {
    return this.servers.list()
  }

  @Post()
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @Idempotent()
  @ActionLog({ domain: 'agent.mcpServer', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'Add an external MCP server; allowPrivate only by root' })
  @ApiEnvelope(agentMcpServerVo, 201)
  create(@Body({ schema: agentMcpServerSave }) dto: AgentMcpServerSave) {
    return this.servers.save(me(), null, dto)
  }

  @Put(':id')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.mcpServer', verb: 'modify' })
  @ApiOperation({
    summary:
      'Change an external MCP server; absent auth keeps the stored one unless the url or auth kind changed',
  })
  @ApiEnvelope(agentMcpServerVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentMcpServerSave }) dto: AgentMcpServerSave,
  ) {
    return this.servers.save(me(), id, dto)
  }

  @Delete(':id')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.mcpServer', verb: 'remove' })
  @ApiOperation({ summary: 'Delete an external MCP server with its credentials and tools' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.servers.removeOne(id)
  }

  @Post(':id/sync')
  @HttpCode(200)
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.mcpServer', verb: 'sync' })
  @ApiOperation({
    summary:
      'Connect and list the tools: new ones disabled with policy ask, vanished ones disabled',
  })
  @ApiEnvelope(agentMcpServerVo)
  sync(@Param('id', ParseIntPipe) id: number) {
    return this.servers.sync(id)
  }

  @Put(':id/tools/:toolId')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.mcpServer', verb: 'modify' })
  @ApiOperation({ summary: 'Switch an external tool on or off and set its approval policy' })
  @ApiEnvelope(agentExternalToolVo)
  updateTool(
    @Param('id', ParseIntPipe) id: number,
    @Param('toolId', ParseIntPipe) toolId: number,
    @Body({ schema: agentExternalToolUpdate }) dto: z.infer<typeof agentExternalToolUpdate>,
  ) {
    return this.servers.updateTool(id, toolId, dto)
  }
}
