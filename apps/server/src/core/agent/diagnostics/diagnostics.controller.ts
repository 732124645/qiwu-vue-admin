import { Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { agentDiagnosticsVo, agentPerms, Err } from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { PlatformOnly } from '../../auth/platform-only.js'
import { RateLimit } from '../../guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { AgentRootOnly } from '../tools/root-only.js'
import { AgentDiagnosticsService } from './diagnostics.service.js'
import { clsGet } from '../../context/cls.js'
import { BizError } from '../../http/biz-error.js'

const probeResult = z.object({
  ok: z.boolean(),
  ms: z.number().int(),
  error: z.string().optional(),
})

/** 每个测试路由每个来源地址每分钟最多 10 次：每次测试都会向外发请求、可能计费。 */
const PROBE_LIMIT = 10
const PROBE_WINDOW_MS = 60_000

/**
 * 平台页“智能体设置 · 诊断”，只有 root（多租户关着也一样，见 AgentRootGuard）：概况汇总了所有租户的
 * 轮次计数与失败；连通测试会用已保存的密钥向外发请求，另外限频、记操作日志。
 */
@ApiTags('agent')
@Controller('agent/diagnostics')
@AgentRootOnly()
export class AgentDiagnosticsController {
  constructor(private readonly diagnostics: AgentDiagnosticsService) {}

  @Get()
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly('root')
  @ApiOperation({
    summary:
      'Agent diagnostics: settings overview without keys, queue backlog, turn counts of every tenant, recent failures, sweep stats',
  })
  @ApiEnvelope(agentDiagnosticsVo)
  overview() {
    return this.diagnostics.overview()
  }

  @Post('test-provider/:id')
  @HttpCode(200)
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly('root')
  @RateLimit(PROBE_LIMIT, PROBE_WINDOW_MS)
  @ActionLog({ domain: 'agent.provider', verb: 'test' })
  @ApiOperation({
    summary: 'Test a model provider with one tiny completion (error: a reason code)',
  })
  @ApiEnvelope(probeResult)
  testProvider(@Param('id', ParseIntPipe) id: number) {
    const p = clsGet('principal')
    if (!p) throw new BizError(Err.UNAUTHENTICATED)
    return this.diagnostics.testProvider(id, p)
  }

  @Post('test-search/:id')
  @HttpCode(200)
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly('root')
  @RateLimit(PROBE_LIMIT, PROBE_WINDOW_MS)
  @ActionLog({ domain: 'agent.searchProvider', verb: 'test' })
  @ApiOperation({ summary: 'Test a web search provider with one search for one result' })
  @ApiEnvelope(probeResult)
  testSearch(@Param('id', ParseIntPipe) id: number) {
    return this.diagnostics.testSearch(id)
  }

  @Post('test-mcp/:id')
  @HttpCode(200)
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly('root')
  @RateLimit(PROBE_LIMIT, PROBE_WINDOW_MS)
  @ActionLog({ domain: 'agent.mcpServer', verb: 'test' })
  @ApiOperation({
    summary: 'Test an external MCP server: connect and list its tools, nothing saved',
  })
  @ApiEnvelope(probeResult)
  testMcp(@Param('id', ParseIntPipe) id: number) {
    return this.diagnostics.testMcp(id)
  }
}
