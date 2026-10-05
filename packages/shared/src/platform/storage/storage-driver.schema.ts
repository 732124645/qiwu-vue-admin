import { z } from 'zod'
import { blankAsNull } from '../../common/crud.js'
import { fieldDomains } from '../../validation/zod-i18n.js'
import { PARAM_SECRET_MASK } from '../settings/param.schema.js'

/**
 * Storage config form (`fs_storage`; see docs/design-notes.md#storage): the driver-specific add / edit bodies and the
 * detail, beside the generated list (business `config`: `/api/storage/configs`, its `configPerms`, field
 * labels `field.storage.config.<prop>`; the driver fields' labels are in field.json). The fields past the
 * common ones are stored in the `config` JSON; a body is flat so each field is its own form item.
 * - `local`: files below `STORAGE_LOCAL_ROOT`, env only: no root field, a sent one is dropped.
 * - `s3`: every connection goes through the core/net guard (see docs/design-notes.md#security); `secretKey` is kept encrypted
 *   (SecretBox) and never sent back: the detail shows {@link STORAGE_SECRET_MASK}, a PUT with the mask or
 *   without the field or with a blank value keeps the stored one only if endpoint/bucket/accessKey stay.
 * - `driver` is set when the storage is added; a PUT naming another driver → 422.
 * - `POST /configs/:id/test` → {@link StorageTestVo}; `PUT /configs/:id/primary` makes it the primary one.
 */

export const STORAGE_DRIVERS = ['local', 's3'] as const
export type StorageDriver = (typeof STORAGE_DRIVERS)[number]

/** What a stored `secretKey` reads as (the same mask as secret params). */
export const STORAGE_SECRET_MASK = PARAM_SECRET_MASK

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .pipe(z.url({ protocol: /^https?$/ }))
/** a path on this site (`/files`): one leading slash, never `//host` or `/\host`, no spaces */
const SITE_PATH = /^\/(?![/\\])[^\s\\?#]*$/

const common = z.object({
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean().optional(),
  note: z.string().trim().max(500).nullish(),
})

export const storageLocalCreate = common
  .extend({
    driver: z.literal('local'),
    /** base of public objects' URLs: a site path (none = `/files`) or the http(s) URL of a CDN in front */
    publicPrefix: blankAsNull(
      z
        .string()
        .trim()
        .max(255)
        .pipe(z.union([z.string().regex(SITE_PATH), httpUrl])),
    ),
  })
  .register(fieldDomains, { domain: 'storage.config' })
export type StorageLocalCreate = z.infer<typeof storageLocalCreate>

const secretKey = z.string().trim().min(1).max(256)

export const storageS3Create = common
  .extend({
    driver: z.literal('s3'),
    endpoint: httpUrl,
    region: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    /** S3 bucket naming: 3–63 lowercase letters, digits, dots and hyphens */
    bucket: z
      .string()
      .trim()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    accessKey: z.string().trim().min(1).max(128),
    secretKey,
    /** path-style URLs (`<endpoint>/<bucket>/<key>`), for services without bucket subdomains */
    forcePathStyle: z.boolean().default(false),
    /** base of public objects' URLs (a CDN or the bucket's public host); none = not linkable directly */
    publicDomain: blankAsNull(httpUrl),
  })
  .register(fieldDomains, { domain: 'storage.config' })
export type StorageS3Create = z.infer<typeof storageS3Create>

/** POST body. */
export const storageConfigCreate = z
  .discriminatedUnion('driver', [storageLocalCreate, storageS3Create])
  .register(fieldDomains, { domain: 'storage.config' })
export type StorageConfigCreate = z.infer<typeof storageConfigCreate>

export const storageS3Update = storageS3Create
  .extend({
    secretKey: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      secretKey.optional(),
    ),
  })
  .register(fieldDomains, { domain: 'storage.config' })

/** PUT body: the whole form; absent/blank/masked `secretKey` is kept only for an unchanged target. */
export const storageConfigUpdate = z
  .discriminatedUnion('driver', [storageLocalCreate, storageS3Update])
  .register(fieldDomains, { domain: 'storage.config' })
export type StorageConfigUpdate = z.infer<typeof storageConfigUpdate>

const commonVo = z.object({
  id: z.number().int(),
  /** i18n key (seeded, `seed.storage.*`) or text */
  name: z.string(),
  isPrimary: z.boolean(),
  enabled: z.boolean(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
})

/** GET /configs/:id (the form's detail). */
export const storageConfigVo = z.discriminatedUnion('driver', [
  commonVo.extend({ driver: z.literal('local'), publicPrefix: z.string().nullable() }),
  commonVo.extend({
    driver: z.literal('s3'),
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
    accessKey: z.string(),
    /** always {@link STORAGE_SECRET_MASK} */
    secretKey: z.string(),
    forcePathStyle: z.boolean(),
    publicDomain: z.string().nullable(),
  }),
])
export type StorageConfigVo = z.infer<typeof storageConfigVo>

/**
 * Test connection: `ok` only. A failure (refused host, timeout, bad credentials, missing bucket) is never
 * told apart and nothing from the remote end is echoed (see docs/design-notes.md#security).
 */
export const storageTestVo = z.object({ ok: z.boolean() })
export type StorageTestVo = z.infer<typeof storageTestVo>
