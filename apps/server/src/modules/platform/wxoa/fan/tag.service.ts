import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { Err, WXOA_TAGS_MAX, type WxoaTagCreate, type WxoaTagVo } from '@qiwu/shared'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { tenantId } from '../../../../core/context/tenant.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { WxoaAccount, WxoaTag } from '../core/wxoa.entity.js'
import { type WxoaCaller, type WxoaJson, WxoaGateway } from '../core/wxoa-gateway.js'
import { untagFans } from './fan.service.js'

/** Tags WeChat keeps for itself (per its documentation): never renamed or deleted. */
const RESERVED = new Set([0, 1, 2])
const TAG_MAX = 4_294_967_295

const vo = (t: WxoaTag): WxoaTagVo => ({
  id: t.id,
  accountId: t.accountId,
  tagId: t.tagId,
  name: t.name,
  fanCount: t.fanCount,
})

/** `tags/get`'s list: well-formed entries only. */
function tagsOf(answer: WxoaJson): { tagId: number; name: string; fanCount: number }[] {
  const list = Array.isArray(answer.tags) ? (answer.tags as WxoaJson[]) : []
  return list.flatMap((t) =>
    t &&
    Number.isInteger(t.id) &&
    (t.id as number) >= 0 &&
    (t.id as number) <= TAG_MAX &&
    typeof t.name === 'string' &&
    t.name
      ? [
          {
            tagId: t.id as number,
            name: [...t.name].slice(0, 30).join(''),
            fanCount: Math.min(Math.max(Math.trunc(Number(t.count)) || 0, 0), TAG_MAX),
          },
        ]
      : [],
  )
}

/**
 * Fan tags of the accounts (see docs/design-notes.md#wxoa), mirrored from WeChat: every change is made
 * there first. At most {@link WXOA_TAGS_MAX} per account; WeChat's reserved tags stay as they are. A
 * deleted tag leaves its fans; a sync replaces the local tags with WeChat's. Every route goes through
 * the account: alive (404) and enabled (`B6011`).
 */
@Injectable()
export class WxoaTagService extends BaseCrudService<WxoaTag> {
  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
  ) {
    super(txHost, WxoaTag)
  }

  async list(accountId: number): Promise<WxoaTagVo[]> {
    await this.account(accountId)
    return (await this.repo.find({ where: { accountId }, order: { tagId: 'ASC' } })).map(vo)
  }

  /** A new tag on WeChat, then here; the account at its cap → 422. */
  async add({ accountId, name }: WxoaTagCreate): Promise<WxoaTagVo> {
    const account = await this.account(accountId)
    if ((await this.repo.countBy({ accountId })) >= WXOA_TAGS_MAX)
      throw new BizError(Err.UNPROCESSABLE)
    const answer = await this.gateway.json(account, '/cgi-bin/tags/create', {
      body: { tag: { name } },
    })
    const tagId = (answer.tag as WxoaJson | undefined)?.id
    if (!Number.isInteger(tagId) || (tagId as number) < 0 || (tagId as number) > TAG_MAX)
      throw new BizError(Err.WXOA_UPSTREAM)
    const row = await this.repo.save(
      this.repo.create({ accountId, tagId: tagId as number, name, fanCount: 0 }),
    )
    return vo(await this.get(row.id))
  }

  /** Renames the tag on WeChat, then here. */
  change(id: number, name: string): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const { row, account } = await this.locked(id)
      await this.gateway.json(account, '/cgi-bin/tags/update', {
        body: { tag: { id: row.tagId, name } },
      })
      await this.repo.update(id, { name })
    })
  }

  /**
   * Deletes the tag on WeChat, then here (its fans lose it). The fan rows are only touched after
   * WeChat answers, so a slow answer never holds locks that callback writes of the account wait on.
   */
  drop(id: number): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const { row, account } = await this.locked(id)
      await this.gateway.json(account, '/cgi-bin/tags/delete', { body: { tag: { id: row.tagId } } })
      await this.deleteRows([id])
      await untagFans(this.txHost.tx, row.accountId, row.tagId)
    })
  }

  /** Replaces the account's tags with WeChat's (`tags/get`): names and counts, gone ones deleted. */
  async sync(accountId: number): Promise<WxoaTagVo[]> {
    const account = await this.account(accountId)
    const tags = tagsOf(await this.gateway.json(account, '/cgi-bin/tags/get'))
    await this.txHost.withTransaction(async () => {
      const em = this.txHost.tx
      if (tags.length)
        await em.query(
          `INSERT INTO wxoa_tag (tenant_id, account_id, tag_id, name, fan_count) VALUES ? AS n
           ON DUPLICATE KEY UPDATE name = n.name, fan_count = n.fan_count`,
          [tags.map((t) => [tenantId(), accountId, t.tagId, t.name, t.fanCount])],
        )
      const kept = new Set(tags.map((t) => t.tagId))
      const gone = (await this.repo.find({ where: { accountId } })).filter(
        (t) => !kept.has(t.tagId),
      )
      if (!gone.length) return
      await this.deleteRows(gone.map((t) => t.id))
      for (const t of gone) await untagFans(em, accountId, t.tagId)
    })
    return this.list(accountId)
  }

  /** Locks tag `id` (404), checks its account and that it is not one of WeChat's reserved tags (422). */
  private async locked(id: number): Promise<{ row: WxoaTag; account: WxoaCaller }> {
    await this.lockScopedIds([id])
    const row = await this.repo.findOneByOrFail({ id })
    const account = await this.account(row.accountId)
    if (RESERVED.has(row.tagId)) throw new BizError(Err.UNPROCESSABLE)
    return { row, account }
  }

  /** Account `id`, alive (else 404) and enabled (else `B6011`). */
  private async account(id: number): Promise<WxoaCaller> {
    const row = await this.txHost.tx.getRepository(WxoaAccount).findOne({
      select: { id: true, appId: true, accountKind: true, enabled: true },
      where: { id },
    })
    if (!row) throw new NotFoundException()
    if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
    return { id: row.id, appId: row.appId, accountKind: row.accountKind }
  }
}
