import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  CLOCK_DAY_ABSENCE_LIMIT,
  DEFAULT_TIMEZONE,
  clockRecordVo,
  type ClockQuery,
  type ClockSummaryQuery,
  type ClockMySummaryQuery,
  type ClockDaySummaryVo,
  type ClockAbsenceVo,
} from '@qiwu/shared'
import { clsGet } from '../../../core/context/cls.js'
import { tenantId } from '../../../core/context/tenant.js'
import { dataScopeSql, SkipDataScope } from '../../../core/data-scope/data-scope.js'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { paginate } from '../../../core/db/page.js'
import { AttendancePolicy } from './policy.entity.js'
import { ClockRecord } from './clock-record.entity.js'
import { ClockTime, workDateAt } from './clock-time.js'
import { clockDayBounds } from './clock-report-time.js'

type Subject = {
  userId: number
  deptId: number | null
  employeeName: string | null
  deptName: string | null
}
type Fragment = { sql: string; params: unknown[] }
const pair = (row: { userId: number; deptId: number | null }) =>
  `${row.userId}:${row.deptId ?? 'null'}`

/** 管理查询保留发生时部门范围；本人查询固定认证身份，调部门后仍能看自己的历史。 */
@Injectable()
export class ClockQueryService extends BaseCrudService<ClockRecord> {
  constructor(
    tx: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly clock: ClockTime,
  ) {
    super(tx, ClockRecord)
  }

  /** 管理列表只读授权范围内的原始记录，输出经过白名单投影。 */
  async admin(query: ClockQuery) {
    const qb = this.scopedQb('t')
    if (query.userId) qb.andWhere('t.user_id = :userId', { userId: query.userId })
    if (query.deptId) qb.andWhere('t.dept_id = :deptId', { deptId: query.deptId })
    if (query.workDateFrom) qb.andWhere('t.work_date >= :from', { from: query.workDateFrom })
    if (query.workDateTo) qb.andWhere('t.work_date <= :to', { to: query.workDateTo })
    if (query.action) qb.andWhere('t.action = :action', { action: query.action })
    const page = await paginate(qb, query)
    return { ...page, items: await Promise.all(page.items.map((row) => this.present(row))) }
  }

  /** 详情沿用管理查看权限的数据范围，越界与不存在都返回404。 */
  async adminDetail(id: number) {
    return this.present(await this.get(id))
  }

  /** 本人详情显式固定本人，跳过部门范围仅为保留调部门之前的本人历史。 */
  @SkipDataScope()
  async mineDetail(id: number) {
    const row = await this.scopedQb('t')
      .andWhere('t.id = :id AND t.user_id = :me', { id, me: this.self() })
      .getOne()
    if (!row) throw new NotFoundException()
    return this.present(row)
  }

  /** 一个读快照内统计活动人员和批准区间，审批状态变化在下一次查询立即生效。 */
  summary(query: ClockSummaryQuery) {
    return this.day(query, false)
  }

  /** 本人零活动也返回一行；不把管理员花名册范围带入本人接口。 */
  mineSummary(query: ClockMySummaryQuery) {
    this.self()
    return this.day(query, true)
  }

  private self() {
    const p = clsGet('principal')
    if (!p || p.actingTenantId !== undefined || p.tenantId !== tenantId())
      throw new NotFoundException()
    return p.userId
  }

  /** 每个原记录、请假和出差分支使用同一认证身份或同一部门/owner过滤。 */
  private filters(alias: string, query: ClockSummaryQuery, scope: Fragment): Fragment {
    return {
      // arch-allow: sql-concat code-owned aliases and scoped predicate; tenant: SQL branches bind tenant_id separately.
      sql: `(${scope.sql}) AND (? IS NULL OR ${alias}.user_id = ?) AND (? IS NULL OR ${alias}.dept_id = ?)`,
      params: [
        ...scope.params,
        query.userId ?? null,
        query.userId ?? null,
        query.deptId ?? null,
        query.deptId ?? null,
      ],
    }
  }

  /** 活动人口来自事实表，不将没有历史雇佣信息的当前员工表当作全员出勤花名册。 */
  private activities(
    query: ClockSummaryQuery,
    own: boolean,
    workDate: string,
    start: Date,
    end: Date,
    absenceOnly = false,
  ): Fragment {
    const parts: string[] = []
    const params: unknown[] = []
    if (!absenceOnly) {
      const scope = own
        ? { sql: 'c.user_id = ?', params: [this.self()] }
        : dataScopeSql('c', { dept: 'dept_id', owner: 'user_id' })
      const s = this.filters('c', query, scope)
      parts.push(
        // arch-allow: sql-concat trusted scope and bound placeholders; tenant: tenant_id explicit, dataScopeSql uses recorded department/owner.
        `SELECT c.user_id AS userId,c.dept_id AS deptId FROM oa_clock_record c WHERE c.tenant_id=? AND c.deleted_at IS NULL AND ${s.sql} AND c.work_date = ? AND c.source = 'native'`,
      )
      params.push(tenantId(), ...s.params, workDate)
    }
    for (const [table, type] of [
      ['biz_leave_request', 'leave'],
      ['oa_trip_request', 'trip'],
    ] as const) {
      const scope = own
        ? { sql: 'a.user_id = ?', params: [this.self()] }
        : dataScopeSql('a', { dept: 'dept_id', owner: 'user_id' })
      const s = this.filters('a', query, scope)
      parts.push(
        // arch-allow: sql-concat fixed table and scope; tenant: tenant_id explicit, recorded department/owner scope.
        `SELECT a.user_id AS userId,a.dept_id AS deptId${absenceOnly ? `,'${type}' AS type,a.id AS sourceId,a.start_at AS startAt,a.end_at AS endAt` : ''} FROM ${table} a WHERE a.tenant_id=? AND a.deleted_at IS NULL AND ${s.sql} AND a.state = 'approved' AND a.start_at < ? AND a.end_at > ?`,
      )
      params.push(tenantId(), ...s.params, end, start)
    }
    return { sql: parts.join(absenceOnly ? ' UNION ALL ' : ' UNION '), params }
  }

  /** 日期仅选择不可变work_date；时区只决定假勤覆盖边界，绝不重分配历史打卡日期。 */
  private day(query: ClockSummaryQuery, own: boolean) {
    return this.txHost.withTransaction(async () => {
      const policy = await this.txHost.tx.getRepository(AttendancePolicy).findOneBy({})
      const timezone = query.timezone ?? policy?.timezone ?? DEFAULT_TIMEZONE
      const workDate = query.workDate ?? workDateAt(this.clock.now(), timezone)
      const bounds = clockDayBounds(workDate, timezone)
      const source = this.activities(query, own, workDate, bounds.start, bounds.end)
      const count = await this.txHost.tx.query<{ total: string }[]>(
        // arch-allow: sql-concat trusted activity branches and bound placeholders; tenant: every source branch binds tenant_id and applies data scope.
        `SELECT COUNT(*) AS total FROM (${source.sql}) subjects`,
        source.params,
      )
      let subjects = await this.txHost.tx.query<Subject[]>(
        // arch-allow: sql-concat trusted activity branches; tenant: every source and name join binds tenant_id. qw:no-data-scope 名称仅装饰已授权历史主体，不读取联系方式或按当前部门移动历史事实。
        `SELECT s.*,u.display_name AS employeeName,d.name AS deptName FROM (${source.sql}) s LEFT JOIN iam_user u ON u.id=s.userId AND u.tenant_id=? AND u.deleted_at IS NULL LEFT JOIN iam_dept d ON d.id=s.deptId AND d.tenant_id=? AND d.deleted_at IS NULL ORDER BY s.userId,s.deptId LIMIT ? OFFSET ?`,
        [
          ...source.params,
          tenantId(),
          tenantId(),
          query.pageSize,
          (query.page - 1) * query.pageSize,
        ],
      )
      let total = Number(count[0]?.total ?? 0)
      if (own && total === 0) {
        total = 1
        if (query.page === 1) {
          const p = clsGet('principal')!
          subjects = [
            {
              userId: this.self(),
              deptId: p.deptId,
              employeeName: p.username ?? null,
              deptName: p.deptName ?? null,
            },
          ]
        }
      }
      const items: ClockDaySummaryVo[] = subjects.map((s) => ({
        ...s,
        checkIn: null,
        checkOut: null,
        recordCount: 0,
        clockTimezones: [],
        absences: [],
        absenceCount: 0,
        absencesTruncated: false,
      }))
      if (items.length) await this.fillDay(items, query, own, workDate, bounds.start, bounds.end)
      return {
        workDate,
        timezone,
        dayStart: bounds.start.toISOString(),
        dayEnd: bounds.end.toISOString(),
        items,
        total,
      }
    })
  }

  /** 每页事实和假勤均重复相同范围过滤，窗口限制每个历史部门最多输出20条假勤。 */
  private async fillDay(
    items: ClockDaySummaryVo[],
    query: ClockSummaryQuery,
    own: boolean,
    workDate: string,
    start: Date,
    end: Date,
  ) {
    const map = new Map(items.map((s) => [pair(s), s]))
    const userIds = [...new Set(items.map((s) => s.userId))]
    const placeholders = userIds.map(() => '?').join(',')
    const roleScope = own
      ? { sql: 'c.user_id = ?', params: [this.self()] }
      : dataScopeSql('c', { dept: 'dept_id', owner: 'user_id' })
    const scope = this.filters('c', query, roleScope)
    const records = await this.txHost.tx.query<
      { userId: number; deptId: number | null; action: string; punchedAt: Date; timezone: string }[]
    >(
      // arch-allow: sql-concat trusted scope and bound placeholders; tenant: tenant_id explicit, dataScopeSql uses recorded department/owner.
      `SELECT c.user_id AS userId,c.dept_id AS deptId,c.action,c.punched_at AS punchedAt,c.timezone FROM oa_clock_record c WHERE c.tenant_id=? AND c.deleted_at IS NULL AND ${scope.sql} AND c.work_date=? AND c.source='native' AND c.user_id IN (${placeholders})`,
      [tenantId(), ...scope.params, workDate, ...userIds],
    )
    for (const row of records) {
      const item = map.get(pair(row))
      if (!item) continue
      item.recordCount++
      if (!item.clockTimezones.includes(row.timezone)) item.clockTimezones.push(row.timezone)
      if (row.action === 'check_in') item.checkIn = row.punchedAt.toISOString()
      else item.checkOut = row.punchedAt.toISOString()
    }
    const source = this.activities(query, own, workDate, start, end, true)
    const absences = await this.txHost.tx.query<
      (Subject &
        Omit<ClockAbsenceVo, 'state' | 'startAt' | 'endAt'> & {
          startAt: Date
          endAt: Date
          amount: number
        })[]
    >(
      // arch-allow: sql-concat trusted activity branches and bound placeholders; tenant: every source branch binds tenant_id and applies data scope.
      `SELECT ranked.* FROM (SELECT a.*,ROW_NUMBER() OVER(PARTITION BY userId,deptId ORDER BY startAt,type,sourceId) AS rn,COUNT(*) OVER(PARTITION BY userId,deptId) AS amount FROM (${source.sql}) a WHERE a.userId IN (${placeholders})) ranked WHERE rn <= ?`,
      [...source.params, ...userIds, CLOCK_DAY_ABSENCE_LIMIT],
    )
    for (const row of absences) {
      const item = map.get(pair(row))
      if (!item) continue
      item.absenceCount = Number(row.amount)
      item.absencesTruncated = item.absenceCount > CLOCK_DAY_ABSENCE_LIMIT
      item.absences.push({
        type: row.type,
        sourceId: row.sourceId,
        state: 'approved',
        startAt: new Date(Math.max(start.getTime(), row.startAt.getTime())).toISOString(),
        endAt: new Date(Math.min(end.getTime(), row.endAt.getTime())).toISOString(),
      })
    }
    for (const item of items) item.clockTimezones.sort()
  }

  /** 响应白名单剔除请求摘要和租户列；姓名只补充当前已授权记录中的主体。 */
  private async present(row: ClockRecord) {
    const names = await this.txHost.tx.query<
      { employeeName: string | null; deptName: string | null }[]
    >(
      // qw:no-data-scope 仅按已授权记录的user/dept快照和本租户取显示名，不读取其他员工资料。
      'SELECT u.display_name AS employeeName,d.name AS deptName FROM iam_user u LEFT JOIN iam_dept d ON d.id=? AND d.tenant_id=? AND d.deleted_at IS NULL WHERE u.id=? AND u.tenant_id=? AND u.deleted_at IS NULL',
      [row.deptId, tenantId(), row.userId, tenantId()],
    )
    const { enabled, timezone, locationMode, retentionDays } = row.policySnapshot
    return {
      ...clockRecordVo.parse({
        ...row,
        punchedAt: row.punchedAt.toISOString(),
        policySnapshot: { enabled, timezone, locationMode, retentionDays },
        siteSnapshot: row.policySnapshot.site ?? null,
      }),
      employeeName: names[0]?.employeeName ?? null,
      deptName: names[0]?.deptName ?? null,
    }
  }
}
