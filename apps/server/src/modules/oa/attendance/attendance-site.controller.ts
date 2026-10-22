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
  attendanceSiteCreate,
  attendanceSiteUpdate,
  attendanceSiteQuery,
  attendanceSiteVo,
  attendanceSiteSnapshot,
  attendanceSiteOptionQuery,
  attendanceSitePerms,
  pageVo,
  type AttendanceSiteCreate,
  type AttendanceSiteUpdate,
  type AttendanceSiteQuery,
  type AttendanceSiteOptionQuery,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { AttendanceSiteService } from './attendance-site.service.js'
import type { AttendanceSite } from './site.entity.js'

@ApiTags('oa')
@RequireFeature('oa')
@Controller('oa/attendance-sites')
export class AttendanceSiteController {
  constructor(private readonly sites: AttendanceSiteService) {}

  @Get('options')
  @ApiOperation({ summary: 'Page of enabled attendance sites for employees' })
  @ApiEnvelope(pageVo(attendanceSiteSnapshot))
  options(@Query({ schema: attendanceSiteOptionQuery }) query: AttendanceSiteOptionQuery) {
    return this.sites.options(query)
  }

  @Get()
  @RequirePerm(attendanceSitePerms.browse)
  @ApiOperation({ summary: 'Page of attendance sites' })
  @ApiEnvelope(pageVo(attendanceSiteVo))
  async page(@Query({ schema: attendanceSiteQuery }) query: AttendanceSiteQuery) {
    const page = await this.sites.page(query)
    return { ...page, items: page.items.map(present) }
  }

  @Get(':id')
  @RequirePerm(attendanceSitePerms.view)
  @ApiOperation({ summary: 'One attendance site' })
  @ApiEnvelope(attendanceSiteVo)
  async get(@Param('id', ParseIntPipe) id: number) {
    return present(await this.sites.get(id))
  }

  @Post()
  @RequirePerm(attendanceSitePerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'oa.attendance-site',
    verb: 'create',
    bizId: (_req, result) => (result as { id?: number })?.id,
  })
  @ApiOperation({ summary: 'Create an attendance site' })
  @ApiEnvelope(attendanceSiteVo, 201)
  async create(@Body({ schema: attendanceSiteCreate }) dto: AttendanceSiteCreate) {
    return present(await this.sites.add(dto))
  }

  @Put(':id')
  @RequirePerm(attendanceSitePerms.modify)
  @ActionLog({ domain: 'oa.attendance-site', verb: 'modify' })
  @ApiOperation({ summary: 'Update an attendance site' })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: attendanceSiteUpdate }) dto: AttendanceSiteUpdate,
  ) {
    return this.sites.change(id, dto)
  }

  @Delete(':id')
  @RequirePerm(attendanceSitePerms.remove)
  @ActionLog({ domain: 'oa.attendance-site', verb: 'remove' })
  @ApiOperation({ summary: 'Delete an unused attendance site' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.sites.remove([id])
  }
}

function present(row: AttendanceSite) {
  return attendanceSiteVo.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
