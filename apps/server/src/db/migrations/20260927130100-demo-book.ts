import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Generator demo, single table: books, soft-deleted (ISBN unique among live rows via
 * `alive`). `genre` holds a `demo.genre` dict value (seeded by db/seeds/demo); `dept_id` (optional)
 * makes the generated module data-scoped (see docs/design-notes.md#data-scope), so the G0 sample covers that path. The column
 * comments are the generator's zh-CN labels.
 */
export class DemoBook20260927130100 implements MigrationInterface {
  name = 'DemoBook20260927130100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE demo_book (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '图书 ID',
      isbn varchar(20) NOT NULL COMMENT 'ISBN',
      title varchar(200) NOT NULL COMMENT '书名',
      author varchar(100) NULL COMMENT '作者',
      cover_url varchar(512) NULL COMMENT '封面图片地址',
      published_on date NULL COMMENT '出版日期',
      price decimal(10,2) NOT NULL DEFAULT 0.00 COMMENT '定价（元）',
      genre varchar(16) NOT NULL COMMENT '分类（字典 demo.genre）',
      dept_id bigint unsigned NULL COMMENT '所属部门 ID（数据权限）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_demo_book_isbn (isbn, alive),
      CONSTRAINT fk_demo_book_dept FOREIGN KEY (dept_id) REFERENCES iam_dept (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='图书（生成器示例）'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE demo_book')
  }
}
