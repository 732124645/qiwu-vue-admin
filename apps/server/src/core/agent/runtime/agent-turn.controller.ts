import { Body, Controller, Inject, Param, ParseIntPipe, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  type AgentApprovalDecide,
  agentApprovalDecide,
  agentCancelVo,
  type AgentMessageSend,
  agentMessageSend,
  agentPerms,
  type AgentPlanDecide,
  agentPlanDecide,
  type AgentQuestionAnswer,
  agentQuestionAnswer,
  agentTurnVo,
} from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { Sensitive } from '../../redact.js'
import { TURN_CONTROL, type TurnControl } from '../agent-ports.js'
import { AgentTurn } from '../entities/agent-thread.entity.js'
import { turnVo } from './item-store.js'

const me = (): Principal => clsGet('principal')!

/**
 * 对话页里推进轮次的接口（see docs/agent.md）：发消息、中断、压缩、确认审批、回答提问、决定方案卡。都要
 * `agent.chat.use`，只对本人的会话与条目生效（别人的、跨租户的 404）；每次都记操作日志。
 */
@ApiTags('agent')
@Controller('agent')
export class AgentTurnController {
  constructor(
    @Inject(TURN_CONTROL) private readonly control: TurnControl,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  @Post('threads/:id/messages')
  @RequirePerm(agentPerms.chat.use)
  @Idempotent()
  @ActionLog({ domain: 'agent.thread', verb: 'send' })
  // 消息正文可能带个人信息或密钥：不进操作日志和接口日志
  @Sensitive('text')
  @ApiOperation({
    summary:
      'Send a message: starts a turn, or while one runs joins it (steer) or waits for the next (queue)',
  })
  @ApiEnvelope(agentTurnVo, 201)
  async send(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentMessageSend }) dto: AgentMessageSend,
  ) {
    const { turnId } = await this.control.send(me(), id, dto)
    return turnVo(await this.ds.getRepository(AgentTurn).findOneByOrFail({ id: turnId }))
  }

  @Post('threads/:id/cancel')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({ domain: 'agent.thread', verb: 'cancel' })
  // 撤下的排队消息原文随响应返回：日志里遮蔽
  @Sensitive('text')
  @ApiOperation({
    summary:
      'Stop the running turn (its open approvals and questions expire) and withdraw the queued messages; they are returned, never started',
  })
  @ApiEnvelope(agentCancelVo, 201)
  cancel(@Param('id', ParseIntPipe) id: number) {
    return this.control.cancel(me(), id)
  }

  @Post('threads/:id/compact')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({ domain: 'agent.thread', verb: 'run' })
  @ApiOperation({ summary: 'Summarize the conversation so far (409 while a turn runs)' })
  @ApiEnvelope()
  async compact(@Param('id', ParseIntPipe) id: number) {
    await this.control.compact(me(), id)
    return null
  }

  @Post('approvals/:itemId')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({
    domain: 'agent.approval',
    verb: 'handle',
    bizId: (req) => (req.params as { itemId?: string }).itemId,
  })
  @ApiOperation({
    summary: 'Decide an approval of the own thread (409 when it is no longer pending)',
  })
  @ApiEnvelope()
  async decide(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body({ schema: agentApprovalDecide }) dto: AgentApprovalDecide,
  ) {
    await this.control.decideApproval(me(), itemId, dto, 'interactive')
    return null
  }

  @Post('questions/:itemId')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({
    domain: 'agent.question',
    verb: 'handle',
    bizId: (req) => (req.params as { itemId?: string }).itemId,
  })
  @ApiOperation({
    summary: 'Answer a question of the own thread (409 when it is no longer pending)',
  })
  @ApiEnvelope()
  async answer(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body({ schema: agentQuestionAnswer }) dto: AgentQuestionAnswer,
  ) {
    await this.control.answerQuestion(me(), itemId, dto)
    return null
  }

  @Post('plans/:itemId')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({
    domain: 'agent.plan',
    verb: 'handle',
    bizId: (req) => (req.params as { itemId?: string }).itemId,
  })
  // 意见可能带个人信息：不进操作日志和接口日志
  @Sensitive('feedback')
  @ApiOperation({
    summary:
      'Decide a plan card of the own thread: approve and run it (auto_review or ask), or keep refining (409 when no longer pending)',
  })
  @ApiEnvelope()
  async decidePlan(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Body({ schema: agentPlanDecide }) dto: AgentPlanDecide,
  ) {
    await this.control.decidePlan(me(), itemId, dto)
    return null
  }
}
