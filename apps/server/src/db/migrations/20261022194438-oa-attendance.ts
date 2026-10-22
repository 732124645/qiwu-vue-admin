import type { MigrationInterface, QueryRunner } from 'typeorm'

/** 原生考勤与外部系统无关，按租户保存规则、办公地点和不可回填的原始打卡。 */
export class OaAttendance20261022194438 implements MigrationInterface {
  name = 'OaAttendance20261022194438'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE oa_attendance_policy (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '规则 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '是否允许原生打卡',
      timezone varchar(64) NOT NULL DEFAULT 'Asia/Shanghai' COMMENT '工作日 IANA 时区',
      location_mode varchar(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'none' COMMENT '定位模式（none/site）',
      retention_days smallint unsigned NOT NULL DEFAULT 180 COMMENT '原始记录保留天数',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oa_attendance_policy_tenant (tenant_id, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='原生考勤规则'`)

    await q.query(`CREATE TABLE oa_attendance_site (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '地点 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      name varchar(100) NOT NULL COMMENT '办公地点名称',
      latitude decimal(9,6) NOT NULL COMMENT '办公地点纬度',
      longitude decimal(9,6) NOT NULL COMMENT '办公地点经度',
      radius_m int unsigned NOT NULL COMMENT '允许半径（米）',
      max_accuracy_m int unsigned NOT NULL COMMENT '最大允许定位误差（米）',
      enabled tinyint NOT NULL DEFAULT 1 COMMENT '地点是否可打卡',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oa_attendance_site_name (tenant_id, name, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='原生考勤地点'`)

    await q.query(`CREATE TABLE oa_clock_record (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '打卡 ID',
      tenant_id bigint unsigned NOT NULL COMMENT '租户 ID',
      user_id bigint unsigned NOT NULL COMMENT '本人 ID',
      dept_id bigint unsigned NULL COMMENT '打卡时部门 ID 快照',
      work_date date NOT NULL COMMENT '按规则时区计算的工作日',
      action varchar(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '动作（check_in/check_out）',
      punched_at datetime(3) NOT NULL COMMENT '服务端处理时刻（UTC）',
      timezone varchar(64) NOT NULL COMMENT '本次工作日时区快照',
      policy_id bigint unsigned NOT NULL COMMENT '规则 ID',
      policy_snapshot json NOT NULL COMMENT '本次规则快照',
      site_id bigint unsigned NULL COMMENT '校验地点 ID',
      site_name varchar(100) NULL COMMENT '校验地点名称快照',
      distance_m int unsigned NULL COMMENT '距办公地点距离（米）',
      accuracy_m decimal(10,2) NULL COMMENT '本次声明的定位误差（米）',
      validation_result varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '本次校验结果',
      source varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'native' COMMENT '本系统原生来源',
      request_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '本人客户端请求标识',
      request_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '请求参数摘要',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '软删唯一索引标识',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oa_clock_record_day_action (tenant_id, user_id, work_date, action, alive),
      UNIQUE KEY uk_oa_clock_record_request (tenant_id, user_id, request_id, alive),
      KEY idx_oa_clock_record_dept_day (tenant_id, dept_id, work_date),
      KEY idx_oa_clock_record_retention (tenant_id, work_date, id),
      KEY idx_oa_clock_record_site (tenant_id, site_id),
      KEY idx_oa_clock_record_policy (tenant_id, policy_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='原生考勤打卡记录'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE oa_clock_record')
    await q.query('DROP TABLE oa_attendance_site')
    await q.query('DROP TABLE oa_attendance_policy')
  }
}
