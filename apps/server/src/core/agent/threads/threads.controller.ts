import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type AgentFeedbackSave,
  agentFeedbackSave,
  agentDraftReceiptVo,
  agentMessageReceiptVo,
  agentRecoveryAcknowledge,
  type AgentRecoveryAcknowledge,
  agentOptionsQuery,
  agentOptionsVo,
  agentPerms,
  type AgentPromptSave,
  agentPromptSave,
  agentPromptVo,
  agentStatusVo,
  type AgentThreadCreate,
  agentThreadCreate,
  agentThreadFork,
  type AgentThreadQuery,
  agentThreadQuery,
  agentThreadRead,
  type AgentThreadUpdate,
  agentThreadUpdate,
  agentThreadVo,
  type AgentUsageQuery,
  agentUsageQuery,
  agentUsageRowVo,
  type AgentUsageEntriesQuery,
  agentUsageEntriesQuery,
  agentUsageEntryVo,
  Err,
  pageVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../audit/action-log.js'
import { RequirePerm } from '../../auth/decorators.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { Idempotent } from '../../guard/idempotent.js'
import { ApiEnvelope } from '../../http/api-envelope.decorator.js'
import { BizError } from '../../http/biz-error.js'
import { AgentOptionsService } from './agent-options.service.js'
import { AgentThreadService } from './thread.service.js'

/** 已登录的调用者（这些路由都在 AuthGuard 之后）。 */
function me(): Principal {
  const p = clsGet('principal')
  if (!p) throw new BizError(Err.UNAUTHENTICATED)
  return p
}

const createdId = (_req: unknown, r: unknown) => (r as { id?: number } | undefined)?.id
const exportVo = z.object({ name: z.string(), text: z.string() })

/**
 * 智能助手对话页的会话接口（`agent.chat.use`）：只操作调用者本人的会话，别人的与别的租户的一律 404。
 * 发消息、停止、压缩、审批与回答在运行时的接口里。
 */
@ApiTags('agent')
@Controller('agent/threads')
@RequirePerm(agentPerms.chat.use)
export class AgentThreadController {
  constructor(private readonly threads: AgentThreadService) {}

  @Get()
  @ApiOperation({
    summary:
      'Own threads (temporary ones never; archived only with status=archived); keyword matches titles and message text',
  })
  @ApiEnvelope(pageVo(agentThreadVo))
  page(@Query({ schema: agentThreadQuery }) query: AgentThreadQuery) {
    return this.threads.page(me(), query)
  }

  @Post()
  @Idempotent()
  @ActionLog({ domain: 'agent.thread', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'New thread; provider and model default to the platform default' })
  @ApiEnvelope(agentThreadVo, 201)
  create(@Body({ schema: agentThreadCreate }) dto: AgentThreadCreate) {
    return this.threads.create(me(), dto)
  }

  @Get('client-drafts/:clientDraftId')
  @ApiOperation({
    summary: 'Read the own persistent draft receipt without creating or reviving a thread',
  })
  @ApiEnvelope(agentDraftReceiptVo)
  draftReceipt(@Param('clientDraftId', new ParseUUIDPipe()) clientDraftId: string) {
    return this.threads.draftReceipt(me(), clientDraftId)
  }

  @Get(':id/messages/:clientMessageId/receipt')
  @ApiOperation({ summary: 'Read the own accepted message receipt, including a removed message' })
  @ApiEnvelope(agentMessageReceiptVo)
  messageReceipt(
    @Param('id', ParseIntPipe) id: number,
    @Param('clientMessageId', new ParseUUIDPipe()) clientMessageId: string,
  ) {
    return this.threads.messageReceipt(me(), id, clientMessageId)
  }

  @Post(':id/recovery/acknowledge')
  @HttpCode(200)
  @ActionLog({ domain: 'agent.thread', verb: 'modify' })
  @ApiOperation({
    summary:
      'Acknowledge checked business results for the current recovery revision; never resumes old work',
  })
  @ApiEnvelope(agentThreadVo)
  acknowledgeRecovery(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentRecoveryAcknowledge }) dto: AgentRecoveryAcknowledge,
  ) {
    return this.threads.acknowledgeRecovery(me(), id, dto.revision)
  }

  @Patch(':id')
  @ActionLog({ domain: 'agent.thread', verb: 'modify' })
  @ApiOperation({
    summary:
      'Rename, archive, pin, switch model (an enabled one), reasoning (reasoning models only) or modes',
  })
  @ApiEnvelope(agentThreadVo)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentThreadUpdate }) dto: AgentThreadUpdate,
  ) {
    return this.threads.update(me(), id, dto)
  }

  @Delete(':id')
  @ActionLog({ domain: 'agent.thread', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a thread with its turns and items' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.threads.remove(me(), id)
  }

  @Get(':id/items')
  @ApiOperation({ summary: 'Items after afterSeq (all when absent) and the latest turn' })
  @ApiEnvelope()
  items(
    @Param('id', ParseIntPipe) id: number,
    @Query('afterSeq', new ParseIntPipe({ optional: true })) afterSeq?: number,
  ) {
    return this.threads.detail(me(), id, afterSeq)
  }

  @Post(':id/fork')
  @Idempotent()
  @ActionLog({ domain: 'agent.thread', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'New thread with the items up to seq copied (same seqs, new ids)' })
  @ApiEnvelope(agentThreadVo, 201)
  fork(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentThreadFork })
    { seq, clientDraftId }: { seq: number; clientDraftId?: string },
  ) {
    return this.threads.fork(me(), id, seq, clientDraftId)
  }

  @Post('read-all')
  @HttpCode(200)
  @ActionLog({ domain: 'agent.thread', verb: 'modify' })
  @ApiOperation({ summary: 'Mark every own thread read up to its latest item' })
  @ApiEnvelope()
  readAll() {
    return this.threads.readAll(me())
  }

  @Post(':id/read')
  @HttpCode(200)
  @ActionLog({ domain: 'agent.thread', verb: 'modify' })
  @ApiOperation({ summary: 'Mark the items up to seq read (never moves back)' })
  @ApiEnvelope()
  read(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentThreadRead }) { seq }: { seq: number },
  ) {
    return this.threads.read(me(), id, seq)
  }

  @Post(':id/revert')
  @HttpCode(200)
  @ActionLog({ domain: 'agent.thread', verb: 'withdraw' })
  @ApiOperation({
    summary:
      'Remove the latest turn and its items (409 while it runs); writes it already made are not undone',
  })
  @ApiEnvelope()
  revert(@Param('id', ParseIntPipe) id: number) {
    return this.threads.revert(me(), id)
  }

  @Get(':id/export')
  @ApiOperation({ summary: 'The thread as Markdown (tool arguments masked, tool output left out)' })
  @ApiEnvelope(exportVo)
  export(@Param('id', ParseIntPipe) id: number) {
    return this.threads.export(me(), id)
  }

  @Get(':id/status')
  @ApiOperation({ summary: 'Context use, the latest turn, today’s usage and limits' })
  @ApiEnvelope(agentStatusVo)
  status(@Param('id', ParseIntPipe) id: number) {
    return this.threads.status(me(), id)
  }

  @Post(':id/share')
  @ActionLog({ domain: 'agent.thread', verb: 'publish' })
  @ApiOperation({
    summary: 'Read-only share link token for the same tenant (temporary threads: 409)',
  })
  @ApiEnvelope(z.object({ token: z.string() }), 201)
  share(@Param('id', ParseIntPipe) id: number) {
    return this.threads.share(me(), id)
  }

  @Delete(':id/share')
  @ActionLog({ domain: 'agent.thread', verb: 'revoke' })
  @ApiOperation({ summary: 'Stop sharing (the old link answers 404)' })
  @ApiEnvelope()
  unshare(@Param('id', ParseIntPipe) id: number) {
    return this.threads.unshare(me(), id)
  }
}

/**
 * 对话页的其余接口（`agent.chat.use`）：选项、分享查看、反馈、提示词模板；用量（`agent.usage.browse`）。
 */
@ApiTags('agent')
@Controller('agent')
export class AgentChatController {
  constructor(
    private readonly threads: AgentThreadService,
    private readonly options: AgentOptionsService,
  ) {}

  @Get('options')
  @RequirePerm(agentPerms.chat.use)
  @ApiOperation({
    summary:
      'Models, defaults, skills, modes, web search, starters for the page (route name), prompts, trust, external servers, tone',
  })
  @ApiEnvelope(agentOptionsVo)
  getOptions(@Query({ schema: agentOptionsQuery }) query: z.infer<typeof agentOptionsQuery>) {
    return this.options.options(me(), query.route)
  }

  @Get('shared/:token')
  @RequirePerm(agentPerms.chat.use)
  @ApiOperation({
    summary:
      'A shared thread, read-only, same tenant only; for anyone but the owner tool arguments, output and approval details are hidden',
  })
  @ApiEnvelope()
  shared(@Param('token') token: string) {
    return this.threads.shared(me(), token)
  }

  @Post('feedback')
  @HttpCode(200)
  @RequirePerm(agentPerms.chat.use)
  @Idempotent()
  @ActionLog({ domain: 'agent.feedback', verb: 'comment', bizId: (req) => req.body?.itemId })
  @ApiOperation({ summary: 'Rate an answer of an own thread (one per user and answer: replaced)' })
  @ApiEnvelope()
  feedback(@Body({ schema: agentFeedbackSave }) dto: AgentFeedbackSave) {
    return this.threads.feedback(me(), dto)
  }

  @Get('prompts')
  @RequirePerm(agentPerms.chat.use)
  @ApiOperation({ summary: 'Own and tenant-wide prompt templates' })
  @ApiEnvelope(z.array(agentPromptVo))
  prompts() {
    return this.options.listPrompts(me())
  }

  @Post('prompts')
  @RequirePerm(agentPerms.chat.use)
  @Idempotent()
  @ActionLog({ domain: 'agent.prompt', verb: 'create', bizId: createdId })
  @ApiOperation({ summary: 'New prompt template (tenant-wide needs agent.skill.modify)' })
  @ApiEnvelope(agentPromptVo, 201)
  createPrompt(@Body({ schema: agentPromptSave }) dto: AgentPromptSave) {
    return this.options.createPrompt(me(), dto)
  }

  @Put('prompts/:id')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({ domain: 'agent.prompt', verb: 'modify' })
  @ApiOperation({ summary: 'Change a prompt template (tenant-wide needs agent.skill.modify)' })
  @ApiEnvelope(agentPromptVo)
  updatePrompt(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: agentPromptSave }) dto: AgentPromptSave,
  ) {
    return this.options.updatePrompt(me(), id, dto)
  }

  @Delete('prompts/:id')
  @RequirePerm(agentPerms.chat.use)
  @ActionLog({ domain: 'agent.prompt', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a prompt template (tenant-wide needs agent.skill.modify)' })
  @ApiEnvelope()
  removePrompt(@Param('id', ParseIntPipe) id: number) {
    return this.options.removePrompt(me(), id)
  }

  @Get('usage')
  @RequirePerm(agentPerms.usage.browse)
  @ApiOperation({ summary: 'Usage of the current tenant by day, user or model (UTC days)' })
  @ApiEnvelope(z.array(agentUsageRowVo))
  usage(@Query({ schema: agentUsageQuery }) query: AgentUsageQuery) {
    return this.options.usage(query)
  }

  @Get('usage/entries')
  @RequirePerm(agentPerms.usage.browse)
  @ApiOperation({
    summary: 'Paged actual model usage and immutable credit-rate snapshots in this tenant',
  })
  @ApiEnvelope(pageVo(agentUsageEntryVo))
  usageEntries(@Query({ schema: agentUsageEntriesQuery }) query: AgentUsageEntriesQuery) {
    return this.options.usageEntries(query)
  }
}
