import { Body, Controller, Get, Put } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  attendancePolicyVo,
  attendancePolicyUpdate,
  attendancePolicyPerms,
  type AttendancePolicyUpdate,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { AttendancePolicyService } from './attendance-policy.service.js'
import type { AttendancePolicy } from './policy.entity.js'

@ApiTags('oa')
@RequireFeature('oa')
@Controller('oa/attendance-policies')
export class AttendancePolicyController {
  constructor(private readonly policies: AttendancePolicyService) {}

  @Get('current')
  @RequirePerm(attendancePolicyPerms.view)
  @ApiOperation({ summary: 'The current tenant attendance policy' })
  @ApiEnvelope(attendancePolicyVo)
  async current() {
    return present(await this.policies.current())
  }

  @Put('current')
  @RequirePerm(attendancePolicyPerms.modify)
  @ActionLog({ domain: 'oa.attendance-policy', verb: 'modify' })
  @ApiOperation({ summary: 'Update the current tenant attendance policy' })
  @ApiEnvelope(attendancePolicyVo)
  async update(@Body({ schema: attendancePolicyUpdate }) dto: AttendancePolicyUpdate) {
    return present(await this.policies.update(dto))
  }
}

function present(row: AttendancePolicy) {
  return attendancePolicyVo.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}
