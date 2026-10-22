import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  attendancePolicyCreate,
  attendancePolicyUpdate,
  type AttendancePolicyUpdate,
} from '@qiwu/shared'
import { parseOr400 } from '../../../core/http/validation.pipe.js'
import { AttendancePolicy } from './policy.entity.js'

/** 规则只能更新当前租户已初始化的单行，不能选择任意租户或另建一份规则。 */
@Injectable()
export class AttendancePolicyService {
  constructor(private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>) {}

  async current(): Promise<AttendancePolicy> {
    const row = await this.txHost.tx.getRepository(AttendancePolicy).findOneBy({})
    if (!row) throw new NotFoundException()
    return row
  }

  /** 配置更新持独占锁，与打卡的共享锁互斥，防止一次打卡混用两个版本。 */
  update(dto: AttendancePolicyUpdate): Promise<AttendancePolicy> {
    const input = parseOr400(attendancePolicyUpdate, dto)
    return this.txHost.withTransaction(async () => {
      const repo = this.txHost.tx.getRepository(AttendancePolicy)
      const row = await repo.findOne({ where: {}, lock: { mode: 'pessimistic_write' } })
      if (!row) throw new NotFoundException()
      const merged = parseOr400(attendancePolicyCreate, {
        enabled: row.enabled,
        timezone: row.timezone,
        locationMode: row.locationMode,
        retentionDays: row.retentionDays,
        ...input,
      })
      await repo.update(row.id, merged)
      return repo.findOneByOrFail({ id: row.id })
    })
  }
}
