import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type EnabledBody,
  enabledBody,
  pageVo,
  type WfDraftBody,
  wfDraftBody,
  type WfModelCreate,
  wfModelCreate,
  wfModelDetailVo,
  type WfModelQuery,
  wfModelQuery,
  type WfModelSortBody,
  wfModelSortBody,
  type WfModelUpdate,
  wfModelUpdate,
  wfModelVo,
  wfPerms,
  type WfPublishBody,
  wfPublishBody,
  wfVersionDetailVo,
  wfVersionVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import type { WfModel, WfVersion } from './wf-model.entity.js'
import { WfModelService } from './wf-model.service.js'

const perms = wfPerms.model

/** Process model admin (see docs/design-notes.md#workflow): `wfPerms.model`, seeded to root only. */
@ApiTags('wf')
@Controller('wf/models')
export class WfModelController {
  constructor(private readonly models: WfModelService) {}

  // also the approval data page's model pick: its own perm lists the models too
  @Get()
  @RequirePerm(perms.browse, wfPerms.data.browse)
  @ApiOperation({ summary: 'Page of process models (without drafts)' })
  @ApiEnvelope(pageVo(wfModelVo))
  page(@Query({ schema: wfModelQuery }) query: WfModelQuery) {
    return this.models.list(query)
  }

  @Get(':id')
  @RequirePerm(perms.view)
  @ApiOperation({
    summary: 'One process model with its draft (tree JSON or BPMN XML) and form fields',
  })
  @ApiEnvelope(wfModelDetailVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.models.detail(id)
  }

  @Get(':id/versions')
  @RequirePerm(perms.view)
  @ApiOperation({ summary: 'Published versions of a model, newest first' })
  @ApiEnvelope(z.array(wfVersionVo))
  versions(@Param('id', ParseIntPipe) id: number) {
    return this.models.versions(id)
  }

  @Get(':id/versions/:versionId')
  @RequirePerm(perms.view)
  @ApiOperation({
    summary: 'One published version with its tree, BPMN XML (a BPMN model) and fields (the export)',
  })
  @ApiEnvelope(wfVersionDetailVo)
  version(
    @Param('id', ParseIntPipe) id: number,
    @Param('versionId', ParseIntPipe) versionId: number,
  ) {
    return this.models.version(id, versionId)
  }

  @Post()
  @RequirePerm(perms.create)
  @Idempotent()
  @ActionLog({
    domain: 'wf.model',
    verb: 'create',
    bizId: (_req, row) => (row as WfModel | undefined)?.id,
  })
  @ApiOperation({
    summary:
      'Add a process model (tree or BPMN, fixed; a custom one names its start route and view)',
  })
  @ApiEnvelope(wfModelVo, 201)
  create(@Body({ schema: wfModelCreate }) dto: WfModelCreate) {
    return this.models.create(dto)
  }

  // static segment before `:id`
  @Put('sort')
  @RequirePerm(perms.modify)
  @ActionLog({ domain: 'wf.model', verb: 'modify' })
  @ApiOperation({ summary: 'New sort numbers of several models at once (all or nothing)' })
  @ApiEnvelope()
  sort(@Body({ schema: wfModelSortBody }) dto: WfModelSortBody) {
    return this.models.sort(dto)
  }

  @Put(':id')
  @RequirePerm(perms.modify)
  @ActionLog({ domain: 'wf.model', verb: 'modify' })
  @ApiOperation({ summary: 'Change a process model (not its key, form type or process type)' })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfModelUpdate }) dto: WfModelUpdate,
  ) {
    return this.models.update(id, dto)
  }

  @Put(':id/draft')
  @RequirePerm(perms.modify)
  @ActionLog({ domain: 'wf.model', verb: 'modify' })
  @ApiOperation({
    summary:
      "Save the designer draft as sent: a tree model's tree, a BPMN model's XML (at most 80 KiB, no DOCTYPE, strict parse; compiled on publish)",
  })
  @ApiEnvelope()
  saveDraft(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfDraftBody }) dto: WfDraftBody,
  ) {
    return this.models.saveDraft(id, dto)
  }

  @Put(':id/enabled')
  @RequirePerm(perms.modify)
  @ActionLog({ domain: 'wf.model', verb: 'modify' })
  @ApiOperation({ summary: 'Enable or disable a process model' })
  @ApiEnvelope()
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: enabledBody }) dto: EnabledBody,
  ) {
    return this.models.update(id, dto)
  }

  @Post(':id/versions')
  @RequirePerm(perms.publish)
  @Idempotent()
  @ActionLog({ domain: 'wf.model', verb: 'publish' })
  @ApiOperation({
    summary:
      "Publish the draft, a process JSON (tree model) or a BPMN XML (BPMN model: the tree derived from it, the XML stored normalized as the version's and the draft) as the next version, compiled first; 400 errors at `tree.…` / `xml.<element id>`",
  })
  @ApiEnvelope(wfVersionVo, 201)
  publish(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: wfPublishBody }) dto: WfPublishBody,
  ) {
    // the list's shape (no tree)
    return this.models
      .publish(id, dto)
      .then(({ id, version, formSnapshot, publishedBy, publishedAt }: WfVersion) => ({
        id,
        version,
        formSnapshot,
        publishedBy,
        publishedAt,
      }))
  }

  @Delete(':id')
  @RequirePerm(perms.remove)
  @ActionLog({ domain: 'wf.model', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a model never published (a published one: disable it)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.models.remove([id])
  }
}
