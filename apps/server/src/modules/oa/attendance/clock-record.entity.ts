import type { AttendancePolicySnapshot, ClockAction } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { DataScoped } from '../../../core/data-scope/data-scope.js'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { referencedBy } from '../../../core/db/references.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

referencedBy('iam_user', { table: 'oa_clock_record', column: 'user_id' })
referencedBy('iam_dept', { table: 'oa_clock_record', column: 'dept_id' })
referencedBy('oa_attendance_policy', { table: 'oa_clock_record', column: 'policy_id' })
referencedBy('oa_attendance_site', { table: 'oa_clock_record', column: 'site_id' })

/** 原生打卡保留服务端时刻与当时规则，不存员工坐标，不提供业务修改或删除入口。 */
@Entity('oa_clock_record')
@DataScoped({ dept: 'dept_id', owner: 'user_id' })
export class ClockRecord extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'dept_id', type: 'bigint', unsigned: true, nullable: true })
  deptId: number | null

  @Column({ name: 'work_date', type: 'date' })
  workDate: string

  @Column({ type: 'varchar', length: 12 })
  action: ClockAction

  @Column({ name: 'punched_at', type: 'datetime', precision: 3 })
  punchedAt: Date

  @Column({ length: 64 })
  timezone: string

  @Column({ name: 'policy_id', type: 'bigint', unsigned: true })
  policyId: number

  @Column({ name: 'policy_snapshot', type: 'json' })
  policySnapshot: AttendancePolicySnapshot

  @Column({ name: 'site_id', type: 'bigint', unsigned: true, nullable: true })
  siteId: number | null

  @Column({ name: 'site_name', type: 'varchar', length: 100, nullable: true })
  siteName: string | null

  @Column({ name: 'distance_m', type: 'int', unsigned: true, nullable: true })
  distanceM: number | null

  @Column({ name: 'accuracy_m', type: 'decimal', precision: 10, scale: 2, nullable: true })
  accuracyM: string | null

  @Column({ name: 'validation_result', type: 'varchar', length: 16 })
  validationResult: 'not_required' | 'passed'

  @Column({ type: 'varchar', length: 16, default: 'native' })
  source: 'native'

  @Column({ name: 'request_id', length: 64 })
  requestId: string

  @Column({ name: 'request_digest', type: 'char', length: 64 })
  requestDigest: string
}
