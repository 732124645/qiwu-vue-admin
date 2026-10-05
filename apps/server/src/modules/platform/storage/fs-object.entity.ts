import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../core/db/base.entity.js'
import { referencedBy } from '../../../core/db/references.js'

// a storage holding objects is in use (the former foreign key)
referencedBy('fs_storage', { table: 'fs_object', column: 'storage_id' })

/** `fs_object`: one stored file. */
@Entity('fs_object')
export class FsObject extends BaseEntity {
  @Column({ name: 'storage_id', type: 'bigint', unsigned: true })
  storageId: number

  /** `yyyy/MM/dd/<uuid>.<ext>`, below the storage's public/ or private/ area */
  @Column({ name: 'object_key', length: 512 })
  objectKey: string

  @Column({ name: 'original_name', length: 255 })
  originalName: string

  @Column({ length: 128 })
  mime: string

  @Column({ type: 'bigint', unsigned: true })
  size: number

  @Column({ type: 'char', length: 64, nullable: true })
  sha256: string | null

  @Column({ name: 'is_public', type: 'boolean', default: false })
  isPublic: boolean

  @Column({ name: 'public_url', type: 'varchar', length: 1024, nullable: true })
  publicUrl: string | null

  @Column({ name: 'biz_tag', length: 64 })
  bizTag: string

  @Column({ name: 'biz_ref', type: 'varchar', length: 64, nullable: true })
  bizRef: string | null

  @Column({ name: 'uploader_id', type: 'bigint', unsigned: true })
  uploaderId: number
}
