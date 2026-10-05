import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Menus as a tree table (trees, `tree` template; see docs/design-notes.md#codegen): `iam_menu` gets `tree_path`
 * (`/1/5/9/`: the ancestors' ids and its own, ASCII, indexed for subtree prefixes, checked like
 * iam_dept's), filled from the parent chain of the rows already there; a row whose parent is missing counts
 * as top level. No default afterwards: every insert names its path (BaseTreeService, the seed helpers).
 */
export class IamMenuTree20260927150000 implements MigrationInterface {
  name = 'IamMenuTree20260927150000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE iam_menu
      ADD COLUMN tree_path varchar(512) CHARACTER SET ascii NOT NULL DEFAULT '/'
        COMMENT '祖先路径（含自身，如 /1/5/9/）' AFTER parent_id`)
    await q.query(`UPDATE iam_menu m JOIN (
      WITH RECURSIVE p (id, path) AS (
        SELECT c.id, CONCAT('/', c.id, '/') FROM iam_menu c
          LEFT JOIN iam_menu o ON o.id = c.parent_id
         WHERE o.id IS NULL
        UNION ALL
        SELECT c.id, CONCAT(p.path, c.id, '/') FROM iam_menu c JOIN p ON c.parent_id = p.id
      ) SELECT id, path FROM p
    ) x ON x.id = m.id SET m.tree_path = x.path`)
    await q.query(`ALTER TABLE iam_menu
      ALTER COLUMN tree_path DROP DEFAULT,
      ADD KEY idx_iam_menu_tree_path (tree_path),
      ADD CONSTRAINT ck_iam_menu_tree_path CHECK (tree_path REGEXP '^(/[0-9]{1,20})*/$')`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE iam_menu
      DROP CHECK ck_iam_menu_tree_path,
      DROP KEY idx_iam_menu_tree_path,
      DROP COLUMN tree_path`)
  }
}
