import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../../core/db/base.entity.js'

/** `iam_tenant` (a platform table, see docs/design-notes.md#tenancy): one tenant, never deleted. */
@Entity('iam_tenant')
export class Tenant extends BaseEntity {
  /** the code a sign-in names it by; never changes */
  @Column({ length: 32 })
  code: string

  /** i18n key (the default tenant) or plain text */
  @Column({ length: 64 })
  name: string

  @Column({ name: 'brand_name', type: 'varchar', length: 64, nullable: true })
  brandName: string | null

  /** a public `cover` object of the default tenant */
  @Column({ name: 'logo_object_id', type: 'bigint', unsigned: true, nullable: true })
  logoObjectId: number | null

  /** null: the default tenant (unrestricted); any other tenant without one may use nothing */
  @Column({ name: 'package_id', type: 'bigint', unsigned: true, nullable: true })
  packageId: number | null

  @Column({ name: 'user_quota', type: 'int', unsigned: true, nullable: true })
  userQuota: number | null

  @Column({ name: 'expires_at', type: 'datetime', precision: 3, nullable: true })
  expiresAt: Date | null

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ name: 'owner_user_id', type: 'bigint', unsigned: true, nullable: true })
  ownerUserId: number | null

  /** SecretBox box of the tenant's initial password; never read by the pages */
  @Column({
    name: 'initial_password_enc',
    type: 'varchar',
    length: 512,
    nullable: true,
    select: false,
  })
  initialPasswordEnc?: string | null

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null
}
