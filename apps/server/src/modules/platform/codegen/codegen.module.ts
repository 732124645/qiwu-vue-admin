import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CgColumn } from './cg-column.entity.js'
import { CgTable } from './cg-table.entity.js'
import { CodegenController } from './codegen.controller.js'
import { CodegenService } from './codegen.service.js'

/**
 * The config service alone (import, sync, save, delete, render configs), without the HTTP layer: what the
 * CLI and the generator specs load (the controller's interceptors need the app's audit and Redis modules).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CgTable, CgColumn])],
  providers: [CodegenService],
  exports: [CodegenService],
})
export class CodegenServiceModule {}

/**
 * Code generator (see docs/design-notes.md#codegen): the config service the CLI uses and the page's API
 * (`/api/codegen/tables`: configs, preview, zip download, workspace write).
 */
@Module({ imports: [CodegenServiceModule], controllers: [CodegenController] })
export class CodegenModule {}
