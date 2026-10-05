import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UploadedFile,
} from '@nestjs/common'
import { ApiBody, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger'
import {
  DEFAULT_EXCEL_IMPORT_LIMITS,
  DEFAULT_PASSWORD_POLICY,
  type EnabledBody,
  enabledBody,
  excelImportParams,
  type IdsBody,
  idsBody,
  IMPORT_MODES,
  type ImportBody,
  importBody,
  importResultVo,
  pageVo,
  type UserAssignRolesBody,
  userAssignRolesBody,
  userCreate,
  userDetailVo,
  type UserOptionQuery,
  userOptionQuery,
  userOptionVo,
  userPerms,
  type UserQuery,
  userQuery,
  userResetPasswordBody,
  type UserUpdate,
  userUpdate,
  userVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../../core/audit/action-log.js'
import { RequirePerm } from '../../../../core/auth/decorators.js'
import { ExcelService, XLSX_TYPE } from '../../../../core/excel/excel.service.js'
import { Idempotent } from '../../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../../core/http/api-envelope.decorator.js'
import { UploadFile, type UploadedFileData } from '../../../../core/http/upload.js'
import { userColumns, UserService } from './user.service.js'

/** Swagger body of a schema that depends on the runtime password policy (documented with the default). */
const policyBody = (schema: z.ZodType) =>
  ApiBody({
    schema: z.toJSONSchema(schema, {
      target: 'openapi-3.0',
      io: 'input',
      unrepresentable: 'any',
    }) as object,
  })

@ApiTags('iam')
@Controller('iam/users')
export class UserController {
  constructor(
    private readonly users: UserService,
    private readonly excel: ExcelService,
  ) {}

  @Get()
  @RequirePerm(userPerms.browse)
  @ApiOperation({ summary: 'Page of users (dept filter includes its subtree)' })
  @ApiEnvelope(pageVo(userVo))
  page(@Query({ schema: userQuery }) query: UserQuery) {
    return this.users.list(query)
  }

  /** The list's rows (same filters and sort, no paging) as .xlsx; contacts masked as in the list. */
  @Get('export')
  @RequirePerm(userPerms.export)
  @ActionLog({ domain: 'iam.user', verb: 'export' })
  @ApiOperation({ summary: 'Export the filtered users (.xlsx)' })
  @ApiProduces(XLSX_TYPE)
  export(@Query({ schema: userQuery }) query: UserQuery) {
    return this.excel.export('users', userColumns, this.users.exportList(query))
  }

  /** Dropdowns: gender, enabled, and the caller's depts as `<id> - <path>`. */
  @Get('import-template')
  @RequirePerm(userPerms.import)
  @ApiOperation({ summary: 'Import template (.xlsx)' })
  @ApiProduces(XLSX_TYPE)
  async importTemplate() {
    return this.excel.template('users', userColumns, { deptId: await this.users.deptOptions() })
  }

  /** Roles and positions are not imported (assigned on the page afterwards). */
  @Post('import')
  @HttpCode(200)
  @RequirePerm(userPerms.import)
  // above @UploadFile: its interceptors run first, so the key covers the file (a double submit)
  @Idempotent()
  @UploadFile('file', excelImportParams.maxMb, DEFAULT_EXCEL_IMPORT_LIMITS.maxMb)
  @ActionLog({ domain: 'iam.user', verb: 'import' })
  @ApiOperation({
    summary: 'Import users (multipart: file + mode insert|upsert); failed rows → error report',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
        mode: { type: 'string', enum: [...IMPORT_MODES], default: 'insert' },
      },
    },
  })
  @ApiEnvelope(importResultVo)
  importXlsx(
    @UploadedFile() file: UploadedFileData | undefined,
    @Body({ schema: importBody }) { mode }: ImportBody,
  ) {
    return this.users.importXlsx(file, mode)
  }

  /** Any signed-in user (UserPicker), within their data scope. */
  @Get('options')
  @ApiOperation({ summary: 'Enabled users of the caller scope for pickers (at most 200)' })
  @ApiEnvelope(z.array(userOptionVo))
  options(@Query({ schema: userOptionQuery }) query: UserOptionQuery) {
    return this.users.options(query)
  }

  @Get(':id')
  @RequirePerm(userPerms.view)
  @ApiOperation({ summary: 'One user with role and position ids' })
  @ApiEnvelope(userDetailVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.users.detail(id)
  }

  /** The body depends on the runtime password policy, so the service validates it. */
  @Post()
  @RequirePerm(userPerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'iam.user',
    verb: 'create',
    bizId: (_req, row) => (row as { id?: number } | undefined)?.id,
  })
  @ApiOperation({
    summary: 'Add a user (empty password → the initial password; must change it at sign-in)',
  })
  @policyBody(userCreate(DEFAULT_PASSWORD_POLICY))
  @ApiEnvelope(userDetailVo, 201)
  create(@Body() body: unknown) {
    return this.users.createUser(body)
  }

  @Put(':id')
  @RequirePerm(userPerms.modify)
  @ActionLog({ domain: 'iam.user', verb: 'modify' })
  @ApiOperation({ summary: 'Change a user (roles pass the grant policy)' })
  @ApiEnvelope()
  update(@Param('id', ParseIntPipe) id: number, @Body({ schema: userUpdate }) dto: UserUpdate) {
    return this.users.modify(id, dto)
  }

  /** Disabling ends every session of the user; never the caller's own account or a root user. */
  @Put(':id/enabled')
  @RequirePerm(userPerms.modify)
  @ActionLog({ domain: 'iam.user', verb: 'modify' })
  @ApiOperation({ summary: 'Enable or disable a user (disabled → signed out everywhere)' })
  @ApiEnvelope()
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: enabledBody }) dto: EnabledBody,
  ) {
    return this.users.modify(id, dto)
  }

  /** The body depends on the runtime password policy, so the service validates it. */
  @Put(':id/password')
  @RequirePerm(userPerms['reset-password'])
  @ActionLog({ domain: 'iam.user', verb: 'reset-password' })
  @ApiOperation({ summary: 'Reset a password (must be changed at sign-in; signed out everywhere)' })
  @policyBody(userResetPasswordBody(DEFAULT_PASSWORD_POLICY))
  @ApiEnvelope()
  resetPassword(@Param('id', ParseIntPipe) id: number, @Body() body: unknown) {
    return this.users.resetPassword(id, body)
  }

  @Put(':id/roles')
  @RequirePerm(userPerms['assign-roles'])
  @ActionLog({ domain: 'iam.user', verb: 'grant' })
  @ApiOperation({
    summary: 'Replace the roles of a user (grant policy; applies at the next request)',
  })
  @ApiEnvelope()
  assignRoles(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: userAssignRolesBody }) { roleIds }: UserAssignRolesBody,
  ) {
    return this.users.modify(id, { roleIds })
  }

  @Delete(':id')
  @RequirePerm(userPerms.remove)
  @ActionLog({ domain: 'iam.user', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a user (not yourself, not root; signed out everywhere)' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.users.remove([id])
  }

  @Post('batch-delete')
  @HttpCode(200)
  @RequirePerm(userPerms.remove)
  @ActionLog({ domain: 'iam.user', verb: 'remove' })
  @ApiOperation({ summary: 'Delete users: all or none' })
  @ApiEnvelope()
  batchRemove(@Body({ schema: idsBody }) { ids }: IdsBody) {
    return this.users.remove(ids)
  }
}
