import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { IM_INT_PARAMS, IM_STORAGE_TAGS, imEntryRef } from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { allTenants, withTenant } from '../../../core/context/tenant.js'
import { softDeleteRows } from '../../../core/db/references.js'
import { type JobContext, JobHandler } from '../../../core/scheduler/job-handler.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { lockRoom } from './im-access.js'

/** 每页扫描的会话数。 */
const ROOM_PAGE = 200
/** 每个事务最多删除的消息行（之后放锁再续）。 */
const IM_PURGE_BATCH = 500
/** 每条语句回收的未绑定上传数。 */
const UPLOAD_BATCH = 500

/**
 * 聊天清理（每日，see docs/im.md）：逐租户（停用、到期的也清）按保留期物理删除每个会话连续的过期前缀并
 * 推进 `floor_seq`、软删其绑定对象；回收 24 小时仍未绑定的上传。信号中止或任务锁丢失立即停，下轮续跑。
 */
@Injectable()
export class ImPurgeJob {
  private readonly logger = new Logger(ImPurgeJob.name)

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly params: ParamService,
  ) {}

  /**
   * 调度器不带租户上下文：先在 allTenants 下取全部未删除租户，再逐个租户在自己的上下文里清理。一个租户
   * 失败只记日志，其余照常；信号中止则整个任务立即停（已提交的批次保留，下轮从新的 floor_seq 续跑）。
   */
  @JobHandler('im.purge')
  async purge(_params: object, { signal, log }: JobContext): Promise<string> {
    signal.throwIfAborted()
    const { key, min, max, fallback } = IM_INT_PARAMS.retentionDays
    const days = await this.params.int(key, min, max, fallback)
    // qw:cross-tenant the purge runs over every live tenant (disabled and expired ones too), each in its own context below
    const tenants = await allTenants(() =>
      this.ds.query<{ id: number }[]>(
        'SELECT t.id FROM iam_tenant t WHERE t.deleted_at IS NULL ORDER BY t.id',
      ),
    )
    let entries = 0
    let uploads = 0
    for (const { id } of tenants) {
      signal.throwIfAborted()
      const tid = Number(id)
      try {
        // qw:cross-tenant the tenant's own rooms, entries and uploads
        const done = await withTenant(tid, () => this.purgeTenant(tid, days, signal))
        entries += done.entries
        uploads += done.uploads
      } catch (err) {
        signal.throwIfAborted()
        this.logger.error({ tenantId: tid, err }, 'im purge failed')
        log(`tenant ${tid}: failed`)
      }
    }
    return `${days ? `kept ${days} days, ${entries} entries deleted` : 'kept forever'}; ${uploads} unbound uploads recycled`
  }

  /** 当前租户：保留期大于 0 时按会话 id 分页清理过期前缀，然后回收未绑定上传。 */
  private async purgeTenant(
    tid: number,
    days: number,
    signal: AbortSignal,
  ): Promise<{ entries: number; uploads: number }> {
    let entries = 0
    for (let after = 0; days > 0;) {
      signal.throwIfAborted()
      const rooms = await this.ds.query<{ id: number; floor_seq: number }[]>(
        `SELECT id, floor_seq FROM im_room
          WHERE tenant_id = ? AND id > ? AND deleted_at IS NULL ORDER BY id LIMIT ?`,
        [tid, after, ROOM_PAGE],
      )
      if (!rooms.length) break
      after = Number(rooms.at(-1)!.id)
      for (const r of rooms)
        entries += await this.purgeRoom(tid, Number(r.id), Number(r.floor_seq), days, signal)
    }
    return { entries, uploads: await this.recycleUploads(tid, signal) }
  }

  /**
   * 一个会话：先不加锁点查 `seq = floor_seq` 那一行，未过期就跳过（不打扰正在聊天的会话）；过期则锁会话，
   * 从 floor_seq 起取 ≤500 行的**连续**过期前缀（遇到未过期或 seq 断开即停，不跳着删），物理删除这些行、
   * 软删它们绑定的对象、把 floor_seq 推进到前缀之后。满一批就放锁再来一批。返回删除的行数。
   */
  private async purgeRoom(
    tid: number,
    roomId: number,
    floorSeq: number,
    days: number,
    signal: AbortSignal,
  ): Promise<number> {
    let deleted = 0
    for (let floor = floorSeq; ;) {
      signal.throwIfAborted()
      const [head] = await this.ds.query<{ expired: number }[]>(
        `SELECT created_at < NOW(3) - INTERVAL ? DAY AS expired FROM im_entry
          WHERE tenant_id = ? AND room_id = ? AND seq = ? AND deleted_at IS NULL`,
        [days, tid, roomId, floor],
      )
      if (!head || !Number(head.expired)) return deleted
      const batch = await this.ds.transaction(async (tx) => {
        // 写会话的事务第一条语句就是锁会话：与发送互斥，floor_seq 以锁内读到的为准
        const from = Number((await lockRoom(tx, roomId)).floorSeq)
        const rows = await tx.query<{ seq: number; expired: number }[]>(
          `SELECT seq, created_at < NOW(3) - INTERVAL ? DAY AS expired FROM im_entry
            WHERE tenant_id = ? AND room_id = ? AND seq >= ? AND deleted_at IS NULL
            ORDER BY seq LIMIT ?`,
          [days, tid, roomId, from, IM_PURGE_BATCH],
        )
        let count = 0
        while (
          count < rows.length &&
          Number(rows[count]!.seq) === from + count &&
          Number(rows[count]!.expired)
        )
          count++
        if (!count) return { count, next: from }
        const to = from + count - 1
        const refs = Array.from({ length: count }, (_, i) => imEntryRef(roomId, from + i))
        const objects = await tx.query<{ id: number }[]>(
          `SELECT id FROM fs_object
            WHERE tenant_id = ? AND biz_tag = 'im.attachment' AND biz_ref IN (?) AND deleted_at IS NULL`,
          [tid, refs],
        )
        await softDeleteRows(
          tx,
          'fs_object',
          objects.map((o) => Number(o.id)),
        )
        await tx.query(
          `DELETE FROM im_entry
            WHERE tenant_id = ? AND room_id = ? AND seq BETWEEN ? AND ? AND deleted_at IS NULL`,
          [tid, roomId, from, to],
        )
        await tx.query(
          'UPDATE im_room SET floor_seq = ? WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL',
          [to + 1, tid, roomId],
        )
        return { count, next: to + 1 }
      })
      deleted += batch.count
      if (batch.count < IM_PURGE_BATCH) return deleted
      floor = batch.next
    }
  }

  /**
   * 回收 24 小时仍未绑定的聊天上传（软删，文件本体随存储保留期清理）。每批是一条条件更新：与发送/收藏时
   * `bindRefs` 的 `biz_ref IS NULL AND deleted_at IS NULL` 条件更新在同一行上互斥，谁先谁赢，已绑定的
   * 对象不会被误删。
   */
  private async recycleUploads(tid: number, signal: AbortSignal): Promise<number> {
    let recycled = 0
    for (;;) {
      signal.throwIfAborted()
      const res = await this.ds.query<{ affectedRows: number }>(
        `UPDATE fs_object SET deleted_at = CURRENT_TIMESTAMP(3)
          WHERE tenant_id = ? AND biz_tag IN (?) AND biz_ref IS NULL AND deleted_at IS NULL
            AND created_at < NOW(3) - INTERVAL 24 HOUR
          ORDER BY id LIMIT ?`,
        [tid, IM_STORAGE_TAGS, UPLOAD_BATCH],
      )
      recycled += res.affectedRows
      if (res.affectedRows < UPLOAD_BATCH) return recycled
    }
  }
}
