import { Controller, Get, Header, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { imDirectoryVo } from '@qiwu/shared'
import { HomeTenant, RequireFeature } from '../../../core/auth/tenant-scope.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { DirectoryService } from './directory.service.js'
import { ImStaffGuard } from './im-staff.guard.js'

/** 聊天通讯录（员工本人、本人租户；see docs/im.md）：全量返回，ETag 复验。 */
@ApiTags('im')
@Controller('im')
@HomeTenant()
@RequireFeature('im')
@UseGuards(ImStaffGuard)
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('directory')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOperation({ summary: 'Enabled depts and enabled staff of the own tenant (no contact data)' })
  @ApiEnvelope(imDirectoryVo)
  list() {
    return this.directory.directory()
  }
}
