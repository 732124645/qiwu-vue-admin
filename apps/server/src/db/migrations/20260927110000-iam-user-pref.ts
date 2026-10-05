import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Per-user UI preferences, e.g. a list page's column settings under
 * `table.iam.position`. Rows go with a hard-deleted user (FK CASCADE); a soft-deleted user keeps them.
 */
export class IamUserPref20260927110000 implements MigrationInterface {
  name = 'IamUserPref20260927110000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE iam_user_pref (
      user_id bigint unsigned NOT NULL COMMENT '用户 ID',
      pref_key varchar(96) CHARACTER SET ascii NOT NULL COMMENT '偏好键（如 table.iam.position）',
      value json NOT NULL COMMENT '偏好值（按键族校验，≤ 8 KB）',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (user_id, pref_key),
      CONSTRAINT fk_iam_user_pref_user FOREIGN KEY (user_id)
        REFERENCES iam_user (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户界面偏好'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE iam_user_pref')
  }
}
