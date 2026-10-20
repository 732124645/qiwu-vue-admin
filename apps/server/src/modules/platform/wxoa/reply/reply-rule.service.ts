import { Injectable, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  WXOA_RULES_MAX,
  type WxoaMediaKind,
  type WxoaReplyKind,
  type WxoaReplyRuleCreate,
  type WxoaReplyRuleQuery,
  type WxoaReplyRuleUpdate,
} from '@qiwu/shared'
import type { QueryDeepPartialEntity, SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { contains } from '../../../../core/db/page.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { WxoaAccount, WxoaMaterial, WxoaReplyRule } from '../core/wxoa.entity.js'

/** The material kind each media reply sends: music carries a thumbnail. */
const MEDIA_OF: Partial<Record<WxoaReplyKind, WxoaMediaKind>> = {
  image: 'image',
  voice: 'voice',
  video: 'video',
  music: 'thumb',
}

/** The stored columns of a rule body: the fields a trigger or reply kind does not use are cleared. */
const columns = (dto: WxoaReplyRuleUpdate) => ({
  ...dto,
  matchMode: dto.matchMode ?? null,
  keywords: dto.keywords ?? null,
  eventKey: dto.eventKey ?? null,
  materialId: dto.materialId ?? null,
})

/**
 * Auto-reply rules (see docs/design-notes.md#wxoa). Every route goes through the rule's account, which
 * must be alive (404) and enabled (`B6011`); a referenced material must be the account's own, of the
 * kind the reply sends (404). The unique indexes keep one enabled subscribe and one enabled default rule
 * per account and one rule per click key or scan scene (409); the callback reads the table uncached.
 */
@Injectable()
export class WxoaReplyRuleService extends BaseCrudService<WxoaReplyRule> {
  constructor(txHost: TransactionHost<TransactionalAdapterTypeOrm>) {
    super(txHost, WxoaReplyRule)
  }

  async list(query: WxoaReplyRuleQuery) {
    await this.account(query.accountId)
    return this.page(query)
  }

  async one(id: number): Promise<WxoaReplyRule> {
    const row = await this.get(id)
    await this.account(row.accountId)
    return row
  }

  /** The account row is locked, so its rule count stays under the cap however many creates race. */
  add(dto: WxoaReplyRuleCreate): Promise<WxoaReplyRule> {
    return this.txHost.withTransaction(async () => {
      await this.account(dto.accountId, true)
      const count = await this.repo.countBy({ accountId: dto.accountId })
      if (count >= WXOA_RULES_MAX) throw new BizError(Err.UNPROCESSABLE)
      await this.assertMaterial(dto.accountId, dto.materialId, dto.replyKind)
      const row = await super.create({ ...columns(dto), accountId: dto.accountId })
      return this.get(row.id)
    })
  }

  change(id: number, dto: WxoaReplyRuleUpdate): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const { accountId } = await this.locked(id)
      await this.assertMaterial(accountId, dto.materialId, dto.replyKind)
      // a JSON column (`replyBody`) is beyond what QueryDeepPartialEntity can type
      await super.update(id, columns(dto) as QueryDeepPartialEntity<WxoaReplyRule>)
    })
  }

  drop(id: number): Promise<void> {
    return this.txHost.withTransaction(async () => {
      await this.locked(id)
      await this.deleteRows([id])
    })
  }

  protected override filter(
    qb: SelectQueryBuilder<WxoaReplyRule>,
    { accountId, triggerKind, name, enabled }: WxoaReplyRuleQuery,
  ): SelectQueryBuilder<WxoaReplyRule> {
    qb.andWhere('t.accountId = :accountId', { accountId })
    if (triggerKind) qb.andWhere('t.triggerKind = :triggerKind', { triggerKind })
    if (name) qb.andWhere('t.name LIKE :name', { name: contains(name) })
    if (enabled !== undefined) qb.andWhere('t.enabled = :enabled', { enabled })
    return qb
  }

  /** Locks rule `id` (404) and checks its account. */
  private async locked(id: number): Promise<WxoaReplyRule> {
    await this.lockScopedIds([id])
    const row = await this.repo.findOneByOrFail({ id })
    await this.account(row.accountId)
    return row
  }

  /** Account `id` must be alive (else 404) and enabled (else `B6011`). */
  private async account(id: number, lock = false): Promise<void> {
    const qb = this.txHost.tx
      .getRepository(WxoaAccount)
      .createQueryBuilder('a')
      .select(['a.id', 'a.enabled'])
      .where('a.id = :id', { id })
    const row = await (lock ? qb.setLock('pessimistic_write') : qb).getOne()
    if (!row) throw new NotFoundException()
    if (!row.enabled) throw new BizError(Err.WXOA_ACCOUNT_DISABLED)
  }

  /** A media reply's material: a live one of the account, of the kind the reply sends; else 404. */
  private async assertMaterial(
    accountId: number,
    materialId: number | null | undefined,
    replyKind: WxoaReplyKind,
  ): Promise<void> {
    const mediaKind = MEDIA_OF[replyKind]
    if (materialId == null || !mediaKind) return
    const found = await this.txHost.tx
      .getRepository(WxoaMaterial)
      .existsBy({ id: materialId, accountId, mediaKind })
    if (!found) throw new NotFoundException()
  }
}
