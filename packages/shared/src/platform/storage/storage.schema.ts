import { z } from 'zod'
import { pageQuery } from '../../common/pagination.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { STORAGE_DRIVERS } from './storage-driver.schema.js'

/**
 * File storage (`fs_object`; see docs/design-notes.md#storage), `/api/storage/objects`. Field labels `field.storage.object.<prop>`.
 *
 * Public or private is decided by the upload's `bizTag`, never by the client: the public tags accept only
 * the images in {@link STORAGE_IMAGE_MIMES} (sniffed by magic number) and are served without a token under
 * `/files/…`; every other tag is private and read only through `GET /objects/:id/download` (uploader,
 * `storage.object.view` or the tag's registered access checker).
 */

export const storageObjectPerms = {
  /** the file list (GET /objects) */
  browse: 'storage.object.browse',
  /** any object's detail; download any private object */
  view: 'storage.object.view',
  export: 'storage.object.export',
  /** delete objects (and their files) */
  remove: 'storage.object.remove',
} as const

export const STORAGE_PUBLIC_TAGS = ['avatar', 'richtext', 'cover'] as const
/** `wf.attachment`: workflow form attachments, bound to their instance on start (`biz_ref = 'wf:<id>'`) */
export const STORAGE_PRIVATE_TAGS = ['attachment', 'import', 'wf.attachment'] as const
export const STORAGE_BIZ_TAGS = [...STORAGE_PUBLIC_TAGS, ...STORAGE_PRIVATE_TAGS] as const
export type StorageBizTag = (typeof STORAGE_BIZ_TAGS)[number]

export const isPublicBizTag = (tag: string): boolean =>
  (STORAGE_PUBLIC_TAGS as readonly string[]).includes(tag)

const STORAGE_REF = /^([1-9]\d{0,14})\/(.+)$/
/**
 * Uploads kept in a text value (a `qw-upload` form field): one `<object id>/<file name>` line per
 * file, `\n`-separated (stored names hold no control characters), as a generated form's file column keeps
 * its one file. '' / null / undefined = none; any other value not of that shape → null.
 */
export function storageRefs(value: unknown): { id: number; name: string }[] | null {
  if (value == null || value === '') return []
  if (typeof value !== 'string') return null
  const refs = value.split('\n').map((line) => STORAGE_REF.exec(line))
  return refs.every((m) => m !== null) ? refs.map((m) => ({ id: Number(m[1]), name: m[2]! })) : null
}

/** The only types a public tag accepts, and the only ones a private download may send `inline`. */
export const STORAGE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** Upload size limit when the `cfg_param` is unset: larger → 413. */
export const STORAGE_MAX_SIZE_DEFAULT = 20 * 1024 * 1024

/**
 * The upload limit in bytes of a `storage.max_size_mb` value, by the server's rule: an integer 1–2048,
 * anything else (unset, unreadable) {@link STORAGE_MAX_SIZE_DEFAULT}.
 */
export function storageMaxBytes(mb: string | null | undefined): number {
  const raw = mb?.trim()
  const n = Number(raw)
  return raw && Number.isInteger(n) && n >= 1 && n <= 2048
    ? n * 1024 * 1024
    : STORAGE_MAX_SIZE_DEFAULT
}

/** Runtime params (`cfg_param`, seeded by the storage module). */
export const storageParams = {
  /** upload limit in MB (default {@link STORAGE_MAX_SIZE_DEFAULT}); public: the pickers read it */
  maxSizeMb: 'storage.max_size_mb',
  /** accepted extensions, comma separated (default {@link STORAGE_ALLOWED_EXTS_DEFAULT}) */
  allowedExts: 'storage.allowed_exts',
} as const

export const STORAGE_ALLOWED_EXTS_DEFAULT = [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'zip',
] as const

/** Never accepted, whatever `storage.allowed_exts` says: browsers run them as documents or scripts. */
export const STORAGE_DENIED_EXTS = [
  'html',
  'htm',
  'xhtml',
  'xht',
  'svg',
  'svgz',
  'xml',
  'js',
  'mjs',
] as const

/** POST /objects multipart fields besides `file`. */
export const fsUploadBody = z
  .object({ bizTag: z.enum(STORAGE_BIZ_TAGS) })
  .register(fieldDomains, { domain: 'storage.object' })
export type FsUploadBody = z.infer<typeof fsUploadBody>

/** GET /objects/:id/download query: `inline=true` asks to display an image instead of saving it. */
export const fsDownloadQuery = z
  .object({ inline: z.stringbool().optional() })
  .register(fieldDomains, { domain: 'storage.object' })
export type FsDownloadQuery = z.output<typeof fsDownloadQuery>

/** An object; also the upload response. */
export const fsObjectVo = z.object({
  id: z.number().int(),
  /** the client's file name, for display and the download's file name only */
  originalName: z.string(),
  /** the sniffed type */
  mime: z.string(),
  /** bytes */
  size: z.number().int(),
  /** public objects: `/files/<key>` (local) or the S3 public domain URL; private: null */
  url: z.string().nullable(),
  isPublic: z.boolean(),
  bizTag: z.string(),
  createdAt: z.iso.datetime(),
})
export type FsObjectVo = z.infer<typeof fsObjectVo>

const FILE_REF = /^(\d+)\/(.+)$/s

/** The file name of a file column's `<id>/<file name>` (list cells, details; web and mobile). */
export const uploadName = (value: string | null | undefined) =>
  FILE_REF.exec(value ?? '')?.[2] ?? value ?? ''

/** A file kept as text, `<id>/<file name>` (no URL: a private object downloads by id with the token). */
export const fileRef = (o: Pick<FsObjectVo, 'id' | 'originalName'>) => `${o.id}/${o.originalName}`

/** The object of a {@link fileRef} (without type, size or tag), null for anything else. */
export function fromFileRef(value: unknown): FsObjectVo | null {
  const file = typeof value === 'string' ? FILE_REF.exec(value) : null
  if (!file) return null
  const [, id, originalName = ''] = file
  return {
    id: Number(id),
    originalName,
    mime: '',
    size: 0,
    url: null,
    isPublic: false,
    bizTag: '',
    createdAt: '',
  }
}

/** What a generated form's `image-upload` / `file-upload` column keeps of its one upload. */
export type UploadKind = 'image' | 'file'

/**
 * The upload of a text column (generated forms, `image-upload` / `file-upload`; web and mobile; see docs/design-notes.md#codegen)
 * as an upload field's list: an image column holds the image's public URL (uploaded under a public tag,
 * `cover`), a file column a {@link fileRef}; '' / null / anything else = none.
 */
export function uploadsOf(value: unknown, kind: UploadKind): FsObjectVo[] {
  if (typeof value !== 'string' || !value) return []
  if (kind === 'file') {
    const file = fromFileRef(value)
    return file ? [file] : []
  }
  const name = value.split('/').pop() || value
  const stub = { mime: '', size: 0, bizTag: '', createdAt: '' }
  return [{ ...stub, id: 0, originalName: name, url: value, isPublic: true }]
}

/** The column's text of an upload field's list ({@link uploadsOf} back): its first upload, none → ''. */
export function uploadText(list: readonly FsObjectVo[], kind: UploadKind): string {
  const o = list[0]
  return !o ? '' : kind === 'image' ? (o.url ?? '') : fileRef(o)
}

/** `fs_object.object_key`: `yyyy/MM/dd/<uuid>.<ext>` (the direct upload's confirm names it). */
export const FS_OBJECT_KEY =
  /^\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$/

/**
 * Direct upload to the primary S3 storage (see docs/design-notes.md#storage): `POST /objects/presign` checks the name's
 * extension, the size (`storage.max_size_mb` → 413) and the tag's rules like an upload, then answers a
 * presigned PUT bound to that type and length; the browser PUTs the file and `POST /objects/confirm`
 * registers it. A local primary storage has no direct upload (→ 422): the page uploads through POST /objects.
 */
export const fsPresignBody = z
  .object({
    filename: z.string().trim().min(1).max(255),
    /** bytes */
    size: z.number().int().positive(),
    /** the type the browser reports; the PUT is signed for it, confirm sniffs the stored bytes again */
    mime: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[\w.+-]+\/[\w.+-]+$/),
    bizTag: z.enum(STORAGE_BIZ_TAGS),
    /** the file's SHA-256 (hex) if the browser computed it: signed as `x-amz-checksum-sha256` and recorded */
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .register(fieldDomains, { domain: 'storage.object' })
export type FsPresignBody = z.infer<typeof fsPresignBody>

export const fsPresignVo = z.object({
  /** the object key to confirm afterwards */
  key: z.string(),
  /** PUT the file here, before `expiresAt` */
  url: z.string(),
  /** headers the PUT must send as given (Content-Type, and the checksum when `sha256` was sent) */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
})
export type FsPresignVo = z.infer<typeof fsPresignVo>

/**
 * `POST /objects/confirm` → {@link FsObjectVo} (201). Only the caller who presigned the key can confirm it,
 * once: anyone else, or an unknown / used key → 404 and the owner's token stays (see docs/design-notes.md#storage). The
 * stored object's size and sniffed type must match the presign, else it is deleted (422).
 */
export const fsConfirmBody = z
  .object({ key: z.string().trim().min(1).max(512).regex(FS_OBJECT_KEY) })
  .register(fieldDomains, { domain: 'storage.object' })
export type FsConfirmBody = z.infer<typeof fsConfirmBody>

/**
 * File list (`GET /objects`, `browse`; export `GET /objects/export`, `export`): every stored object, newest
 * first by default. Deleting a public object (`DELETE /objects/:id`, `remove`) may break the pages that
 * still link it: no references are recorded (see docs/design-notes.md#storage).
 */
export const fsObjectQuery = pageQuery(['size', 'createdAt', 'id'])
  .extend({
    /** contains */
    originalName: z.string().trim().max(255).optional(),
    bizTag: z.enum(STORAGE_BIZ_TAGS).optional(),
    isPublic: z.stringbool().optional(),
    storageId: z.coerce.number().int().positive().optional(),
    createdAtFrom: z.iso.datetime({ offset: true }).optional(),
    createdAtTo: z.iso.datetime({ offset: true }).optional(),
  })
  .register(fieldDomains, { domain: 'storage.object' })
export type FsObjectQuery = z.output<typeof fsObjectQuery>

/** A row of the file list. */
export const fsObjectRowVo = fsObjectVo.extend({
  storageId: z.number().int(),
  /** the storage's name: a `seed.storage.*` key or text */
  storageName: z.string(),
  uploaderId: z.number().int(),
  /** the uploader's display name; null when the user is gone */
  uploaderName: z.string().nullable(),
})
export type FsObjectRowVo = z.infer<typeof fsObjectRowVo>

/** `GET /objects/:id` (`view`). */
export const fsObjectDetailVo = fsObjectRowVo.extend({
  storageDriver: z.enum(STORAGE_DRIVERS),
  objectKey: z.string(),
  sha256: z.string().nullable(),
  /** e.g. `wf:<instanceId>`, for the tag's access checker */
  bizRef: z.string().nullable(),
})
export type FsObjectDetailVo = z.infer<typeof fsObjectDetailVo>
