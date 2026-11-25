import type { MigrationInterface, QueryRunner } from 'typeorm'

const ROUTES = [
  'agent',
  'agent-chat',
  'agent-batch',
  'agent-skill',
  'agent-setting',
  'agent-usage',
  'agent-automation',
]
const PERMS = [
  'agent.chat.use',
  'agent.batch.run',
  'agent.skill.browse',
  'agent.skill.create',
  'agent.skill.modify',
  'agent.skill.remove',
  'agent.instruction.modify',
  'agent.setting.browse',
  'agent.setting.modify',
  'agent.restriction.browse',
  'agent.restriction.modify',
  'agent.usage.browse',
  'agent.automation.use',
  'agent.automation.share',
]
const TEMPLATES = [
  'agent.turn.waiting',
  'agent.turn.completed',
  'agent.automation.result',
  'agent.automation.stopped',
]

/**
 * 退役已不随包提供的内置助手入口：菜单、权限、参数与消息模板软删，
 * 助手业务表与历史数据保留，回到带助手的版本时可由管理员重新配置。
 */
export class AgentRetire20261125040531 implements MigrationInterface {
  name = 'AgentRetire20261125040531'

  async up(q: QueryRunner): Promise<void> {
    // qw:cross-tenant 这些平台菜单被所有租户的角色与套餐引用；只退役固定的旧路由与权限。
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
    // 参数已无读取方，留着会在参数管理里显示成无名称的孤儿行。按前缀而非清单匹配，才能顺带清掉
    // 更早版本改名留下的旧键；agent 是保留域名，项目不会有自己的 agent.* 参数。
    await q.query(
      `UPDATE cfg_param SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP(3))
       WHERE param_key LIKE 'agent.%'`,
    )
    // 模板名称的翻译已移除，不退役会在模板管理里直接显示翻译键。
    for (const table of ['msg_inbox_template', 'msg_mail_template'])
      await q.query(
        // arch-allow: sql-concat 表名来自上方固定白名单。tenant: 平台表，无租户列。
        `UPDATE ${table} SET deleted_at = COALESCE(deleted_at, UTC_TIMESTAMP(3))
         WHERE code IN (?)`,
        [TEMPLATES],
      )
  }

  async down(): Promise<void> {
    // 不猜测管理员旧设置；回到带助手的版本后由其种子重新补齐入口与模板。
  }
}
