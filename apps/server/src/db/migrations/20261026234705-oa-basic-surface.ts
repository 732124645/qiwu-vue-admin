import type { MigrationInterface, QueryRunner } from 'typeorm'

const ROUTES = ['oa-clock-records', 'oa-attendance-policy', 'oa-attendance-sites']
const PERMS = [
  'oa.clock.browse',
  'oa.clock.view',
  'oa.attendance-policy.view',
  'oa.attendance-policy.modify',
  'oa.attendance-site.browse',
  'oa.attendance-site.view',
  'oa.attendance-site.create',
  'oa.attendance-site.modify',
  'oa.attendance-site.remove',
]

/** 退役旧公开版不再提供的入口与处理器，保留业务表及任务运行历史。 */
export class OaBasicSurface20261026234705 implements MigrationInterface {
  name = 'OaBasicSurface20261026234705'

  async up(q: QueryRunner): Promise<void> {
    // qw:cross-tenant 这些平台菜单被所有租户引用；只退役已移出当前包的固定旧权限。
    await q.query(
      `UPDATE iam_role_menus rm JOIN iam_menu m ON m.id = rm.menu_id
       SET rm.deleted_at = COALESCE(rm.deleted_at, UTC_TIMESTAMP(3))
       WHERE m.route_name IN (?) OR m.perms IN (?)`,
      [ROUTES, PERMS],
    )
    await q.query(
      `UPDATE iam_tenant_package_menus pm JOIN iam_menu m ON m.id = pm.menu_id
       SET pm.deleted_at = COALESCE(pm.deleted_at, UTC_TIMESTAMP(3))
       WHERE m.route_name IN (?) OR m.perms IN (?)`,
      [ROUTES, PERMS],
    )
    await q.query(
      `UPDATE iam_menu SET enabled = 0, visible = 0,
       deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP(3))
       WHERE route_name IN (?) OR perms IN (?)`,
      [ROUTES, PERMS],
    )
    // 处理器已不随包提供；保留原配置和历史，不让已启用的旧任务继续调用缺失代码。
    await q.query(
      `UPDATE job_task SET enabled = 0, deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP(3))
       WHERE handler = ?`,
      ['oa.clock.retention'],
    )
  }

  async down(): Promise<void> {
    // 不猜测管理员旧设置，也不在缺少处理器时复活任务；恢复旧版本后须显式重新配置。
  }
}
