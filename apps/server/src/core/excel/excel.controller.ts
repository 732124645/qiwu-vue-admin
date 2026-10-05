import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common'
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger'
import { ExcelService, XLSX_TYPE } from './excel.service.js'

/** Import error reports (core/excel): any signed-in user, only their own (someone else's id → 404). */
@ApiTags('excel')
@Controller('excel/reports')
export class ExcelController {
  constructor(private readonly excel: ExcelService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Download an import error report (.xlsx, kept 30 min)' })
  @ApiProduces(XLSX_TYPE)
  report(@Param('id', ParseUUIDPipe) id: string) {
    return this.excel.report(id)
  }
}
