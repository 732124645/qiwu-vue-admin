import { createHash } from 'node:crypto'
import { NotFoundException } from '@nestjs/common'
import { DEFAULT_TENANT_ID, Err } from '@qiwu/shared'
import type { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import type { EntityManager } from 'typeorm'
import { canonicalJson } from '../../../../core/guard/idempotent.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { featuresOf } from '../../iam/menu-tree.js'
import { packageMenuIds } from '../../iam/tenant-package/package-menus.js'
import { WxoaAccount } from './wxoa.entity.js'
import type { WxoaCaller } from './wxoa-gateway.js'

/** 取当前租户下存活且启用的公众号账号：不存在 404，已停用 B6011（内容与运营各服务共用）。 */
export async function activeAccount(
  txHost: TransactionHost<TransactionalAdapterTypeOrm>,
  id: number,
): Promise<WxoaCaller> {
  const row = await txHost.tx.getRepository(WxoaAccount).findOne({
    select: { id: true, appId: true, accountKind: true, enabled: true, tenantId: true },
    where: { id },
  })
  if (!row) throw new NotFoundException()
  if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
  return { id: row.id, appId: row.appId, accountKind: row.accountKind, tenantId: row.tenantId }
}

/**
 * 微信应答里的文本或编号：字符串原样返回，数字转成十进制串（微信示例里 msg_id、msg_data_id、
 * user_comment_id、create_time 都是数字；超过 2^53 的整数网关已保留为原始数字串），其余为空串。
 */
export const textOf = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint'
      ? String(v)
      : ''
/** 非空的上游编号（数字或字符串），否则 null。 */
export const stringId = (v: unknown): string | null => textOf(v) || null
/**
 * 发给微信的数字型编号：十进制串在安全整数范围内转成 number（官方要求 number），
 * 超出范围的保留字符串，避免精度丢失。
 */
export const wxNumber = (v: string): number | string =>
  /^\d{1,20}$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : v
export const jsonObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/**
 * 一次失败调用的 errcode：网关把未映射的放在 params.errcode，额度用尽映射成了 B6005（记 45009），
 * 其余已映射的拒绝记 -1；B6001（网络错误、超时、应答不可读）与非业务错误结果未知，返回 null。
 */
export function upstreamErrcode(err: unknown): number | null {
  if (!(err instanceof BizError)) return null
  if (typeof err.params.errcode === 'number') return err.params.errcode
  if (err.err.code === Err.WXOA_QUOTA_EXCEEDED.code) return 45009
  return err.err.code === Err.WXOA_UPSTREAM.code ? null : -1
}

/**
 * 草稿内容摘要：键排序后的 JSON 求 sha256。MySQL 的 JSON 列会重排对象键，按写入顺序算的摘要
 * 读回后就对不上，所以必须先规范化。
 */
export const draftDigest = (articles: unknown): string =>
  createHash('sha256').update(canonicalJson(articles)).digest('hex')

/**
 * 租户此刻能否使用公众号模块（回调落库、夜间粉丝同步等会调用微信的流程共用）：已启用、未删除、未到期；
 * 非默认租户还要多租户开关打开，且套餐覆盖公众号功能组（与会话的功能集同一判定 `featuresOf`）。
 * 只读平台表，不需要租户上下文。
 */
export async function wxoaTenantServes(
  tx: EntityManager,
  multiTenant: boolean,
  tid: number,
): Promise<boolean> {
  if (tid !== DEFAULT_TENANT_ID && !multiTenant) return false
  const [tenant] = await tx.query<unknown[]>(
    `SELECT 1 FROM iam_tenant WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW(3))`,
    [tid],
  )
  if (!tenant) return false
  const inPackage = await packageMenuIds(tx, tid)
  if (!inPackage) return true
  const menus = await tx.query<Parameters<typeof featuresOf>[0]>(
    `SELECT id, parent_id, enabled, perms, platform_only, kind, route_name FROM iam_menu
      WHERE deleted_at IS NULL`,
  )
  return featuresOf(menus, inPackage).includes('wxoa')
}
