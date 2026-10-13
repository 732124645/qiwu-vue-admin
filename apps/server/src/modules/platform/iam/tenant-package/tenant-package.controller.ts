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
  pageVo,
  roleMenuNodeVo,
  type TenantPackageCreate,
  tenantPackageCreate,
  tenantPackageDetailVo,
  tenantPackageOptionVo,
  tenantPackagePerms,
  type TenantPackageQuery,
  tenantPackageQuery,
  type TenantPackageUpdate,
  tenantPackageUpdate,
  tenantPackageVo,
  tenantPerms,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { PlatformOnly } from '../../../../core/auth/platform-only.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { TenancyOn } from '../../../../core/guard/tenancy-on.guard.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { TenantPackageService } from './tenant-package.service.js'

/**
 * `/api/iam/tenant-packages`: the menus a tenant may use. A platform page (`@PlatformOnly()`), no route
 * at all while multi-tenancy is off (`@TenancyOn()`, 404).
 */
@ApiTags('iam')
@TenancyOn()
@PlatformOnly()
@Controller('iam/tenant-packages')
export class TenantPackageController {
  constructor(private readonly packages: TenantPackageService) {}

  @Get()
  @RequirePerm(tenantPackagePerms.browse)
  @ApiOperation({ summary: 'Page of tenant packages, each with the number of tenants using it' })
  @ApiEnvelope(pageVo(tenantPackageVo))
  page(@Query({ schema: tenantPackageQuery }) query: TenantPackageQuery) {
    return this.packages.list(query)
  }

  /** Also for whoever opens or edits tenants: the tenant form picks from it. */
  @Get('options')
  @RequirePerm(tenantPackagePerms.browse, tenantPerms.create, tenantPerms.modify)
  @ApiOperation({ summary: 'The enabled packages, for the tenant form' })
  @ApiEnvelope(z.array(tenantPackageOptionVo))
  options() {
    return this.packages.options()
  }

  /** The package form's grant tree; before `:id`. */
  @Get('menu-tree')
  @RequirePerm(tenantPackagePerms.browse)
  @ApiOperation({ summary: 'Every menu open to tenants (not platform-only) as a forest' })
  @ApiEnvelope(z.array(roleMenuNodeVo))
  menuTree() {
    return this.packages.menuTree()
  }

  @Get(':id')
  @RequirePerm(tenantPackagePerms.view)
  @ApiOperation({ summary: 'One package with its menus' })
  @ApiEnvelope(tenantPackageDetailVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.packages.detail(id)
  }

  @Post()
  @RequirePerm(tenantPackagePerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'iam.tenantPackage',
    verb: 'create',
    bizId: (_req, row) => (row as { id: number } | undefined)?.id,
  })
  @ApiOperation({
    summary: 'Add a package (menus open to tenants only: a platform-only one is refused, 422)',
  })
  @ApiEnvelope(tenantPackageVo, 201)
  create(@Body({ schema: tenantPackageCreate }) dto: TenantPackageCreate) {
    return this.packages.add(dto)
  }

  @Put(':id')
  @RequirePerm(tenantPackagePerms.modify)
  @ActionLog({ domain: 'iam.tenantPackage', verb: 'modify' })
  @ApiOperation({
    summary:
      'Change a package; `menuIds` replaces its menus. A change of its menus or of enabled reaches the sessions of its tenants at their next request',
  })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: tenantPackageUpdate }) dto: TenantPackageUpdate,
  ) {
    return this.packages.change(id, dto)
  }

  @Delete(':id')
  @RequirePerm(tenantPackagePerms.remove)
  @ActionLog({ domain: 'iam.tenantPackage', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a package no tenant uses (409 otherwise)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.packages.remove([id])
  }
}
