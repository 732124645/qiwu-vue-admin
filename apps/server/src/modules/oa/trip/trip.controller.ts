import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  oaTripPerms,
  pageVo,
  tripCreate,
  tripQuery,
  tripUpdate,
  tripVo,
  type TripCreate,
  type TripQuery,
  type TripUpdate,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import type { OaTripRequest } from './trip.entity.js'
import { TripService } from './trip.service.js'

/** 出差申请的业务入口，办理动作仍统一由工作流控制器提供。 */
@ApiTags('oa')
@Controller('oa/trips')
@RequireFeature('workflow')
export class TripController {
  constructor(private readonly trips: TripService) {}

  @Get()
  @RequirePerm(oaTripPerms.browse)
  @ApiOperation({ summary: 'Page of my trip requests' })
  @ApiEnvelope(pageVo(tripVo))
  page(@Query({ schema: tripQuery }) query: TripQuery) {
    return this.trips.myPage(query)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Trip request visible to its owner or workflow participant' })
  @ApiEnvelope(tripVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.trips.get(id)
  }

  @Post()
  @RequirePerm(oaTripPerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'oa.trip',
    verb: 'create',
    bizId: (_req, row) => (row as OaTripRequest | undefined)?.id,
  })
  @ApiOperation({ summary: 'Submit a trip request and start its approval in one transaction' })
  @ApiEnvelope(tripVo, 201)
  create(@Body({ schema: tripCreate }) dto: TripCreate) {
    return this.trips.submit(dto)
  }

  @Put(':id')
  @RequirePerm(oaTripPerms.modify)
  @ActionLog({ domain: 'oa.trip', verb: 'modify' })
  @ApiOperation({ summary: 'Change my draft or sent-back trip request' })
  @ApiEnvelope()
  update(@Param('id', ParseIntPipe) id: number, @Body({ schema: tripUpdate }) dto: TripUpdate) {
    return this.trips.update(id, dto)
  }
}
