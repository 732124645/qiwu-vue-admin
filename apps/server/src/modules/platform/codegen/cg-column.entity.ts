import type { CgColumnOptions, CgQueryOp, CgTsType, CgWidget, Locale } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../core/db/base.entity.js'

/**
 * `cg_column`: one imported column of a `cg_table`. The `column*` facts, `nullable`,
 * `isPk`, `isAutoInc` come from information_schema (refreshed by sync); the rest is editable config
 * (`cgColumnFields`, `@qiwu/shared`), kept by sync.
 */
@Entity('cg_column')
export class CgColumn extends BaseEntity {
  @Column({ name: 'table_id', type: 'bigint', unsigned: true })
  tableId: number

  @Column({ name: 'column_name', length: 64 })
  columnName: string

  @Column({ name: 'column_type', type: 'text' })
  columnType: string

  @Column({ name: 'column_comment', length: 1024, default: '' })
  columnComment: string

  @Column({ name: 'column_default', type: 'text', nullable: true })
  columnDefault: string | null

  @Column({ type: 'boolean' })
  nullable: boolean

  @Column({ name: 'is_pk', type: 'boolean', default: false })
  isPk: boolean

  @Column({ name: 'is_auto_inc', type: 'boolean', default: false })
  isAutoInc: boolean

  @Column({ name: 'ts_type', type: 'varchar', length: 16 })
  tsType: CgTsType

  @Column({ name: 'field_name', length: 64 })
  fieldName: string

  @Column({ type: 'varchar', length: 24 })
  widget: CgWidget

  @Column({ name: 'in_list', type: 'boolean', default: true })
  inList: boolean

  @Column({ name: 'in_form', type: 'boolean', default: true })
  inForm: boolean

  @Column({ name: 'in_query', type: 'boolean', default: false })
  inQuery: boolean

  @Column({ name: 'query_op', type: 'varchar', length: 8, default: 'eq' })
  queryOp: CgQueryOp

  @Column({ type: 'boolean', default: false })
  sortable: boolean

  @Column({ type: 'boolean', default: false })
  required: boolean

  @Column({ name: 'dict_code', type: 'varchar', length: 100, nullable: true })
  dictCode: string | null

  @Column({ name: 'label_i18n', type: 'json', nullable: true })
  labelI18n: Record<Locale, string> | null

  @Column({ type: 'json', nullable: true })
  options: CgColumnOptions | null

  @Column({ name: 'sort_no', type: 'int', default: 0 })
  sortNo: number

  @Column({ type: 'varchar', length: 255, nullable: true })
  example: string | null
}
