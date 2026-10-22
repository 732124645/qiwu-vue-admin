import { attendancePolicyPerms, attendanceSitePerms, clockPerms } from '@qiwu/shared'
import type { EntityManager } from 'typeorm'
import { tenantId } from '../../../core/context/tenant.js'
import { findRow, insertRow, upsert } from '../upsert.js'

/** 每个租户只补首份默认规则，不覆盖管理员的修改、停用或删除，不伪造打卡记录。 */
export async function seedOaAttendance(q: EntityManager): Promise<string[]> {
  if (await findRow(q, 'oa_attendance_policy', { tenant_id: tenantId() })) return []
  await insertRow(q, 'oa_attendance_policy', {
    enabled: 1,
    timezone: 'Asia/Shanghai',
    location_mode: 'none',
    retention_days: 180,
  })
  return []
}

/** 仅登记功能权限，页面接入前不创建空路由，也不静默授予普通员工管理权。 */
export async function seedOaAttendanceMenus(q: EntityManager): Promise<string[]> {
  const group = await findRow(q, 'iam_menu', { kind: 'group', route_name: 'oa' })
  if (!group) throw new Error('seedOaAttendanceMenus: office group is missing')
  if (group.deleted) return []
  for (const perms of [clockPerms, attendancePolicyPerms, attendanceSitePerms])
    for (const [i, [verb, code]] of Object.entries(perms).entries())
      await upsert(
        q,
        'iam_menu',
        { kind: 'action', perms: code },
        {},
        {
          parent_id: group.id,
          name: `menu.action.${verb}`,
          sort_no: (i + 1) * 10,
        },
      )
  return []
}

/** 只在平台首次补到期清理任务；调度、停用、改名和软删均由管理员保留。 */
export async function seedOaAttendanceJob(q: EntityManager): Promise<string[]> {
  await upsert(
    q,
    'job_task',
    { handler: 'oa.clock.retention' },
    {},
    {
      name: 'seed.task.clockRetention',
      group_code: 'system',
      params: {},
      cron: '0 15 4 * * *',
      misfire: 'run_once',
      timeout_ms: 600_000,
      enabled: process.env.NODE_ENV === 'test' ? 0 : 1,
    },
  )
  return []
}
