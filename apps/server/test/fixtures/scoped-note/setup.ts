// Fixture DDL (see docs/design-notes.md#data-scope): test-only tables live here, never in src migrations.
import type { DataSource } from 'typeorm'

const DDL = [
  `CREATE TABLE IF NOT EXISTS test_dept (
    id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Dept id',
    parent_id bigint unsigned NOT NULL DEFAULT 0 COMMENT 'Parent dept id, 0 = root',
    tree_path varchar(512) CHARACTER SET ascii NOT NULL COMMENT 'Ancestor ids incl. self, /1/5/9/',
    name varchar(64) NOT NULL COMMENT 'Dept name',
    deleted_at datetime(3) NULL COMMENT 'Soft-deleted at (UTC)',
    PRIMARY KEY (id),
    KEY idx_test_dept_tree_path (tree_path)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Test fixture: dept tree'`,
  `CREATE TABLE IF NOT EXISTS test_scoped_note (
    id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Note id',
    title varchar(100) NOT NULL COMMENT 'Title, unique among live rows',
    dept_id bigint unsigned NULL COMMENT 'Owning dept',
    created_by bigint unsigned NULL COMMENT 'Created by user id',
    created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Created at (UTC)',
    updated_by bigint unsigned NULL COMMENT 'Updated by user id',
    updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT 'Updated at (UTC)',
    deleted_at datetime(3) NULL COMMENT 'Soft-deleted at (UTC)',
    alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '1 while live, NULL once soft-deleted',
    PRIMARY KEY (id),
    UNIQUE KEY uk_test_scoped_note_title (title, alive),
    KEY idx_test_scoped_note_dept (dept_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Test fixture: data-scoped note'`,
  // links between notes: the reference registry's and the link helpers' fixture (core-db spec)
  `CREATE TABLE IF NOT EXISTS test_note_link (
    note_id bigint unsigned NOT NULL COMMENT 'Linking note id',
    target_id bigint unsigned NOT NULL COMMENT 'Linked note id',
    deleted_at datetime(3) NULL COMMENT 'Soft-deleted at (UTC)',
    PRIMARY KEY (note_id, target_id),
    KEY idx_test_note_link_target (target_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Test fixture: note links'`,
]

export const createScopedNoteTables = async (ds: DataSource) => {
  for (const sql of DDL) await ds.query(sql)
}

export const truncateScopedNoteTables = async (ds: DataSource) => {
  await ds.query('TRUNCATE TABLE test_scoped_note')
  await ds.query('TRUNCATE TABLE test_dept')
  await ds.query('TRUNCATE TABLE test_note_link')
}

export const dropScopedNoteTables = (ds: DataSource) =>
  ds.query('DROP TABLE IF EXISTS test_scoped_note, test_dept, test_note_link')
