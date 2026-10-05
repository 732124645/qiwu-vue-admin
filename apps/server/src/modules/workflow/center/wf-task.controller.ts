import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  wfBackTargetVo,
  type WfCommentBody,
  wfCommentBody,
  type WfDecideBody,
  wfDecideBody,
  type WfSendBackBody,
  wfSendBackBody,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../core/audit/action-log.js'
import { clsGet } from '../../../core/context/cls.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { WfDecideService } from './wf-decide.service.js'

const me = () => clsGet('principal')!.userId

/**
 * Task actions of the approval center (see docs/design-notes.md#workflow): sign-in only; the task must be the caller's
 * (else 404), one no longer pending is 409.
 */
@ApiTags('wf')
@Controller('wf/tasks')
export class WfTaskController {
  constructor(private readonly decide: WfDecideService) {}

  @Get(':id/back-targets')
  @ApiOperation({
    summary:
      'Steps a task may be sent back to: steps already passed, newest first, then the initiator',
  })
  @ApiEnvelope(z.array(wfBackTargetVo))
  backTargets(@Param('id', ParseIntPipe) id: number) {
    return this.decide.backTargets(id, me())
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'approve' })
  @ApiOperation({
    summary: 'Approve a task (a dynamic form may change the fields the step lets it edit)',
  })
  @ApiEnvelope()
  async approve(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfDecideBody }) dto: WfDecideBody,
  ) {
    await this.decide.approve(id, me(), dto)
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'reject' })
  @ApiOperation({
    summary: "Reject a task: the step's onReject ends the process or sends it back one step",
  })
  @ApiEnvelope()
  async reject(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfCommentBody }) dto: WfCommentBody,
  ) {
    await this.decide.reject(id, me(), dto)
  }

  @Post(':id/send-back')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'send-back' })
  @ApiOperation({ summary: 'Send a task back to a step already passed, or to the initiator' })
  @ApiEnvelope()
  async sendBack(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfSendBackBody }) dto: WfSendBackBody,
  ) {
    await this.decide.sendBack(id, me(), dto)
  }

  @Post(':id/resubmit')
  @HttpCode(200)
  @ActionLog({ domain: 'wf.task', verb: 'resubmit' })
  @ApiOperation({
    summary:
      "The initiator resubmits a process sent back to them (a custom form's row is read again)",
  })
  @ApiEnvelope()
  async resubmit(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfDecideBody }) dto: WfDecideBody,
  ) {
    await this.decide.resubmit(id, me(), dto)
  }
}
