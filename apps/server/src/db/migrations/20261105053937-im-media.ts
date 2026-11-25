import type { MigrationInterface, QueryRunner } from 'typeorm'

/** 员工通话与成员时期；结束和媒体清理分别持久化，未知创建不会丢掉后续收敛线索。 */
export class ImMedia20261105053937 implements MigrationInterface {
  name = 'ImMedia20261105053937'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE im_call (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL,1,NULL)) VIRTUAL COMMENT '软删唯一标识',
      room_id bigint unsigned NOT NULL COMMENT '业务聊天房间 ID',
      caller_id bigint unsigned NOT NULL COMMENT '发起员工 ID',
      client_call_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '客户端稳定请求 ID',
      mode_code varchar(16) NOT NULL COMMENT '媒体类型（audio / video）',
      state_code varchar(16) NOT NULL DEFAULT 'ringing' COMMENT '业务状态（ringing / active / ending / ended）',
      media_room varchar(160) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '永不复用的独立媒体房间名',
      media_status varchar(16) NOT NULL DEFAULT 'intent' COMMENT '媒体状态（intent / creating / ready / unknown / closing / closed）',
      media_operation_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '创建意图认领编号',
      create_in_flight tinyint NOT NULL DEFAULT 0 COMMENT '仍有未决创建请求，远端不存在不能直接结案',
      create_started_at datetime(3) NULL COMMENT '创建请求认领时间（UTC）',
      checked_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '最近收敛检查时间（UTC）',
      invite_expires_at datetime(3) NOT NULL COMMENT '邀请截止时间（UTC）',
      started_at datetime(3) NULL COMMENT '首次业务接通时间（UTC）',
      ending_at datetime(3) NULL COMMENT '业务授权停止时间（UTC），不计入后续媒体清理等待',
      ended_at datetime(3) NULL COMMENT '确认清理后的结束时间（UTC）',
      end_reason varchar(32) NULL COMMENT '结束原因编码',
      revision int unsigned NOT NULL DEFAULT 1 COMMENT '业务修订号',
      summary_seq bigint unsigned NULL COMMENT '唯一终局摘要消息 seq',
      active_room_id bigint unsigned AS (IF(deleted_at IS NULL AND state_code <> 'ended',room_id,NULL)) VIRTUAL COMMENT '媒体清理确认前保留房间槽',
      PRIMARY KEY (id),
      UNIQUE KEY uk_im_call_client (tenant_id,room_id,caller_id,client_call_id,alive),
      UNIQUE KEY uk_im_call_room (tenant_id,active_room_id,alive),
      UNIQUE KEY uk_im_call_media (tenant_id,media_room),
      KEY idx_im_call_due (state_code,checked_at,id),
      KEY idx_im_call_state (tenant_id,state_code,id),
      KEY idx_im_call_room (tenant_id,room_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='员工音视频通话'`)
    await q.query(`CREATE TABLE im_call_member (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL,1,NULL)) VIRTUAL COMMENT '软删唯一标识',
      call_id bigint unsigned NOT NULL COMMENT '通话 ID',
      user_id bigint unsigned NOT NULL COMMENT '员工 ID',
      roster_id bigint unsigned NOT NULL COMMENT '本次邀请绑定的成员时期',
      sid varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '首次接受时绑定的活会话编号',
      state_code varchar(16) NOT NULL DEFAULT 'invited' COMMENT '参与状态（invited / accepted / left / declined）',
      display_name varchar(64) NOT NULL COMMENT '邀请时姓名快照',
      identity varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '媒体参与者身份',
      last_seen_at datetime(3) NULL COMMENT '最后合法心跳（UTC）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_im_call_member (tenant_id,call_id,user_id,alive),
      KEY idx_im_call_member_user (tenant_id,user_id,call_id),
      KEY idx_im_call_member_sid (sid,tenant_id,call_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='员工通话邀请及会话绑定'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE im_call_member')
    await q.query('DROP TABLE im_call')
  }
}
