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
  StreamableFile,
} from '@nestjs/common'
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  type CgDownloadQuery,
  cgDownloadQuery,
  type CgImportBody,
  cgImportBody,
  cgImportableVo,
  cgImportVo,
  cgParentMenuNodeVo,
  cgPreviewVo,
  cgSyncVo,
  cgTableDetailVo,
  type CgTableQuery,
  cgTableQuery,
  type CgTableUpdate,
  cgTableUpdate,
  cgTableVo,
  cgWritableVo,
  type CgWriteBody,
  cgWriteBody,
  cgWriteResultVo,
  codegenPerms,
  Err,
  type IdsBody,
  idsBody,
  pageVo,
} from '@qiwu/shared'
import { z } from 'zod'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { BizError } from '../../../core/http/biz-error.js'
import { CodegenService } from './codegen.service.js'
import { canWrite, repoRoot, writeWorkspace, zipOf } from './workspace.js'

const ZIP_TYPE = 'application/zip'

/**
 * The generator page (contract `codegen-api.schema.ts`; see docs/design-notes.md#codegen): configs of imported tables
 * (list, import, edit, sync, delete) and their output (preview, zip download, workspace write). Preview
 * and download render the stored config, everywhere; writing into the repository only where the server
 * runs with NODE_ENV=development and CODEGEN_WRITE=true (else 422 C3005), below the whitelisted source
 * roots, never over an existing file: if one differs, nothing is written and the diffs come back.
 */
@ApiTags('codegen')
@Controller('codegen/tables')
export class CodegenController {
  constructor(private readonly codegen: CodegenService) {}

  @Get()
  @RequirePerm(codegenPerms.browse)
  @ApiOperation({ summary: 'Page of generator configs' })
  @ApiEnvelope(pageVo(cgTableVo))
  page(@Query({ schema: cgTableQuery }) query: CgTableQuery) {
    return this.codegen.page(query)
  }

  @Get('importable')
  @RequirePerm(codegenPerms.import)
  @ApiOperation({
    summary: 'Base tables of this database not imported yet (no meta_ / test_ / cg_ tables)',
  })
  @ApiEnvelope(z.array(cgImportableVo))
  importable() {
    return this.codegen.importable()
  }

  @Get('writable')
  @RequirePerm(codegenPerms.browse)
  @ApiOperation({ summary: 'Whether this server writes generated files into the repository' })
  @ApiEnvelope(cgWritableVo)
  writable() {
    return { writable: canWrite() }
  }

  @Get('parent-menus')
  @RequirePerm(codegenPerms.view)
  @ApiOperation({ summary: 'Every group menu as a forest, each marked pickable' })
  @ApiEnvelope(z.array(cgParentMenuNodeVo))
  parentMenus() {
    return this.codegen.parentMenus()
  }

  /** The configs' files at their repository paths, one zip (`ids=1,2`). */
  @Get('download')
  @RequirePerm(codegenPerms.generate)
  @ActionLog({ domain: 'codegen.table', verb: 'generate', bizId: (req) => req.query.ids })
  @ApiOperation({ summary: 'Download the generated files of configs as one zip' })
  @ApiOkResponse({
    description: 'The files at their repository paths (codegen.zip)',
    content: { [ZIP_TYPE]: { schema: { type: 'string', format: 'binary' } } },
  })
  async download(@Query({ schema: cgDownloadQuery }) { ids }: CgDownloadQuery) {
    const { files } = await this.codegen.render(ids)
    return new StreamableFile(zipOf(files), {
      type: ZIP_TYPE,
      disposition: 'attachment; filename="codegen.zip"',
    })
  }

  @Post('import')
  @HttpCode(200)
  @RequirePerm(codegenPerms.import)
  @Idempotent()
  @ActionLog({ domain: 'codegen.table', verb: 'import' })
  @ApiOperation({ summary: 'Import tables with the default config: all or none' })
  @ApiEnvelope(cgImportVo)
  import(@Body({ schema: cgImportBody }) { tableNames }: CgImportBody) {
    return this.codegen.import(tableNames)
  }

  @Post('write')
  @HttpCode(200)
  @RequirePerm(codegenPerms.write)
  @Idempotent()
  @ActionLog({ domain: 'codegen.table', verb: 'write', bizId: (req) => req.body?.ids })
  @ApiOperation({
    summary:
      'Write the generated files of configs into the repository (development only): all or none; differing files come back as diffs',
  })
  @ApiEnvelope(cgWriteResultVo)
  async write(@Body({ schema: cgWriteBody }) { ids }: CgWriteBody) {
    if (!canWrite()) throw new BizError(Err.CODEGEN_WRITE_DISABLED)
    const { files, registration } = await this.codegen.render(ids)
    return { ...writeWorkspace(repoRoot(), files), registration }
  }

  @Post('batch-delete')
  @HttpCode(200)
  @RequirePerm(codegenPerms.remove)
  @ActionLog({ domain: 'codegen.table', verb: 'remove' })
  @ApiOperation({ summary: 'Delete configs with their columns: all or none' })
  @ApiEnvelope()
  batchRemove(@Body({ schema: idsBody }) { ids }: IdsBody) {
    return this.codegen.remove(ids)
  }

  @Get(':id')
  @RequirePerm(codegenPerms.view)
  @ApiOperation({ summary: 'One config with its columns' })
  @ApiEnvelope(cgTableDetailVo)
  detail(@Param('id', ParseIntPipe) id: number) {
    return this.codegen.detail(id)
  }

  @Put(':id')
  @RequirePerm(codegenPerms.modify)
  @ActionLog({ domain: 'codegen.table', verb: 'modify' })
  @ApiOperation({ summary: 'Change a config: the fields and columns (by id) sent, the rest kept' })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: cgTableUpdate }) dto: CgTableUpdate,
  ) {
    return this.codegen.save(id, dto)
  }

  @Delete(':id')
  @RequirePerm(codegenPerms.remove)
  @ActionLog({ domain: 'codegen.table', verb: 'remove' })
  @ApiOperation({ summary: 'Delete a config with its columns' })
  @ApiEnvelope()
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.codegen.remove([id])
  }

  @Post(':id/sync')
  @HttpCode(200)
  @RequirePerm(codegenPerms.modify)
  @ActionLog({ domain: 'codegen.table', verb: 'sync' })
  @ApiOperation({ summary: "Re-read the table's columns from the database, manual config kept" })
  @ApiEnvelope(cgSyncVo)
  sync(@Param('id', ParseIntPipe) id: number) {
    return this.codegen.sync(id)
  }

  @Get(':id/preview')
  @RequirePerm(codegenPerms.generate)
  @ApiOperation({ summary: 'The generated files of a config and the lines to register it' })
  @ApiEnvelope(cgPreviewVo)
  preview(@Param('id', ParseIntPipe) id: number) {
    return this.codegen.preview(id)
  }
}
