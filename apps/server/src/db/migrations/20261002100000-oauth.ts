import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * OAuth2 (see docs/design-notes.md#auth-sessions): clients and the users' remembered consents. A live `client_id` is unique;
 * a deleted one may be registered again (`alive`), so its sessions end when it is deleted or disabled
 * (SessionRevoker.revokeClient), authorization codes are bound to the row id and consents point at the row
 * id (`oauth_client.id`, not the string), soft-deleted with the client or the user (reference registry,
 * cascade). Client ids, secret hashes and scopes are case-sensitive ASCII (`ascii_bin`). Join-table style
 * consents (composite primary key, no `alive`): revived by `ON DUPLICATE KEY UPDATE deleted_at = NULL`.
 * No foreign keys.
 */
export class Oauth20261002100000 implements MigrationInterface {
  name = 'Oauth20261002100000'

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE TABLE oauth_client (
      id bigint unsigned NOT NULL AUTO_INCREMENT COMMENT '客户端编号',
      client_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '客户端标识（client_id，区分大小写）',
      secret_hash varchar(100) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '密钥 bcrypt 哈希（内置客户端为空）',
      name varchar(64) NOT NULL COMMENT '名称（种子为 seed.* 键）',
      logo_url varchar(512) NULL COMMENT '图标地址',
      grant_types json NOT NULL COMMENT '授权类型（authorization_code/refresh_token/client_credentials）',
      redirect_uris json NOT NULL COMMENT '回调地址（逐字精确匹配）',
      scopes json NOT NULL COMMENT '可申请的权限范围',
      auto_approve_scopes json NOT NULL COMMENT '免确认的权限范围',
      access_ttl_sec int NOT NULL DEFAULT 1800 COMMENT '访问令牌有效期（秒）',
      refresh_ttl_sec int NOT NULL DEFAULT 604800 COMMENT '刷新令牌有效期（秒，也是授权会话的绝对上限）',
      is_builtin tinyint(1) NOT NULL DEFAULT 0 COMMENT '是否内置（不可删）',
      enabled tinyint(1) NOT NULL DEFAULT 1 COMMENT '是否启用',
      created_by bigint unsigned NULL COMMENT '创建人 ID',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（UTC）',
      updated_by bigint unsigned NULL COMMENT '更新人 ID',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      alive tinyint AS (IF(deleted_at IS NULL, 1, NULL)) VIRTUAL COMMENT '未删除为 1、已删除为空（唯一索引用）',
      PRIMARY KEY (id),
      UNIQUE KEY uk_oauth_client_client_id (client_id, alive)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='OAuth2 客户端'`)
    await q.query(`CREATE TABLE oauth_consent (
      user_id bigint unsigned NOT NULL COMMENT '用户 ID',
      client_id bigint unsigned NOT NULL COMMENT '客户端编号（oauth_client.id）',
      scope varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '已同意的权限范围',
      expires_at datetime(3) NOT NULL COMMENT '记住授权到期时间（UTC）',
      created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '同意时间（UTC）',
      updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间（UTC）',
      deleted_at datetime(3) NULL COMMENT '删除时间（UTC）',
      PRIMARY KEY (user_id, client_id, scope),
      KEY idx_oauth_consent_client (client_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='OAuth2 用户授权记录'`)
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query('DROP TABLE oauth_consent, oauth_client')
  }
}
