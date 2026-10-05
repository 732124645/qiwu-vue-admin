import { Column, Entity } from 'typeorm'
import { CreatedEntity } from '../../../../core/db/base.entity.js'

@Entity('msg_sms_otp')
export class SmsOtp extends CreatedEntity {
  @Column({ length: 32 })
  mobile: string

  @Column({ name: 'user_id', type: 'bigint', unsigned: true, nullable: true })
  userId: number | null

  @Column({ length: 24 })
  scene: string

  @Column({ length: 8 })
  code: string

  @Column({ type: 'tinyint', unsigned: true, default: 0 })
  attempts: number

  @Column({ name: 'daily_seq', type: 'int', unsigned: true })
  dailySeq: number

  @Column({ name: 'request_ip', length: 64 })
  requestIp: string

  @Column({ name: 'consumed_at', type: 'datetime', precision: 3, nullable: true })
  consumedAt: Date | null

  @Column({ name: 'consumed_ip', type: 'varchar', length: 64, nullable: true })
  consumedIp: string | null
}
