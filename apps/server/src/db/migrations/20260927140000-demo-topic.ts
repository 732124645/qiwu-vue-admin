import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Generator demo, tree: knowledge topics, the `tree` template's G0 sample. `parent_id` (0 =
 * top level) + `tree_path` (`/1/5/9/`: the ancestors' ids and its own, ASCII, indexed for subtree
 * prefixes, checked like iam_dept's). Not soft-deleted: a topic is deleted for good once it has no
 * children. The column comments are the generator's zh-CN labels.
 */
export class DemoTopic20260927140000 implements MigrationInterface {
  name = 'DemoTopic20260927140000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE demo_topic (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主题 ID',
      parent_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '上级主题（0 为顶级）',
      tree_path varchar(512) CHARACTER SET ascii NOT NULL COMMENT '祖先路径（含自身，如 /1/5/9/）',
      title varchar(100) NOT NULL COMMENT '主题名称',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      KEY idx_demo_topic_parent (parent_id),
      KEY idx_demo_topic_tree_path (tree_path),
      CONSTRAINT ck_demo_topic_tree_path CHECK (tree_path REGEXP '^(/[0-9]{1,20})*/$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='知识主题（生成器示例）'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE demo_topic')
  }
}
