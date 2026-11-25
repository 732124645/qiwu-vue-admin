import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, Query } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import {
  expenseCreate,
  expenseDetailVo,
  expenseQuery,
  expenseUpdate,
  expenseVo,
  oaExpensePerms,
  pageVo,
  type ExpenseCreate,
  type ExpenseQuery,
  type ExpenseUpdate,
} from '@qiwu/shared'
import { ActionLog } from '../../../core/audit/action-log.js'
import { RequirePerm } from '../../../core/auth/decorators.js'
import { RequireFeature } from '../../../core/auth/tenant-scope.js'
import { Idempotent } from '../../../core/guard/idempotent.js'
import { ApiEnvelope } from '../../../core/http/api-envelope.decorator.js'
import type { OaExpenseClaim } from './expense.entity.js'
import { ExpenseService } from './expense.service.js'

/** 报销只提供业务单据入口，审批动作统一使用现有工作流 API。 */
@ApiTags('oa')
@Controller('oa/expense-claims')
@RequireFeature('workflow')
export class ExpenseController {
  constructor(private readonly expenses: ExpenseService) {}

  @Get()
  @RequirePerm(oaExpensePerms.browse)
  @ApiOperation({ summary: 'Page of my expense claims' })
  @ApiEnvelope(pageVo(expenseVo))
  page(@Query({ schema: expenseQuery }) query: ExpenseQuery) {
    return this.expenses.myPage(query)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Expense claim and items visible to its owner or workflow participant' })
  @ApiEnvelope(expenseDetailVo)
  get(@Param('id', ParseIntPipe) id: number) {
    return this.expenses.get(id)
  }

  @Post()
  @RequirePerm(oaExpensePerms.create)
  @Idempotent()
  @ActionLog({
    domain: 'oa.expense',
    verb: 'create',
    bizId: (_req, row) => (row as OaExpenseClaim | undefined)?.id,
  })
  @ApiOperation({ summary: 'Submit an expense claim and start approval in one transaction' })
  @ApiEnvelope(expenseDetailVo, 201)
  create(@Body({ schema: expenseCreate }) dto: ExpenseCreate) {
    return this.expenses.submit(dto)
  }

  @Put(':id')
  @RequirePerm(oaExpensePerms.modify)
  @ActionLog({ domain: 'oa.expense', verb: 'modify' })
  @ApiOperation({ summary: 'Change my draft or sent-back claim and its expense items' })
  @ApiEnvelope()
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body({ schema: expenseUpdate }) dto: ExpenseUpdate,
  ) {
    return this.expenses.update(id, dto)
  }
}
