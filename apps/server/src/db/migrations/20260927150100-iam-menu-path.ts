import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Menu rules: the route path is unique among siblings (and among top-level menus), as a
 * DB constraint (errno 1062 → 409 `duplicate`): `path_key` = the path, NULL when empty (actions, external
 * links) so those never collide; like `alive`, a generated column the entity does not map.
 */
export class IamMenuPath20260927150100 implements MigrationInterface {
  name = 'IamMenuPath20260927150100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE iam_menu
      ADD COLUMN path_key varchar(255) AS (NULLIF(route_path, '')) VIRTUAL
        COMMENT '路由路径，空为 NULL（同级唯一用）' AFTER route_path,
      ADD UNIQUE KEY uk_iam_menu_path (parent_id, path_key)`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('ALTER TABLE iam_menu DROP KEY uk_iam_menu_path, DROP COLUMN path_key')
  }
}
