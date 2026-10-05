import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../../core/db/base.entity.js'

/** A user's sign-in binding of a third-party identity (`iam_user_social`); unbind = soft delete. */
@Entity('iam_user_social')
export class UserSocial extends BaseEntity {
  /** `wx-mp` (WeChat mini program) */
  @Column({ length: 24 })
  provider: string

  @Column({ length: 64 })
  appid: string

  @Column({ length: 128 })
  openid: string

  @Column({ type: 'varchar', length: 128, nullable: true })
  unionid: string | null

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number
}
