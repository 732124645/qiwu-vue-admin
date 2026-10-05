import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Sign-in bindings of third-party identities to users, WeChat mini program (`wx-mp`) first.
 * A live identity (provider, appid, openid) belongs to one user; a user has one live binding per provider
 * and app. Unbinding (and deleting the user) soft-deletes the row, which frees both keys. No foreign key
 * the user reference is registered in the iam module (cascade). WeChat ids are case-sensitive:
 * `ascii_bin`, so a lookup or a unique key never takes one openid for another.
 */
export class IamUserSocial20261001100000 implements MigrationInterface {
  name = 'IamUserSocial20261001100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE iam_user_social (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '绑定 ID',
      provider varchar(24) NOT NULL COMMENT '身份来源（wx-mp：微信小程序）',
      appid varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '应用 ID（小程序 AppID）',
      openid varchar(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '应用内用户标识（openid）',
      unionid varchar(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '开放平台用户标识（unionid，可空）',
      user_id bigint unsigned NOT NULL COMMENT '绑定的用户 ID',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '绑定时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC，软删 = 解绑）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_iam_user_social_openid (provider, appid, openid, alive),
      UNIQUE KEY uk_iam_user_social_user (user_id, provider, appid, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='用户第三方登录绑定'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE iam_user_social')
  }
}
