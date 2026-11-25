import type {
  ImCallEndReason,
  ImCallMediaState,
  ImCallMemberState,
  ImCallMode,
  ImCallState,
} from '@qiwu/shared'
import { Column, Entity } from 'typeorm'
import { BaseEntity } from '../../../../core/db/base.entity.js'
import { referencedBy } from '../../../../core/db/references.js'
import { TenantColumn } from '../../../../core/db/tenant-filter.js'

referencedBy('im_room', { table: 'im_call', column: 'room_id' })
referencedBy('im_call', { table: 'im_call_member', column: 'call_id', cascade: true })

/**
 * 通话历史不提供删除动作；媒体名字是不可复用的安全标识。active_room_id 只用于数据库约束，结束前一直占槽，
 * 包括远端清理未确认的 ending；实体不映射任何生成列。
 */
@Entity('im_call')
export class ImCallEntity extends BaseEntity {
  @TenantColumn() tenantId: number
  @Column({ name: 'room_id', type: 'bigint', unsigned: true }) roomId: number
  @Column({ name: 'caller_id', type: 'bigint', unsigned: true }) callerId: number
  @Column({ name: 'client_call_id', length: 64 }) clientCallId: string
  @Column({ name: 'mode_code', type: 'varchar', length: 16 }) mode: ImCallMode
  @Column({ name: 'state_code', type: 'varchar', length: 16, default: 'ringing' })
  state: ImCallState
  @Column({ name: 'media_room', length: 160 }) mediaRoom: string
  @Column({ name: 'media_status', type: 'varchar', length: 16, default: 'intent' })
  mediaStatus: ImCallMediaState
  @Column({ name: 'media_operation_id', type: 'varchar', length: 64, nullable: true })
  mediaOperationId: string | null
  @Column({ name: 'create_in_flight', type: 'boolean', default: false }) createInFlight: boolean
  @Column({ name: 'create_started_at', type: 'datetime', precision: 3, nullable: true })
  createStartedAt: Date | null
  @Column({
    name: 'checked_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  checkedAt: Date
  @Column({ name: 'invite_expires_at', type: 'datetime', precision: 3 }) inviteExpiresAt: Date
  @Column({ name: 'started_at', type: 'datetime', precision: 3, nullable: true })
  startedAt: Date | null
  @Column({ name: 'ending_at', type: 'datetime', precision: 3, nullable: true })
  endingAt: Date | null
  @Column({ name: 'ended_at', type: 'datetime', precision: 3, nullable: true }) endedAt: Date | null
  @Column({ name: 'end_reason', type: 'varchar', length: 32, nullable: true })
  endReason: ImCallEndReason | null
  @Column({ name: 'revision', type: 'int', unsigned: true, default: 1 }) rev: number
  @Column({ name: 'summary_seq', type: 'bigint', unsigned: true, nullable: true }) summarySeq:
    number | null
}

/** 用户和 roster 编号保留历史归属；资格只由当前员工、当前成员时期及已绑定的活会话共同确认。 */
@Entity('im_call_member')
export class ImCallMemberEntity extends BaseEntity {
  @TenantColumn() tenantId: number
  @Column({ name: 'call_id', type: 'bigint', unsigned: true }) callId: number
  @Column({ name: 'user_id', type: 'bigint', unsigned: true }) userId: number
  @Column({ name: 'roster_id', type: 'bigint', unsigned: true }) rosterId: number
  @Column({ type: 'varchar', length: 64, nullable: true }) sid: string | null
  @Column({ name: 'state_code', type: 'varchar', length: 16, default: 'invited' })
  state: ImCallMemberState
  @Column({ name: 'display_name', length: 64 }) displayName: string
  @Column({ length: 64 }) identity: string
  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3, nullable: true })
  lastSeenAt: Date | null
}

export const IM_CALL_ENTITIES = [ImCallEntity, ImCallMemberEntity]
