import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import {
  WXOA_MATERIAL_ORIGINS,
  WXOA_MEDIA_KINDS,
  wxoaNeed,
  wxoaQueryId,
  type WxoaMediaKind,
} from './wxoa.schema.js'

/**
 * Permanent materials (`wxoa_material`), `/api/wxoa/materials`: uploaded here (a local `wxoa.media` copy
 * first) or pulled from WeChat (link only). A material a reply rule uses is not deleted (409).
 */

const MiB = 1024 * 1024

/** WeChat's size and type limits per kind (the upload also stays within `storage.max_size_mb`). */
export const WXOA_MEDIA_LIMITS = {
  image: { maxBytes: 10 * MiB, exts: ['jpg', 'jpeg', 'png', 'gif', 'bmp'] },
  voice: { maxBytes: 2 * MiB, exts: ['mp3', 'amr'] },
  video: { maxBytes: 10 * MiB, exts: ['mp4'] },
  thumb: { maxBytes: 64 * 1024, exts: ['jpg'] },
} as const satisfies Record<WxoaMediaKind, { maxBytes: number; exts: readonly string[] }>

/** POST /materials multipart fields besides `file`; a video needs `title` and `intro`, others take neither. */
export const wxoaMaterialCreate = z
  .object({
    accountId: wxoaQueryId,
    mediaKind: z.enum(WXOA_MEDIA_KINDS),
    title: blankAsNull(z.string().trim().max(64)),
    intro: blankAsNull(z.string().trim().max(255)),
  })
  .superRefine((m, ctx) => {
    wxoaNeed(m.title, m.mediaKind === 'video', 'title', ctx)
    wxoaNeed(m.intro, m.mediaKind === 'video', 'intro', ctx)
  })
  .register(fieldDomains, { domain: 'wxoa.material' })
export type WxoaMaterialCreate = z.output<typeof wxoaMaterialCreate>

export const wxoaMaterialQuery = pageQuery(['createdAt', 'id'])
  .extend({
    accountId: wxoaQueryId,
    mediaKind: z.enum(WXOA_MEDIA_KINDS).optional(),
    title: z.string().trim().max(64).optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.material' })
export type WxoaMaterialQuery = z.output<typeof wxoaMaterialQuery>

export const wxoaMaterialVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  mediaKind: z.enum(WXOA_MEDIA_KINDS),
  mediaId: z.string(),
  title: z.string().nullable(),
  intro: z.string().nullable(),
  fileName: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  /** an image's WeChat link (https; show through `wxoaImageUrl`) */
  wxUrl: z.string().nullable(),
  /** the local copy, read through the storage download */
  objectId: z.number().int().nullable(),
  origin: z.enum(WXOA_MATERIAL_ORIGINS),
  createdAt: z.iso.datetime(),
})
export type WxoaMaterialVo = z.infer<typeof wxoaMaterialVo>

/** GET /materials/counts: WeChat's own counts. */
export const wxoaMaterialCountsVo = z.object({
  image: z.number().int(),
  voice: z.number().int(),
  video: z.number().int(),
  news: z.number().int(),
})
export type WxoaMaterialCountsVo = z.infer<typeof wxoaMaterialCountsVo>
