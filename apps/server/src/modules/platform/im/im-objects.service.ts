import { pipeline } from 'node:stream'
import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import {
  DEFAULT_IM_FILE_EXTS,
  Err,
  IM_IMAGE_EXTS,
  IM_INT_PARAMS,
  IM_LIMITS,
  type ImAttachment,
  imEntryRef,
  imParams,
  imStickerRef,
  type ImUpload,
  STORAGE_ALLOWED_EXTS_DEFAULT,
  STORAGE_DENIED_EXTS,
  STORAGE_IMAGE_MIMES,
  storageMaxBytes,
  storageParams,
} from '@qiwu/shared'
import type { Response } from 'express'
import sharp from 'sharp'
import { IsNull, type Repository } from 'typeorm'
import { BizError } from '../../../core/http/biz-error.js'
import type { UploadedFileData } from '../../../core/http/upload.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { FsObject } from '../storage/fs-object.entity.js'
import { type Download, StorageService } from '../storage/storage.service.js'
import { ImStickerEntity } from './entities/im.entity.js'
import { inspectImVoice } from './im-voice.js'

/** 发送前要准备的附件：已上传的图片/文件对象，或要复制的自定义表情。 */
export type ImPrepareInput =
  { kind: 'image' | 'file' | 'voice'; objectId: number } | { kind: 'sticker'; stickerId: number }

/** 准备结果：写进 `im_entry.attachment` 的信息，与发送事务里要 `bindRefs` 的对象（原图 + 缩略图）。 */
export interface ImPrepared {
  attachment: ImAttachment
  objectIds: number[]
}

/** 生效的上传限额：扩展名已与 `storage.allowed_exts` 取交集，字节上限取参数与存储上限的较小值。 */
export interface ImFileLimits {
  fileExts: string[]
  imageExts: string[]
  /** `im.file.max_mb`（参数值，未与存储上限取小） */
  fileMaxMb: number
  maxBytes: number
}

const MB = 1024 * 1024
const ATTACHMENT_TAG = 'im.attachment'
const STICKER_TAG = 'im.sticker'
/** 服务端生成的规范化表情及其复制件：webp，≤512KiB。 */
const WEBP_RULE = { exts: ['webp'], maxBytes: IM_LIMITS.stickerMaxBytes } as const
/** 缩略图：webp，≤360px 的图远小于这个上限。 */
const THUMB_RULE = { exts: ['webp'], maxBytes: 4 * MB } as const

const isImage = (mime: string) => (STORAGE_IMAGE_MIMES as readonly string[]).includes(mime)

/** 逗号或空白分隔的扩展名列表（小写、去空）。 */
const extList = (raw: string) =>
  raw
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)

/**
 * 图片的显示尺寸（已按 EXIF 方向换算；动图取单帧高度）与 ≤360px 的 webp 缩略图（动图只取第 1 帧）。
 * 输入像素有上限，解码失败或超限 → 422，客户端可改按文件发送。
 */
async function thumbnail(data: Buffer): Promise<{ width: number; height: number; webp: Buffer }> {
  const opts = { limitInputPixels: IM_LIMITS.inputPixels, pages: 1 }
  try {
    const meta = await sharp(data, opts).metadata()
    const webp = await sharp(data, opts)
      .rotate()
      .resize(IM_LIMITS.thumbPx, IM_LIMITS.thumbPx, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toBuffer()
    const w = meta.width
    const h = meta.pageHeight ?? meta.height
    // EXIF 方向 5–8 表示图像转了 90°，显示宽高互换
    const [width, height] = (meta.orientation ?? 1) >= 5 ? [h, w] : [w, h]
    return { width, height, webp }
  } catch {
    throw new BizError(Err.UNPROCESSABLE)
  }
}

/**
 * 聊天文件（see docs/im.md）：上传、缩略图、自定义表情复制成消息附件、授权之后的输出。对象都是
 * `im.attachment` 私有标签，未绑定的由清理任务 24 小时后回收；通用存储接口对它们一律拒绝。
 * 成员与可见区间由调用方经 `im-access.ts` 判定之后才调用这里。
 */
@Injectable()
export class ImObjectsService {
  constructor(
    private readonly storage: StorageService,
    private readonly params: ParamService,
    @InjectRepository(FsObject) private readonly objects: Repository<FsObject>,
    @InjectRepository(ImStickerEntity) private readonly stickers: Repository<ImStickerEntity>,
  ) {}

  /** 生效的上传限额（`GET /options` 与上传共用）。 */
  async limits(): Promise<ImFileLimits> {
    const { key, min, max, fallback } = IM_INT_PARAMS.fileMaxMb
    const fileMaxMb = await this.params.int(key, min, max, fallback)
    const storageRaw = (await this.params.get(storageParams.allowedExts))?.trim()
    const denied = new Set<string>(STORAGE_DENIED_EXTS)
    // 与通用存储同一读取规则：空值用默认清单，永不允许的扩展名剔除
    const allowed = new Set(
      (storageRaw ? extList(storageRaw) : [...STORAGE_ALLOWED_EXTS_DEFAULT]).filter(
        (e) => !denied.has(e),
      ),
    )
    const fileRaw = (await this.params.get(imParams.fileExts))?.trim() || DEFAULT_IM_FILE_EXTS
    const only = (exts: readonly string[]) => [...new Set(exts)].filter((e) => allowed.has(e))
    // 聊天上限不能放宽通用存储上限：取两者较小值
    const storageBytes = storageMaxBytes(await this.params.get(storageParams.maxSizeMb))
    return {
      fileExts: only(extList(fileRaw)),
      imageExts: only(IM_IMAGE_EXTS),
      fileMaxMb,
      maxBytes: Math.min(fileMaxMb * MB, storageBytes),
    }
  }

  /** 成员上传一张图片或一个文件（调用方已确认是当前成员且会话未解散）；超限 413、类型不符 422。 */
  async upload(file: UploadedFileData | undefined, userId: number): Promise<ImUpload> {
    if (!file?.buffer.length) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const { fileExts, imageExts, maxBytes } = await this.limits()
    // 先比大小再识别类型：超限的文件不做魔数与容器扫描
    if (file.buffer.length > maxBytes) throw new BizError(Err.PAYLOAD_TOO_LARGE)
    const obj = await this.storage.putImObject(
      file.buffer,
      file.originalname,
      ATTACHMENT_TAG,
      userId,
      { exts: [...fileExts, ...imageExts], maxBytes },
    )
    return { objectId: obj.id, name: obj.originalName, size: obj.size, mime: obj.mime }
  }

  /** 语音固定格式独立于普通文件扩展配置，字节仍不得超过存储限额。 */
  async voiceLimits(): Promise<{ maxBytes: number; maxSeconds: number; maxMb: number }> {
    const seconds = IM_INT_PARAMS.voiceMaxSeconds
    const mb = IM_INT_PARAMS.voiceMaxMb
    const maxMb = await this.params.int(mb.key, mb.min, mb.max, mb.fallback)
    return {
      maxMb,
      maxSeconds: await this.params.int(seconds.key, seconds.min, seconds.max, seconds.fallback),
      maxBytes: Math.min(
        maxMb * MB,
        storageMaxBytes(await this.params.get(storageParams.maxSizeMb)),
      ),
    }
  }

  /** 上传前验证实际音频，存储仍使用聊天自有私有标签，普通文件路由不能读取。 */
  async uploadVoice(file: UploadedFileData | undefined, userId: number): Promise<ImUpload> {
    if (!file?.buffer.length) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const limits = await this.voiceLimits()
    if (file.buffer.length > limits.maxBytes) throw new BizError(Err.PAYLOAD_TOO_LARGE)
    const durationMs = await inspectImVoice(file.buffer, limits.maxSeconds)
    const obj = await this.storage.putImObject(file.buffer, 'voice.wav', ATTACHMENT_TAG, userId, {
      exts: ['wav'],
      maxBytes: limits.maxBytes,
    })
    return { objectId: obj.id, name: obj.originalName, size: obj.size, mime: obj.mime, durationMs }
  }

  /**
   * 发送前在锁外准备附件：图片生成 ≤360px webp 缩略图对象；文件只核对对象；自定义表情把表情对象复制成
   * 新的 `im.attachment` 对象。对象必须是本人上传、未绑定、未删除的，否则 `STORAGE_REF_INVALID`。
   */
  async prepare(input: ImPrepareInput, userId: number): Promise<ImPrepared> {
    if (input.kind === 'sticker') return this.copySticker(input.stickerId, userId)
    // 只是预检，给出明确的错误；真正的“未绑定”保证是发送事务里 bindRefs 的条件更新
    const obj = await this.objects.findOneBy({
      id: input.objectId,
      bizTag: ATTACHMENT_TAG,
      uploaderId: userId,
      bizRef: IsNull(),
    })
    if (!obj) throw new BizError(Err.STORAGE_REF_INVALID)
    const base = {
      objectId: obj.id,
      name: obj.originalName,
      mime: obj.mime,
      size: obj.size,
      sha256: obj.sha256 ?? '',
    }
    if (input.kind === 'file') return { attachment: base, objectIds: [obj.id] }
    if (input.kind === 'voice') {
      const limits = await this.voiceLimits()
      if (obj.size > limits.maxBytes) throw new BizError(Err.PAYLOAD_TOO_LARGE)
      const { data } = await this.storage.readInternal(obj.id, {
        bizTag: ATTACHMENT_TAG,
        maxBytes: limits.maxBytes,
      })
      const durationMs = await inspectImVoice(data, limits.maxSeconds)
      return { attachment: { ...base, durationMs }, objectIds: [obj.id] }
    }
    if (!isImage(obj.mime)) throw new BizError(Err.STORAGE_TYPE_REJECTED, { ext: obj.mime })
    const { data } = await this.storage.readInternal(obj.id, {
      bizTag: ATTACHMENT_TAG,
      maxBytes: obj.size,
    })
    const { width, height, webp } = await thumbnail(data)
    const thumb = await this.storage.putImObject(
      webp,
      'thumb.webp',
      ATTACHMENT_TAG,
      userId,
      THUMB_RULE,
    )
    return {
      attachment: { ...base, thumbObjectId: thumb.id, width, height },
      objectIds: [obj.id, thumb.id],
    }
  }

  /**
   * 输出第 seq 条消息的附件（调用方已核对当前成员、可见区间、未撤回、该行有附件）：按 `thumb` 取缩略图或
   * 原图对象，核对 `biz_tag = 'im.attachment'` 与 `biz_ref = im:<roomId>:<seq>` 后交给存储输出。
   */
  async serve(
    roomId: number,
    seq: number,
    attachment: ImAttachment,
    opts: { thumb: boolean; proxy: boolean },
  ): Promise<Download> {
    // 没有缩略图的小图（表情）缩略图就是原图；文件没有缩略图
    const id = !opts.thumb
      ? attachment.objectId
      : (attachment.thumbObjectId ?? (isImage(attachment.mime) ? attachment.objectId : undefined))
    // 附件 JSON 不是授权依据：对象必须确实绑定在这一条消息上（已撤回、已清理的对象已软删，查不到）
    const obj =
      id === undefined
        ? null
        : await this.objects.findOneBy({
            id,
            bizTag: ATTACHMENT_TAG,
            bizRef: imEntryRef(roomId, seq),
          })
    if (!obj) throw new BizError(Err.IM_ENTRY_NOT_FOUND)
    return this.storage.serveAuthorized(obj, { inline: true, proxy: opts.proxy })
  }

  /**
   * 发送自定义表情：把本人表情的对象读出来另存一个新的 `im.attachment` 对象。消息与对象一一对应，之后删
   * 收藏不影响已发消息，撤回消息也不动收藏。别人的、已删除的表情与不存在的一样 → `STORAGE_REF_INVALID`。
   */
  private async copySticker(stickerId: number, userId: number): Promise<ImPrepared> {
    const sticker = await this.stickers.findOneBy({ id: stickerId, userId })
    if (!sticker) throw new BizError(Err.STORAGE_REF_INVALID)
    const { data } = await this.storage.readInternal(sticker.objectId, {
      bizTag: STICKER_TAG,
      bizRef: imStickerRef(sticker.id),
      maxBytes: WEBP_RULE.maxBytes,
    })
    const copy = await this.storage.putImObject(
      data,
      'sticker.webp',
      ATTACHMENT_TAG,
      userId,
      WEBP_RULE,
    )
    return {
      attachment: {
        objectId: copy.id,
        name: copy.originalName,
        mime: copy.mime,
        size: copy.size,
        width: sticker.width,
        height: sticker.height,
        sha256: copy.sha256 ?? sticker.sha256,
      },
      objectIds: [copy.id],
    }
  }
}

/** 把存储的输出写到响应：302 跳转或文件流（不经过 JSON 包络）。 */
export function sendImFile(res: Response, out: Download): void {
  if ('redirect' in out) return res.redirect(302, out.redirect)
  const { type, length, disposition } = out.getHeaders()
  res.set({
    'Content-Type': type,
    'Content-Disposition': disposition,
    ...(length == null ? {} : { 'Content-Length': String(length) }),
  })
  // 客户端断开或读取失败时 pipeline 一并销毁文件流
  pipeline(out.getStream(), res, () => undefined)
}
