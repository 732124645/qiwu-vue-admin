import type { EntityManager } from 'typeorm'
import { tenantId } from '../../context/tenant.js'

/** 自动化每次会新开隐藏会话，风险必须按定义拦截，不能被新会话绕过。 */
export async function automationRecoveryRequired(
  m: EntityManager,
  automationId: number,
): Promise<boolean> {
  const rows = await m.query<unknown[]>(
    // qw:include-deleted 已有风险事实即使会话被软删也不能绕过自动化定义的暂停。
    `SELECT 1 FROM agent_thread t JOIN agent_automation_run r
       ON r.id = t.automation_run_id AND r.tenant_id = t.tenant_id
     WHERE r.automation_id = ? AND t.tenant_id = ? AND t.recovery_required = 1
       AND r.deleted_at IS NULL LIMIT 1`,
    [automationId, tenantId()],
  )
  return rows.length > 0
}
