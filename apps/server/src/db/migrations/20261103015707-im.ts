import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 员工即时通讯：会话、成员时期、按会话递增 seq 的消息事件、个人自定义表情。四张都是租户表，
 * 唯一键以 tenant_id 开头、以 alive 结尾；消息行从不软删（撤回只清内容，保留期物理删除）。
 */
export class Im20261103015707 implements MigrationInterface {
  name = 'Im20261103015707'

  /** 建四张表；公共审计列每张相同，生成列 alive 与 owner_one 只用于唯一约束，实体不映射。 */
  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE im_room (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL,1,NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      room_kind varchar(16) NOT NULL COMMENT '会话类型（direct 私聊 / group 群聊）',
      scope_code varchar(24) NOT NULL DEFAULT 'staff' COMMENT '会话范围（当前只有 staff 内部员工）',
      pair_low_id bigint unsigned NULL COMMENT '私聊较小的用户 ID（群聊为空）',
      pair_high_id bigint unsigned NULL COMMENT '私聊较大的用户 ID（群聊为空）',
      label varchar(80) NULL COMMENT '群名（私聊为空）',
      last_seq bigint unsigned NOT NULL DEFAULT 0 COMMENT '最后一条消息事件的 seq',
      floor_seq bigint unsigned NOT NULL DEFAULT 1 COMMENT '最早仍保留的 seq',
      last_entry_at datetime(3) NULL COMMENT '最后一条非编辑/撤回事件的时间（UTC，排序用）',
      meta_rev int unsigned NOT NULL DEFAULT 1 COMMENT '群名、成员、角色或解散变化的修订号',
      closed_at datetime(3) NULL COMMENT '解散时间（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_im_room_pair (tenant_id,scope_code,pair_low_id,pair_high_id,alive),
      KEY idx_im_room_tenant (tenant_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='即时通讯会话'`)
    await q.query(`CREATE TABLE im_roster (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL,1,NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      room_id bigint unsigned NOT NULL COMMENT '会话 ID',
      user_id bigint unsigned NOT NULL COMMENT '成员用户 ID',
      identity_kind varchar(16) NOT NULL DEFAULT 'admin' COMMENT '成员身份类型（当前只有 admin 内部员工）',
      role_code varchar(16) NOT NULL COMMENT '群角色（owner / moderator / participant）',
      member_label varchar(64) NOT NULL COMMENT '入会时姓名快照（用户删除后显示）',
      visible_from_seq bigint unsigned NOT NULL COMMENT '本时期可见的最小 seq',
      read_seq bigint unsigned NOT NULL DEFAULT 0 COMMENT '已读到的 seq',
      owner_one tinyint AS (IF(role_code = 'owner',1,NULL)) VIRTUAL COMMENT '群主唯一标识（每个会话至多一个群主）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_im_roster_member (tenant_id,room_id,user_id,alive),
      UNIQUE KEY uk_im_roster_owner (tenant_id,room_id,owner_one,alive),
      KEY idx_im_roster_user (tenant_id,user_id,deleted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='即时通讯会话成员时期'`)
    await q.query(`CREATE TABLE im_entry (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL,1,NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      room_id bigint unsigned NOT NULL COMMENT '会话 ID',
      seq bigint unsigned NOT NULL COMMENT '会话内递增序号',
      author_id bigint unsigned NULL COMMENT '发送人用户 ID（系统事件为空）',
      author_kind varchar(16) NULL COMMENT '发送人身份类型',
      author_label varchar(64) NULL COMMENT '发送时姓名快照',
      client_entry_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '客户端消息 ID（幂等）',
      request_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '规范化发送内容的 SHA-256',
      entry_kind varchar(16) NOT NULL COMMENT '类型（text / image / file / sticker / event）',
      text_value mediumtext NULL COMMENT '文字内容（纯文本）',
      sticker_code varchar(32) NULL COMMENT '内置表情编码',
      attachment json NULL COMMENT '附件信息（对象 ID、缩略图、名称、类型、大小、宽高、SHA-256）',
      event_data json NULL COMMENT '系统事件数据（编码、操作人、相关用户快照）',
      target_seq bigint unsigned NULL COMMENT '编辑/撤回事件指向的 seq',
      content_rev int unsigned NOT NULL DEFAULT 1 COMMENT '内容修订号（编辑 +1）',
      edited_at datetime(3) NULL COMMENT '最后编辑时间（UTC）',
      recalled_at datetime(3) NULL COMMENT '撤回时间（UTC）',
      recalled_by bigint unsigned NULL COMMENT '撤回人用户 ID',
      PRIMARY KEY (id),
      UNIQUE KEY uk_im_entry_seq (tenant_id,room_id,seq,alive),
      UNIQUE KEY uk_im_entry_client (tenant_id,room_id,author_id,client_entry_id,alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='即时通讯消息与系统事件'`)
    await q.query(`CREATE TABLE im_sticker (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL,1,NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      user_id bigint unsigned NOT NULL COMMENT '所属用户 ID',
      object_id bigint unsigned NOT NULL COMMENT '表情图片文件对象 ID',
      sha256 char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '规范化图片的 SHA-256',
      mime varchar(64) NOT NULL COMMENT '图片类型',
      width smallint unsigned NOT NULL COMMENT '宽（像素）',
      height smallint unsigned NOT NULL COMMENT '高（像素）',
      sort_no int NOT NULL DEFAULT 0 COMMENT '排序号',
      PRIMARY KEY (id),
      UNIQUE KEY uk_im_sticker_hash (tenant_id,user_id,sha256,alive),
      KEY idx_im_sticker_user (tenant_id,user_id,sort_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='即时通讯个人自定义表情'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE im_sticker')
    await q.query('DROP TABLE im_entry')
    await q.query('DROP TABLE im_roster')
    await q.query('DROP TABLE im_room')
  }
}
