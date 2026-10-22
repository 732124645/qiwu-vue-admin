import type { AttendanceLocationMode } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

/** 每个租户一份原生打卡规则，修改后不回算旧记录的工作日或结果。 */
@Entity('oa_attendance_policy')
export class AttendancePolicy extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ length: 64, default: 'Asia/Shanghai' })
  timezone: string

  @Column({ name: 'location_mode', type: 'varchar', length: 8, default: 'none' })
  locationMode: AttendanceLocationMode

  @Column({ name: 'retention_days', type: 'smallint', unsigned: true, default: 180 })
  retentionDays: number
}
