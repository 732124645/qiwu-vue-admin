import { Column, Entity } from 'typeorm'
import type { OaRequestState } from '@qiwu/shared'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

/** 出差单保存真实业务内容，审批状态由工作流事务内回写。 */
@Entity('oa_trip_request')
export class OaTripRequest extends BaseEntity {
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'dept_id', type: 'bigint', unsigned: true, nullable: true })
  deptId: number | null

  @Column({ length: 200 })
  destination: string

  @Column({ name: 'start_at', type: 'datetime', precision: 3 })
  startAt: Date

  @Column({ name: 'end_at', type: 'datetime', precision: 3 })
  endAt: Date

  @Column({ length: 500 })
  reason: string

  /** 金额保持 MySQL 的精确字符串，不使用浮点转换器。 */
  @Column({ name: 'estimated_amount', type: 'decimal', precision: 12, scale: 2, nullable: true })
  estimatedAmount: string | null

  @Column({ name: 'attachment_ids', type: 'json', nullable: true })
  attachmentIds: number[] | null

  @Column({ type: 'varchar', length: 12, default: 'draft' })
  state: OaRequestState

  @Column({ name: 'instance_id', type: 'bigint', unsigned: true, nullable: true })
  instanceId: number | null

  @TenantColumn()
  tenantId: number
}
