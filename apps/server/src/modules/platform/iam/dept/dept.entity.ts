import { Column, Entity } from 'typeorm'
import { DataScoped } from '../../../../core/data-scope/data-scope.js'
import { BaseEntity } from '../../../../core/db/base.entity.js'

/** `iam_dept`, data-scoped by its own id (the dept list/tree is the `checkDept` equivalent; see docs/design-notes.md#data-scope). */
@Entity('iam_dept')
@DataScoped({ dept: 'id', owner: null })
export class Dept extends BaseEntity {
  /** 0 = top level */
  @Column({ name: 'parent_id', type: 'bigint', unsigned: true, default: 0 })
  parentId: number

  /** `/1/5/9/`: ancestors and itself, always ends with `/` */
  @Column({ name: 'tree_path', length: 512 })
  treePath: string

  /** i18n key (seeded, `seed.dept.*`) or text */
  @Column({ length: 64 })
  name: string

  @Column({ name: 'sort_no', type: 'int', default: 0 })
  sortNo: number

  @Column({ name: 'head_user_id', type: 'bigint', unsigned: true, nullable: true })
  headUserId: number | null

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone: string | null

  @Column({ type: 'varchar', length: 128, nullable: true })
  email: string | null

  @Column({ type: 'boolean', default: true })
  enabled: boolean
}
