import { Injectable } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  attendanceSiteCreate,
  attendanceSiteUpdate,
  type AttendanceSiteCreate,
  type AttendanceSiteUpdate,
  type AttendanceSiteQuery,
  type AttendanceSiteOptionQuery,
  type AttendanceSiteSnapshot,
  Err,
} from '@qiwu/shared'
import { BaseCrudService } from '../../../core/db/base-crud.service.js'
import { contains, paginate } from '../../../core/db/page.js'
import { BizError } from '../../../core/http/biz-error.js'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import type { SelectQueryBuilder } from 'typeorm'
import { AttendanceSite } from './site.entity.js'

/** 办公地点只做租户隔离，没有部门维度；员工的选项只含启用配置。 */
@Injectable()
export class AttendanceSiteService extends BaseCrudService<AttendanceSite> {
  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>) {
    super(txHost, AttendanceSite)
  }

  protected override filter(qb: SelectQueryBuilder<AttendanceSite>, query: AttendanceSiteQuery) {
    if (query.name) qb.andWhere('t.name LIKE :name', { name: contains(query.name) })
    if (query.enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled: query.enabled })
    return qb
  }

  /** 登录员工不需要管理权限，但不能枚举停用地点或完整管理审计信息。 */
  async options(query: AttendanceSiteOptionQuery) {
    const qb = this.scopedQb('t').andWhere('t.enabled = :enabled', { enabled: true })
    if (query.name) qb.andWhere('t.name LIKE :name', { name: contains(query.name) })
    const page = await paginate(qb, query)
    return { ...page, items: page.items.map(siteSnapshot) }
  }

  /** 严格验证并沿用通用 CRUD 的事务、软删除引用检查和租户过滤。 */
  async add(dto: AttendanceSiteCreate) {
    try {
      return await super.create(parseOr400(attendanceSiteCreate, dto))
    } catch (error) {
      return duplicateName(error)
    }
  }

  /** 更新先锁原地点；打卡读取同一地点的共享锁，修改不影响已保存快照。 */
  async change(id: number, dto: AttendanceSiteUpdate): Promise<void> {
    try {
      await super.update(id, parseOr400(attendanceSiteUpdate, dto))
    } catch (error) {
      duplicateName(error)
    }
  }
}

/** 快照只含固定办公配置，不带租户和管理审计字段。 */
export function siteSnapshot(row: AttendanceSite): AttendanceSiteSnapshot {
  return {
    id: row.id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    radiusM: row.radiusM,
    maxAccuracyM: row.maxAccuracyM,
  }
}

function duplicateName(error: unknown): never {
  if ((error as { driverError?: { code?: string } })?.driverError?.code === 'ER_DUP_ENTRY')
    throw new BizError(Err.CONFLICT)
  throw error
}
