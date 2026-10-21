import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import type { Principal } from '../../auth/principal.js'
import { tenantId } from '../../context/tenant.js'
import { AgentUsage } from '../entities/agent-usage.entity.js'
import type { ChatUsage } from '../provider/chat-model.js'

/** Today as the usage rows count it (UTC). */
export const usageDay = () => new Date().toISOString().slice(0, 10)

/**
 * 模型用量记账（see docs/agent.md）：每用户、每天（UTC）、每模型一行，限额与用量页都读它。轮次之外的
 * 模型调用（例如从会话生成技能）也经 {@link record} 记账，计入同一份每日限额。
 */
@Injectable()
export class UsageBook {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** 记一次模型调用（调用者的租户里）。 */
  record(p: Principal, model: string, u: ChatUsage): Promise<void> {
    return this.add(p.userId, model, u)
  }

  /**
   * 插入或累加当天那一行：唯一键以租户开头，冲突只会落在本租户本人的那一行（ORM 的 upsert 对租户表
   * 不可用，这里写明租户）。
   */
  async add(userId: number, model: string, u: ChatUsage): Promise<void> {
    await this.ds.query(
      `INSERT INTO agent_usage (tenant_id, user_id, day, model, calls, prompt_tokens, completion_tokens)
       VALUES (?, ?, ?, ?, 1, ?, ?) AS n
       ON DUPLICATE KEY UPDATE calls = agent_usage.calls + 1,
         prompt_tokens = agent_usage.prompt_tokens + n.prompt_tokens,
         completion_tokens = agent_usage.completion_tokens + n.completion_tokens`,
      [tenantId(), userId, usageDay(), model.slice(0, 128), u.promptTokens, u.completionTokens],
    )
  }

  /** 今日已用的 token：给了用户就是本人的，否则是本租户的。 */
  async usedToday(userId?: number): Promise<number> {
    const qb = this.ds
      .getRepository(AgentUsage)
      .createQueryBuilder('u')
      .select('COALESCE(SUM(u.promptTokens + u.completionTokens), 0)', 'n')
      .where('u.day = :day', { day: usageDay() })
    if (userId !== undefined) qb.andWhere('u.userId = :userId', { userId })
    return Number((await qb.getRawOne<{ n: string | number }>())?.n ?? 0)
  }
}
