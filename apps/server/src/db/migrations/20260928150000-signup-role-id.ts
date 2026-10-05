import type { MigrationInterface, QueryRunner } from 'typeorm'

interface ParamRow {
  id: number
  param_value: string
  group_code: string | null
  is_builtin: number
  is_public: number
  is_secret: number
}

/** Keep the existing sign-up choice when moving from a mutable role code to its live id. */
export class SignupRoleId20260928150000 implements MigrationInterface {
  name = 'SignupRoleId20260928150000'

  async up(q: QueryRunner): Promise<void> {
    const [old] = (await q.query(
      "SELECT id, param_value, group_code, is_builtin, is_public, is_secret FROM cfg_param WHERE param_key = 'auth.signup.default_role_code'",
    )) as ParamRow[]
    if (!old) return
    const [current] = (await q.query(
      "SELECT id FROM cfg_param WHERE param_key = 'auth.signup.default_role_id'",
    )) as { id: number }[]
    if (!current) {
      const [role] = (await q.query(
        'SELECT id FROM iam_role WHERE code = ? AND deleted_at IS NULL LIMIT 1',
        [old.param_value],
      )) as { id: number }[]
      await q.query(
        `INSERT INTO cfg_param (param_key, param_value, name, name_i18n, group_code, is_builtin, is_public, is_secret)
         VALUES ('auth.signup.default_role_id', ?, ?, ?, ?, ?, ?, ?)`,
        [
          role ? String(role.id) : '',
          '注册默认角色 ID',
          JSON.stringify({ 'zh-CN': '注册默认角色 ID', 'en-US': 'Default sign-up role ID' }),
          old.group_code,
          old.is_builtin,
          old.is_public,
          old.is_secret,
        ],
      )
    }
    await q.query('DELETE FROM cfg_param WHERE id = ?', [old.id])
  }

  async down(q: QueryRunner): Promise<void> {
    const [current] = (await q.query(
      "SELECT id, param_value, group_code, is_builtin, is_public, is_secret FROM cfg_param WHERE param_key = 'auth.signup.default_role_id'",
    )) as ParamRow[]
    if (!current) return
    const [old] = (await q.query(
      "SELECT id FROM cfg_param WHERE param_key = 'auth.signup.default_role_code'",
    )) as { id: number }[]
    if (!old) {
      const [role] = (await q.query(
        'SELECT code FROM iam_role WHERE id = ? AND deleted_at IS NULL LIMIT 1',
        [current.param_value],
      )) as { code: string }[]
      await q.query(
        `INSERT INTO cfg_param (param_key, param_value, name, name_i18n, group_code, is_builtin, is_public, is_secret)
         VALUES ('auth.signup.default_role_code', ?, ?, ?, ?, ?, ?, ?)`,
        [
          role?.code ?? '',
          '注册默认角色代码',
          JSON.stringify({ 'zh-CN': '注册默认角色代码', 'en-US': 'Default sign-up role code' }),
          current.group_code,
          current.is_builtin,
          current.is_public,
          current.is_secret,
        ],
      )
    }
    await q.query('DELETE FROM cfg_param WHERE id = ?', [current.id])
  }
}
