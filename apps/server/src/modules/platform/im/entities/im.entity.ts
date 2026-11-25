import type { ImAttachment, ImEntryKind, ImEvent, ImRole, ImRoomKind } from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../../core/db/base.entity.js'
import { TenantColumn } from '../../../../core/db/tenant-filter.js'

/**
 * 会话：私聊（同一对员工唯一，`pair_low_id < pair_high_id`）或群。会话从不删除，解散写 `closedAt`；
 * `lastSeq` 只在锁住本行的事务里 +1 分配。
 */
@Entity('im_room')
export class ImRoomEntity extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'room_kind', type: 'varchar', length: 16 })
  roomKind: ImRoomKind

  @Column({ name: 'scope_code', type: 'varchar', length: 24, default: 'staff' })
  scopeCode: string

  @Column({ name: 'pair_low_id', type: 'bigint', unsigned: true, nullable: true })
  pairLowId: number | null

  @Column({ name: 'pair_high_id', type: 'bigint', unsigned: true, nullable: true })
  pairHighId: number | null

  @Column({ type: 'varchar', length: 80, nullable: true })
  label: string | null

  @Column({ name: 'last_seq', type: 'bigint', unsigned: true, default: 0 })
  lastSeq: number

  @Column({ name: 'floor_seq', type: 'bigint', unsigned: true, default: 1 })
  floorSeq: number

  @Column({ name: 'last_entry_at', type: 'datetime', precision: 3, nullable: true })
  lastEntryAt: Date | null

  @Column({ name: 'meta_rev', type: 'int', unsigned: true, default: 1 })
  metaRev: number

  @Column({ name: 'closed_at', type: 'datetime', precision: 3, nullable: true })
  closedAt: Date | null
}

/**
 * 成员时期：一行一个时期（`id` 即 periodId），退出或被移除 = 软删本行，再加入 = 新行。
 * 生成列 `owner_one` 只为“每个会话至多一个群主”的唯一键存在，不映射。
 */
@Entity('im_roster')
export class ImRosterEntity extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'room_id', type: 'bigint', unsigned: true })
  roomId: number

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'identity_kind', type: 'varchar', length: 16, default: 'admin' })
  identityKind: string

  @Column({ name: 'role_code', type: 'varchar', length: 16 })
  roleCode: ImRole

  @Column({ name: 'member_label', type: 'varchar', length: 64 })
  memberLabel: string

  @Column({ name: 'visible_from_seq', type: 'bigint', unsigned: true })
  visibleFromSeq: number

  @Column({ name: 'read_seq', type: 'bigint', unsigned: true, default: 0 })
  readSeq: number
}

/**
 * 消息与系统事件：按会话 seq 递增。本表从不软删：撤回只清内容，保留期清理物理删除连续的过期前缀。
 */
@Entity('im_entry')
export class ImEntryEntity extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'room_id', type: 'bigint', unsigned: true })
  roomId: number

  @Column({ type: 'bigint', unsigned: true })
  seq: number

  @Column({ name: 'author_id', type: 'bigint', unsigned: true, nullable: true })
  authorId: number | null

  @Column({ name: 'author_kind', type: 'varchar', length: 16, nullable: true })
  authorKind: string | null

  @Column({ name: 'author_label', type: 'varchar', length: 64, nullable: true })
  authorLabel: string | null

  @Column({ name: 'client_entry_id', type: 'varchar', length: 64, nullable: true })
  clientEntryId: string | null

  @Column({ name: 'request_digest', type: 'char', length: 64, nullable: true })
  requestDigest: string | null

  @Column({ name: 'entry_kind', type: 'varchar', length: 16 })
  entryKind: ImEntryKind

  @Column({ name: 'text_value', type: 'mediumtext', nullable: true })
  textValue: string | null

  @Column({ name: 'sticker_code', type: 'varchar', length: 32, nullable: true })
  stickerCode: string | null

  @Column({ type: 'json', nullable: true })
  attachment: ImAttachment | null

  @Column({ name: 'event_data', type: 'json', nullable: true })
  eventData: ImEvent | null

  @Column({ name: 'target_seq', type: 'bigint', unsigned: true, nullable: true })
  targetSeq: number | null

  @Column({ name: 'content_rev', type: 'int', unsigned: true, default: 1 })
  contentRev: number

  @Column({ name: 'edited_at', type: 'datetime', precision: 3, nullable: true })
  editedAt: Date | null

  @Column({ name: 'recalled_at', type: 'datetime', precision: 3, nullable: true })
  recalledAt: Date | null

  @Column({ name: 'recalled_by', type: 'bigint', unsigned: true, nullable: true })
  recalledBy: number | null
}

/** 个人自定义表情：同一张规范化图片（按 sha256）每人只收藏一次；删除连同其文件对象一起软删。 */
@Entity('im_sticker')
export class ImStickerEntity extends BaseEntity {
  @TenantColumn()
  tenantId: number

  @Column({ name: 'user_id', type: 'bigint', unsigned: true })
  userId: number

  @Column({ name: 'object_id', type: 'bigint', unsigned: true })
  objectId: number

  @Column({ type: 'char', length: 64 })
  sha256: string

  @Column({ type: 'varchar', length: 64 })
  mime: string

  @Column({ type: 'smallint', unsigned: true })
  width: number

  @Column({ type: 'smallint', unsigned: true })
  height: number

  @Column({ name: 'sort_no', type: 'int', default: 0 })
  sortNo: number
}

export const IM_ENTITIES = [ImRoomEntity, ImRosterEntity, ImEntryEntity, ImStickerEntity]
