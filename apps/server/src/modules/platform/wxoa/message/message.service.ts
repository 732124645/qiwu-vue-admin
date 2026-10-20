import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  type Page,
  RT,
  WXOA_MEDIA_LIMITS,
  WXOA_RETENTION_DAYS_DEFAULT,
  WXOA_SEND_WINDOWS,
  type WxoaConversationQuery,
  type WxoaFanMessagesQuery,
  type WxoaFanVo,
  type WxoaMediaKind,
  type WxoaMessageQuery,
  type WxoaMessageSend,
  type WxoaMessageVo,
  type WxoaReplyKind,
  type WxoaSendWindowVo,
  wxoaParams,
} from '@qiwu/shared'
import { In, IsNull, LessThan, MoreThanOrEqual, Not, type SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { allTenants, tenantId, withTenant } from '../../../../core/context/tenant.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { RealtimeService } from '../../../../core/realtime/realtime.service.js'
import { JobHandler, type JobContext } from '../../../../core/scheduler/job-handler.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { StorageService } from '../../storage/storage.service.js'
import { WxoaAccount, WxoaFan, WxoaMaterial, WxoaMessage } from '../core/wxoa.entity.js'
import { type WxoaCaller, WxoaGateway } from '../core/wxoa-gateway.js'
import { type WxoaInbound, WxoaInboundHub } from '../core/wxoa-inbound-hub.js'
import { WxoaFanService } from '../fan/fan.service.js'
import { WxoaMaterialService } from '../material/material.service.js'

const SEND = '/cgi-bin/message/custom/send'
const MEDIA_GET = '/cgi-bin/media/get'
/** rows one purge step reads, deletes or fails */
const PURGE_BATCH = 1000
/** an outbound row still pending this long was left behind by a stopped process */
const ORPHAN_MS = 10 * 60_000
const DAY_MS = 86_400_000
const MEDIA_ID = /^[\x21-\x7e]{1,128}$/

/** The material kind of each media message; video and music also take a `thumb` material. */
const MEDIA_OF: Partial<Record<WxoaReplyKind, WxoaMediaKind>> = {
  image: 'image',
  voice: 'voice',
  video: 'video',
}

/** Inbound kinds whose media is copied: the payload field naming it, the rule it is stored by. */
const COPIED: Record<string, { field: string; kind: WxoaMediaKind }> = {
  image: { field: 'MediaId', kind: 'image' },
  voice: { field: 'MediaId', kind: 'voice' },
  // a video itself is not served by media/get; its thumbnail (a jpg) is
  video: { field: 'ThumbMediaId', kind: 'image' },
  shortvideo: { field: 'ThumbMediaId', kind: 'image' },
}
const EXT_OF: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'audio/amr': 'amr',
  'audio/mpeg': 'mp3',
}

const vo = (m: WxoaMessage): WxoaMessageVo => ({
  id: m.id,
  accountId: m.accountId,
  openId: m.openId,
  direction: m.direction,
  channel: m.channel,
  msgKind: m.msgKind,
  eventKind: m.eventKind,
  eventKey: m.eventKey,
  payload: m.payload,
  objectId: m.objectId,
  wxMsgId: m.wxMsgId,
  sendState: m.sendState as WxoaMessageVo['sendState'],
  errcode: m.errcode,
  operatorId: m.operatorId,
  occurredAt: m.occurredAt.toISOString(),
})
/** whether a window opened at `at` (null: never) and lasting `ms` is still open */
const open = (at: Date | null, ms: number, now: number) => !!at && now < at.getTime() + ms

/**
 * The message log, conversations and customer-service messages (see docs/design-notes.md#wxoa). Fan
 * rows and their window times are written by the callback inside the push request, so nothing here
 * waits for the hub. A customer-service message needs one of the fan's windows open (the times only;
 * WeChat counts the messages) and its media from the account itself: one of its materials, or one of
 * its `wxoa.media` objects uploaded as a temporary medium (any other object → 404). It is written as a
 * pending outbound row first, then settled sent or failed by WeChat's answer. The hub copies inbound
 * images, voice and video thumbnails to the account's media (`wxoa.media.copy_inbound`) and tells the
 * signed-in admins a message came. `wxoa.message.purge` drops the log past its retention, with the
 * inbound rows' copies, and fails outbound rows left pending. Every route goes through the account:
 * alive (404) and enabled (`B6011`).
 */
@Injectable()
export class WxoaMessageService extends BaseCrudService<WxoaMessage> implements OnModuleInit {
  private readonly logger = new Logger(WxoaMessageService.name)

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly hub: WxoaInboundHub,
    private readonly fans: WxoaFanService,
    private readonly materials: WxoaMaterialService,
    private readonly storage: StorageService,
    private readonly params: ParamService,
    private readonly realtime: RealtimeService,
  ) {
    super(txHost, WxoaMessage)
  }

  onModuleInit(): void {
    this.hub.on((row) => this.inbound(row))
  }

  async list(query: WxoaMessageQuery): Promise<Page<WxoaMessageVo>> {
    await this.account(query.accountId)
    const { items, total } = await this.page(query)
    return { items: items.map(vo), total }
  }

  /** The account's fans by their last message, newest first unless sorted otherwise. */
  conversations(query: WxoaConversationQuery): Promise<Page<WxoaFanVo>> {
    return this.fans.list({
      ...query,
      sort: query.sort ?? [{ field: 'lastInboundAt', order: 'DESC' }],
    })
  }

  /** Fan `fanId`'s messages, in and out, newest first, before `beforeId`. */
  async fanMessages(fanId: number, query: WxoaFanMessagesQuery): Promise<WxoaMessageVo[]> {
    const fan = await this.fans.one(fanId)
    const rows = await this.repo.find({
      where: {
        accountId: fan.accountId,
        openId: fan.openId,
        ...(query.beforeId ? { id: LessThan(query.beforeId) } : {}),
      },
      order: { id: 'DESC' },
      take: query.limit,
    })
    return rows.map(vo)
  }

  /** Fan `fanId`'s two windows: when each ends and how many messages went out since it opened. */
  async window(fanId: number): Promise<WxoaSendWindowVo> {
    const fan = await this.fans.one(fanId)
    const one = async (opened: string | null, { ms, max }: { ms: number; max: number }) => {
      if (!opened) return { until: null, used: 0, max }
      const used = await this.repo.countBy({
        accountId: fan.accountId,
        openId: fan.openId,
        direction: 'out',
        channel: 'cs',
        sendState: Not('failed'),
        occurredAt: MoreThanOrEqual(new Date(opened)),
      })
      return { until: new Date(Date.parse(opened) + ms).toISOString(), used, max }
    }
    return {
      inbound: await one(fan.lastInboundAt, WXOA_SEND_WINDOWS.inbound),
      event: await one(fan.lastEventAt, WXOA_SEND_WINDOWS.event),
    }
  }

  /**
   * Sends a customer-service message to a fan of the account (else 404) while one of its windows is
   * open (else `B6007`, nothing sent). The row is written pending before WeChat is called and settled
   * by its answer; a refusal leaves it failed and is thrown.
   */
  async send(dto: WxoaMessageSend, operatorId: number): Promise<WxoaMessageVo> {
    const account = await this.account(dto.accountId)
    const fan = await this.txHost.tx
      .getRepository(WxoaFan)
      .findOneBy({ id: dto.fanId, accountId: account.id })
    if (!fan) throw new NotFoundException()
    const now = Date.now()
    if (
      !open(fan.lastInboundAt, WXOA_SEND_WINDOWS.inbound.ms, now) &&
      !open(fan.lastEventAt, WXOA_SEND_WINDOWS.event.ms, now)
    )
      throw new BizError(Err.WXOA_SEND_WINDOW)
    const content = await this.content(account, dto)
    const row = await this.repo.save(
      this.repo.create({
        accountId: account.id,
        openId: fan.openId,
        direction: 'out',
        channel: 'cs',
        msgKind: dto.kind,
        payload: {
          ...dto.body,
          ...(dto.materialId ? { materialId: dto.materialId } : {}),
          ...(dto.objectId ? { objectId: dto.objectId } : {}),
          ...(dto.thumbMaterialId ? { thumbMaterialId: dto.thumbMaterialId } : {}),
        },
        sendState: 'pending',
        operatorId,
        occurredAt: new Date(now),
      }),
    )
    const settle = (state: Pick<WxoaMessage, 'sendState' | 'errcode'>) =>
      this.repo.update({ id: row.id, sendState: 'pending' }, state)
    try {
      await this.gateway.json(account, SEND, {
        body: { touser: fan.openId, msgtype: dto.kind, [dto.kind]: content },
      })
    } catch (err) {
      const errcode = err instanceof BizError ? err.params.errcode : undefined
      await settle({ sendState: 'failed', errcode: typeof errcode === 'number' ? errcode : null })
      throw err
    }
    await settle({ sendState: 'sent', errcode: 0 })
    return vo({ ...row, sendState: 'sent', errcode: 0 })
  }

  /**
   * 保留期任务：删除超过 `wxoa.message.retention_days`（0 为永久保留）的消息记录（入站行的媒体副本一并删除，
   * 素材的副本从不属于某一行），并把创建超过 10 分钟仍 pending 的出站行标为失败。调度器不带租户上下文，
   * 所以先在 allTenants 下取全部未删除的租户，再逐个租户处理：停用、到期、套餐不含公众号或多租户开关
   * 关闭的租户也照样清理——清理不调用微信，而保留期是对已存数据的承诺，不能因租户暂停而失效。
   * 一个租户失败只记日志，其余照常。信号中止（超时、停机、任务锁丢失）时立即停止。
   */
  @JobHandler('wxoa.message.purge')
  async purge(_params: object, { signal, log }: JobContext): Promise<string> {
    signal.throwIfAborted()
    const days = await this.params.int(
      wxoaParams.retentionDays,
      0,
      3650,
      WXOA_RETENTION_DAYS_DEFAULT,
    )
    // qw:cross-tenant the retention runs over every live tenant, each in its own context below
    const tenants = await allTenants(() =>
      this.txHost.tx.query<{ id: number }[]>(
        'SELECT t.id FROM iam_tenant t WHERE t.deleted_at IS NULL ORDER BY t.id',
      ),
    )
    let deleted = 0
    let failed = 0
    for (const { id } of tenants) {
      signal.throwIfAborted()
      try {
        // qw:cross-tenant the tenant's own rows
        const done = await withTenant(Number(id), () => this.purgeTenant(days, signal))
        deleted += done.deleted
        failed += done.failed
      } catch (err) {
        signal.throwIfAborted()
        this.logger.error({ tenantId: Number(id), err }, 'wxoa message purge failed')
        log(`tenant ${id}: failed`)
      }
    }
    return `${days ? `kept ${days} days, ${deleted} deleted` : 'kept forever'}; ${failed} pending failed`
  }

  /** 当前租户的一轮清理：按批删除过期行，再把遗留的 pending 出站行标为失败。 */
  private async purgeTenant(
    days: number,
    signal: AbortSignal,
  ): Promise<{ deleted: number; failed: number }> {
    let deleted = 0
    const before = new Date(Date.now() - days * DAY_MS)
    for (let more = days > 0; more;) {
      signal.throwIfAborted()
      const batch = await this.repo.find({
        select: { id: true, direction: true, objectId: true },
        where: { occurredAt: LessThan(before) },
        order: { id: 'ASC' },
        take: PURGE_BATCH,
      })
      for (const m of batch) if (m.direction === 'in' && m.objectId) await this.dropCopy(m.objectId)
      if (batch.length) await this.repo.delete({ id: In(batch.map((m) => m.id)) })
      deleted += batch.length
      more = batch.length === PURGE_BATCH
    }
    let failed = 0
    const stale = new Date(Date.now() - ORPHAN_MS)
    for (let more = true; more;) {
      signal.throwIfAborted()
      const batch = await this.repo.find({
        select: { id: true },
        where: { direction: 'out', sendState: 'pending', createdAt: LessThan(stale) },
        order: { id: 'ASC' },
        take: PURGE_BATCH,
      })
      if (batch.length)
        failed +=
          (
            await this.repo.update(
              { id: In(batch.map((m) => m.id)), sendState: 'pending' },
              { sendState: 'failed' },
            )
          ).affected ?? 0
      more = batch.length === PURGE_BATCH
    }
    return { deleted, failed }
  }

  protected override filter(
    qb: SelectQueryBuilder<WxoaMessage>,
    q: WxoaMessageQuery,
  ): SelectQueryBuilder<WxoaMessage> {
    qb.andWhere('t.accountId = :accountId', { accountId: q.accountId })
    if (q.openId) qb.andWhere('t.openId = :openId', { openId: q.openId })
    if (q.direction) qb.andWhere('t.direction = :direction', { direction: q.direction })
    if (q.channel) qb.andWhere('t.channel = :channel', { channel: q.channel })
    if (q.msgKind) qb.andWhere('t.msgKind = :msgKind', { msgKind: q.msgKind })
    if (q.occurredAtFrom) qb.andWhere('t.occurredAt >= :from', { from: new Date(q.occurredAtFrom) })
    if (q.occurredAtTo) qb.andWhere('t.occurredAt <= :to', { to: new Date(q.occurredAtTo) })
    return qb
  }

  /**
   * The message as `custom/send` takes it under its `msgtype`. Media must be the account's: a material
   * of the kind sent (a `thumb` for a thumbnail), else 404; an object goes through the material
   * service, which takes the account's `wxoa.media` objects only.
   */
  private async content(account: WxoaCaller, dto: WxoaMessageSend): Promise<object> {
    const b = dto.body as Record<string, string | undefined>
    const kind = MEDIA_OF[dto.kind]
    // the thumb first: a refused one must not cost an upload of the object
    const thumb =
      dto.thumbMaterialId != null
        ? await this.materialMediaId(account.id, dto.thumbMaterialId, 'thumb')
        : undefined
    const mediaId = !kind
      ? undefined
      : dto.materialId != null
        ? await this.materialMediaId(account.id, dto.materialId, kind)
        : await this.materials.tempMediaId(account, dto.objectId!, kind)
    switch (dto.kind) {
      case 'text':
        return { content: b.content }
      case 'news':
        return {
          articles: [{ title: b.title, description: b.description, url: b.url, picurl: b.picUrl }],
        }
      case 'music':
        return {
          title: b.title,
          description: b.description,
          musicurl: b.musicUrl,
          ...(b.hqMusicUrl ? { hqmusicurl: b.hqMusicUrl } : {}),
          thumb_media_id: thumb,
        }
      case 'video':
        return {
          media_id: mediaId,
          thumb_media_id: thumb,
          ...(b.title ? { title: b.title } : {}),
          ...(b.description ? { description: b.description } : {}),
        }
      default:
        return { media_id: mediaId }
    }
  }

  private async materialMediaId(accountId: number, id: number, mediaKind: WxoaMediaKind) {
    const found = await this.txHost.tx
      .getRepository(WxoaMaterial)
      .findOne({ select: { id: true, mediaId: true }, where: { id, accountId, mediaKind } })
    if (!found) throw new NotFoundException()
    return found.mediaId
  }

  /** A new inbound row: its media copied (when switched on), then the admins told. */
  private async inbound(row: WxoaInbound): Promise<void> {
    try {
      await this.copy(row)
    } finally {
      this.realtime.toUserType(row.tenantId ?? tenantId(), 'admin', {
        type: RT.wxoaMessage,
        payload: { accountId: row.accountId, messageId: row.id },
      })
    }
  }

  /**
   * The row's image, voice or video thumbnail from `media/get` (WeChat keeps it 3 days) as the
   * account's `wxoa.media` object, the row's own; a row gone meanwhile takes it back.
   */
  private async copy(row: WxoaInbound): Promise<void> {
    const copied = COPIED[row.msgKind]
    const mediaId = copied && row.payload[copied.field]
    if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) return
    if ((await this.params.get(wxoaParams.copyInbound))?.trim() === 'false') return
    const rule = WXOA_MEDIA_LIMITS[copied.kind]
    const media = await this.gateway.download(await this.account(row.accountId), MEDIA_GET, {
      query: { media_id: mediaId },
      maxBytes: rule.maxBytes,
    })
    const name = `${row.msgKind}-${row.id}.${EXT_OF[media.mime] ?? 'bin'}`
    const obj = await this.storage.putWxoaMedia(row.accountId, { name, data: media.data }, rule)
    const { affected } = await this.repo.update(
      { id: row.id, accountId: row.accountId, direction: 'in', objectId: IsNull() },
      { objectId: obj.id },
    )
    if (!affected) await this.dropCopy(obj.id)
  }

  /** Soft-deletes a media copy; one already gone counts as done. */
  private dropCopy(objectId: number): Promise<void> {
    return this.storage.remove(objectId).catch((err: unknown) => {
      if (!(err instanceof NotFoundException)) throw err
    })
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
