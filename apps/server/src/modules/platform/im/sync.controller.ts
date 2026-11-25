import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { imOptionsVo, imRoomDetailVo, type ImSyncQuery, imSyncQuery, imSyncVo } from '@qiwu/shared'
import { z } from 'zod'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { clsGet } from '../../../core/context/cls.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { ImStaffGuard } from './im-staff.guard.js'
import { SyncService } from './sync.service.js'

const me = () => clsGet('principal')!.userId

/**
 * 限额探测与同步（员工本人、本人租户；see docs/im.md）。ETag 由 Express 默认生成，`If-None-Match` 命中 304。
 */
@ApiTags('im')
@Controller('im')
@HomeTenant()
@RequireFeature('im')
@UseGuards(ImStaffGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('options')
  @ApiOperation({ summary: 'Chat limits and sync epoch; also the probe whether chat is available' })
  @ApiEnvelope(imOptionsVo)
  options() {
    return this.sync.options()
  }

  @Get('sync')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({
    summary:
      'Without ids: compact tuples of every current conversation; with ids (≤100): details of those that are still current',
  })
  @ApiEnvelope(z.union([imSyncVo, z.array(imRoomDetailVo)]))
  run(@Query({ schema: imSyncQuery }) { ids }: ImSyncQuery) {
    return ids ? this.sync.details(ids, me()) : this.sync.full(me())
  }
}
