import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { Injectable } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import {
  Err,
  IM_LIMITS,
  imEntryRef,
  type ImSticker,
  type ImStickerFromEntry,
  type ImStickerOrder,
  imStickerRef,
  STORAGE_IMAGE_MIMES,
} from '@qiwu/shared'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import type { DataSource, Repository } from 'typeorm'
import { tenantId } from '../../../core/context/tenant.js'
import { softDeleteRows } from '../../../core/db/references.js'
import { BizError } from '../../../core/http/biz-error.js'
import type { UploadedFileData } from '../../../core/http/upload.js'
import { FsObject } from '../storage/fs-object.entity.js'
import { type Download, StorageService } from '../storage/storage.service.js'
import { ImStickerEntity } from './entities/im.entity.js'
import { requireMember, visibleEntry } from './im-access.js'
import { ImObjectsService } from './im-objects.service.js'

const STICKER_TAG = 'im.sticker'
const STICKER_RULE = { exts: ['webp'], maxBytes: IM_LIMITS.stickerMaxBytes } as const

const isImage = (mime: string) => (STORAGE_IMAGE_MIMES as readonly string[]).includes(mime)

const vo = (s: ImStickerEntity): ImSticker => ({
  id: s.id,
  sha256: s.sha256,
  mime: s.mime,
  width: s.width,
  height: s.height,
})

/**
 * 规范化成表情：自动转正、缩到 ≤240px 的 webp，动图保留动画但最多取前 100 帧；输入像素有上限。解不开
 * → 422；结果超过 512KiB → B5013。
 */
async function normalize(input: Buffer): Promise<{ webp: Buffer; width: number; height: number }> {
  let out: { webp: Buffer; width: number; height: number }
  try {
    const limitInputPixels = IM_LIMITS.inputPixels
    // 先读帧数再定 pages：要求的帧数多于实际帧数时解码器会报错
    const { pages = 1 } = await sharp(input, { limitInputPixels }).metadata()
    const { data, info } = await sharp(input, {
      limitInputPixels,
      pages: Math.min(pages, IM_LIMITS.animatedFrames),
    })
      .rotate()
      .resize(IM_LIMITS.stickerMaxPx, IM_LIMITS.stickerMaxPx, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp()
      .toBuffer({ resolveWithObject: true })
    out = { webp: data, width: info.width, height: info.pageHeight ?? info.height }
  } catch {
    throw new BizError(Err.UNPROCESSABLE)
  }
  if (out.webp.length > IM_LIMITS.stickerMaxBytes)
    throw new BizError(Err.IM_STICKER_LIMIT, { max: IM_LIMITS.stickerMax })
  return out
}

/**
 * 个人自定义表情（see docs/im.md）：上传或“存为我的表情”都规范化为 ≤240px、≤512KiB 的 webp，存
 * `im.sticker` 对象并绑定 `stk:<id>`；每人至多 100 个、同图去重；只限本人读取；删除同一事务软删对象。
 */
@Injectable()
export class StickersService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @InjectRepository(ImStickerEntity) private readonly repo: Repository<ImStickerEntity>,
    @InjectRepository(FsObject) private readonly objects: Repository<FsObject>,
    private readonly storage: StorageService,
    private readonly imObjects: ImObjectsService,
  ) {}

  /** 本人表情，按 sort_no。 */
  async list(userId: number): Promise<ImSticker[]> {
    return (await this.repo.find({ where: { userId }, order: { sortNo: 'ASC', id: 'ASC' } })).map(
      vo,
    )
  }

  /** 上传一张图片作为表情：大小按聊天上限（与存储上限取小），只收聊天允许的图片类型且内容确是图片。 */
  async create(file: UploadedFileData | undefined, userId: number): Promise<ImSticker> {
    if (!file?.buffer.length) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const { imageExts, maxBytes } = await this.imObjects.limits()
    if (file.buffer.length > maxBytes) throw new BizError(Err.PAYLOAD_TOO_LARGE)
    const ext = extname(file.originalname).slice(1).toLowerCase()
    const sniffed = await fileTypeFromBuffer(file.buffer)
    // 只有魔数确认的图片才交给解码器
    if (!imageExts.includes(ext) || !sniffed || !isImage(sniffed.mime))
      throw new BizError(Err.STORAGE_TYPE_REJECTED, { ext: ext || '?' })
    return this.keep(file.buffer, userId)
  }

  /** 把可见、未撤回的图片或表情消息存为我的表情。 */
  async fromEntry({ roomId, seq }: ImStickerFromEntry, userId: number): Promise<ImSticker> {
    const db = this.ds.manager
    // 与附件文件路由同一判定：当前成员（否则 B5002）、可见区间内（否则 B5012）
    const entry = await visibleEntry(db, await requireMember(db, roomId, userId), seq)
    if (entry.recalledAt) throw new BizError(Err.IM_ENTRY_NOT_FOUND)
    if ((entry.entryKind !== 'image' && entry.entryKind !== 'sticker') || !entry.attachment)
      throw new BizError(Err.UNPROCESSABLE)
    const { data } = await this.storage.readInternal(entry.attachment.objectId, {
      bizTag: 'im.attachment',
      bizRef: imEntryRef(roomId, seq),
      maxBytes: IM_LIMITS.proxyMaxBytes,
    })
    return this.keep(data, userId)
  }

  /** 按给定顺序重排本人表情；别人的与已删除的 id 不受影响，未列出的保持原序号。 */
  async reorder({ ids }: ImStickerOrder, userId: number): Promise<void> {
    // FIELD(id, …) 是 id 在列表中的位置（从 1 起）
    await this.ds.query(
      `UPDATE im_sticker SET sort_no = FIELD(id, ?)
        WHERE tenant_id = ? AND user_id = ? AND id IN (?) AND deleted_at IS NULL`,
      [ids, tenantId(), userId, ids],
    )
  }

  /** 删除本人一个表情（连同其文件对象，同一事务）；已发出的消息有自己的副本，不受影响。 */
  async remove(id: number, userId: number): Promise<void> {
    await this.ds.transaction(async (tx) => {
      const row = await tx
        .getRepository(ImStickerEntity)
        .findOne({ where: { id, userId }, lock: { mode: 'pessimistic_write' } })
      if (!row) throw new BizError(Err.NOT_FOUND)
      await softDeleteRows(tx, 'im_sticker', [id])
      await softDeleteRows(tx, 'fs_object', [row.objectId])
    })
  }

  /** 输出本人一个表情的图片；别人的与不存在的一样 404。 */
  async file(id: number, userId: number, opts: { proxy: boolean }): Promise<Download> {
    const row = await this.repo.findOneBy({ id, userId })
    const obj =
      row &&
      (await this.objects.findOneBy({
        id: row.objectId,
        bizTag: STICKER_TAG,
        bizRef: imStickerRef(id),
      }))
    if (!obj) throw new BizError(Err.NOT_FOUND)
    return this.storage.serveAuthorized(obj, { inline: true, proxy: opts.proxy })
  }

  /**
   * 规范化后收藏：同图（规范化结果的 sha256）已收藏 → 返回原表情；达到上限 → B5013；否则存对象、插入表情
   * 行并在同一事务绑定 `stk:<id>`。重复或失败时已存的对象未绑定，由清理任务 24 小时后回收。
   */
  private async keep(input: Buffer, userId: number): Promise<ImSticker> {
    const { webp, width, height } = await normalize(input)
    const sha256 = createHash('sha256').update(webp).digest('hex')
    const same = await this.repo.findOneBy({ userId, sha256 })
    if (same) return vo(same)
    if ((await this.repo.countBy({ userId })) >= IM_LIMITS.stickerMax)
      throw new BizError(Err.IM_STICKER_LIMIT, { max: IM_LIMITS.stickerMax })
    const obj = await this.storage.putImObject(
      webp,
      'sticker.webp',
      STICKER_TAG,
      userId,
      STICKER_RULE,
    )
    return this.ds.transaction(async (tx) => {
      // 锁本人的用户行：同一人的并发收藏排队，上限与去重在锁内复查（只锁空区间的间隙锁会互相死锁）
      await tx.query(
        // qw:no-data-scope 只锁调用者本人的行，不读取任何数据
        'SELECT id FROM iam_user WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE',
        [tenantId(), userId],
      )
      const repo = tx.getRepository(ImStickerEntity)
      const dup = await repo.findOneBy({ userId, sha256 })
      if (dup) return vo(dup)
      const mine = await repo.find({ select: { id: true, sortNo: true }, where: { userId } })
      if (mine.length >= IM_LIMITS.stickerMax)
        throw new BizError(Err.IM_STICKER_LIMIT, { max: IM_LIMITS.stickerMax })
      const row = await repo.save(
        repo.create({
          userId,
          objectId: obj.id,
          sha256,
          mime: obj.mime,
          width,
          height,
          sortNo: Math.max(0, ...mine.map((s) => s.sortNo)) + 1,
        }),
      )
      await this.storage.bindRefs([obj.id], STICKER_TAG, imStickerRef(row.id), userId, tx)
      return vo(row)
    })
  }
}
