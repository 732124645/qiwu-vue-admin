import { Column, Entity } from 'typeorm'
import type { OaRequestState } from '@qiwu/shared'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { TenantColumn } from '../../../core/db/tenant-filter.js'

/** 用印单只记录申请与批准结果，不代表印章已经实际使用。 */
@Entity('oa_seal_request')
export class OaSealRequest extends BaseEntity {
  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'dept_id', type: 'bigint', unsigned: true, nullable: true })
  deptId: number | null

  @Column({ name: 'seal_kind', length: 32 })
  sealKind: string

  @Column({ name: 'document_name', length: 200 })
  documentName: string

  @Column({ length: 500 })
  purpose: string

  @Column({ type: 'int', unsigned: true })
  copies: number

  @Column({ name: 'expected_date', type: 'date' })
  expectedDate: string

  @Column({ name: 'attachment_ids', type: 'json', nullable: true })
  attachmentIds: number[] | null

  @Column({ type: 'varchar', length: 12, default: 'draft' })
  state: OaRequestState

  @Column({ name: 'instance_id', type: 'bigint', unsigned: true, nullable: true })
  instanceId: number | null

  @TenantColumn()
  tenantId: number
}
