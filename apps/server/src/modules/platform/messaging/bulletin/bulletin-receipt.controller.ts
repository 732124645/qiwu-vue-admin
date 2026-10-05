import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  bulletinPerms,
  type BulletinReceiptQuery,
  bulletinReceiptQuery,
  bulletinReceiptVo,
  pageVo,
} from '@qiwu/shared'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { BulletinReceiptService } from './bulletin-receipt.service.js'

/** Who read a bulletin (admin): only users in the caller's `iam_user` data scope. */
@ApiTags('messaging')
@Controller('messaging/bulletins')
export class BulletinReceiptController {
  constructor(private readonly receipts: BulletinReceiptService) {}

  @Get(':id/receipts')
  @RequirePerm(bulletinPerms.view)
  @ApiOperation({ summary: 'Readers of a bulletin (in the caller’s user data scope)' })
  @ApiEnvelope(pageVo(bulletinReceiptVo))
  list(
    @Param('id', ParseIntPipe) id: number,
    @Query({ schema: bulletinReceiptQuery }) query: BulletinReceiptQuery,
  ) {
    return this.receipts.receipts(id, query)
  }
}
