/** 显式测试费率使一个输入或输出 Token 对应一个积分，不借测试模型绕开生产定价检查。 */
export const TEST_AGENT_PRICING = {
  input: '1000000',
  output: '1000000',
  cacheRead: null,
  cacheWrite: null,
  imageCredits: '4000',
} as const
import type { DataSource } from 'typeorm'

/** 回归夹具清理同一组用户的明细与汇总，避免删除用户后留下测试账目。 */
export async function clearAgentUsage(ds: DataSource, userIds: number[], tenantId = 1) {
  if (!userIds.length) return
  for (const table of ['agent_usage_entry', 'agent_usage'])
    await ds.query(`DELETE FROM ${table} WHERE tenant_id = ? AND user_id IN (?)`, [
      tenantId,
      userIds,
    ])
}
