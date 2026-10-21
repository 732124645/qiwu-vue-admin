import { Module } from '@nestjs/common'
import { DiscoveryModule } from '@nestjs/core'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RedisLock } from '../guard/redis-lock.js'
import { McpToolSwitch } from '../mcp/mcp.entity.js'
import { ToolHostModule } from '../mcp/tool-host.js'
import { registerQueue } from '../queue/queue-registry.js'
import {
  EXTERNAL_TOOL_SOURCE,
  INSTRUCTION_SOURCE,
  SKILL_SOURCE,
  TURN_CONTROL,
} from './agent-ports.js'
import { AgentBatchController } from './batch/batch.controller.js'
import { AgentBatchService } from './batch/batch.service.js'
import { AgentBatchTargets } from './batch/batch-targets.js'
import { AgentMcpServer, AgentMcpTool } from './entities/agent-mcp.entity.js'
import {
  AgentInstruction,
  AgentPlatformSkill,
  AgentPrompt,
  AgentSkill,
} from './entities/agent-skill.entity.js'
import {
  AgentBatch,
  AgentFeedback,
  AgentItem,
  AgentThread,
  AgentTurn,
} from './entities/agent-thread.entity.js'
import { AgentUsage } from './entities/agent-usage.entity.js'
import { AgentOptionsService } from './threads/agent-options.service.js'
import { AgentThreadService } from './threads/thread.service.js'
import { AgentChatController, AgentThreadController } from './threads/threads.controller.js'
import { AgentExternalTools } from './mcp-client/external-tools.js'
import { McpConnector } from './mcp-client/mcp-connector.js'
import { AgentMcpServerController } from './mcp-client/mcp-server.controller.js'
import { AgentMcpServerService } from './mcp-client/mcp-server.service.js'
import { AgentProviderModule } from './provider/agent-provider.module.js'
import { ProviderSearchConfig } from './provider/provider-registry.js'
import { AgentTurnController } from './runtime/agent-turn.controller.js'
import { ItemStore } from './runtime/item-store.js'
import { TurnControlService } from './runtime/turn-control.service.js'
import { AGENT_CLEANUP_QUEUE, AGENT_TURN_QUEUE, TurnQueue } from './runtime/turn-queue.js'
import { TurnRunner } from './runtime/turn-runner.js'
import { AgentCleanupProcessor, AgentTurnProcessor } from './runtime/turn.processor.js'
import { UsageBook } from './runtime/usage-book.js'
import { AgentInstructionService } from './skills/instruction.service.js'
import {
  AgentInstructionController,
  AgentPlatformSkillController,
  AgentSkillController,
} from './skills/skill.controller.js'
import { AgentPlatformSkillService, AgentSkillService } from './skills/skill.service.js'
import { AgentToolPolicies, AgentToolPolicyController } from './tools/tool-policy.js'
import { AgentWebModule } from './web/agent-web.module.js'

/**
 * 后台智能体（see docs/agent.md），只在 `APP_AGENT` 打开时加载：关闭时 `/api/agent/*` 不存在（404），
 * 菜单隐藏。工具层复用 MCP 的注册表与执行护栏（ToolHostModule，进程内调用 `ToolHost.call`），但不依赖
 * McpModule：`APP_MCP` 关着时 `/api/mcp` 仍不存在。
 */
@Module({
  imports: [
    DiscoveryModule,
    ToolHostModule,
    AgentProviderModule,
    AgentWebModule.register({ imports: [AgentProviderModule], searchConfig: ProviderSearchConfig }),
    TypeOrmModule.forFeature([
      AgentThread,
      AgentTurn,
      AgentItem,
      AgentBatch,
      AgentFeedback,
      AgentSkill,
      AgentPlatformSkill,
      AgentInstruction,
      AgentPrompt,
      AgentUsage,
      AgentMcpServer,
      AgentMcpTool,
      McpToolSwitch,
    ]),
    // 轮次在租户队列里执行；临时会话的定时清理在平台队列里
    registerQueue({ name: AGENT_TURN_QUEUE }, { name: AGENT_CLEANUP_QUEUE, platform: true }),
  ],
  controllers: [
    AgentThreadController,
    AgentChatController,
    AgentMcpServerController,
    AgentToolPolicyController,
    AgentSkillController,
    AgentPlatformSkillController,
    AgentInstructionController,
    AgentTurnController,
    AgentBatchController,
  ],
  providers: [
    AgentThreadService,
    AgentOptionsService,
    McpConnector,
    AgentMcpServerService,
    AgentExternalTools,
    { provide: EXTERNAL_TOOL_SOURCE, useExisting: AgentExternalTools },
    AgentToolPolicies,
    AgentSkillService,
    AgentPlatformSkillService,
    { provide: SKILL_SOURCE, useExisting: AgentSkillService },
    AgentInstructionService,
    { provide: INSTRUCTION_SOURCE, useExisting: AgentInstructionService },
    RedisLock,
    ItemStore,
    UsageBook,
    TurnQueue,
    TurnRunner,
    TurnControlService,
    { provide: TURN_CONTROL, useExisting: TurnControlService },
    AgentTurnProcessor,
    AgentCleanupProcessor,
    AgentBatchTargets,
    AgentBatchService,
  ],
  exports: [
    ToolHostModule,
    AgentProviderModule,
    AgentWebModule,
    EXTERNAL_TOOL_SOURCE,
    SKILL_SOURCE,
    INSTRUCTION_SOURCE,
    AgentToolPolicies,
    ItemStore,
    UsageBook,
    TurnQueue,
    TURN_CONTROL,
  ],
})
export class AgentModule {}
