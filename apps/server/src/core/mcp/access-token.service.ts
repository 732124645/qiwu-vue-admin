import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  type AccessTokenAdminVo,
  type AccessTokenCreate,
  type AccessTokenCreatedVo,
  type AccessTokenQuery,
  type AccessTokenVo,
  Err,
  MCP_TOKEN_MAX_PER_USER,
  MCP_TOKEN_PREFIX,
  type Page,
} from '@qiwu/shared'
import { Brackets, IsNull, type SelectQueryBuilder } from 'typeorm'
import { TENANT_LOOKUP, type TenantLookup } from '../auth/tenant-lookup.js'
import { TokenService } from '../auth/token.service.js'
import { allTenants, tenantId } from '../context/tenant.js'
import { contains, paginate } from '../db/page.js'
import { BizError } from '../http/biz-error.js'
import { McpRegistry } from './mcp-registry.js'
import { AccessToken } from './mcp.entity.js'

/** The digest stored for a token (hex SHA-256): tokens are 256 random server-made bits, a fast hash suffices. */
export const tokenDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

/** A token is well-formed when it is the prefix plus 43 base64url characters. */
const TOKEN_SHAPE = new RegExp(`^${MCP_TOKEN_PREFIX}[\\w-]{43}$`)

const iso = (d: Date | null) => (d ? d.toISOString() : null)

const toVo = (t: AccessToken): AccessTokenVo => ({
  id: Number(t.id),
  name: t.name,
  tokenHint: t.tokenHint,
  tools: t.tools,
  allowWrite: t.allowWrite,
  expiresAt: iso(t.expiresAt),
  lastUsedAt: iso(t.lastUsedAt),
  revokedAt: iso(t.revokedAt),
  createdAt: t.createdAt.toISOString(),
})

/** A usable token as the MCP endpoint sees it. */
export interface VerifiedToken {
  id: number
  userId: number
  tenantId: number
  tools: string[] | null
  allowWrite: boolean
}

/**
 * 个人访问令牌（see docs/mcp.md）：用户自建、明文只在创建时返回一次，库里存摘要；吊销与到期后
 * 永久失效。读写都走 ORM 的租户条件：个人路由在用户本人的租户里，租户管理员只看得到本租户的令牌。
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly registry: McpRegistry,
    private readonly sessions: TokenService,
    @Inject(TENANT_LOOKUP) private readonly tenants: TenantLookup,
  ) {}

  private get repo() {
    return this.txHost.tx.getRepository(AccessToken)
  }

  /**
   * 为用户新建令牌，返回带明文的一次性结果。允许的工具必须都已注册；列出写入类工具却未允许写入
   * 视为配置错误（422），免得用户以为令牌能写；每人有效令牌数有上限，防止无限签发长期凭据。
   * 计数与插入在同一事务里，先锁住用户行，并发的新建依次进行，不会一起越过上限。
   * `credVer`：验密之前读到的凭据版本（`TokenService.credVersion`）；插入后版本已变，说明期间用户改密、
   * 被重置或停用（其令牌已被吊销），刚建的令牌删掉并回 409，与登录签发会话的做法一致。
   * 租户同理：停用先提交租户行、再吊销该租户的令牌；插入若晚于那次吊销，提交后再读租户必然已不可用，
   * 同样删掉并回 409，令牌不会在租户重新启用后复活。
   */
  async create(
    userId: number,
    dto: AccessTokenCreate,
    credVer?: string,
  ): Promise<AccessTokenCreatedVo> {
    const tools = dto.tools ? [...new Set(dto.tools)] : null
    for (const name of tools ?? []) {
      const tool = this.registry.get(name)
      if (!tool) throw new BizError(Err.MCP_TOOL_UNKNOWN, { name })
      if (tool.kind === 'write' && !dto.allowWrite)
        throw new BizError(Err.MCP_WRITE_NOT_ALLOWED, { name })
    }
    const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const id = await this.txHost.withTransaction(async () => {
      // 锁本人的用户行，同一用户的并发新建在此排队；本租户条件写明
      await this.txHost.tx.query(
        // qw:no-data-scope 锁的是调用者本人的行，用于令牌计数，不是按部门查用户
        'SELECT id FROM iam_user WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL FOR UPDATE',
        [userId, tenantId()],
      )
      const live = await this.live(this.repo.createQueryBuilder('t'), new Date())
        .andWhere('t.user_id = :userId', { userId })
        .getCount()
      if (live >= MCP_TOKEN_MAX_PER_USER)
        throw new BizError(Err.MCP_TOKEN_LIMIT, { max: MCP_TOKEN_MAX_PER_USER })
      const saved = await this.repo.save(
        this.repo.create({
          userId,
          name: dto.name,
          tokenDigest: tokenDigest(token),
          tokenHint: token.slice(-4),
          tools,
          allowWrite: dto.allowWrite,
          expiresAt: dto.expiresInDays
            ? new Date(Date.now() + dto.expiresInDays * 86_400_000)
            : null,
          lastUsedAt: null,
          revokedAt: null,
        }),
      )
      return saved.id
    })
    if (
      (credVer !== undefined && (await this.sessions.credVersion(userId)) !== credVer) ||
      !(await this.tenants.active(tenantId()))
    ) {
      await this.repo.delete({ id })
      throw new BizError(Err.CONFLICT)
    }
    const row = await this.repo.findOneByOrFail({ id })
    return { ...toVo(row), token }
  }

  /** 用户自己的令牌（含已吊销、已过期），新的在前。 */
  async mine(userId: number): Promise<AccessTokenVo[]> {
    const rows = await this.repo.find({ where: { userId }, order: { id: 'DESC' }, take: 200 })
    return rows.map(toVo)
  }

  /** 吊销自己的一个令牌；不是自己的或不存在 → 404；已吊销的再吊销不报错。 */
  async revokeMine(userId: number, id: number): Promise<void> {
    const row = await this.repo.findOneBy({ id, userId })
    if (!row) throw new NotFoundException()
    await this.revokeRow(row)
  }

  /** 租户管理员：本租户的令牌分页，带所属用户的用户名与姓名。 */
  async page(query: AccessTokenQuery): Promise<Page<AccessTokenAdminVo>> {
    const qb = this.repo.createQueryBuilder('t')
    if (query.userId) qb.andWhere('t.user_id = :userId', { userId: query.userId })
    if (query.name) qb.andWhere('t.name LIKE :name', { name: contains(query.name) })
    const now = new Date()
    if (query.state === 'active') this.live(qb, now)
    else if (query.state === 'revoked') qb.andWhere('t.revoked_at IS NOT NULL')
    else if (query.state === 'expired')
      qb.andWhere('t.revoked_at IS NULL AND t.expires_at <= :now', { now })
    const { items, total } = await paginate(qb, query)
    const ids = [...new Set(items.map((t) => Number(t.userId)))]
    const users = ids.length
      ? await this.txHost.tx.query<{ id: number; username: string; display_name: string }[]>(
          // 令牌的所属用户只在本租户内查；删除用户时其令牌已随之软删除。
          // qw:no-data-scope 只取已在令牌列表里的行的用户名，令牌列表按租户而不按部门开放
          'SELECT id, username, display_name FROM iam_user WHERE id IN (?) AND tenant_id = ? AND deleted_at IS NULL',
          [ids, tenantId()],
        )
      : []
    const byId = new Map(users.map((u) => [Number(u.id), u]))
    return {
      items: items.map((t) => ({
        ...toVo(t),
        userId: Number(t.userId),
        username: byId.get(Number(t.userId))?.username ?? '',
        displayName: byId.get(Number(t.userId))?.display_name ?? '',
      })),
      total,
    }
  }

  /** 租户管理员吊销本租户的一个令牌；别的租户的令牌在租户条件下看不到 → 404。 */
  async revoke(id: number): Promise<void> {
    const row = await this.repo.findOneBy({ id })
    if (!row) throw new NotFoundException()
    await this.revokeRow(row)
  }

  /**
   * MCP 端点的令牌校验：形状不对、未知、已吊销、已过期或已删除都返回 null（同一个 401，不区分原因）。
   * 此时请求还没有租户，按摘要全局查找；摘要是全局唯一的随机值，命中的行决定租户。
   */
  async verify(token: string): Promise<VerifiedToken | null> {
    if (!TOKEN_SHAPE.test(token)) return null
    const digest = tokenDigest(token)
    // qw:cross-tenant 令牌本身决定租户，查找时还没有租户上下文；摘要全局唯一
    const row = await allTenants(() =>
      this.repo.findOneBy({ tokenDigest: digest, revokedAt: IsNull() }),
    )
    if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now())) return null
    // 最近使用时间按分钟记，避免每次调用都写一行
    if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000)
      // qw:cross-tenant 更新刚按摘要找到的那一行，租户即该行的租户
      await allTenants(() => this.repo.update({ id: row.id }, { lastUsedAt: new Date() }))
    return {
      id: Number(row.id),
      userId: Number(row.userId),
      tenantId: Number(row.tenantId),
      tools: row.tools,
      allowWrite: row.allowWrite,
    }
  }

  /** Narrows `qb` (alias `t`) to tokens usable at `now`: not revoked, not expired. */
  private live(qb: SelectQueryBuilder<AccessToken>, now: Date): SelectQueryBuilder<AccessToken> {
    return qb
      .andWhere('t.revoked_at IS NULL')
      .andWhere(
        new Brackets((w) =>
          w.where('t.expires_at IS NULL').orWhere('t.expires_at > :now', { now }),
        ),
      )
  }

  private async revokeRow(row: AccessToken): Promise<void> {
    if (row.revokedAt) return
    await this.repo.update({ id: row.id, revokedAt: IsNull() }, { revokedAt: new Date() })
  }
}
