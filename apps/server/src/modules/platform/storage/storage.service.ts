import { createHash, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import {
  Err,
  type FsObjectDetailVo,
  type FsObjectQuery,
  type FsObjectRowVo,
  type FsObjectVo,
  type FsPresignBody,
  type FsPresignVo,
  type Page,
  isPublicBizTag,
  STORAGE_ALLOWED_EXTS_DEFAULT,
  STORAGE_DENIED_EXTS,
  STORAGE_IMAGE_MIMES,
  storageObjectPerms,
  STORAGE_MAX_SIZE_DEFAULT,
  storageParams,
  type StorageBizTag,
} from '@qiwu/shared'
import { fileTypeFromBuffer } from 'file-type'
import {
  type EntityManager,
  In,
  IsNull,
  LessThan,
  MoreThan,
  Not,
  type Repository,
  type SelectQueryBuilder,
} from 'typeorm'
import type { Principal } from '../../../core/auth/principal.js'
import { EXPORT_BATCH } from '../../../core/db/base-crud.service.js'
import { contains, exportBatches, paginate, sorted } from '../../../core/db/page.js'
import { softDeleteRows } from '../../../core/db/references.js'
import type { ExcelColumn } from '../../../core/excel/excel.service.js'
import { AppConfigService } from '../../../core/config/config.module.js'
import { SecretBox } from '../../../core/crypto/secret-box.js'
import { zipEntries } from '../../../core/excel/excel.js'
import { BizError } from '../../../core/http/biz-error.js'
import { outboundRule } from '../../../core/net/net-guard.js'
import type { UploadedFileData } from '../../../core/http/upload.js'
import { redisKey } from '../../../core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../../core/redis/redis.module.js'
import { ParamService } from '../../../core/settings/param.service.js'
import { FsObject } from './fs-object.entity.js'
import { StorageConfig } from './config/config.entity.js'
import { dropUnusedSecrets } from './config/config.service.js'
import { LocalStorage } from './local-storage.js'
import { type S3Config, S3Storage } from './s3-storage.js'
import { StorageAccess } from './storage-access.js'

/** A storage's driver (both offer put / remove / publicUrl). */
type StorageClient = LocalStorage | S3Storage

/** What a download answers: the file (local) or a presigned URL to redirect to (S3). */
export type Download = StreamableFile | { redirect: string }

/** Extensions whose sniffed type has another name: old Office files are CFB containers, OOXML may sniff as zip. */
const SNIFFED_AS: Record<string, string[]> = {
  jpeg: ['jpg'],
  doc: ['cfb'],
  xls: ['cfb'],
  ppt: ['cfb'],
  docx: ['zip'],
  xlsx: ['zip'],
  pptx: ['zip'],
}

/** OOXML packages sniffed as a plain zip: must still be that kind of document ([Content_Types].xml + its part). */
const OOXML_PART: Record<string, string> = { docx: 'word/', xlsx: 'xl/', pptx: 'ppt/' }
const isOoxml = (names: string[], ext: string) =>
  names.includes('[Content_Types].xml') && names.some((n) => n.startsWith(OOXML_PART[ext]!))

/**
 * Old Office files are CFB containers (so are .msi and others): the document's main stream name
 * (UTF-16LE in the CFB directory) must be present.
 * A byte search, not a CFB directory walk; walk the directory if a forged name ever matters.
 */
const CFB_STREAM: Record<string, Buffer[]> = Object.fromEntries(
  Object.entries({
    doc: ['WordDocument'],
    xls: ['Workbook', 'Book'],
    ppt: ['PowerPoint Document'],
  }).map(([ext, names]) => [ext, names.map((n) => Buffer.from(n, 'utf16le'))]),
)

/** Extensions whose content is a zip / CFB container: only the whole file shows the document inside. */
const CONTAINER_EXTS = new Set([...Object.keys(OOXML_PART), ...Object.keys(CFB_STREAM)])

/** What the whole of a container file shows: its zip part names, whether a CFB stream of its kind occurs. */
interface Inside {
  zipNames: string[]
  cfbStream: boolean
}
const insideOf = (buf: Buffer, ext: string): Inside => ({
  zipNames: zipEntries(buf)?.map((e) => e.name) ?? [],
  cfbStream: (CFB_STREAM[ext] ?? []).some((name) => buf.includes(name)),
})

/** Bytes a direct upload's confirm reads to sniff the type (file-type needs at most 4100). */
const SNIFF_BYTES = 4100

/** A zip tail kept while streaming: end record + comment (≤ 64 KiB) + a central directory ≤ 1 MiB. */
const ZIP_TAIL_MAX = 1024 * 1024 + 22 + 0xffff

/**
 * A direct upload's Office container, read once as a stream with bounded memory whatever its size: its
 * first bytes (the sniff), its last ZIP_TAIL_MAX bytes (a zip's central directory) and a search for the
 * CFB stream names, i.e. what {@link typeOf} needs of the whole file. Stops (size = max + 1) past `max`.
 * A central directory over 1 MiB (tens of thousands of parts) is not found: refused.
 */
async function scanContainer(body: AsyncIterable<Uint8Array>, ext: string, max: number) {
  const names = CFB_STREAM[ext] ?? []
  let head = Buffer.alloc(0)
  let carry = Buffer.alloc(0)
  let cfbStream = false
  const tail: Buffer[] = []
  let tailSize = 0
  let size = 0
  for await (const piece of body) {
    const chunk = Buffer.from(piece)
    size += chunk.length
    if (size > max) break
    if (head.length < SNIFF_BYTES)
      head = Buffer.concat([head, chunk.subarray(0, SNIFF_BYTES - head.length)])
    // the end of the previous chunks too: a name may straddle chunks
    const window = Buffer.concat([carry, chunk])
    cfbStream ||= names.some((name) => window.includes(name))
    carry = window.subarray(-64)
    tail.push(chunk)
    tailSize += chunk.length
    while (tailSize - tail[0]!.length >= ZIP_TAIL_MAX) tailSize -= tail.shift()!.length
  }
  const zipTail = Buffer.concat(tail)
  const inside: Inside = {
    zipNames: zipEntries(zipTail, size - tailSize)?.map((e) => e.name) ?? [],
    cfbStream,
  }
  return { head, size, inside }
}

const isImage = (mime: string) => (STORAGE_IMAGE_MIMES as readonly string[]).includes(mime)

/**
 * The content's type when it is what the extension says (plain text: no magic number and `.txt`), else
 * null. `buf` is sniffed (the whole file, or a direct upload's first bytes); `inside` = what the whole
 * file shows of a zip or CFB container, null when only the first bytes are known: then an Office
 * container cannot be checked for the document inside, so only exact sniffs pass.
 */
async function typeOf(buf: Buffer, ext: string, inside: Inside | null): Promise<string | null> {
  const sniffed = await fileTypeFromBuffer(buf)
  if (!sniffed) return ext === 'txt' ? 'text/plain' : null
  if (sniffed.ext === ext) return sniffed.mime
  if (!(SNIFFED_AS[ext] ?? []).includes(sniffed.ext)) return null
  if (sniffed.ext === 'zip') return inside && isOoxml(inside.zipNames, ext) ? sniffed.mime : null
  if (sniffed.ext === 'cfb') return inside?.cfbStream ? sniffed.mime : null
  return sniffed.mime
}

/** File list export columns (list order). */
export const objectColumns: ExcelColumn[] = [
  { prop: 'originalName', label: 'field.storage.object.originalName', width: 40 },
  { prop: 'bizTag', label: 'field.storage.object.bizTag' },
  { prop: 'mime', label: 'field.storage.object.mime', width: 28 },
  { prop: 'size', label: 'field.storage.object.size', type: 'number' },
  {
    prop: 'isPublic',
    label: 'field.storage.object.isPublic',
    type: 'boolean',
    dict: 'core.yes_no',
  },
  { prop: 'storageName', label: 'field.storage.object.storageName', seedName: true },
  { prop: 'uploaderName', label: 'field.storage.object.uploaderName' },
  { prop: 'createdAt', label: 'field.storage.object.createdAt', type: 'datetime' },
]

/** Lifetime of a direct upload's presigned PUT and of its one-time confirm grant. */
export const PRESIGN_TTL_SEC = 600

/** `presign:{key}`: who may confirm the key, and what they were allowed to upload. */
interface PresignGrant {
  /** the uploader's id as a string (the Lua script compares strings) */
  uid: string
  storageId: number
  name: string
  size: number
  bizTag: StorageBizTag
  sha256: string | null
}

// Confirm's one-time grant (see docs/design-notes.md#storage): returns and deletes it only for its owner; anyone else,
// or an unknown key, gets nil and the grant stays, so knowing a key never burns the owner's confirm.
// KEYS: presign:{key} · ARGV: caller id
const TAKE_GRANT = `
local v = redis.call('GET', KEYS[1])
if not v then return false end
if cjson.decode(v).uid ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return v`

/** Display name: no directories, no control characters, ≤ 255 characters. */
const displayName = (name: string) =>
  basename(name.replace(/\\/g, '/'))
    .replace(/\p{Cc}/gu, '')
    .slice(0, 255) || 'file'

/** `Content-Disposition` with an ASCII fallback name and the exact UTF-8 one (RFC 6266 / 5987). */
const disposition = (type: 'inline' | 'attachment', name: string) =>
  `${type}; filename="${name.replace(/[^\x20-\x7e]|["\\%]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(
    name,
  ).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`

const today = () => new Date().toISOString().slice(0, 10).replaceAll('-', '/')
const newKey = (ext: string) => `${today()}/${randomUUID()}.${ext}`

/** Deleted objects per `purgeDeleted` read (each is then one storage delete + one row delete). */
const PURGE_BATCH = 100

/**
 * Uploads, downloads and deletes (see docs/design-notes.md#storage, #security). An upload must have an allowed extension
 * (`storage.allowed_exts`, never html/svg/xml/js) whose magic number matches the content; its business
 * tag decides public (images only, served at `/files/<key>`) or private (download route only: uploader,
 * `storage.object.view` or the tag's `StorageAccess` checker). Stored as `yyyy/MM/dd/<uuid>.<ext>`.
 * Deleting is soft (a public body leaves the public area at once); the body goes with the retention
 * purge (`remove`, `purgeDeleted`).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name)
  /** S3 clients by storage id, rebuilt when the row's `updated_at` moves (config edited) */
  private readonly s3 = new Map<number, { stamp: number; client: S3Storage }>()

  constructor(
    @InjectRepository(FsObject) private readonly objects: Repository<FsObject>,
    @InjectRepository(StorageConfig) private readonly storages: Repository<StorageConfig>,
    private readonly params: ParamService,
    private readonly access: StorageAccess,
    private readonly box: SecretBox,
    private readonly cfg: AppConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** The driver of a storage row; an S3 config's `secretKey` is opened through SecretBox. */
  clientFor(storage: StorageConfig): StorageClient {
    const config = storage.config ?? {}
    if (storage.driver === 'local') return new LocalStorage(config.publicPrefix as string | null)
    const stamp = storage.updatedAt.getTime()
    const cached = this.s3.get(storage.id)
    if (cached?.stamp === stamp) return cached.client
    // the replaced client may still be uploading: left alone, its idle sockets time out (core/net)
    const client = this.s3Client(config)
    this.s3.set(storage.id, { stamp, client })
    return client
  }

  /** An S3 client for a stored config (`secretKey` boxed) under this deployment's SSRF rule. */
  s3Client(config: Record<string, unknown>): S3Storage {
    const s3 = config as unknown as S3Config
    return new S3Storage(
      { ...s3, secretKey: this.box.decrypt(s3.secretKey) },
      outboundRule(this.cfg, 's3'),
    )
  }

  async upload(
    file: UploadedFileData | undefined,
    bizTag: StorageBizTag,
    uploaderId: number,
  ): Promise<FsObjectVo> {
    if (!file?.buffer.length) throw new BizError(Err.STORAGE_FILE_REQUIRED)
    const originalName = displayName(file.originalname)
    const ext = extname(originalName).slice(1).toLowerCase()
    await this.assertExt(ext)
    const mime = await typeOf(file.buffer, ext, insideOf(file.buffer, ext))
    if (!mime) throw new BizError(Err.STORAGE_TYPE_REJECTED, { ext })
    const isPublic = isPublicBizTag(bizTag)
    if (isPublic && !isImage(mime)) throw new BizError(Err.STORAGE_PUBLIC_IMAGE_ONLY)

    const storage = await this.primary()
    const client = this.clientFor(storage)
    const key = newKey(ext)
    await client.put(key, file.buffer, isPublic, mime)
    try {
      const row = await this.objects.save(
        this.objects.create({
          storageId: storage.id,
          objectKey: key,
          originalName,
          mime,
          size: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          isPublic,
          publicUrl: isPublic ? client.publicUrl(key) : null,
          bizTag,
          uploaderId,
        }),
      )
      return this.vo(row)
    } catch (e) {
      await client.remove(key, isPublic)
      throw e
    }
  }

  /**
   * Direct upload, step 1 (see docs/design-notes.md#storage): the name's extension, the size and the tag's rules are checked
   * like an upload, then the browser gets a PUT URL to the primary S3 storage signed with that type and
   * length (and the SHA-256 when sent), and `presign:{key}` records who may confirm what, for as long
   * as the URL lives. A local primary storage → 422 (upload through `POST /objects`).
   */
  async presign(body: FsPresignBody, uploaderId: number): Promise<FsPresignVo> {
    const name = displayName(body.filename)
    const ext = extname(name).slice(1).toLowerCase()
    await this.assertExt(ext)
    const maxMb = await this.params.int(
      storageParams.maxSizeMb,
      1,
      2048,
      STORAGE_MAX_SIZE_DEFAULT / 1024 / 1024,
    )
    if (body.size > maxMb * 1024 * 1024) throw new BizError(Err.PAYLOAD_TOO_LARGE)
    const isPublic = isPublicBizTag(body.bizTag)
    if (isPublic && !isImage(body.mime)) throw new BizError(Err.STORAGE_PUBLIC_IMAGE_ONLY)
    const storage = await this.primary()
    const client = this.clientFor(storage)
    if (!(client instanceof S3Storage)) throw new BizError(Err.STORAGE_DIRECT_UNAVAILABLE)
    const key = newKey(ext)
    const expiresAt = new Date(Date.now() + PRESIGN_TTL_SEC * 1000).toISOString()
    const put = await client.presignPut(key, body, PRESIGN_TTL_SEC)
    const grant: PresignGrant = {
      uid: String(uploaderId),
      storageId: storage.id,
      name,
      size: body.size,
      bizTag: body.bizTag,
      sha256: body.sha256 ?? null,
    }
    await this.redis.set(redisKey('presign', key), JSON.stringify(grant), {
      expiration: { type: 'EX', value: PRESIGN_TTL_SEC },
    })
    return { key, ...put, expiresAt }
  }

  /**
   * Direct upload, step 2: only the caller who presigned `key` takes its grant (atomically, once);
   * anyone else or an unknown / used key → 404 with the grant untouched. The staged upload must then
   * have the presigned size and a type matching the name (a public tag: an image; its first bytes by a
   * Range GET, Office containers whole), else it is deleted (422); a passing one moves to its area
   * served with the sniffed type. HEAD, the reads and the copy are all bound to one ETag, so bytes PUT
   * to the still-valid URL meanwhile are refused (422), nothing unchecked is ever public and the PUT URL
   * cannot touch the registered object.
   * The SHA-256 is recorded only when the service confirms the signed checksum.
   */
  async confirm(key: string, uploaderId: number): Promise<FsObjectVo> {
    const raw = await this.redis.eval(TAKE_GRANT, {
      keys: [redisKey('presign', key)],
      arguments: [String(uploaderId)],
    })
    if (typeof raw !== 'string') throw new NotFoundException()
    const grant = JSON.parse(raw) as PresignGrant
    const storage = await this.storages.findOneBy({ id: grant.storageId })
    const client = storage && this.clientFor(storage)
    if (!(client instanceof S3Storage)) throw new NotFoundException()
    const isPublic = isPublicBizTag(grant.bizTag)
    const stored = await client.headStaged(key)
    if (!stored) throw new NotFoundException()
    const ext = extname(key).slice(1)
    const mime = await this.stagedType(client, key, ext, stored, grant.size)
    // the copy is bound to the checked version too: bytes PUT after the check are never published
    if (
      !mime ||
      (isPublic && !isImage(mime)) ||
      !(await client.publish(key, stored.etag!, isPublic, mime))
    ) {
      await client.dropStaged(key)
      throw new BizError(Err.STORAGE_UPLOAD_MISMATCH)
    }
    const signed = grant.sha256 && Buffer.from(grant.sha256, 'hex').toString('base64')
    try {
      const row = await this.objects.save(
        this.objects.create({
          storageId: grant.storageId,
          objectKey: key,
          originalName: grant.name,
          mime,
          size: stored.size,
          sha256: signed && stored.sha256 === signed ? grant.sha256 : null,
          isPublic,
          publicUrl: isPublic ? client.publicUrl(key) : null,
          bizTag: grant.bizTag,
          uploaderId,
        }),
      )
      return this.vo(row)
    } catch (e) {
      await client.remove(key, isPublic)
      throw e
    }
  }

  /**
   * The type of the staged version HEAD saw, judged like a server upload; null when it has not the
   * presigned size, no ETag, is not what its name says, or changed meanwhile (every read is If-Match
   * that ETag). Its first bytes suffice (a Range GET), except for Office containers (zip / CFB), whose
   * document part only the whole file shows: streamed through {@link scanContainer} (bounded memory).
   */
  private async stagedType(
    client: S3Storage,
    key: string,
    ext: string,
    stored: { size: number; etag: string | null },
    size: number,
  ): Promise<string | null> {
    if (stored.size !== size || !stored.etag) return null
    if (!CONTAINER_EXTS.has(ext)) {
      const first = Math.min(size, SNIFF_BYTES)
      const head = await client.readStaged(key, stored.etag, first)
      return head?.length === first ? typeOf(head, ext, null) : null
    }
    const body = await client.openStaged(key, stored.etag)
    const scan = body && (await scanContainer(body, ext, size))
    return scan?.size === size ? typeOf(scan.head, ext, scan.inside) : null
  }

  /** File list (see docs/design-notes.md#storage): every stored object, filtered; newest first unless sorted. */
  async list(query: FsObjectQuery): Promise<Page<FsObjectRowVo>> {
    const page = await paginate(this.filtered(query), query)
    return { total: page.total, items: await this.rows(page.items) }
  }

  /** The list's rows (same filters and sort, no paging) in batches of EXPORT_BATCH, for the export. */
  async *exportRows(query: FsObjectQuery): AsyncGenerator<object[]> {
    for await (const batch of exportBatches(
      () => sorted(this.filtered(query), query.sort),
      EXPORT_BATCH,
    ))
      yield (await this.rows(batch)).map((r) => ({ ...r, createdAt: new Date(r.createdAt) }))
  }

  /** One object with its key, hash, business reference and storage driver; unknown id → 404. */
  async detail(id: number): Promise<FsObjectDetailVo> {
    const obj = await this.objects.findOneBy({ id })
    if (!obj) throw new NotFoundException()
    const [row] = await this.rows([obj])
    const storage = await this.storages.findOneByOrFail({ id: obj.storageId })
    return {
      ...row!,
      storageDriver: storage.driver,
      objectKey: obj.objectKey,
      sha256: obj.sha256,
      bizRef: obj.bizRef,
    }
  }

  private filtered(q: FsObjectQuery): SelectQueryBuilder<FsObject> {
    const qb = this.objects.createQueryBuilder('t')
    if (q.originalName)
      qb.andWhere('t.original_name LIKE :name', { name: contains(q.originalName) })
    if (q.bizTag) qb.andWhere('t.biz_tag = :bizTag', { bizTag: q.bizTag })
    if (q.isPublic !== undefined) qb.andWhere('t.is_public = :isPublic', { isPublic: q.isPublic })
    if (q.storageId) qb.andWhere('t.storage_id = :storageId', { storageId: q.storageId })
    if (q.createdAtFrom) qb.andWhere('t.created_at >= :from', { from: new Date(q.createdAtFrom) })
    if (q.createdAtTo) qb.andWhere('t.created_at <= :to', { to: new Date(q.createdAtTo) })
    return qb
  }

  /** List rows: the storage's name and the uploader's display name (null once the user is gone). */
  private async rows(objs: FsObject[]): Promise<FsObjectRowVo[]> {
    if (!objs.length) return []
    const storageIds = [...new Set(objs.map((o) => o.storageId))]
    const userIds = [...new Set(objs.map((o) => o.uploaderId))]
    const [storages, users] = await Promise.all([
      this.storages.findBy({ id: In(storageIds) }),
      this.objects.manager.query<{ id: number; display_name: string }[]>(
        'SELECT id, display_name FROM iam_user WHERE id IN (?) AND deleted_at IS NULL',
        [userIds],
      ),
    ])
    const storageName = new Map(storages.map((s) => [s.id, s.name]))
    const userName = new Map(users.map((u) => [Number(u.id), u.display_name]))
    return objs.map((o) => ({
      ...this.vo(o),
      storageId: o.storageId,
      storageName: storageName.get(o.storageId) ?? '',
      uploaderId: o.uploaderId,
      uploaderName: userName.get(Number(o.uploaderId)) ?? null,
    }))
  }

  /**
   * Binds uploads to a business record (e.g. workflow start → `wf:<instanceId>`, which
   * the tag's `StorageAccess` checker reads; see docs/design-notes.md#storage), inside the caller's transaction `tx`: one conditional UPDATE
   * takes only live objects of `tag` that `uploaderId` uploaded and nothing has bound yet. Any other id
   * (someone else's, already bound, another tag, deleted, unknown) → 400 C1009, the same for each (no
   * probing); the caller's transaction then rolls back what this matched. No ids → nothing to do.
   * `tx` outside a transaction (e.g. `txHost.tx` without `@Transactional`) throws: a partial bind would stay.
   */
  async bindRefs(
    ids: readonly number[],
    tag: StorageBizTag,
    ref: string,
    uploaderId: number,
    tx: EntityManager,
  ): Promise<void> {
    if (!tx.queryRunner?.isTransactionActive) throw new Error('bindRefs needs a transaction')
    const unique = [...new Set(ids)]
    if (!unique.length) return
    const res = await tx.query<{ affectedRows: number }>(
      `UPDATE fs_object SET biz_ref = ?, updated_by = ?
        WHERE id IN (?) AND biz_tag = ? AND uploader_id = ? AND biz_ref IS NULL AND deleted_at IS NULL`,
      [ref, uploaderId, unique, tag, uploaderId],
    )
    if (res.affectedRows !== unique.length) throw new BizError(Err.STORAGE_REF_INVALID)
  }

  /**
   * The object's content: public → anyone signed in; private → the uploader, `storage.object.view` or
   * the tag's checker, else 403; unknown id → 404. `attachment` always, except `inline` asked for an image.
   * On S3 the caller is redirected to a 60 s presigned GET carrying the same type and disposition.
   */
  async download(id: number, inline: boolean, p: Principal): Promise<Download> {
    const obj = await this.objects.findOneBy({ id })
    if (!obj) throw new NotFoundException()
    const allowed =
      obj.isPublic ||
      obj.uploaderId === p.userId ||
      p.root === true ||
      p.perms.includes(storageObjectPerms.view) ||
      (await this.access.allows(obj, p))
    if (!allowed) throw new ForbiddenException()
    const how = disposition(inline && isImage(obj.mime) ? 'inline' : 'attachment', obj.originalName)
    const client = this.clientFor(await this.storages.findOneByOrFail({ id: obj.storageId }))
    if (client instanceof S3Storage)
      return { redirect: await client.presignGet(obj.objectKey, obj.isPublic, obj.mime, how) }
    return new StreamableFile(await client.read(obj.objectKey, obj.isPublic), {
      type: obj.mime,
      length: obj.size,
      disposition: how,
    })
  }

  /**
   * Soft delete: from now on the object is gone for the list, the detail and the download (404),
   * and a public one for its URL too: its body moves to the private area in the same transaction (a
   * failed move rolls the delete back, a retry moves it again), so its references (avatars, rich text)
   * break at once. The body stays there until `purgeDeleted` (the `audit.purge` job, past
   * `audit.retention_days`) removes body and row, so a mistaken delete can still be undone by hand.
   */
  async remove(id: number): Promise<void> {
    await this.objects.manager.transaction(async (q) => {
      const obj = await q
        .getRepository(FsObject)
        .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } })
      if (!obj) throw new NotFoundException()
      await softDeleteRows(q, 'fs_object', [id])
      if (obj.isPublic)
        await this.clientFor(await this.storages.findOneByOrFail({ id: obj.storageId })).unpublish(
          obj.objectKey,
        )
    })
  }

  /**
   * Retention: objects deleted before `before` go for good, the body first, then the row.
   * A body the storage fails to delete (S3 down, refused) keeps its row, so the next purge tries it again;
   * a body already gone counts as deleted (S3 DELETE and the local rm are idempotent). Also on a storage
   * deleted since (its row still holds the config; its S3 secret goes once no object is left on it,
   * `dropUnusedSecrets`). Returns how many went.
   */
  async purgeDeleted(before: Date, signal: AbortSignal): Promise<number> {
    let purged = 0
    for (let after = 0; ;) {
      signal.throwIfAborted()
      const batch = await this.objects.find({
        withDeleted: true,
        where: { id: MoreThan(after), deletedAt: LessThan(before) },
        order: { id: 'ASC' },
        take: PURGE_BATCH,
      })
      if (!batch.length) {
        await dropUnusedSecrets(this.objects.manager)
        return purged
      }
      after = batch.at(-1)!.id
      const ids = [...new Set(batch.map((o) => o.storageId))]
      const storages = new Map(
        (await this.storages.find({ withDeleted: true, where: { id: In(ids) } })).map((s) => [
          s.id,
          s,
        ]),
      )
      for (const obj of batch) {
        signal.throwIfAborted()
        try {
          // a deleted object's body sits in the private area (remove moved a public one there); a public
          // one deleted before that move existed still sits in public/: both go (idempotent)
          const client = this.clientFor(storages.get(obj.storageId)!)
          await client.remove(obj.objectKey, false)
          if (obj.isPublic) await client.remove(obj.objectKey, true)
          await this.objects.delete({ id: obj.id, deletedAt: Not(IsNull()) })
          purged++
        } catch (err) {
          this.logger.warn({ objectId: obj.id, err }, 'storage purge: body not deleted, row kept')
        }
      }
    }
  }

  private vo(row: FsObject): FsObjectVo {
    return {
      id: row.id,
      originalName: row.originalName,
      mime: row.mime,
      size: row.size,
      url: row.publicUrl,
      isPublic: row.isPublic,
      bizTag: row.bizTag,
      createdAt: row.createdAt.toISOString(),
    }
  }

  private async primary(): Promise<StorageConfig> {
    const storage = await this.storages.findOneBy({ isPrimary: true, enabled: true })
    if (!storage) throw new Error('storage: no enabled primary storage (fs_storage)')
    return storage
  }

  private async assertExt(ext: string): Promise<void> {
    if (!(await this.allowedExts()).has(ext))
      throw new BizError(Err.STORAGE_TYPE_REJECTED, { ext: ext || '?' })
  }

  /** `storage.allowed_exts` (comma/space separated) minus the never-allowed ones; blank → the defaults. */
  private async allowedExts(): Promise<Set<string>> {
    const raw = (await this.params.get(storageParams.allowedExts))?.trim()
    const exts = raw ? raw.toLowerCase().split(/[\s,]+/) : [...STORAGE_ALLOWED_EXTS_DEFAULT]
    const denied = new Set<string>(STORAGE_DENIED_EXTS)
    return new Set(exts.filter((e) => e && !denied.has(e)))
  }
}
