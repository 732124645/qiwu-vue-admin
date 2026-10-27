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
  agentPerms,
  type AgentProviderModelsQuery,
  agentProviderModelsQuery,
  agentProviderModelsVo,
  type AgentProviderSave,
  agentProviderSave,
  agentProviderVo,
  type AgentSearchProviderSave,
  agentSearchProviderSave,
  agentSearchProviderVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import { PlatformOnly } from '../../auth/platform-only.js'
import { Idempotent } from '../../guard/idempotent.js'
import { RateLimit } from '../../guard/rate-limit.decorator.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import {
  ProviderSettingsService,
  SearchProviderSettingsService,
} from './provider-settings.service.js'
import { AgentRootOnly } from '../tools/root-only.js'

const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id

/**
 * 平台页“智能体设置 · 模型”：提供方对所有租户生效，所以是平台页。密钥只写不读：请求里的 `apiKey`
 * 按密钥名在操作日志里遮蔽，响应只有 `hasKey`。
 */
@ApiTags('agent')
@Controller('agent/providers')
@AgentRootOnly()
export class AgentProviderController {
  constructor(private readonly settings: ProviderSettingsService) {}

  @Get()
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly()
  @ApiOperation({ summary: 'Model providers (keys never returned, only hasKey)' })
  @ApiEnvelope(z.array(agentProviderVo))
  list() {
    return this.settings.list()
  }

  @Post()
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @Idempotent()
  @ActionLog({ domain: 'agent.provider', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'Add a model provider; isDefault clears the other default' })
  @ApiEnvelope(agentProviderVo, 201)
  create(@Body({ schema: agentProviderSave }) dto: AgentProviderSave) {
    return this.settings.save(null, dto)
  }

  /** 表单里“从服务加载模型”：用已保存的密钥发出站请求，所以与改动一样只有 root 能调用。 */
  @Post('models')
  @HttpCode(200)
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @RateLimit(20, 60_000)
  // 只读查询上游的模型清单，不改任何数据，不记操作日志
  @SkipActionLog()
  @ApiOperation({
    summary:
      "List the upstream's models (GET {baseUrl}/models); without apiKey the stored key of id is used only for its stored baseUrl",
  })
  @ApiEnvelope(agentProviderModelsVo)
  models(@Body({ schema: agentProviderModelsQuery }) dto: AgentProviderModelsQuery) {
    return this.settings.upstreamModels(dto)
  }

  @Put(':id')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.provider', verb: 'modify' })
  @ApiOperation({
    summary: 'Change a model provider; an absent or empty apiKey keeps the stored one',
  })
  @ApiEnvelope(agentProviderVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentProviderSave }) dto: AgentProviderSave,
  ) {
    return this.settings.save(id, dto)
  }

  @Delete(':id')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.provider', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a model provider (its key with it)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.settings.removeOne(id)
  }
}

/** 平台页“智能体设置 · 搜索”：联网搜索服务商，密钥同上只写不读。 */
@ApiTags('agent')
@Controller('agent/search-providers')
@AgentRootOnly()
export class AgentSearchProviderController {
  constructor(private readonly settings: SearchProviderSettingsService) {}

  @Get()
  @RequirePerm(agentPerms.setting.browse)
  @PlatformOnly()
  @ApiOperation({ summary: 'Web search providers (keys never returned, only hasKey)' })
  @ApiEnvelope(z.array(agentSearchProviderVo))
  list() {
    return this.settings.list()
  }

  @Post()
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @Idempotent()
  @ActionLog({ domain: 'agent.searchProvider', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'Add a web search provider; isDefault clears the other default' })
  @ApiEnvelope(agentSearchProviderVo, 201)
  create(@Body({ schema: agentSearchProviderSave }) dto: AgentSearchProviderSave) {
    return this.settings.save(null, dto)
  }

  @Put(':id')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.searchProvider', verb: 'modify' })
  @ApiOperation({
    summary: 'Change a web search provider; an absent or empty apiKey keeps the stored one',
  })
  @ApiEnvelope(agentSearchProviderVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentSearchProviderSave }) dto: AgentSearchProviderSave,
  ) {
    return this.settings.save(id, dto)
  }

  @Delete(':id')
  @RequirePerm(agentPerms.setting.modify)
  @PlatformOnly('root')
  @ActionLog({ domain: 'agent.searchProvider', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a web search provider (its key with it)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.settings.removeOne(id)
  }
}
