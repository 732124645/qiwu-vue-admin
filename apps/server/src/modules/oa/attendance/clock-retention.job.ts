import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import { DEFAULT_TENANT_ID, attendancePolicyCreate } from '@qiwu/shared'
import { AppConfigService } from '../../../core/config/config.module.js'
import { allTenants, withTenant } from '../../../core/context/tenant.js'
import { JobHandler, NO_PARAMS, type JobContext } from '../../../core/scheduler/job-handler.js'
import { ClockTime, workDateAt } from './clock-time.js'
import { clockCutoffDay, clockDayBounds } from './clock-report-time.js'

const BATCH = 500
const RUN_LIMIT = 5000

/** 平台定时清理只执行租户自己已保存的保留规则，不接受员工身份或任意删除参数。 */
@Injectable()
export class ClockRetentionJob {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly cfg: AppConfigService,
    private readonly clock: ClockTime,
  ) {}

  /** 每批重新锁规则并复查租户生命周期，延长保留期与清理并发时以锁内当前规则为准。 */
  @JobHandler('oa.clock.retention', NO_PARAMS)
  async run(_params: Record<string, never>, ctx: JobContext) {
    ctx.signal.throwIfAborted()
    let deleted = 0
    let cursor = 0
    // 按主键小页读取租户，不因固定前1000个租户而饿死后续租户，超时信号在页和批次之间检查。
    while (deleted < RUN_LIMIT) {
      ctx.signal.throwIfAborted()
      // qw:cross-tenant 平台调度从真实有效租户登记迭代，后续逐租户重入并再次校验生命周期。
      const tenants = await allTenants(() =>
        this.ds.query<{ id: number }[]>(
          'SELECT id FROM iam_tenant WHERE id>? AND enabled=1 AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>?) AND (?=1 OR id=?) ORDER BY id LIMIT 100',
          [cursor, this.clock.now(), this.cfg.get('APP_MULTI_TENANT') ? 1 : 0, DEFAULT_TENANT_ID],
        ),
      )
      if (!tenants.length) break
      for (const tenant of tenants) {
        cursor = tenant.id
        ctx.signal.throwIfAborted()
        if (deleted >= RUN_LIMIT) break
        // qw:cross-tenant 仅对上方受信登记中的单个租户清理，所有事实SQL仍显式限定tenant_id。
        await withTenant(tenant.id, async () => {
          while (deleted < RUN_LIMIT) {
            ctx.signal.throwIfAborted()
            const size = Math.min(BATCH, RUN_LIMIT - deleted)
            const amount = await this.ds.transaction(async (tx) => {
              const policies = await tx.query<
                { timezone: string; retentionDays: number; locationMode: string; enabled: number }[]
              >(
                'SELECT timezone,retention_days AS retentionDays,location_mode AS locationMode,enabled FROM oa_attendance_policy WHERE tenant_id=? AND deleted_at IS NULL FOR UPDATE',
                [tenant.id],
              )
              ctx.signal.throwIfAborted()
              const active = await tx.query<{ enabled: number; expiresAt: Date | null }[]>(
                'SELECT enabled,expires_at AS expiresAt FROM iam_tenant WHERE id=? AND deleted_at IS NULL FOR SHARE',
                [tenant.id],
              )
              // 取完所有锁再读时钟，等待租户锁时跨过到期瞬间也不能沿用旧时刻。
              const now = this.clock.now()
              const raw = policies[0]
              const parsed =
                raw && attendancePolicyCreate.safeParse({ ...raw, enabled: Boolean(raw.enabled) })
              const lifecycle = active[0]
              if (
                !lifecycle?.enabled ||
                (lifecycle.expiresAt && lifecycle.expiresAt.getTime() <= now.getTime()) ||
                (!this.cfg.get('APP_MULTI_TENANT') && tenant.id !== DEFAULT_TENANT_ID) ||
                !parsed?.success
              )
                return 0
              const policy = parsed.data
              const today = workDateAt(now, policy.timezone)
              const cutoffDay = clockCutoffDay(today, policy.retentionDays)
              // 日历条件之外再加UTC经过时间下界；时区切换和夏令时也不能删掉未满保留天数或当天记录。
              const elapsedCutoff = new Date(
                Math.min(
                  now.getTime() - Math.max(30, policy.retentionDays) * 86400000,
                  clockDayBounds(today, policy.timezone).start.getTime(),
                ),
              )
              const rows = await tx.query<{ id: number }[]>(
                // qw:no-data-scope 平台清理只执行已锁定租户规则，无员工角色身份。 qw:include-deleted 到期隐私清理包含已软删记录。
                'SELECT id FROM oa_clock_record WHERE tenant_id=? AND work_date<? AND punched_at<? ORDER BY work_date,id LIMIT ? FOR UPDATE',
                [tenant.id, cutoffDay, elapsedCutoff, size],
              )
              ctx.signal.throwIfAborted()
              if (!rows.length) return 0
              await tx.query(
                // arch-allow: sql-concat bound placeholder count; tenant: explicit tenant_id repeated. qw:no-data-scope 删除集合来自同事务本租户已锁定到期行。 qw:include-deleted 到期隐私清理包含已软删记录。
                `DELETE FROM oa_clock_record WHERE tenant_id=? AND work_date<? AND punched_at<? AND id IN (${rows.map(() => '?').join(',')})`,
                [tenant.id, cutoffDay, elapsedCutoff, ...rows.map((r) => r.id)],
              )
              ctx.signal.throwIfAborted()
              return rows.length
            })
            deleted += amount
            if (amount < size) break
          }
        })
      }
    }
    ctx.log(`attendance retention deleted=${deleted}`)
    return { deleted }
  }
}
