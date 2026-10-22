import {
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common'
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger'
import { InjectDataSource } from '@nestjs/typeorm'
import {
  type AgentChartSpec,
  type AgentXlsxQuery,
  agentPerms,
  agentXlsxQuery,
  markdownTables,
} from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { RequirePerm } from '../../auth/decorators.js'
import type { Principal } from '../../auth/principal.js'
import { clsGet } from '../../context/cls.js'
import { ExcelService, XLSX_TYPE } from '../../excel/excel.service.js'
import { AgentItem, AgentThread } from '../entities/agent-thread.entity.js'

const me = (): Principal => clsGet('principal')!

/** 图表 → 表格的行：表格类按原样（类别是表头、每个系列一行），其余第一列是类别、每个系列一列。 */
export function chartRows(spec: AgentChartSpec): unknown[][] {
  if (spec.kind === 'table')
    return [spec.categories, ...spec.series.map((s) => spec.categories.map((_, k) => s.data[k]))]
  return [
    [spec.unit ? `${spec.title} (${spec.unit})` : spec.title, ...spec.series.map((s) => s.name)],
    ...spec.categories.map((c, k) => [c, ...spec.series.map((s) => s.data[k])]),
  ]
}

/** 工作表名：去掉 Excel 不允许的字符，最多 31 个字符。 */
const sheetName = (title: string) =>
  title
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31) || 'export'

/**
 * 智能体产出的导出（see docs/agent.md#图表图片与导出）：只给条目所在会话的主人（子会话也属于父会话的主人），
 * 别人的、别的租户的（ORM 的租户条件）、已删除的条目一律 404。单元格经 ExcelService 写成纯值：数字照写，
 * 文字以 `= + - @` 等开头的加单引号，从不成为公式。
 */
@Injectable()
export class AgentOutputExport {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly excel: ExcelService,
  ) {}

  /** 图表的数据，或报告正文里第 `table` 张表格（从 0 起，缺省第一张），导出 xlsx。 */
  async xlsx(p: Principal, itemId: number, q: AgentXlsxQuery) {
    const item = await this.ds.getRepository(AgentItem).findOneBy({ id: itemId })
    if (!item) throw new NotFoundException()
    const thread = await this.ds
      .getRepository(AgentThread)
      .findOne({ where: { id: item.threadId }, select: { id: true, userId: true } })
    if (!thread || Number(thread.userId) !== p.userId) throw new NotFoundException()
    let title: string
    let rows: unknown[][]
    if (item.kind === 'chart') {
      const spec = item.payload as AgentChartSpec
      title = spec.title
      rows = chartRows(spec)
    } else if (item.kind === 'report') {
      const report = item.payload as { title: string; text: string }
      const table = markdownTables(report.text)[q.table ?? 0]
      if (!table) throw new NotFoundException()
      title = report.title
      rows = table
    } else throw new NotFoundException()
    const [head = [], ...body] = rows
    const width = Math.max(head.length, ...body.map((r) => r.length))
    const columns = Array.from({ length: width }, (_, k) => ({
      prop: `c${k}`,
      label: String(head[k] ?? ''),
      literal: true,
    }))
    const objects = body.map((r) => Object.fromEntries(r.map((v, k) => [`c${k}`, v])))
    return this.excel.export(sheetName(title), columns, objects)
  }
}

@ApiTags('agent')
@Controller('agent/items')
@RequirePerm(agentPerms.chat.use)
export class AgentOutputController {
  constructor(private readonly exports: AgentOutputExport) {}

  @Get(':itemId/xlsx')
  @ApiOperation({
    summary:
      "A chart's data or a report's Markdown table (`table`, 0-based) as xlsx; the thread's owner only",
  })
  @ApiProduces(XLSX_TYPE)
  xlsx(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Query({ schema: agentXlsxQuery }) q: AgentXlsxQuery,
  ) {
    return this.exports.xlsx(me(), itemId, q)
  }
}
