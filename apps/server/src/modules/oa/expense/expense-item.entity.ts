import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

/** 报销明细随主单整单保存，其归属与费用金额由服务端复查。 */
@Entity('oa_expense_item')
export class OaExpenseItem extends BaseEntity {
  @Column({ name: 'claim_id', type: 'bigint', unsigned: true })
  claimId: number

  /** 费用日是日历日期，不经 JavaScript 本地时区转换。 */
  @Column({ name: 'expense_date', type: 'date' })
  expenseDate: string

  @Column({ name: 'expense_kind', length: 32 })
  expenseKind: string

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount: string

  @Column({ length: 200 })
  description: string

  @Column({ name: 'attachment_ids', type: 'json', nullable: true })
  attachmentIds: number[] | null

  @Column({ name: 'sort_no', type: 'int', default: 0 })
  sortNo: number

  @TenantColumn()
  tenantId: number
}
