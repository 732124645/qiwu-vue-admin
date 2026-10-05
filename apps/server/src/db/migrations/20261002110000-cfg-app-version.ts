import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Published App versions for the mobile update check (`wgt` resource hot update or `full` package).
 * One live row per platform and version (`alive`): a version is either a wgt or a full package, never both,
 * so the check stays "highest enabled version wins". Versions are dotted numbers in ASCII.
 */
export class CfgAppVersion20261002110000 implements MigrationInterface {
  name = 'CfgAppVersion20261002110000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE cfg_app_version (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '版本 ID',
      platform varchar(16) NOT NULL COMMENT '平台（android/ios）',
      package_kind varchar(8) NOT NULL COMMENT '包类型（wgt：资源热更新包，full：整包）',
      version varchar(24) CHARACTER SET ascii NOT NULL COMMENT '版本号（如 1.2.0）',
      native_min varchar(24) CHARACTER SET ascii NULL COMMENT '热更新包要求的最低原生版本（空为不限）',
      url varchar(1024) NOT NULL COMMENT '下载地址（https；整包为应用商店或安装包链接）',
      is_forced tinyint(1) NOT NULL DEFAULT 0 COMMENT '强制更新',
      notes text NULL COMMENT '更新说明',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '发布状态',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cfg_app_version (platform, version, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='App 版本'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE cfg_app_version')
  }
}
