import { extname } from 'node:path'
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { TransactionHost } from '@nestjs-cls/transactional'
import type { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import {
  Err,
  WXOA_MEDIA_LIMITS,
  WXOA_MEDIA_TAG,
  type WxoaMaterialCountsVo,
  type WxoaMaterialCreate,
  type WxoaMaterialQuery,
  type WxoaMediaKind,
  type WxoaSyncVo,
  wxoaImageUrl,
  wxoaMediaRef,
} from '@qiwu/shared'
import type { SelectQueryBuilder } from 'typeorm'
import { BaseCrudService } from '../../../../core/db/base-crud.service.js'
import { contains } from '../../../../core/db/page.js'
import { type Lease, RedisLock } from '../../../../core/guard/redis-lock.js'
import { BizError } from '../../../../core/http/biz-error.js'
import type { UploadedFileData } from '../../../../core/http/upload.js'
import { redisKey } from '../../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../../core/redis/redis.module.js'
import { FsObject } from '../../storage/fs-object.entity.js'
import { StorageService } from '../../storage/storage.service.js'
import { WxoaAccount, WxoaMaterial } from '../core/wxoa.entity.js'
import { type WxoaCaller, type WxoaJson, WxoaGateway } from '../core/wxoa-gateway.js'

/** The kinds `batchget_material` lists (thumbnails are not listed). */
const LISTED = ['image', 'voice', 'video'] as const
/** `batchget_material` page size (WeChat: 1–20) */
const PAGE = 20
const LOCK_TTL_MS = 30_000
/** seconds a sync's progress stays readable */
const PROGRESS_TTL = 7 * 24 * 3600
/** seconds a temporary media_id is reused (WeChat keeps temporary media 3 days) */
const TEMP_TTL = 60 * 60 * 60
/** WeChat's answer to an unknown media_id: deleted on WeChat's side already */
const UNKNOWN_MEDIA = 40007
const MEDIA_ID = /^[\x21-\x7e]{1,128}$/

/** A media_id as WeChat answered it (printable ASCII, the column's 128); else B6001. */
function mediaIdOf(answer: WxoaJson): string {
  const id = answer.media_id
  if (typeof id !== 'string' || !MEDIA_ID.test(id)) throw new BizError(Err.WXOA_UPSTREAM)
  return id
}

/** An image link as stored: the https form on WeChat's image hosts, within the column; else null. */
const imageUrl = (raw: unknown) => {
  const url = typeof raw === 'string' ? wxoaImageUrl(raw) : null
  return url && url.length <= 1024 ? url : null
}

const idle = (): WxoaSyncVo => ({
  state: 'idle',
  done: 0,
  total: null,
  startedAt: null,
  finishedAt: null,
  code: null,
})

/**
 * Permanent materials (see docs/design-notes.md#wxoa). An upload is stored first as the account's
 * `wxoa.media` object (types and sizes per kind), then sent to `add_material`; a refused upload takes
 * the local object back. A sync records what `batchget_material` lists (links only, nothing
 * downloaded), one per account across instances. A material a reply rule uses is not deleted (409, no
 * call to WeChat). Every route goes through the account: alive (404) and enabled (`B6011`).
 */
@Injectable()
export class WxoaMaterialService extends BaseCrudService<WxoaMaterial> {
  private readonly logger = new Logger(WxoaMaterialService.name)

  constructor(
    txHost: TransactionHost<TransactionalAdapterTypeOrm>,
    private readonly gateway: WxoaGateway,
    private readonly storage: StorageService,
    private readonly locks: RedisLock,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super(txHost, WxoaMaterial)
  }

  async list(query: WxoaMaterialQuery) {
    await this.account(query.accountId)
    return this.page(query)
  }

  /** WeChat's own counts per kind. */
  async counts(accountId: number): Promise<WxoaMaterialCountsVo> {
    const answer = await this.gateway.json(
      await this.account(accountId),
      '/cgi-bin/material/get_materialcount',
    )
    const n = (key: string) => Number(answer[key]) || 0
    return {
      image: n('image_count'),
      voice: n('voice_count'),
      video: n('video_count'),
      news: n('news_count'),
    }
  }

  /** Stores `file` as the account's media, then on WeChat; a failure there removes the local copy. */
  async upload(
    dto: WxoaMaterialCreate,
    file: UploadedFileData | undefined,
    uploaderId: number,
  ): Promise<WxoaMaterial> {
    const account = await this.account(dto.accountId)
    if (!file?.buffer.length) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const obj = await this.storage.putWxoaMedia(
      account.id,
      { name: file.originalname, data: file.buffer },
      WXOA_MEDIA_LIMITS[dto.mediaKind],
      uploaderId,
    )
    let saved: WxoaMaterial
    try {
      const answer = await this.gateway.upload(
        account,
        '/cgi-bin/material/add_material',
        { name: obj.originalName, mime: obj.mime, data: file.buffer },
        {
          query: { type: dto.mediaKind },
          fields:
            dto.mediaKind === 'video'
              ? { description: JSON.stringify({ title: dto.title, introduction: dto.intro }) }
              : undefined,
        },
      )
      saved = await this.repo.save(
        this.repo.create({
          accountId: account.id,
          mediaKind: dto.mediaKind,
          mediaId: mediaIdOf(answer),
          title: dto.title,
          intro: dto.intro,
          fileName: obj.originalName,
          byteSize: obj.size,
          wxUrl: dto.mediaKind === 'image' ? imageUrl(answer.url) : null,
          objectId: obj.id,
          origin: 'local',
        }),
      )
    } catch (err) {
      await this.storage
        .remove(obj.id)
        .catch((cause: unknown) =>
          this.logger.warn(
            { objectId: obj.id, err: cause },
            'wxoa material: local copy not removed',
          ),
        )
      throw err
    }
    return this.get(saved.id)
  }

  /**
   * Deletes material `id` on WeChat and here, in one transaction: the local delete goes first and
   * refuses a material still in use (409) before WeChat is called; WeChat refusing rolls it back.
   * Once committed, its local copy is deleted too (a failure there is only logged).
   */
  async drop(id: number): Promise<void> {
    const row = await this.txHost.withTransaction(async () => {
      await this.lockScopedIds([id])
      const row = await this.repo.findOneByOrFail({ id })
      const account = await this.account(row.accountId)
      await this.deleteRows([id])
      try {
        await this.gateway.json(account, '/cgi-bin/material/del_material', {
          body: { media_id: row.mediaId },
        })
      } catch (err) {
        if (!(err instanceof BizError && err.params.errcode === UNKNOWN_MEDIA)) throw err
      }
      return row
    })
    if (row.objectId)
      await this.storage
        .removeWxoaMedia(row.accountId, row.objectId)
        .catch((err: unknown) =>
          this.logger.warn(
            { objectId: row.objectId, err },
            'wxoa material: local copy not removed',
          ),
        )
  }

  /**
   * For customer service messages: the media_id of object `objectId` (one of the account's
   * `wxoa.media` objects, alive, else 404; a file `kind` takes, else C1002) uploaded as a temporary
   * `kind` medium, reused for 2.5 days. The object is checked on every call, cached or not.
   */
  async tempMediaId(account: WxoaCaller, objectId: number, kind: WxoaMediaKind): Promise<string> {
    const bizRef = wxoaMediaRef(account.id)
    const obj = await this.txHost.tx.getRepository(FsObject).findOne({
      select: { id: true, originalName: true },
      where: { id: objectId, bizTag: WXOA_MEDIA_TAG, bizRef },
    })
    if (!obj) throw new NotFoundException()
    const limit = WXOA_MEDIA_LIMITS[kind]
    const ext = extname(obj.originalName).slice(1).toLowerCase()
    if (!(limit.exts as readonly string[]).includes(ext))
      throw new BizError(Err.STORAGE_TYPE_REJECTED, { ext: ext || '?' })
    const key = redisKey('wxoa', 'temp', account.id, objectId)
    // `<kind> <media_id>` (a media_id has no space): one uploaded as another kind is not reused
    const [cachedKind, cachedId] = (await this.redis.get(key))?.split(' ') ?? []
    if (cachedKind === kind && cachedId) return cachedId
    const file = await this.storage.readInternal(objectId, {
      bizTag: WXOA_MEDIA_TAG,
      bizRef,
      maxBytes: limit.maxBytes,
    })
    const mediaId = mediaIdOf(
      await this.gateway.upload(account, '/cgi-bin/media/upload', file, { query: { type: kind } }),
    )
    await this.redis.set(key, `${kind} ${mediaId}`, { expiration: { type: 'EX', value: TEMP_TTL } })
    return mediaId
  }

  /** Starts a sync of the account's materials in the background; one already running → `B6010`. */
  async startSync(accountId: number): Promise<WxoaSyncVo> {
    const account = await this.account(accountId)
    const lease = await this.locks.acquire(this.lockKey(accountId), LOCK_TTL_MS)
    if (!lease) throw new BizError(Err.WXOA_SYNC_RUNNING)
    const progress: WxoaSyncVo = { ...idle(), state: 'running', startedAt: now() }
    try {
      await this.saveProgress(accountId, progress)
    } catch (err) {
      // renewal stops on release; a failed release leaves the key to expire within LOCK_TTL_MS
      await lease.release().catch(() => false)
      throw err
    }
    void this.sync(account, lease, progress).catch((err: unknown) =>
      this.logger.warn({ accountId, err }, 'wxoa material sync: progress or lock not settled'),
    )
    return { ...progress }
  }

  /** The last sync's progress; one left running by a stopped instance (its lock gone) is `interrupted`. */
  async syncProgress(accountId: number): Promise<WxoaSyncVo> {
    await this.account(accountId)
    const raw = await this.redis.get(this.progressKey(accountId))
    if (!raw) return idle()
    const progress = JSON.parse(raw) as WxoaSyncVo
    if (progress.state === 'running' && !(await this.redis.exists(this.lockKey(accountId))))
      progress.state = 'interrupted'
    return progress
  }

  protected override filter(
    qb: SelectQueryBuilder<WxoaMaterial>,
    { accountId, mediaKind, title }: WxoaMaterialQuery,
  ): SelectQueryBuilder<WxoaMaterial> {
    qb.andWhere('t.accountId = :accountId', { accountId })
    if (mediaKind) qb.andWhere('t.mediaKind = :mediaKind', { mediaKind })
    if (title)
      qb.andWhere('(t.title LIKE :title OR t.fileName LIKE :title)', { title: contains(title) })
    return qb
  }

  /** Pages through `batchget_material` per listed kind; stops when the lock is lost. */
  private async sync(account: WxoaCaller, lease: Lease, progress: WxoaSyncVo): Promise<void> {
    const save = () => lease.held && this.saveProgress(account.id, progress)
    try {
      const counts = await this.counts(account.id)
      progress.total = LISTED.reduce((sum, kind) => sum + counts[kind], 0)
      await save()
      for (const kind of LISTED)
        for (let offset = 0; ;) {
          lease.lost.throwIfAborted()
          const page = await this.gateway.json(account, '/cgi-bin/material/batchget_material', {
            body: { type: kind, offset, count: PAGE },
          })
          const items = Array.isArray(page.item) ? (page.item as WxoaJson[]) : []
          await this.record(account.id, kind, items)
          offset += items.length
          progress.done += items.length
          await save()
          if (!items.length || offset >= Number(page.total_count)) break
        }
      progress.state = 'done'
    } catch (err) {
      progress.state = 'failed'
      progress.code = err instanceof BizError ? err.err.code : Err.INTERNAL.code
      this.logger.warn({ accountId: account.id, err }, 'wxoa material sync failed')
    }
    progress.finishedAt = now()
    try {
      await save()
    } finally {
      await lease.release()
    }
  }

  /** Records listed materials not known yet (by media_id); known ones stay as they are. */
  private async record(accountId: number, kind: WxoaMediaKind, items: WxoaJson[]): Promise<void> {
    const rows = items.flatMap((item) => {
      const mediaId = item.media_id
      if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) return []
      return [
        {
          accountId,
          mediaKind: kind,
          mediaId,
          fileName: typeof item.name === 'string' ? item.name.slice(0, 255) : null,
          wxUrl: kind === 'image' ? imageUrl(item.url) : null,
          origin: 'pulled' as const,
        },
      ]
    })
    if (rows.length) await this.repo.createQueryBuilder().insert().values(rows).orIgnore().execute()
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

  private saveProgress(accountId: number, progress: WxoaSyncVo) {
    return this.redis.set(this.progressKey(accountId), JSON.stringify(progress), {
      expiration: { type: 'EX', value: PROGRESS_TTL },
    })
  }

  private progressKey = (accountId: number) => redisKey('wxoa', 'sync', accountId, 'material')
  private lockKey = (accountId: number) => redisKey('lock', `wxoa-sync-material-${accountId}`)
}

const now = () => new Date().toISOString()
