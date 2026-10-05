import type { CgTableFields, CgTableOptions, Locale } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { referencedBy } from '../../../core/db/references.js'

// The former foreign keys: a master with linked sub tables is in use (deleting both in one call is
// fine); a config's columns go with it
referencedBy(
  'cg_table',
  { table: 'cg_table', column: 'master_table_id' },
  { table: 'cg_column', column: 'table_id', cascade: true },
)

/**
 * `cg_table`: the generator config of one imported table. `tableName` / `tableComment` come
 * from information_schema; the rest is editable and whitelisted (`cgTableFields`, `@qiwu/shared`).
 */
@Entity('cg_table')
export class CgTable extends BaseEntity {
  @Column({ name: 'table_name', length: 64 })
  tableName: string

  @Column({ name: 'table_comment', length: 2048, default: '' })
  tableComment: string

  @Column({ name: 'group_code', type: 'varchar', length: 16 })
  groupCode: CgTableFields['groupCode']

  @Column({ length: 32 })
  domain: string

  @Column({ length: 64 })
  business: string

  @Column({ name: 'class_name', length: 64 })
  className: string

  @Column({ name: 'feature_name', length: 128 })
  featureName: string

  @Column({ name: 'feature_name_i18n', type: 'json', nullable: true })
  featureNameI18n: Record<Locale, string> | null

  @Column({ type: 'varchar', length: 12, default: 'crud' })
  template: CgTableFields['template']

  @Column({ name: 'parent_menu_route_name', type: 'varchar', length: 128, nullable: true })
  parentMenuRouteName: string | null

  @Column({ name: 'tree_parent_col', type: 'varchar', length: 64, nullable: true })
  treeParentCol: string | null

  @Column({ name: 'tree_label_col', type: 'varchar', length: 64, nullable: true })
  treeLabelCol: string | null

  @Column({ name: 'master_table_id', type: 'bigint', unsigned: true, nullable: true })
  masterTableId: number | null

  @Column({ name: 'sub_fk_col', type: 'varchar', length: 64, nullable: true })
  subFkCol: string | null

  @Column({ name: 'form_cols', type: 'tinyint', default: 1 })
  formCols: number

  @Column({ name: 'with_detail_view', type: 'boolean', default: false })
  withDetailView: boolean

  @Column({ type: 'boolean', default: false })
  readonly: boolean

  @Column({ type: 'json', nullable: true })
  options: CgTableOptions | null

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null
}
