import { Column, Entity } from 'typeorm'
import type { OaRequestState } from '@qiwu/shared'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

/** 报销单总额由明细精确求和，币种和审批状态均由服务端确定。 */
@Entity('oa_expense_claim')
export class OaExpenseClaim extends BaseEntity {
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'dept_id', type: 'bigint', unsigned: true, nullable: true })
  deptId: number | null

  @Column({ length: 500 })
  reason: string

  @Column({ name: 'trip_id', type: 'bigint', unsigned: true, nullable: true })
  tripId: number | null

  /** 保留十进制文本，避免读出后发生二进制浮点舍入。 */
  @Column({ name: 'total_amount', type: 'decimal', precision: 12, scale: 2 })
  totalAmount: string

  @Column({ length: 3, default: 'CNY' })
  currency: string

  @Column({ name: 'attachment_ids', type: 'json', nullable: true })
  attachmentIds: number[] | null

  @Column({ type: 'varchar', length: 12, default: 'draft' })
  state: OaRequestState

  @Column({ name: 'instance_id', type: 'bigint', unsigned: true, nullable: true })
  instanceId: number | null

  @TenantColumn()
  tenantId: number
}
