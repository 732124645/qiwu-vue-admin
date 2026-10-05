import { Column, Entity, JoinColumn, ManyToOne, type Relation } from 'typeorm'
import { DataScoped } from '../../../../core/data-scope/data-scope.js'
import { BaseEntity } from '../../../../core/db/base.entity.js'
import { Dept } from '../dept/dept.entity.js'

/**
 * `iam_user`, data-scoped by its dept and, for `own_rows`, by its own id (a user
 * "owns" only their own row; see docs/design-notes.md#data-scope). Sign-in reads and writes stay raw SQL in `IamUserLookup` (core/auth port).
 */
@Entity('iam_user')
@DataScoped({ dept: 'dept_id', owner: 'id' })
export class User extends BaseEntity {
  @Column({ length: 64 })
  username: string

  /** bcrypt; never selected unless asked for */
  @Column({ name: 'password_hash', length: 100, select: false })
  passwordHash?: string

  @Column({ name: 'display_name', length: 64 })
  displayName: string

  @Column({ name: 'dept_id', type: 'bigint', unsigned: true, nullable: true })
  deptId: number | null

  /** read-only join for the dept name (soft-deleted depts join as null) */
  @ManyToOne(() => Dept, { createForeignKeyConstraints: false })
  @JoinColumn({ name: 'dept_id' })
  dept?: Relation<Dept> | null

  @Column({ type: 'varchar', length: 128, nullable: true })
  email: string | null

  @Column({ type: 'varchar', length: 32, nullable: true })
  mobile: string | null

  @Column({ length: 8, default: 'unknown' })
  gender: string

  @Column({ name: 'avatar_url', type: 'varchar', length: 512, nullable: true })
  avatarUrl: string | null

  @Column({ type: 'boolean', default: true })
  enabled: boolean

  @Column({ name: 'last_login_at', type: 'datetime', precision: 3, nullable: true })
  lastLoginAt: Date | null

  /** null = the next sign-in must change the password (see docs/design-notes.md#auth-sessions) */
  @Column({ name: 'password_changed_at', type: 'datetime', precision: 3, nullable: true })
  passwordChangedAt: Date | null

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null
}
