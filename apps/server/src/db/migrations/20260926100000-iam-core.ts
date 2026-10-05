import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Identity core: users, roles, menus, depts and their join tables.
 * Positions (iam_position, iam_user_positions) arrive in a later migration. Column comments are the codegen zh-CN labels.
 */
export class IamCore20260926100000 implements MigrationInterface {
  name = 'IamCore20260926100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE iam_user (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '用户 ID',
      username varchar(64) NOT NULL COMMENT '登录名',
      password_hash varchar(100) NOT NULL COMMENT '密码哈希（bcrypt）',
      display_name varchar(64) NOT NULL COMMENT '显示名',
      dept_id bigint unsigned NULL COMMENT '所属部门 ID',
      email varchar(128) NULL COMMENT '邮箱',
      mobile varchar(32) NULL COMMENT '手机号',
      gender varchar(8) NOT NULL DEFAULT 'unknown' COMMENT '性别（字典 iam.gender）',
      avatar_url varchar(512) NULL COMMENT '头像地址',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      locale varchar(10) NULL COMMENT '界面语言（zh-CN/en-US）',
      timezone varchar(64) NULL COMMENT '时区（IANA，登录时由 X-Timezone 写入）',
      user_type varchar(16) NOT NULL DEFAULT 'admin' COMMENT '用户类型',
      last_login_ip varchar(64) NULL COMMENT '最后登录 IP',
      last_login_at datetime(3) NULL COMMENT '最后登录时间（UTC）',
      password_changed_at datetime(3) NULL COMMENT '密码修改时间（UTC；为空则首次登录须改密）',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_user_username (username, alive),
      UNIQUE KEY uk_iam_user_mobile (mobile, alive),
      UNIQUE KEY uk_iam_user_email (email, alive),
      KEY idx_iam_user_dept (dept_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户'`)

    await q.query(`CREATE TABLE iam_role (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '角色 ID',
      name varchar(64) NOT NULL COMMENT '角色名（种子为 seed.* 键）',
      code varchar(64) NOT NULL COMMENT '角色编码（root 为超级管理员）',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      data_scope varchar(24) NOT NULL COMMENT '数据范围（字典 iam.data_scope）',
      menu_link tinyint(1) NOT NULL DEFAULT 1 COMMENT '菜单授权树父子联动',
      dept_link tinyint(1) NOT NULL DEFAULT 1 COMMENT '部门授权树父子联动',
      is_builtin tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否内置',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      note varchar(500) NULL COMMENT '备注',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_role_code (code, alive),
      UNIQUE KEY uk_iam_role_name (name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色'`)

    await q.query(`CREATE TABLE iam_menu (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '菜单 ID',
      parent_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '上级菜单 ID（0 为顶级）',
      kind varchar(8) NOT NULL COMMENT '类型（字典 iam.menu_kind）',
      name varchar(128) NOT NULL COMMENT '名称（i18n 键或原文）',
      name_i18n json NULL COMMENT '多语言名称',
      route_path varchar(255) NOT NULL DEFAULT '' COMMENT '路由路径',
      component varchar(255) NULL COMMENT '视图组件（src/views 下的路径，无扩展名）',
      component_name varchar(128) NULL COMMENT '组件名（页面缓存用）',
      route_name varchar(128) NULL COMMENT '路由名',
      route_query varchar(255) NULL COMMENT '路由参数',
      link_type varchar(8) NOT NULL DEFAULT 'route' COMMENT '链接方式（route/iframe/external）',
      link_url varchar(512) NULL COMMENT '链接地址',
      perms varchar(128) NULL COMMENT '权限点',
      icon varchar(64) NULL COMMENT '图标',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      visible tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否显示',
      keep_alive tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否缓存页面',
      always_show tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否总是显示目录',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_menu_route_name (route_name),
      KEY idx_iam_menu_parent (parent_id),
      KEY idx_iam_menu_perms (perms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='菜单'`)

    // tree_path always ends with '/' so a `LIKE '/1/2/%'` prefix never matches /1/23/ (see docs/design-notes.md#data-scope)
    await q.query(`CREATE TABLE iam_dept (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '部门 ID',
      parent_id bigint unsigned NOT NULL DEFAULT 0 COMMENT '上级部门 ID（0 为顶级）',
      tree_path varchar(512) CHARACTER SET ascii NOT NULL COMMENT '祖先路径（含自身，如 /1/5/9/）',
      name varchar(64) NOT NULL COMMENT '部门名（种子为 seed.* 键）',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      head_user_id bigint unsigned NULL COMMENT '负责人用户 ID',
      phone varchar(32) NULL COMMENT '联系电话',
      email varchar(128) NULL COMMENT '邮箱',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_dept_name (parent_id, name, alive),
      KEY idx_iam_dept_tree_path (tree_path),
      CONSTRAINT ck_iam_dept_tree_path CHECK (tree_path REGEXP '^(/[0-9]{1,20})*/$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='部门'`)

    await q.query(`CREATE TABLE iam_user_roles (
      user_id bigint unsigned NOT NULL COMMENT '用户 ID',
      role_id bigint unsigned NOT NULL COMMENT '角色 ID',
      PRIMARY KEY (user_id, role_id),
      KEY idx_iam_user_roles_role (role_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户角色关联'`)

    await q.query(`CREATE TABLE iam_role_menus (
      role_id bigint unsigned NOT NULL COMMENT '角色 ID',
      menu_id bigint unsigned NOT NULL COMMENT '菜单 ID',
      PRIMARY KEY (role_id, menu_id),
      KEY idx_iam_role_menus_menu (menu_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色菜单关联'`)

    await q.query(`CREATE TABLE iam_role_depts (
      role_id bigint unsigned NOT NULL COMMENT '角色 ID',
      dept_id bigint unsigned NOT NULL COMMENT '部门 ID',
      PRIMARY KEY (role_id, dept_id),
      KEY idx_iam_role_depts_dept (dept_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='角色数据范围部门关联'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(
      'DROP TABLE iam_role_depts, iam_role_menus, iam_user_roles, iam_dept, iam_menu, iam_role, iam_user',
    )
  }
}
