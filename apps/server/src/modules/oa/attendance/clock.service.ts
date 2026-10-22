import { createHash } from 'node:crypto'
import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  clockPunch,
  clockRequestId,
  Err,
  type AttendancePolicyCreate,
  type ClockMyQuery,
  type ClockPunch,
  type ClockRecordVo,
  type ClockTodayVo,
} from '@qiwu/shared'
import { clsGet } from '../../../core/context/cls.js'
import { tenantId } from '../../../core/context/tenant.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { paginate } from '../../../core/db/page.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { canonicalJson } from '../../../core/guard/idempotent.js'
import { AttendancePolicy } from './policy.entity.js'
import { AttendanceSite } from './site.entity.js'
import { ClockRecord } from './clock-record.entity.js'
import { ClockTime, distanceMeters, workDateAt } from './clock-time.js'
import { siteSnapshot } from './attendance-site.service.js'

const caller = () => clsGet('principal')!

/** 本人端不按角色部门范围取并集：每次 scopedQb 后固定本人，root 也没有代打卡入口。 */
@Injectable()
export class ClockService extends BaseCrudService<ClockRecord> {
  protected override scopeRules = []

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly clock: ClockTime,
  ) {
    super(txHost, ClockRecord)
  }

  /** 用户行作为跨设备串行锁；重试先读持久请求记录，再判断当前规则和工作日。 */
  async punch(dto: ClockPunch): Promise<ClockRecordVo> {
    const input = parseOr400(clockPunch, dto)
    const userId = this.self()
    const digest = createHash('sha256')
      .update(canonicalJson({ action: input.action, position: input.position ?? null }))
      .digest('hex')
    try {
      return await this.txHost.withTransaction(async () => {
        const tx = this.txHost.tx
        const users = await tx.query<{ id: number; deptId: number | null }[]>(
          // qw:no-data-scope 本人打卡锁只按认证身份和当前租户查询，不按管理员部门权限扩大身份。
          'SELECT id, dept_id AS deptId FROM iam_user WHERE id = ? AND tenant_id = ? AND enabled = 1 AND deleted_at IS NULL FOR UPDATE',
          [userId, tenantId()],
        )
        if (!users.length) throw new NotFoundException()
        const existing = await this.ownQb()
          .andWhere('t.request_id = :requestId', { requestId: input.requestId })
          .setLock('pessimistic_read')
          .getOne()
        if (existing) {
          if (existing.requestDigest !== digest) throw new BizError(Err.CONFLICT)
          return present(existing)
        }
        const policy = await tx
          .getRepository(AttendancePolicy)
          .findOne({ where: {}, lock: { mode: 'pessimistic_read' } })
        if (!policy) throw new NotFoundException()
        if (!policy.enabled) throw clockInvalid('disabled')
        let site: AttendanceSite | null = null
        let distance: number | null = null
        if (policy.locationMode === 'site') {
          if (!input.position) throw clockInvalid('position_required')
          site = await tx
            .getRepository(AttendanceSite)
            .findOne({ where: { id: input.position.siteId }, lock: { mode: 'pessimistic_read' } })
          if (!site) throw new NotFoundException()
          if (!site.enabled) throw clockInvalid('site_disabled')
          if (input.position.accuracyM > site.maxAccuracyM) throw clockInvalid('accuracy')
          distance = distanceMeters(
            input.position.latitude,
            input.position.longitude,
            Number(site.latitude),
            Number(site.longitude),
          )
          if (distance > site.radiusM) throw clockInvalid('outside')
        }
        // 等待所有锁之后才读取服务器时刻，跨午夜等待不能沿用进入请求时的日期。
        const now = this.clock.now()
        const workDate = workDateAt(now, policy.timezone)
        const records = await this.ownQb()
          .andWhere('t.work_date = :workDate', { workDate })
          .setLock('pessimistic_read')
          .getMany()
        if (records.some((row) => row.action === input.action)) throw new BizError(Err.CONFLICT)
        if (input.action === 'check_out') {
          const checkIn = records.find((row) => row.action === 'check_in')
          if (!checkIn) throw clockInvalid('check_in_required')
          if (now.getTime() <= checkIn.punchedAt.getTime()) throw clockInvalid('time_order')
        }
        const row = await this.repo.save(
          this.repo.create({
            userId,
            deptId: users[0]!.deptId,
            workDate,
            action: input.action,
            punchedAt: now,
            timezone: policy.timezone,
            policyId: policy.id,
            policySnapshot: {
              ...policyValues(policy),
              ...(site ? { site: siteSnapshot(site) } : {}),
            },
            siteId: site?.id ?? null,
            siteName: site?.name ?? null,
            distanceM: distance === null ? null : Math.round(distance),
            accuracyM: site ? input.position!.accuracyM.toFixed(2) : null,
            validationResult: site ? 'passed' : 'not_required',
            source: 'native',
            requestId: input.requestId,
            requestDigest: digest,
          }),
        )
        return present(row)
      })
    } catch (error) {
      // 持久唯一索引是应用串行锁之外的最后防线，冲突不转换为服务器错误。
      if ((error as { driverError?: { code?: string } })?.driverError?.code === 'ER_DUP_ENTRY')
        throw new BizError(Err.CONFLICT)
      throw error
    }
  }

  /** 今日按规则时区计算，并在一个读快照中返回本人签到、签退及可展示的规则摘要。 */
  today(): Promise<ClockTodayVo> {
    this.self()
    return this.txHost.withTransaction(async () => {
      const policy = await this.txHost.tx.getRepository(AttendancePolicy).findOneBy({})
      if (!policy) throw new NotFoundException()
      const now = this.clock.now()
      const workDate = workDateAt(now, policy.timezone)
      const rows = await this.ownQb().andWhere('t.work_date = :workDate', { workDate }).getMany()
      return {
        serverAt: now.toISOString(),
        workDate,
        policy: {
          id: policy.id,
          enabled: policy.enabled,
          timezone: policy.timezone,
          locationMode: policy.locationMode,
        },
        checkIn: rows.find((r) => r.action === 'check_in')
          ? present(rows.find((r) => r.action === 'check_in')!)
          : null,
        checkOut: rows.find((r) => r.action === 'check_out')
          ? present(rows.find((r) => r.action === 'check_out')!)
          : null,
      }
    })
  }

  /** 请求状态只按本人请求标识查询，移动端超时重试可以先查，不能探测其他人的结果。 */
  async request(requestId: string): Promise<ClockRecordVo> {
    this.self()
    const parsed = parseOr400(clockRequestId, requestId)
    const row = await this.ownQb()
      .andWhere('t.request_id = :requestId', { requestId: parsed })
      .getOne()
    if (!row) throw new NotFoundException()
    return present(row)
  }

  /** 日期和动作是唯一业务筛选项，分页输出必须显式投影，绝不序列化实体内部摘要。 */
  async mine(dto: ClockMyQuery) {
    this.self()
    const query = dto
    const qb = this.ownQb()
    if (query.workDateFrom) qb.andWhere('t.work_date >= :from', { from: query.workDateFrom })
    if (query.workDateTo) qb.andWhere('t.work_date <= :to', { to: query.workDateTo })
    if (query.action) qb.andWhere('t.action = :action', { action: query.action })
    const page = await paginate(qb, query)
    return { ...page, items: page.items.map(present) }
  }

  /** 代入别的租户是管理操作，不存在该租户的“本人打卡”身份。 */
  private self(): number {
    const p = caller()
    if (p.actingTenantId !== undefined || p.tenantId !== tenantId()) throw new NotFoundException()
    return p.userId
  }

  /** 固定 user_id 条件独立于角色、root 和 skipDataScope，角色范围不会扩大本人端点。 */
  private ownQb() {
    return this.scopedQb('t').andWhere('t.user_id = :clockMe', { clockMe: this.self() })
  }
}

function policyValues(row: AttendancePolicy | AttendancePolicyCreate): AttendancePolicyCreate {
  return {
    enabled: row.enabled,
    timezone: row.timezone,
    locationMode: row.locationMode,
    retentionDays: row.retentionDays,
  }
}

/** 显式输出字段是隐私边界：内部摘要、租户列和员工原始定位都不能进入任何响应。 */
function present(row: ClockRecord): ClockRecordVo {
  return {
    id: row.id,
    userId: row.userId,
    deptId: row.deptId,
    workDate: row.workDate,
    action: row.action,
    punchedAt: row.punchedAt.toISOString(),
    timezone: row.timezone,
    policyId: row.policyId,
    policySnapshot: policyValues(row.policySnapshot),
    siteId: row.siteId,
    siteName: row.siteName,
    siteSnapshot: row.policySnapshot.site ?? null,
    distanceM: row.distanceM,
    accuracyM: row.accuracyM,
    validationResult: row.validationResult,
    source: row.source,
    requestId: row.requestId,
  }
}

/** 状态原因只使用本地化键，不把用户坐标或上游异常文本写进日志和响应。 */
function clockInvalid(
  reason:
    | 'disabled'
    | 'position_required'
    | 'site_disabled'
    | 'accuracy'
    | 'outside'
    | 'check_in_required'
    | 'time_order',
): BizError {
  const keys = {
    disabled: 'validation.oa.clock_disabled',
    position_required: 'validation.oa.clock_position_required',
    site_disabled: 'validation.oa.clock_site_disabled',
    accuracy: 'validation.oa.clock_accuracy',
    outside: 'validation.oa.clock_outside',
    check_in_required: 'validation.oa.clock_check_in_required',
    time_order: 'validation.oa.clock_time_order',
  }
  return new BizError({ ...Err.VALIDATION_FAILED, status: 422, key: keys[reason] })
}
