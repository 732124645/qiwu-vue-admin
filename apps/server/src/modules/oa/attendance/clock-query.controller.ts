import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  clockPerms,
  clockQuery,
  clockAdminRecordVo,
  clockMySummaryQuery,
  clockSummaryQuery,
  clockSummaryPageVo,
  pageVo,
  type ClockQuery,
  type ClockMySummaryQuery,
  type ClockSummaryQuery,
} from '@qiwu/shared'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { ClockQueryService } from './clock-query.service.js'

@ApiTags('oa')
@RequireFeature('oa')
@Controller('oa/clock-records')
export class ClockQueryController {
  constructor(private readonly clocks: ClockQueryService) {}
  @Get('admin')
  @RequirePerm(clockPerms.browse)
  @ApiOperation({ summary: 'Page of original punches within the recorded department data scope' })
  @ApiEnvelope(pageVo(clockAdminRecordVo))
  admin(@Query({ schema: clockQuery }) query: ClockQuery) {
    return this.clocks.admin(query)
  }
  @Get('admin/:id')
  @RequirePerm(clockPerms.view)
  @ApiOperation({ summary: 'One punch within the recorded department data scope' })
  @ApiEnvelope(clockAdminRecordVo)
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.clocks.adminDetail(id)
  }
  @Get('mine/:id')
  @ApiOperation({ summary: 'One original punch of the signed-in employee' })
  @ApiEnvelope(clockAdminRecordVo)
  mine(@Param('id', ParseIntPipe) id: number) {
    return this.clocks.mineDetail(id)
  }
}

@ApiTags('oa')
@RequireFeature('oa')
@Controller('oa/clock-summaries')
export class ClockSummaryController {
  constructor(private readonly clocks: ClockQueryService) {}
  @Get('mine')
  @ApiOperation({
    summary: 'My daily punches and approved absence intervals, including a zero-activity day',
  })
  @ApiEnvelope(clockSummaryPageVo)
  mine(@Query({ schema: clockMySummaryQuery }) query: ClockMySummaryQuery) {
    return this.clocks.mineSummary(query)
  }
  @Get()
  @RequirePerm(clockPerms.browse)
  @ApiOperation({
    summary: 'Daily activity subjects within data scope, not a complete employee roster',
  })
  @ApiEnvelope(clockSummaryPageVo)
  admin(@Query({ schema: clockSummaryQuery }) query: ClockSummaryQuery) {
    return this.clocks.summary(query)
  }
}
