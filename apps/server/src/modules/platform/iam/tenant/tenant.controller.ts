import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type EnabledBody,
  enabledBody,
  pageVo,
  tenantCreate,
  tenantCreatedVo,
  type TenantEnterBody,
  tenantEnterBody,
  tenantInitialPasswordVo,
  tenantOptionVo,
  tenantPerms,
  type TenantQuery,
  tenantQuery,
  tenantUpdate,
  tenantVo,
} from '@qiwu/shared'
import type { Request } from 'express'
import { z } from 'zod'
import { ActionLog, SkipActionLog } from '../../../../core/audit/action-log.js'
import { TraceAlways } from '../../../../core/audit/http-trace.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { PlatformOnly } from '../../../../core/auth/platform-only.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { TenancyOn } from '../../../../core/guard/tenancy-on.guard.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { Sensitive } from '../../../../core/redact.js'
import { TenantService } from './tenant.service.js'

/**
 * Tenant management (see docs/design-notes.md#tenancy): no route while multi-tenancy is off, platform
 * users only, each route behind its button perm. No delete: a tenant is never deleted. The tenant a
 * request works in is the caller's own session's; no header picks one.
 */
@ApiTags('iam')
@TenancyOn()
@PlatformOnly()
@Controller('iam/tenants')
export class TenantController {
  constructor(private readonly tenants: TenantService) {}

  @Get()
  @RequirePerm(tenantPerms.browse)
  @ApiOperation({ summary: 'Page of tenants' })
  @ApiEnvelope(pageVo(tenantVo))
  page(@Query({ schema: tenantQuery }) query: TenantQuery) {
    return this.tenants.page(query)
  }

  @Get('options')
  @RequirePerm(tenantPerms.browse)
  @ApiOperation({ summary: 'Every tenant (id, code, name), for filters' })
  @ApiEnvelope(z.array(tenantOptionVo))
  options() {
    return this.tenants.options()
  }

  /**
   * Back to one's own tenant: only a session working inside another one (403 otherwise), so no perm: inside
   * it a platform user holds no platform perm, this one's page's included.
   */
  @Post('leave')
  @HttpCode(200)
  // its `leave` row is written in the default tenant when the session leaves, whatever ends it
  @SkipActionLog()
  @TraceAlways()
  @ApiOperation({
    summary:
      "Leave the tenant entered: the session works in its user's own tenant again (403 when not inside another one)",
  })
  @ApiEnvelope()
  leave(@Req() req: Request) {
    return this.tenants.leave(req)
  }

  @Get(':id')
  @RequirePerm(tenantPerms.view)
  @ApiOperation({ summary: 'One tenant with its host names' })
  @ApiEnvelope(tenantVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.tenants.get(id)
  }

  @Post()
  @RequirePerm(tenantPerms.create)
  @Idempotent()
  @Sensitive('initialPassword')
  @ActionLog({
    domain: 'iam.tenant',
    verb: 'create',
    bizId: (_req, row) => (row as { id?: number } | undefined)?.id,
  })
  @ApiOperation({
    summary:
      'Open a tenant with its administrator; the initial password is answered this once only',
  })
  @ApiEnvelope(tenantCreatedVo, 201)
  create(@Body({ schema: tenantCreate }) dto: z.output<typeof tenantCreate>, @Req() req: Request) {
    return this.tenants.create(dto, req.hostname)
  }

  @Put(':id')
  @RequirePerm(tenantPerms.modify)
  @ActionLog({ domain: 'iam.tenant', verb: 'modify' })
  @ApiOperation({
    summary:
      'Change a tenant (never its code; `domains` replaces its host names; a new package or end reloads every session, an end not in the future ends its sessions)',
  })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: tenantUpdate }) dto: z.output<typeof tenantUpdate>,
    @Req() req: Request,
  ) {
    return this.tenants.update(id, dto, req.hostname)
  }

  @Put(':id/enabled')
  @RequirePerm(tenantPerms.modify)
  @ActionLog({ domain: 'iam.tenant', verb: 'modify' })
  @ApiOperation({ summary: 'Enable or disable a tenant (disabling ends its sessions)' })
  @ApiEnvelope()
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: enabledBody }) dto: EnabledBody,
  ) {
    return this.tenants.setEnabled(id, dto.enabled)
  }

  /**
   * Work inside tenant `id` (a disabled or expired one too): the web console session works on that
   * tenant's data with its user's own perms, the platform ones left out, for two hours at most.
   */
  @Post(':id/enter')
  @HttpCode(200)
  @RequirePerm(tenantPerms.enter)
  // its `enter` row (with the reason and the end) is written in the default tenant by the service
  @SkipActionLog()
  @TraceAlways()
  @ApiOperation({
    summary:
      "Enter a tenant (web console sessions only) with a reason: its data with one's own perms, platform perms left out, for two hours at most; audited in the default tenant",
  })
  @ApiEnvelope()
  enter(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: tenantEnterBody }) dto: TenantEnterBody,
    @Req() req: Request,
  ) {
    return this.tenants.enter(id, dto.reason, req)
  }

  /** Double clicks would reset twice and void the password shown first: 429 within 3 s. */
  @Post(':id/initial-password')
  @HttpCode(200)
  @RequirePerm(tenantPerms['reset-password'])
  @Idempotent()
  @Sensitive('initialPassword')
  @ActionLog({ domain: 'iam.tenant', verb: 'reset-password' })
  @ApiOperation({
    summary: "Reset the tenant's initial password; the new one is answered this once only",
  })
  @ApiEnvelope(tenantInitialPasswordVo)
  resetInitialPassword(@Param('id', ParseIntPipe) id: number) {
    return this.tenants.resetInitialPassword(id)
  }
}
