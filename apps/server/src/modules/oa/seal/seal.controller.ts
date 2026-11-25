import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  oaSealPerms,
  pageVo,
  sealCreate,
  sealQuery,
  sealUpdate,
  sealVo,
  type SealCreate,
  type SealQuery,
  type SealUpdate,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import type { OaSealRequest } from './seal.entity.js'
import { SealService } from './seal.service.js'

/** 用印申请的业务入口，办理动作仍统一由工作流控制器提供。 */
@ApiTags('oa')
@Controller('oa/seal-requests')
@RequireFeature('workflow')
export class SealController {
  constructor(private readonly seals: SealService) {}

  @Get()
  @RequirePerm(oaSealPerms.browse)
  @ApiOperation({ summary: 'Page of my seal requests' })
  @ApiEnvelope(pageVo(sealVo))
  page(@Query({ schema: sealQuery }) query: SealQuery) {
    return this.seals.myPage(query)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Seal request visible to its owner or workflow participant' })
  @ApiEnvelope(sealVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.seals.get(id)
  }

  @Post()
  @RequirePerm(oaSealPerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'oa.seal',
    verb: 'create',
    bizId: (_req, row) => (row as OaSealRequest | undefined)?.id,
  })
  @ApiOperation({ summary: 'Submit a seal request and start its approval in one transaction' })
  @ApiEnvelope(sealVo, 201)
  create(@Body({ schema: sealCreate }) dto: SealCreate) {
    return this.seals.submit(dto)
  }

  @Put(':id')
  @RequirePerm(oaSealPerms.modify)
  @ActionLog({ domain: 'oa.seal', verb: 'modify' })
  @ApiOperation({ summary: 'Change my draft or sent-back seal request' })
  @ApiEnvelope()
  update(@Param('id', ParseIntPipe) id: number, @Body({ schema: sealUpdate }) dto: SealUpdate) {
    return this.seals.update(id, dto)
  }
}
