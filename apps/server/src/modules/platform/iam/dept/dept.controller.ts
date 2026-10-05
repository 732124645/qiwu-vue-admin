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
  type DeptCreate,
  deptCreate,
  deptNodeVo,
  deptPerms,
  type DeptQuery,
  deptQuery,
  deptTreeNodeVo,
  type DeptUpdate,
  deptUpdate,
  deptVo,
  type EnabledBody,
  enabledBody,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { DeptService } from './dept.service.js'

/**
 * `/api/iam/depts`, the tree golden sample's routes (docs/codegen-golden.md "Tree"): the whole filtered
 * forest instead of pages, no export and no batch delete; `tree` is the picker lookup.
 */
@ApiTags('iam')
@Controller('iam/depts')
export class DeptController {
  constructor(private readonly depts: DeptService) {}

  @Get()
  @RequirePerm(deptPerms.browse)
  @ApiOperation({ summary: 'Departments matching the filters as a forest (not paged)' })
  @ApiEnvelope(z.array(deptNodeVo))
  list(@Query({ schema: deptQuery }) query: DeptQuery) {
    return this.depts.list(query)
  }

  /** Any signed-in user (dept filters and pickers), within their data scope. */
  @Get('tree')
  @ApiOperation({ summary: 'Enabled departments in the data scope of the caller, as a forest' })
  @ApiEnvelope(z.array(deptTreeNodeVo))
  tree() {
    return this.depts.tree()
  }

  @Get(':id')
  @RequirePerm(deptPerms.view)
  @ApiOperation({ summary: 'One department' })
  @ApiEnvelope(deptVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.depts.detail(id)
  }

  @Post()
  @RequirePerm(deptPerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'iam.dept',
    verb: 'create',
    bizId: (_req, row) => (row as { id?: number } | undefined)?.id,
  })
  @ApiOperation({ summary: 'Add a department under an enabled parent (0 = top level)' })
  @ApiEnvelope(deptVo, 201)
  create(@Body({ schema: deptCreate }) dto: DeptCreate) {
    return this.depts.add(dto)
  }

  @Put(':id')
  @RequirePerm(deptPerms.modify)
  @ActionLog({ domain: 'iam.dept', verb: 'modify' })
  @ApiOperation({ summary: 'Change a department (a new parent moves its whole subtree)' })
  @ApiEnvelope()
  update(@Param('id', ParseIntPipe) id: number, @Body({ schema: deptUpdate }) dto: DeptUpdate) {
    return this.depts.update(id, dto)
  }

  @Put(':id/enabled')
  @RequirePerm(deptPerms.modify)
  @ActionLog({ domain: 'iam.dept', verb: 'modify' })
  @ApiOperation({
    summary: 'Enable (with its disabled ancestors) or disable (no enabled child) a department',
  })
  @ApiEnvelope()
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: enabledBody }) dto: EnabledBody,
  ) {
    return this.depts.update(id, dto)
  }

  @Delete(':id')
  @RequirePerm(deptPerms.remove)
  @ActionLog({ domain: 'iam.dept', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a department without children or users' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.depts.remove([id])
  }
}
