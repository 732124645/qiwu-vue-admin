import type { MigrationInterface, QueryRunner } from 'typeorm'

/** Settings: dictionaries, dictionary entries and runtime parameters (not soft-deleted). */
export class Cfg20260926100100 implements MigrationInterface {
  name = 'Cfg20260926100100'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE cfg_dict (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '字典 ID',
      code varchar(100) NOT NULL COMMENT '字典编码（点分，如 iam.gender）',
      name varchar(100) NOT NULL COMMENT '字典名称（无对应语言时显示）',
      name_i18n json NULL COMMENT '多语言名称',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cfg_dict_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='字典'`)

    await q.query(`CREATE TABLE cfg_dict_entry (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '字典项 ID',
      dict_code varchar(100) NOT NULL COMMENT '字典编码',
      value varchar(100) NOT NULL COMMENT '字典值',
      label varchar(100) NOT NULL COMMENT '标签（无对应语言时显示）',
      label_i18n json NULL COMMENT '多语言标签',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      tag_type varchar(12) NULL COMMENT '标签样式（primary/success/info/warning/danger）',
      css_class varchar(100) NULL COMMENT '样式类名',
      is_default tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否默认值',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cfg_dict_entry_value (dict_code, value)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='字典项'`)

    await q.query(`CREATE TABLE cfg_param (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '参数 ID',
      param_key varchar(128) NOT NULL COMMENT '参数键（点分，如 core.default_timezone）',
      param_value text NOT NULL COMMENT '参数值',
      name varchar(128) NOT NULL COMMENT '参数名称（无对应语言时显示）',
      name_i18n json NULL COMMENT '多语言名称',
      group_code varchar(64) NULL COMMENT '分组',
      is_builtin tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否内置',
      is_secret tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否敏感（界面掩码）',
      is_public tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否登录前可读',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cfg_param_key (param_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='参数'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE cfg_param, cfg_dict_entry, cfg_dict')
  }
}
