import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { RedisLock } from '../../guard/redis-lock.js'
import { registerQueue } from '../../queue/queue-registry.js'
import { PROFILE_SOURCE } from '../agent-ports.js'
import { AgentMemory, AgentProfile } from '../entities/agent-memory.entity.js'
import { AgentItem, AgentThread, AgentTurn } from '../entities/agent-thread.entity.js'
import { AgentProfileController } from '../profiles/profile.controller.js'
import { AgentProfileService } from '../profiles/profile.service.js'
import { AgentProviderModule } from '../provider/agent-provider.module.js'
import { UsageBook } from '../runtime/usage-book.js'
import { AgentMemoryController } from './memory.controller.js'
import { AGENT_MEMORY_QUEUE, AgentMemoryExtractor, AgentMemoryProcessor } from './memory-extract.js'
import { AgentMemoryService } from './memory.service.js'
import { AgentMemoryAgent, AgentProfileContext } from './memory-tools.js'

/**
 * 配置方案与记忆（see docs/agent.md），由 AgentModule 引入：两组接口、运行时用的配置方案来源
 * （`PROFILE_SOURCE`）、内置工具 `memory.save` 与两个上下文贡献者（运行时启动时扫描到），以及平台队列里
 * 定时的记忆提炼。
 */
@Module({
  imports: [
    AgentProviderModule,
    TypeOrmModule.forFeature([AgentProfile, AgentMemory, AgentThread, AgentTurn, AgentItem]),
    registerQueue({ name: AGENT_MEMORY_QUEUE, platform: true }),
  ],
  controllers: [AgentProfileController, AgentMemoryController],
  providers: [
    AgentProfileService,
    { provide: PROFILE_SOURCE, useExisting: AgentProfileService },
    AgentMemoryService,
    AgentMemoryAgent,
    AgentProfileContext,
    AgentMemoryExtractor,
    AgentMemoryProcessor,
    RedisLock,
    UsageBook,
  ],
  exports: [PROFILE_SOURCE],
})
export class AgentMemoryModule {}
