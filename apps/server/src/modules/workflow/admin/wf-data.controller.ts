import { Controller, Get, Param, Query } from '@nestjs/common'
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger'
import { type WfDataQuery, wfDataPageVo, wfDataQuery, wfPerms } from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { ExcelService, XLSX_TYPE } from '../../../core/excel/excel.service.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import { WfDataService } from './wf-data.service.js'

/**
 * Approval data: a model's instances by its form fields, `wfPerms.data` (root only), within the
 * caller's data scope on `initiator_dept_id`; fields a step hides only for root and the process admins.
 */
@ApiTags('wf')
@Controller('wf/models')
export class WfDataController {
  constructor(
    private readonly data: WfDataService,
    private readonly excel: ExcelService,
  ) {}

  @Get(':key/data')
  @RequirePerm(wfPerms.data.browse)
  @ApiOperation({
    summary:
      "Page of a model's instances with the chosen version's form fields as columns (fields a step hides: root and the model's process admins only)",
  })
  @ApiEnvelope(wfDataPageVo)
  page(@Param('key') key: string, @Query({ schema: wfDataQuery }) query: WfDataQuery) {
    return this.data.page(key, query)
  }

  /** The page's columns and rows (same filters and sort, no paging) as .xlsx. */
  @Get(':key/data/export')
  @RequirePerm(wfPerms.data.export)
  @ActionLog({ domain: 'wf.data', verb: 'export' })
  @ApiOperation({ summary: "Export a model's filtered instances with their form fields (.xlsx)" })
  @ApiProduces(XLSX_TYPE)
  async export(@Param('key') key: string, @Query({ schema: wfDataQuery }) query: WfDataQuery) {
    const { columns, rows } = await this.data.export(key, query)
    return this.excel.export('wfData', columns, rows)
  }
}
