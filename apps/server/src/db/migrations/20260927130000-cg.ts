import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Code generator config (see docs/design-notes.md#codegen): one `cg_table` row per imported table, one `cg_column`
 * row per imported column (deleted with its table). Table and column names only ever come from
 * information_schema; every identifier the templates write passes the whitelist of
 * `@qiwu/shared` codegen.schema.ts on save.
 * Beyond the base columns: `cg_table.options` holds with_export / with_import / with_options,
 * the menu icon and sort_no, the entity noun and page description texts (both languages);
 * `cg_column.column_default` (entity defaults, the "NOT NULL without default → required" rule),
 * `cg_column.sortable` (server sort + table column), `cg_column.label_i18n` (field labels in both
 * languages) and `cg_column.options` (per-column extras, e.g. a seeded-name search);
 * `uk_cg_column_field` keeps generated property names unique per table.
 */
export class Cg20260927130000 implements MigrationInterface {
  name = 'Cg20260927130000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE cg_table (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '生成配置 ID',
      table_name varchar(64) NOT NULL COMMENT '表名（取自 information_schema）',
      table_comment varchar(2048) NOT NULL DEFAULT '' COMMENT '表注释',
      group_code varchar(16) NOT NULL COMMENT '代码分组（platform/workflow/biz）',
      domain varchar(32) NOT NULL COMMENT '领域（权限、字段标签前缀，如 iam）',
      business varchar(64) NOT NULL COMMENT '业务名（kebab-case，如 position）',
      class_name varchar(64) NOT NULL COMMENT '类名（如 Position）',
      feature_name varchar(128) NOT NULL COMMENT '功能名（取自表注释）',
      feature_name_i18n json NULL COMMENT '多语言功能名（菜单名）',
      template varchar(12) NOT NULL DEFAULT 'crud' COMMENT '模板（crud/tree/master_sub）',
      parent_menu_route_name varchar(128) NULL COMMENT '父菜单 route_name（自然键，不存 ID）',
      tree_parent_col varchar(64) NULL COMMENT '树：父节点列',
      tree_label_col varchar(64) NULL COMMENT '树：显示列',
      master_table_id bigint unsigned NULL COMMENT '主子：主表配置 ID',
      sub_fk_col varchar(64) NULL COMMENT '主子：子表外键列',
      form_cols tinyint NOT NULL DEFAULT 1 COMMENT '表单列数（1/2/3）',
      with_detail_view tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否生成详情抽屉',
      readonly tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否只读页（日志类）',
      options json NULL COMMENT '其它选项（导出/导入/下拉接口、菜单图标与排序、实体名与页面描述）',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cg_table_name (table_name),
      KEY idx_cg_table_master (master_table_id),
      CONSTRAINT fk_cg_table_master FOREIGN KEY (master_table_id) REFERENCES cg_table (id) ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='代码生成表配置'`)

    await q.query(`CREATE TABLE cg_column (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '列配置 ID',
      table_id bigint unsigned NOT NULL COMMENT '生成配置 ID',
      column_name varchar(64) NOT NULL COMMENT '列名（取自 information_schema）',
      column_type text NOT NULL COMMENT '列类型（如 varchar(64)、decimal(10,2)）',
      column_comment varchar(1024) NOT NULL DEFAULT '' COMMENT '列注释（zh-CN 标签来源）',
      column_default text NULL COMMENT '列默认值（无默认值为空）',
      nullable tinyint(1) NOT NULL COMMENT '是否可空',
      is_pk tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否主键',
      is_auto_inc tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否自增',
      ts_type varchar(16) NOT NULL COMMENT 'TS 类型（string/number/boolean/Date/unknown）',
      field_name varchar(64) NOT NULL COMMENT '属性名（camelCase）',
      widget varchar(24) NOT NULL COMMENT '表单组件',
      in_list tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否列表列',
      in_form tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否表单项',
      in_query tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否查询条件',
      query_op varchar(8) NOT NULL DEFAULT 'eq' COMMENT '查询方式（eq/like/between）',
      sortable tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否可排序',
      required tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否必填',
      dict_code varchar(100) NULL COMMENT '字典编码',
      label_i18n json NULL COMMENT '多语言字段标签',
      options json NULL COMMENT '列的其它选项（如种子名称搜索）',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      example varchar(255) NULL COMMENT '示例值',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_cg_column_name (table_id, column_name),
      UNIQUE KEY uk_cg_column_field (table_id, field_name),
      CONSTRAINT fk_cg_column_table FOREIGN KEY (table_id) REFERENCES cg_table (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='代码生成列配置'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE cg_column, cg_table')
  }
}
