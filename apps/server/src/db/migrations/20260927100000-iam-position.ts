import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Positions: not soft-deleted. "Assigned positions cannot be deleted" is the
 * `position_id` foreign key (ON DELETE RESTRICT → errno 1451 → 409 `in_use`); user links are removed
 * with the user (users are soft-deleted, so no FK on `user_id`, like the other iam join tables).
 */
export class IamPosition20260927100000 implements MigrationInterface {
  name = 'IamPosition20260927100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE iam_position (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '岗位 ID',
      code varchar(64) NOT NULL COMMENT '岗位编码',
      name varchar(64) NOT NULL COMMENT '岗位名称（种子为 seed.* 键）',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_position_code (code),
      UNIQUE KEY uk_iam_position_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='岗位'`)

    await q.query(`CREATE TABLE iam_user_positions (
      user_id bigint unsigned NOT NULL COMMENT '用户 ID',
      position_id bigint unsigned NOT NULL COMMENT '岗位 ID',
      PRIMARY KEY (user_id, position_id),
      KEY idx_iam_user_positions_position (position_id),
      CONSTRAINT fk_iam_user_positions_position FOREIGN KEY (position_id)
        REFERENCES iam_position (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户岗位关联'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE iam_user_positions, iam_position')
  }
}
