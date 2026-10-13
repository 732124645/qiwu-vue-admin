import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  deptTreeNodeVo,
  pageVo,
  wfCcItemVo,
  type WfCcQuery,
  wfCcQuery,
  type WfDoneQuery,
  wfDoneQuery,
  wfInstanceDetailVo,
  wfInstanceItemVo,
  type WfMineQuery,
  wfMineQuery,
  type WfStartBody,
  wfStartableVo,
  wfStartBody,
  wfStartInfoVo,
  type WfStartVo,
  wfStartVo,
  wfTaskItemVo,
  type WfTodoQuery,
  wfTodoQuery,
  type WfUserOptionQuery,
  wfUserOptionQuery,
  wfUserOptionVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../core/audit/action-log.js'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { clsGet } from '../../../core/context/cls.js'
import { withTenant } from '../../../core/context/tenant.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { WfDetailService } from './wf-detail.service.js'
import { WfListService } from './wf-lists.service.js'
import { WfStartService } from './wf-start.service.js'

const me = () => clsGet('principal')!.userId

/**
 * Approval center (access model; see docs/design-notes.md#workflow): sign-in only (no `wfPerms`), the caller's own data,
 * part of the `workflow` feature (a tenant's package may leave it out); the caller's own lists run in the
 * caller's own tenant, and so do the actions on their items (see docs/design-notes.md#tenancy).
 * An instance's detail serves the admin pages of the data tenant too: inside another tenant, one the
 * caller may not see there opens in the caller's own (the items of its lists).
 * `wf/startable-models` lists the start page's cards (not under `wf/models`: the admin `wf/models/:id` would
 * take it). `wf/models/:key/start-info` sits beside the admin model routes (`wf/models/:id…`, `wfPerms.model`).
 */
@ApiTags('wf')
@Controller('wf')
@RequireFeature('workflow')
export class WfCenterController {
  constructor(
    private readonly starts: WfStartService,
    private readonly details: WfDetailService,
    private readonly lists: WfListService,
  ) {}

  @Get('users/options')
  @ApiOperation({
    summary:
      "Whom a process dialog picks: enabled users of the whole org (not the caller's data scope), id, name and dept",
  })
  @ApiEnvelope(z.array(wfUserOptionVo))
  userOptions(@Query({ schema: wfUserOptionQuery }) query: WfUserOptionQuery) {
    return this.lists.userOptions(query)
  }

  @Get('depts/options')
  @ApiOperation({
    summary:
      "What a process form's dept field picks: enabled depts of the whole org (not the caller's data scope), as a forest",
  })
  @ApiEnvelope(z.array(deptTreeNodeVo))
  deptOptions() {
    return this.lists.deptOptions()
  }

  @Get('startable-models')
  @ApiOperation({ summary: 'The models the caller may start (the start page cards)' })
  @ApiEnvelope(z.array(wfStartableVo))
  startable() {
    return this.starts.list(me())
  }

  @Get('models/:key/start-info')
  @ApiOperation({
    summary: 'What starting a model asks of the caller: the steps whose users they pick',
  })
  @ApiEnvelope(wfStartInfoVo)
  startInfo(@Param('key') key: string) {
    return this.starts.info(key, me())
  }

  @Post('instances')
  @Idempotent()
  @ActionLog({
    domain: 'wf.instance',
    verb: 'create',
    bizId: (_req, res) => (res as WfStartVo | undefined)?.id,
  })
  @ApiOperation({
    summary:
      'Start a process: a dynamic form sends its values, a custom one the business row it starts',
  })
  @ApiEnvelope(wfStartVo, 201)
  async start(@Body({ schema: wfStartBody }) dto: WfStartBody): Promise<WfStartVo> {
    const { inst } = await this.starts.start(me(), dto)
    return { id: inst.id, state: inst.state }
  }

  // the static `instances/mine` before `instances/:id`
  @Get('instances/mine')
  @HomeTenant()
  @ApiOperation({ summary: 'The instances I started, newest first' })
  @ApiEnvelope(pageVo(wfInstanceItemVo))
  mine(@Query({ schema: wfMineQuery }) query: WfMineQuery) {
    return this.lists.mine(me(), query)
  }

  @Get('tasks/todo')
  @HomeTenant()
  @ApiOperation({ summary: 'My pending tasks, newest first' })
  @ApiEnvelope(pageVo(wfTaskItemVo))
  todo(@Query({ schema: wfTodoQuery }) query: WfTodoQuery) {
    return this.lists.todo(me(), query)
  }

  @Get('tasks/done')
  @HomeTenant()
  @ApiOperation({ summary: 'The tasks I handled, latest first' })
  @ApiEnvelope(pageVo(wfTaskItemVo))
  done(@Query({ schema: wfDoneQuery }) query: WfDoneQuery) {
    return this.lists.done(me(), query)
  }

  @Get('ccs/mine')
  @HomeTenant()
  @ApiOperation({ summary: 'Copies sent to me, newest first' })
  @ApiEnvelope(pageVo(wfCcItemVo))
  ccs(@Query({ schema: wfCcQuery }) query: WfCcQuery) {
    return this.lists.ccs(me(), query)
  }

  @Post('ccs/:id/read')
  @HomeTenant()
  @HttpCode(200)
  @SkipActionLog()
  @ApiOperation({ summary: "Mark a copy sent to me read; anyone else's 404" })
  @ApiEnvelope()
  read(@Param('id', ParseIntPipe) id: number) {
    return this.lists.read(me(), id)
  }

  @Get('instances/:id')
  @ApiOperation({
    summary:
      'An instance with its timeline: its initiator, task holders, cc recipients, wf.instance.view in scope; else 404',
  })
  @ApiEnvelope(wfInstanceDetailVo)
  async detail(@Param('id', ParseIntPipe) id: number) {
    const { actingTenantId, tenantId } = clsGet('principal')!
    if (actingTenantId !== undefined && tenantId !== undefined && !(await this.details.canView(id)))
      // qw:cross-tenant an item of the caller's own lists, which run in its own tenant
      return withTenant(tenantId, () => this.details.detail(id))
    return this.details.detail(id)
  }
}
