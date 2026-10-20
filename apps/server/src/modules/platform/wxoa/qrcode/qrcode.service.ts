import { Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  WXOA_MEDIA_LIMITS,
  WXOA_SCENE,
  type WxoaQrcodeCreate,
  type WxoaQrcodeQuery,
  type WxoaQrcodeStatsVo,
  type WxoaQrcodeUpdate,
} from '@qiwu/shared'
import type { SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { contains } from '../../../../core/db/page.js'
import { formatInZone } from '../../../../core/excel/excel.js'
import { BizError } from '../../../../core/http/biz-error.js'
import { currentTimezone } from '../../../../core/i18n/locale.js'
import { ParamService } from '../../../../core/settings/param.service.js'
import { StorageService } from '../../storage/storage.service.js'
import { WxoaAccount, WxoaMessage, WxoaQrcode, WxoaTag } from '../core/wxoa.entity.js'
import { type WxoaCaller, WxoaGateway } from '../core/wxoa-gateway.js'
import { type WxoaInbound, WxoaInboundHub } from '../core/wxoa-inbound-hub.js'
import { WxoaFanService } from '../fan/fan.service.js'

/** a subscribe through a QR code carries `qrscene_<scene>` as its event key */
const SUBSCRIBE_PREFIX = 'qrscene_'
/** a ticket or a code link as WeChat answers it (printable ASCII, the columns' 255) */
const ASCII_255 = /^[\x21-\x7e]{1,255}$/
const IMAGE_EXTS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
}
const DAY_MS = 86_400_000
/** stats are counted per quarter hour (the SQL's 900 s) first: every time zone's day starts on one */
const QUARTER_MS = 900_000

/** `YYYY-MM-DD` `n` calendar days before `day`. */
const daysBefore = (day: string, n: number) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! - n)).toISOString().slice(0, 10)
}

/** A string WeChat answered for a column of 255 ASCII characters; else B6001. */
function asciiOf(raw: unknown): string {
  if (typeof raw !== 'string' || !ASCII_255.test(raw)) throw new BizError(Err.WXOA_UPSTREAM)
  return raw
}

/**
 * Channel QR codes (see docs/design-notes.md#wxoa): string scenes only, one live code per scene and
 * account. A code is created on WeChat (`qrcode/create`), its image copied to the account's
 * `wxoa.media` (a failed copy leaves the code without one); deleting removes the local row and that
 * copy only. A subscribed fan's scan (`SCAN`) and a subscribe through a code (`qrscene_` key) count
 * on the code, atomically, and give the fan the code's tag (through the fan service; a failure is
 * only logged). Daily stats come from the message log, by the request's time zone. Every route goes
 * through the account: alive (404) and enabled (`B6011`); a tag must be the account's (404).
 */
@Injectable()
export class WxoaQrcodeService extends BaseCrudService<WxoaQrcode> implements OnModuleInit {
  private readonly logger = new Logger(WxoaQrcodeService.name)

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly storage: StorageService,
    private readonly fans: WxoaFanService,
    private readonly hub: WxoaInboundHub,
    private readonly params: ParamService,
  ) {
    super(txHost, WxoaQrcode)
  }

  onModuleInit(): void {
    this.hub.on((row) => this.scanned(row))
  }

  async list(query: WxoaQrcodeQuery) {
    await this.account(query.accountId)
    return this.page(query)
  }

  /** Creates the code on WeChat, copies its image, then records it; a scene the account uses → 409. */
  async add(dto: WxoaQrcodeCreate): Promise<WxoaQrcode> {
    const account = await this.account(dto.accountId)
    await this.assertTag(account.id, dto.tagId)
    // the unique index stays the guard; this spares WeChat a code that could not be recorded
    if (await this.repo.existsBy({ accountId: account.id, scene: dto.scene }))
      throw new BizError(Err.DUPLICATE, { scene: dto.scene })
    const temporary = dto.qrKind === 'temporary'
    const answer = await this.gateway.json(account, '/cgi-bin/qrcode/create', {
      body: {
        ...(temporary ? { expire_seconds: dto.expireSeconds } : {}),
        action_name: temporary ? 'QR_STR_SCENE' : 'QR_LIMIT_STR_SCENE',
        action_info: { scene: { scene_str: dto.scene } },
      },
    })
    const ticket = asciiOf(answer.ticket)
    const qrUrl = asciiOf(answer.url)
    const objectId = await this.copyImage(account.id, dto.scene, ticket)
    try {
      const row = await this.create({
        accountId: account.id,
        label: dto.label,
        qrKind: dto.qrKind,
        scene: dto.scene,
        expiresAt: temporary ? new Date(Date.now() + dto.expireSeconds! * 1000) : null,
        ticket,
        qrUrl,
        objectId,
        tagId: dto.tagId ?? null,
      })
      return await this.get(row.id)
    } catch (err) {
      if (objectId) await this.dropObject(account.id, objectId)
      throw err
    }
  }

  /** Renames the code and sets (or with null removes) its tag. */
  change(id: number, dto: WxoaQrcodeUpdate): Promise<void> {
    return this.txHost.withTransaction(async () => {
      const row = await this.locked(id)
      const tagId = dto.tagId ?? null
      if (tagId !== row.tagId) await this.assertTag(row.accountId, tagId)
      await this.repo.update(id, { label: dto.label, tagId })
    })
  }

  /** Deletes the local row and its image copy only: a permanent code keeps working on WeChat. */
  async drop(id: number): Promise<void> {
    const row = await this.txHost.withTransaction(async () => {
      const row = await this.locked(id)
      await this.deleteRows([id])
      return row
    })
    if (row.objectId) await this.dropObject(row.accountId, row.objectId)
  }

  /** Scans and subscribes through the code per day of the request's time zone, the last `days` days. */
  async stats(id: number, days: number): Promise<WxoaQrcodeStatsVo> {
    const code = await this.get(id)
    await this.account(code.accountId)
    const tz = await currentTimezone(this.params)
    const now = Date.now()
    const today = formatInZone(new Date(now), tz).slice(0, 10)
    const list = Array.from({ length: days }, (_, i) => ({
      day: daysBefore(today, days - 1 - i),
      scans: 0,
      subscribes: 0,
    }))
    const byDay = new Map(list.map((d) => [d.day, d]))
    const rows = await this.txHost.tx
      .getRepository(WxoaMessage)
      .createQueryBuilder('m')
      .select('FLOOR(UNIX_TIMESTAMP(m.occurredAt) / 900)', 'quarter')
      .addSelect('m.eventKind', 'kind')
      .addSelect('COUNT(*)', 'n')
      .where('m.accountId = :accountId', { accountId: code.accountId })
      .andWhere("m.direction = 'in' AND m.msgKind = 'event'")
      // a day longer than 24 h at most: one day more than asked covers the first one's start
      .andWhere('m.occurredAt >= :since', { since: new Date(now - (days + 1) * DAY_MS) })
      // the log column compares case-insensitively, scenes are case-sensitive: compare bytes
      .andWhere(
        "((m.eventKind = 'SCAN' AND m.eventKey COLLATE utf8mb4_bin = :scene) OR (m.eventKind = 'subscribe' AND m.eventKey COLLATE utf8mb4_bin = :subscribed))",
        { scene: code.scene, subscribed: SUBSCRIBE_PREFIX + code.scene },
      )
      .groupBy('quarter')
      .addGroupBy('kind')
      .getRawMany<{ quarter: string | number; kind: string; n: string | number }>()
    for (const r of rows) {
      const day = byDay.get(formatInZone(new Date(Number(r.quarter) * QUARTER_MS), tz).slice(0, 10))
      if (!day) continue
      if (r.kind === 'SCAN') day.scans += Number(r.n)
      else day.subscribes += Number(r.n)
    }
    return list
  }

  protected override filter(
    qb: SelectQueryBuilder<WxoaQrcode>,
    { accountId, qrKind, label }: WxoaQrcodeQuery,
  ): SelectQueryBuilder<WxoaQrcode> {
    qb.andWhere('t.accountId = :accountId', { accountId })
    if (qrKind) qb.andWhere('t.qrKind = :qrKind', { qrKind })
    if (label) qb.andWhere('t.label LIKE :label', { label: contains(label) })
    return qb
  }

  /** A scan or a subscribe through one of the account's codes: counted, then the fan tagged. */
  private async scanned(row: WxoaInbound): Promise<void> {
    if (row.msgKind !== 'event' || !row.eventKey) return
    const scan = row.eventKind === 'SCAN'
    const scene = scan
      ? row.eventKey
      : row.eventKind === 'subscribe' && row.eventKey.startsWith(SUBSCRIBE_PREFIX)
        ? row.eventKey.slice(SUBSCRIBE_PREFIX.length)
        : null
    if (!scene || !WXOA_SCENE.test(scene)) return
    const code = await this.repo.findOne({
      select: { id: true, tagId: true },
      where: { accountId: row.accountId, scene },
    })
    if (!code) return
    await this.repo.increment({ id: code.id }, scan ? 'scanCount' : 'subscribeCount', 1)
    // a failure is logged by the hub; the count stays
    if (code.tagId !== null)
      await this.fans.tagOpenIds(row.accountId, [row.openId], code.tagId, 'add')
  }

  /** The code's image as the account's `wxoa.media` object (uploader 0); null when that failed. */
  private async copyImage(
    accountId: number,
    scene: string,
    ticket: string,
  ): Promise<number | null> {
    try {
      const image = await this.gateway.qrImage(ticket)
      const ext = IMAGE_EXTS[image.mime] ?? 'bin'
      const obj = await this.storage.putWxoaMedia(
        accountId,
        { name: `qrcode-${scene}.${ext}`, data: image.data },
        WXOA_MEDIA_LIMITS.image,
      )
      return obj.id
    } catch (err) {
      // the error's code only: nothing of a URL or an answer
      const code = err instanceof BizError ? err.err.code : 'error'
      this.logger.warn({ accountId, code }, 'wxoa qrcode: image not copied')
      return null
    }
  }

  /** Deletes the account's image copy `objectId` (after the row's commit); a failure is only logged. */
  private dropObject(accountId: number, objectId: number): Promise<void> {
    return this.storage
      .removeWxoaMedia(accountId, objectId)
      .catch((err: unknown) =>
        this.logger.warn({ objectId, err }, 'wxoa qrcode: image copy not removed'),
      )
  }

  /** Locks code `id` (404) and checks its account. */
  private async locked(id: number): Promise<WxoaQrcode> {
    await this.lockScopedIds([id])
    const row = await this.repo.findOneByOrFail({ id })
    await this.account(row.accountId)
    return row
  }

  /** Upstream tag `tagId` must be a live tag of the account (else 404); null passes. */
  private async assertTag(accountId: number, tagId: number | null | undefined): Promise<void> {
    if (tagId == null) return
    if (!(await this.txHost.tx.getRepository(WxoaTag).existsBy({ accountId, tagId })))
      throw new NotFoundException()
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
