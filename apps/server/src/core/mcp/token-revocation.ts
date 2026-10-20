import { Injectable, Module } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import type { DataSource } from 'typeorm'
import {
  KICKED,
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  SessionRevoker,
} from '../auth/session-revoker.js'
import { allTenants, withTenant } from '../context/tenant.js'
import { referencedBy } from '../db/references.js'

// 删除用户时其访问令牌一并软删除（列表与校验都只看未删除的行）
referencedBy('iam_user', { table: 'iam_access_token', column: 'user_id', cascade: true })

/**
 * 让用户的访问令牌随这些会话吊销原因永久失效：停用、删除、改密 / 重置密码、管理员踢下线、密码试错
 * 锁定。换手机号、解绑微信不在其列：它们不改变谁在用这个账号。
 */
export const TOKEN_REVOKING_REASONS: ReadonlySet<string> = new Set([
  'user_disabled',
  'user_removed',
  PASSWORD_CHANGED,
  PASSWORD_RESET,
  KICKED,
  'password_attempts',
])

/**
 * 访问令牌与现有会话吊销的联动（see docs/mcp.md）。不随 `APP_MCP` 加载与否变化：开关关着时改密或
 * 停用的用户，其令牌在开关重新打开后也不能复活。
 */
@Injectable()
export class McpTokenRevocation {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    revoker: SessionRevoker,
  ) {
    // again：新建令牌存好后才比较 credver，在第一轮与 credver 递增之间存下的令牌由第二轮吊销
    revoker.onRevokeUser(
      async (userId, reason) => {
        if (TOKEN_REVOKING_REASONS.has(reason)) await this.revokeUser(userId)
      },
      { again: true },
    )
    revoker.onRevokeTenant(async (tenantId) => {
      await this.revokeTenant(tenantId)
    })
  }

  /** 吊销用户全部未吊销的令牌；返回吊销数。 */
  async revokeUser(userId: number): Promise<number> {
    // 调用方可能在别的租户上下文里（平台人员进入租户后停用该租户的用户）；
    // qw:cross-tenant 用户 id 全局唯一，按 id 命中的只会是该用户所在租户的行
    const r = await allTenants(() =>
      this.ds.query<{ affectedRows: number }>(
        // qw:cross-tenant 按全局唯一的用户 id 吊销，不限当前上下文的租户
        `UPDATE iam_access_token SET revoked_at = CURRENT_TIMESTAMP(3)
          WHERE user_id = ? AND revoked_at IS NULL AND deleted_at IS NULL`,
        [userId],
      ),
    )
    return r.affectedRows
  }

  /** 租户停用或到期提前：吊销该租户全部令牌。 */
  async revokeTenant(tenantId: number): Promise<number> {
    // qw:cross-tenant 租户停用由平台在默认租户里执行，吊销的是被停用租户自己的行
    const r = await withTenant(tenantId, () =>
      this.ds.query<{ affectedRows: number }>(
        `UPDATE iam_access_token SET revoked_at = CURRENT_TIMESTAMP(3)
          WHERE tenant_id = ? AND revoked_at IS NULL AND deleted_at IS NULL`,
        [tenantId],
      ),
    )
    return r.affectedRows
  }
}

/** 常驻（与 `APP_MCP` 无关）：只注册令牌吊销钩子。 */
@Module({ providers: [McpTokenRevocation] })
export class CoreMcpTokenModule {}
