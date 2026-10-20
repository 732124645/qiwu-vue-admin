import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import {
  WXOA_QR_KINDS,
  WXOA_SCENE,
  wxoaId,
  wxoaNeed,
  wxoaQueryId,
  wxoaTagId,
} from './wxoa.schema.js'

/**
 * Channel QR codes (`wxoa_qrcode`), `/api/wxoa/qrcodes`: string scenes only, temporary (60 s – 30 days)
 * or permanent. Scans and scan-subscribes are counted; `tagId` (a tag of the account) is given to the
 * fan who scans. Deleting removes the local row only: a permanent code keeps working on WeChat.
 */

export const WXOA_QR_EXPIRE_SECONDS = { min: 60, max: 2_592_000 } as const

const label = z.string().trim().min(1).max(64)

/** POST body: a temporary code needs `expireSeconds`, a permanent one takes none. */
export const wxoaQrcodeCreate = z
  .object({
    accountId: wxoaId,
    label,
    qrKind: z.enum(WXOA_QR_KINDS),
    scene: z.string().regex(WXOA_SCENE),
    expireSeconds: z
      .number()
      .int()
      .min(WXOA_QR_EXPIRE_SECONDS.min)
      .max(WXOA_QR_EXPIRE_SECONDS.max)
      .nullish(),
    tagId: wxoaTagId.nullish(),
  })
  .superRefine((q, ctx) =>
    wxoaNeed(q.expireSeconds, q.qrKind === 'temporary', 'expireSeconds', ctx),
  )
  .register(fieldDomains, { domain: 'wxoa.qrcode' })
export type WxoaQrcodeCreate = z.infer<typeof wxoaQrcodeCreate>

/** PUT body: the name and the auto tag only (null removes the tag). */
export const wxoaQrcodeUpdate = z
  .strictObject({ label, tagId: wxoaTagId.nullish() })
  .register(fieldDomains, { domain: 'wxoa.qrcode' })
export type WxoaQrcodeUpdate = z.infer<typeof wxoaQrcodeUpdate>

export const wxoaQrcodeQuery = pageQuery(['createdAt', 'scanCount', 'subscribeCount', 'id'])
  .extend({
    accountId: wxoaQueryId,
    qrKind: z.enum(WXOA_QR_KINDS).optional(),
    label: z.string().trim().max(64).optional(),
  })
  .register(fieldDomains, { domain: 'wxoa.qrcode' })
export type WxoaQrcodeQuery = z.output<typeof wxoaQrcodeQuery>

export const wxoaQrcodeVo = z.object({
  id: z.number().int(),
  accountId: z.number().int(),
  label: z.string(),
  qrKind: z.enum(WXOA_QR_KINDS),
  scene: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  ticket: z.string(),
  /** the content the code encodes */
  qrUrl: z.string(),
  /** the image copy, read through the storage download */
  objectId: z.number().int().nullable(),
  tagId: z.number().int().nullable(),
  scanCount: z.number().int(),
  subscribeCount: z.number().int(),
  createdAt: z.iso.datetime(),
})
export type WxoaQrcodeVo = z.infer<typeof wxoaQrcodeVo>

/** GET /qrcodes/:id/stats: the last `days` days, per day. */
export const wxoaQrcodeStatsQuery = z
  .object({ days: z.coerce.number().int().min(1).max(90).default(30) })
  .register(fieldDomains, { domain: 'wxoa.qrcode' })
export type WxoaQrcodeStatsQuery = z.output<typeof wxoaQrcodeStatsQuery>
export const wxoaQrcodeStatsVo = z.array(
  z.object({ day: z.iso.date(), scans: z.number().int(), subscribes: z.number().int() }),
)
export type WxoaQrcodeStatsVo = z.infer<typeof wxoaQrcodeStatsVo>
