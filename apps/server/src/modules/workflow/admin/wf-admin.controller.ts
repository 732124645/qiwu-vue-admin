import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  pageVo,
  type WfAdminInstanceQuery,
  wfAdminInstanceQuery,
  wfAdminInstanceVo,
  type WfAdminTaskQuery,
  wfAdminTaskQuery,
  wfAdminTaskVo,
  wfPerms,
  type WfReassignBody,
  wfReassignBody,
  type WfTerminateBody,
  wfTerminateBody,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { clsGet } from '../../../core/context/cls.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { WfAdminService } from './wf-admin.service.js'

const me = () => clsGet('principal')!.userId

/**
 * Instance and task admin (access model; see docs/design-notes.md#workflow): `wfPerms.instance` / `wfPerms.task`, seeded to
 * root only; lists and actions stay inside the caller's data scope on the initiator's dept (else 404).
 */
@ApiTags('wf')
@Controller('wf')
export class WfAdminController {
  constructor(private readonly admin: WfAdminService) {}

  @Get('instances')
  @RequirePerm(wfPerms.instance.browse)
  @ApiOperation({ summary: "Page of process instances in the caller's data scope" })
  @ApiEnvelope(pageVo(wfAdminInstanceVo))
  instances(@Query({ schema: wfAdminInstanceQuery }) query: WfAdminInstanceQuery) {
    return this.admin.instances(query)
  }

  @Get('tasks')
  @RequirePerm(wfPerms.task.browse)
  @ApiOperation({ summary: "Page of approval tasks of the instances in the caller's data scope" })
  @ApiEnvelope(pageVo(wfAdminTaskVo))
  tasks(@Query({ schema: wfAdminTaskQuery }) query: WfAdminTaskQuery) {
    return this.admin.tasks(query)
  }

  @Post('instances/:id/terminate')
  @HttpCode(200)
  @RequirePerm(wfPerms.task.manage)
  @ActionLog({ domain: 'wf.instance', verb: 'terminate' })
  @ApiOperation({ summary: 'Terminate a running instance: its open tasks are canceled' })
  @ApiEnvelope()
  async terminate(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfTerminateBody }) dto: WfTerminateBody,
  ): Promise<void> {
    await this.admin.terminate(id, me(), dto)
  }

  @Post('tasks/:id/reassign')
  @HttpCode(200)
  @RequirePerm(wfPerms.task.manage)
  @ActionLog({ domain: 'wf.task', verb: 'reassign' })
  @ApiOperation({
    summary: 'Reassign an open approval task to another user (e.g. its holder left)',
  })
  @ApiEnvelope()
  async reassign(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfReassignBody }) dto: WfReassignBody,
  ): Promise<void> {
    await this.admin.reassign(id, me(), dto)
  }
}
