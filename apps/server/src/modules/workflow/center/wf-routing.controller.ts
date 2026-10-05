import { Body, Controller, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type WfAddSignBody,
  wfAddSignBody,
  type WfCcBody,
  wfCcBody,
  type WfCommentBody,
  wfCommentBody,
  type WfHandOverBody,
  wfHandOverBody,
  type WfRemarkBody,
  wfRemarkBody,
  type WfRemoveSignBody,
  wfRemoveSignBody,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { clsGet } from '../../../core/context/cls.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { WfRoutingService } from './wf-routing.service.js'

const me = () => clsGet('principal')!.userId

/**
 * Routing and lifecycle actions of the approval center (see docs/design-notes.md#workflow): sign-in only. Task
 * actions need the caller's task (withdraw: the approval they made), instance actions the caller's instance
 * (its initiator); else 404. A state the action does not expect is 409.
 */
@ApiTags('wf')
@Controller('wf')
export class WfRoutingController {
  constructor(private readonly routing: WfRoutingService) {}

  @Post('tasks/:id/transfer')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'transfer' })
  @ApiOperation({ summary: 'Transfer a task to another user' })
  @ApiEnvelope()
  async transfer(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfHandOverBody }) dto: WfHandOverBody,
  ) {
    await this.routing.transfer(id, me(), dto)
  }

  @Post('tasks/:id/delegate')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'delegate' })
  @ApiOperation({
    summary: 'Delegate a task: the user handles it first, then it is back to decide',
  })
  @ApiEnvelope()
  async delegate(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfHandOverBody }) dto: WfHandOverBody,
  ) {
    await this.routing.delegate(id, me(), dto)
  }

  @Post('tasks/:id/add-sign')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'add-sign' })
  @ApiOperation({
    summary: 'Add signers before the task (it waits) or after it (it is approved now)',
  })
  @ApiEnvelope()
  async addSign(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfAddSignBody }) dto: WfAddSignBody,
  ) {
    await this.routing.addSign(id, me(), dto)
  }

  @Post('tasks/:id/remove-sign')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'remove-sign' })
  @ApiOperation({ summary: "Remove the task's add-sign tasks still pending" })
  @ApiEnvelope()
  async removeSign(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfRemoveSignBody }) dto: WfRemoveSignBody,
  ) {
    await this.routing.removeSign(id, me(), dto)
  }

  @Post('tasks/:id/cc')
  @HttpCode(200)
  @Idempotent()
  @ActionLog({ domain: 'wf.task', verb: 'cc' })
  @ApiOperation({ summary: 'Send users a copy of the process' })
  @ApiEnvelope()
  async cc(@Param('id', ParseIntPipe) id: number, @Body({ schema: wfCcBody }) dto: WfCcBody) {
    await this.routing.cc(id, me(), dto)
  }

  @Post('tasks/:id/comment')
  @HttpCode(200)
  @Idempotent()
  @ActionLog({ domain: 'wf.task', verb: 'comment' })
  @ApiOperation({ summary: 'Comment on a task (the timeline only)' })
  @ApiEnvelope()
  async comment(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfRemarkBody }) dto: WfRemarkBody,
  ) {
    await this.routing.comment(id, me(), dto)
  }

  @Post('tasks/:id/withdraw')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'withdraw' })
  @ApiOperation({
    summary: 'Withdraw an approval while the tasks it created are untouched (model allow_withdraw)',
  })
  @ApiEnvelope()
  async withdraw(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfCommentBody }) dto: WfCommentBody,
  ) {
    await this.routing.withdraw(id, me(), dto)
  }

  @Post('instances/:id/cancel')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.instance', verb: 'cancel' })
  @ApiOperation({
    summary:
      'The initiator cancels a running process (model allow_cancel, or when sent back to them)',
  })
  @ApiEnvelope()
  async cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfCommentBody }) dto: WfCommentBody,
  ) {
    await this.routing.cancel(id, me(), dto)
  }

  @Post('instances/:id/urge')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.instance', verb: 'urge' })
  @ApiOperation({
    summary: 'The initiator urges the reviewers of a running process (once an hour)',
  })
  @ApiEnvelope()
  async urge(@Param('id', ParseIntPipe) id: number) {
    await this.routing.urge(id, me())
  }
}
