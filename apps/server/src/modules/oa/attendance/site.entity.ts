import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

/** 办公地点坐标保持精确字串，员工的原始定位不写入本表。 */
@Entity('oa_attendance_site')
export class AttendanceSite extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ length: 100 })
  name: string

  @Column({ type: 'decimal', precision: 9, scale: 6 })
  latitude: string

  @Column({ type: 'decimal', precision: 9, scale: 6 })
  longitude: string

  @Column({ name: 'radius_m', type: 'int', unsigned: true })
  radiusM: number

  @Column({ name: 'max_accuracy_m', type: 'int', unsigned: true })
  maxAccuracyM: number

  @Column({ type: 'boolean', default: true })
  enabled: boolean
}
