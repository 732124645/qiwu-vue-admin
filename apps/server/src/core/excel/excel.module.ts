import { Global, Module } from '@nestjs/common'
import { ExcelController } from './excel.controller.js'
import { ExcelService } from './excel.service.js'

/** ExcelService for every module (exports, templates, imports) + the import report download. */
@Global()
@Module({ controllers: [ExcelController], providers: [ExcelService], exports: [ExcelService] })
export class CoreExcelModule {}
