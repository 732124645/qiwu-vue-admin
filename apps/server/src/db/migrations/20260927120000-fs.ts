import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * File storage (see docs/design-notes.md#storage): storage backends (one primary, enforced by a generated column like
 * `alive`) and the stored objects. Objects are not soft-deleted: deleting one removes its file too.
 */
export class Fs20260927120000 implements MigrationInterface {
  name = 'Fs20260927120000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE fs_storage (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '存储 ID',
      name varchar(64) NOT NULL COMMENT '名称（种子为 seed.* 键）',
      driver varchar(8) NOT NULL COMMENT '驱动（local/s3）',
      is_primary tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否主存储',
      config json NULL COMMENT '驱动配置（s3 密钥经 SecretBox 加密）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      primary_one tinyint AS (IF(is_primary = 1, 1, NULL)) VIRTUAL COMMENT '主存储为 1、其余为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_fs_storage_name (name),
      UNIQUE KEY uk_fs_storage_primary (primary_one)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='文件存储'`)

    await q.query(`CREATE TABLE fs_object (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '文件 ID',
      storage_id bigint unsigned NOT NULL COMMENT '存储 ID',
      object_key varchar(512) CHARACTER SET ascii NOT NULL COMMENT '对象键（yyyy/MM/dd/<uuid>.<ext>）',
      original_name varchar(255) NOT NULL COMMENT '原始文件名（仅展示）',
      mime varchar(128) NOT NULL COMMENT '文件类型（按魔数识别）',
      size bigint unsigned NOT NULL COMMENT '大小（字节）',
      sha256 char(64) CHARACTER SET ascii NULL COMMENT 'SHA-256',
      is_public tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否公开（由业务标签决定）',
      public_url varchar(1024) NULL COMMENT '公开访问地址',
      biz_tag varchar(64) NOT NULL COMMENT '业务标签',
      biz_ref varchar(64) NULL COMMENT '业务引用（如 wf:<实例 ID>，供访问检查器）',
      uploader_id bigint unsigned NOT NULL COMMENT '上传人 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_fs_object_key (storage_id, object_key),
      KEY idx_fs_object_uploader (uploader_id),
      KEY idx_fs_object_biz (biz_tag, biz_ref),
      CONSTRAINT fk_fs_object_storage FOREIGN KEY (storage_id) REFERENCES fs_storage (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='文件对象'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE fs_object, fs_storage')
  }
}
