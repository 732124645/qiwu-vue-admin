// Files with tenants (see docs/design-notes.md#tenancy, #storage), the switch on, between the default
// tenant (A) and tenant B. An object belongs to the tenant it was uploaded in (`fs_object.tenant_id`):
// lists and exports leave the other tenant's out, and its ids are 404 to the detail, the download (root,
// `storage.object.view`, its uploader and a tag's checker alike) and the delete, nothing of it changing.
// A direct upload's grant is confirmed in the tenant it was presigned in only, a business binding takes
// the caller's tenant's objects only, and an uploader of another tenant shows no name. Object keys carry
// no tenant (`yyyy/MM/dd/<uuid>.<ext>` as ever) and a public object's URL answers whoever asks (by
// design). The storages stay platform rows: one holding another tenant's files is in use, its secret
// kept until they are purged, and the retention purge takes every tenant's deleted files.
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NotFoundException } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { DEFAULT_TENANT_ID as A, Err, FS_OBJECT_KEY, storageObjectPerms } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { uploadRoot } from '../../src/core/paths.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { StorageAccess } from '../../src/modules/platform/storage/storage-access.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addRow,
  addUser,
  bootApp,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'tf-e2e-'
const URL = '/api/storage/objects'
const WF = 'wf.attachment'

let on: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
const tokens = { root: '', aViewer: '', aPlain: '', bOwner: '' }
type Who = keyof typeof tokens
const aUsers: Record<'viewer' | 'plain', number> = { viewer: 0, plain: 0 }
let aRole = 0
/** the last fs_object / fs_storage ids before this spec: every row above them is this spec's */
let lastObject = 0
let lastStorage = 0
/** the seeded local storage (primary) */
let localId = 0

let seq = 0
const unique = () => `${PREFIX}${process.pid}-${++seq}`
/** A 2×2 PNG of its own colour (an upload repeated within 3 s is refused). */
const pngOf = (blue: number) =>
  sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 9, g: 99, b: blue } } })
    .png()
    .toBuffer()
/** A small PDF of its own (an upload repeated within 3 s is refused). */
const pdfOf = (tag: string) =>
  Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n`)

const http = () => request(on.getHttpServer())
const call = (who: Who, method: 'get' | 'post' | 'delete', path: string) =>
  http()[method](`/api${path}`).set(bearer(tokens[who]))
const upload = (who: Who, file: Buffer, name: string, bizTag = 'attachment') =>
  http().post(URL).set(bearer(tokens[who])).field('bizTag', bizTag).attach('file', file, name)
const download = (who: Who, id: number) =>
  call(who, 'get', `/storage/objects/${id}/download`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
const expect404 = (res: request.Response) => {
  expect(res.status).toBe(404)
  // a download's body is read as bytes
  const body = Buffer.isBuffer(res.body) ? JSON.parse(res.body.toString()) : res.body
  expect(body.code).toBe(Err.NOT_FOUND.code)
}
const idsOf = (res: request.Response): number[] =>
  res.body.data.items.map((r: { id: number }) => Number(r.id))

/** GET the export as the first sheet's data rows (the header row aside). */
async function exported(who: Who, query: object): Promise<unknown[][]> {
  const res = await call(who, 'get', '/storage/objects/export')
    .query(query)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    .expect(200)
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0])
  const ws = wb.worksheets[0]!
  return Array.from({ length: ws.actualRowCount - 1 }, (_, i) =>
    (ws.getRow(i + 2).values as unknown[]).slice(1),
  )
}

/** The stored row (raw SQL: no tenant condition). */
const rowOf = async (id: number) =>
  (
    (await ds.query(
      'SELECT tenant_id, object_key, biz_ref, deleted_at FROM fs_object WHERE id = ?',
      [id],
    )) as { tenant_id: number; object_key: string; biz_ref: string | null; deleted_at: unknown }[]
  )[0]

/** A row only, in tenant `tid` (what an upload of `uploaderId` there leaves; no body). */
const objectRow = (tid: number, uploaderId: number, over: Record<string, unknown> = {}) =>
  addRow(on, tid, 'fs_object', {
    storage_id: localId,
    object_key: `${PREFIX}${process.pid}/${++seq}.pdf`,
    original_name: 'form.pdf',
    mime: 'application/pdf',
    size: 1,
    is_public: 0,
    biz_tag: 'attachment',
    uploader_id: uploaderId,
    ...over,
  })

beforeAll(async () => {
  // this mode's own upload root (.env.test): safe to wipe
  if (!uploadRoot().endsWith('test-upload'))
    throw new Error(`not the test upload root: ${uploadRoot()}`)
  on = await bootApp({ multiTenant: true })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  lastObject = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM fs_object'))[0].n)
  lastStorage = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM fs_storage'))[0].n)
  ;[{ id: localId }] = await ds.query(
    "SELECT id FROM fs_storage WHERE name = 'seed.storage.local' AND deleted_at IS NULL",
  )
  B = await createTenant(on, { users: true })
  // a plain storage viewer of the default tenant (no root): browse, view, export
  aRole = await addRow(on, A, 'iam_role', {
    code: `${PREFIX}viewer`,
    name: `${PREFIX}viewer`,
    data_scope: 'all',
  })
  for (const perm of [
    storageObjectPerms.browse,
    storageObjectPerms.view,
    storageObjectPerms.export,
  ])
    await addRow(on, A, 'iam_role_menus', {
      role_id: aRole,
      menu_id: await findId(ds.manager, 'iam_menu', { perms: perm }),
    })
  aUsers.viewer = await addUser(on, A, `${PREFIX}viewer`, { roleId: aRole })
  aUsers.plain = await addUser(on, A, `${PREFIX}plain`)
  tokens.root = (await signIn(on)).accessToken
  tokens.aViewer = (await signInDirect(on, aUsers.viewer))!.accessToken
  tokens.aPlain = (await signInDirect(on, aUsers.plain))!.accessToken
  tokens.bOwner = (await signInDirect(on, B.ownerId))!.accessToken
  // a tag checker letting everyone in: it is never asked about another tenant's object
  on.get(StorageAccess).register('attachment', async () => true)
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    await ds.query('DELETE FROM fs_object WHERE id > ?', [lastObject])
    await ds.query('UPDATE fs_storage SET is_primary = 0 WHERE id > ?', [lastStorage])
    await ds.query('UPDATE fs_storage SET is_primary = 1 WHERE id = ?', [localId])
    await ds.query('DELETE FROM fs_storage WHERE id > ?', [lastStorage])
    const users = Object.values(aUsers).filter(Boolean)
    if (users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (aRole) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [aRole])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [aRole])
    }
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await rm(uploadRoot(), { recursive: true, force: true })
})

describe('upload, list, export', () => {
  it("an upload is the caller tenant's whatever the body says, under a key without a tenant; its public URL answers anyone", async () => {
    const res = await upload('bOwner', await pngOf(199), 'logo.png', 'avatar').field(
      'tenantId',
      String(A),
    )
    expect(res.status).toBe(201)
    const obj = res.body.data
    const row = await rowOf(obj.id)
    expect(Number(row!.tenant_id)).toBe(B.id)
    expect(row!.object_key).toMatch(FS_OBJECT_KEY)
    expect(obj.url).toBe(`/files/${row!.object_key}`)
    // by design: a public object is read by its URL, signed in or not, from any tenant
    const file = await http().get(obj.url).expect(200)
    expect(file.headers['content-type']).toBe('image/png')
    // its id stays B's: the download route of another tenant does not know it
    expect404(await download('root', obj.id))
    await download('bOwner', obj.id).expect(200)
  })

  it('list and export: each tenant sees its own copy of the same file only', async () => {
    const name = unique()
    const a = (await upload('aViewer', pdfOf(`a-${name}`), `${name}.pdf`).expect(201)).body.data.id
    const b = (await upload('bOwner', pdfOf(`b-${name}`), `${name}.pdf`).expect(201)).body.data.id
    const list = async (who: Who) =>
      idsOf(await call(who, 'get', '/storage/objects').query({ originalName: name }).expect(200))
    expect(await list('root')).toEqual([a])
    expect(await list('aViewer')).toEqual([a])
    expect(await list('bOwner')).toEqual([b])
    expect(await exported('root', { originalName: name })).toHaveLength(1)
    expect(await exported('bOwner', { originalName: name })).toHaveLength(1)
    expect(Number((await rowOf(a))!.tenant_id)).toBe(A)
    expect(Number((await rowOf(b))!.tenant_id)).toBe(B.id)
  })

  it('an uploader of another tenant: no name in the list, and being the uploader opens nothing there', async () => {
    const id = await objectRow(B.id, aUsers.plain, { original_name: `${unique()}.pdf` })
    const res = await call('bOwner', 'get', `/storage/objects/${id}`).expect(200)
    expect(res.body.data).toMatchObject({ uploaderId: aUsers.plain, uploaderName: null })
    expect404(await download('aPlain', id))
  })
})

describe("the other tenant's ids", () => {
  it('detail and download: 404 to root, storage.object.view and a tag checker; their own tenant opens them', async () => {
    const a = (await upload('aViewer', pdfOf(unique()), 'a.pdf').expect(201)).body.data.id
    const b = (await upload('bOwner', pdfOf(unique()), 'b.pdf').expect(201)).body.data.id
    for (const who of ['root', 'aViewer'] as const)
      expect404(await call(who, 'get', `/storage/objects/${b}`))
    expect404(await call('bOwner', 'get', `/storage/objects/${a}`))
    // root, storage.object.view, the checker of `attachment` (aPlain): none reaches B's object
    for (const who of ['root', 'aViewer', 'aPlain'] as const) expect404(await download(who, b))
    expect404(await download('bOwner', a))
    // the same callers in their own tenant
    for (const who of ['root', 'aViewer', 'aPlain'] as const) await download(who, a).expect(200)
    await download('bOwner', b).expect(200)
    await call('aViewer', 'get', `/storage/objects/${a}`).expect(200)
    await call('bOwner', 'get', `/storage/objects/${b}`).expect(200)
  })

  it('delete: 404 and nothing changes (a public one keeps its URL); its own tenant deletes it', async () => {
    const a = (await upload('aViewer', pdfOf(unique()), 'a.pdf').expect(201)).body.data
    const pub = (await upload('bOwner', await pngOf(200), 'b.png', 'avatar').expect(201)).body.data
    expect404(await call('root', 'delete', `/storage/objects/${pub.id}`))
    expect404(await call('bOwner', 'delete', `/storage/objects/${a.id}`))
    expect((await rowOf(pub.id))!.deleted_at).toBeNull()
    expect((await rowOf(a.id))!.deleted_at).toBeNull()
    await http().get(pub.url).expect(200)
    await call('bOwner', 'delete', `/storage/objects/${pub.id}`).expect(200)
    expect((await rowOf(pub.id))!.deleted_at).not.toBeNull()
    await http().get(pub.url).expect(404)
  })

  it("bindRefs: another tenant's object of the same uploader → 400 C1009, nothing bound; in its tenant it binds", async () => {
    const id = await objectRow(B.id, aUsers.plain, { biz_tag: WF })
    const bind = (tid: number) =>
      ds.transaction((tx) =>
        withTenant(tid, () => on.get(StorageService).bindRefs([id], WF, 'wf:1', aUsers.plain, tx)),
      )
    await expect(bind(A)).rejects.toMatchObject({
      err: { code: Err.STORAGE_REF_INVALID.code, status: 400 },
    })
    expect((await rowOf(id))!.biz_ref).toBeNull()
    await bind(B.id)
    expect((await rowOf(id))!.biz_ref).toBe('wf:1')
  })
})

describe('S3: direct upload and the storages', () => {
  /** In-memory S3 (path-style), enough for a direct upload: PUT, copy, HEAD, ranged GET, DELETE. */
  const objects = new Map<string, { body: Buffer; type: string }>()
  const etagOf = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`
  let s3: Server
  let s3Id = 0
  const s3Config = () => ({
    endpoint: `http://127.0.0.1:${(s3.address() as AddressInfo).port}`,
    region: 'us-east-1',
    bucket: 'qw-files',
    accessKey: 'AKIDEXAMPLE',
    secretKey: on.get(SecretBox).encrypt('tenant-files-secret'),
    forcePathStyle: true,
    publicDomain: null,
  })

  beforeAll(async () => {
    s3 = createServer((req, res) => {
      const path = decodeURIComponent(new globalThis.URL(req.url!, 'http://s3').pathname)
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const copyOf = req.headers['x-amz-copy-source']
        if (req.method === 'PUT') {
          const body =
            typeof copyOf === 'string'
              ? objects.get(`/${decodeURIComponent(copyOf).replace(/^\//, '')}`)?.body
              : Buffer.concat(chunks)
          if (!body) return res.writeHead(404).end()
          objects.set(path, { body, type: String(req.headers['content-type']) })
          return copyOf
            ? res
                .writeHead(200, { 'content-type': 'application/xml' })
                .end(`<CopyObjectResult><ETag>${etagOf(body)}</ETag></CopyObjectResult>`)
            : res.writeHead(200).end()
        }
        if (req.method === 'DELETE') {
          objects.delete(path)
          return res.writeHead(204).end()
        }
        const obj = objects.get(path)
        if (!obj) return res.writeHead(404).end()
        const head = { 'content-type': obj.type, etag: etagOf(obj.body) }
        if (req.method === 'HEAD')
          return res.writeHead(200, { ...head, 'content-length': obj.body.length }).end()
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
        const part = m ? obj.body.subarray(Number(m[1]), Number(m[2]) + 1) : obj.body
        const range = m && {
          'content-range': `bytes ${m[1]}-${Number(m[1]) + part.length - 1}/${obj.body.length}`,
        }
        res.writeHead(m ? 206 : 200, { ...head, ...range, 'content-length': part.length }).end(part)
      })
    })
    await new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', resolve))
    s3Id = await insertRow(ds.manager, 'fs_storage', {
      name: `${PREFIX}direct`,
      driver: 's3',
      config: s3Config(),
    })
  })
  afterAll(async () => {
    if (s3) await new Promise((resolve) => s3.close(resolve))
  })

  it('a grant is confirmed in the tenant it was presigned in only (anyone else 404, the grant kept); the key carries no tenant', async () => {
    await ds.query('UPDATE fs_storage SET is_primary = 0 WHERE id = ?', [localId])
    await ds.query('UPDATE fs_storage SET is_primary = 1 WHERE id = ?', [s3Id])
    try {
      const file = pdfOf(unique())
      const p = (
        await call('bOwner', 'post', '/storage/objects/presign')
          .send({
            filename: 'b.pdf',
            size: file.length,
            mime: 'application/pdf',
            bizTag: 'attachment',
          })
          .expect(200)
      ).body.data
      expect(p.key).toMatch(FS_OBJECT_KEY)
      const put = await fetch(p.url, {
        method: 'PUT',
        headers: p.headers,
        body: new Uint8Array(file),
      })
      expect(put.status).toBe(200)
      const grant = () => redis.exists(redisKey('presign', p.key))
      // the other tenant's callers
      for (const who of ['root', 'aViewer'] as const)
        expect404(await call(who, 'post', '/storage/objects/confirm').send({ key: p.key }))
      // its owner itself, in another tenant
      await expect(
        inTenant1(() => on.get(StorageService).confirm(p.key, B.ownerId)),
      ).rejects.toBeInstanceOf(NotFoundException)
      expect(await grant()).toBe(1)
      const obj = (
        await call('bOwner', 'post', '/storage/objects/confirm').send({ key: p.key }).expect(201)
      ).body.data
      const row = await rowOf(obj.id)
      expect(row).toMatchObject({ object_key: p.key })
      expect(Number(row!.tenant_id)).toBe(B.id)
      expect(objects.has(`/qw-files/private/${p.key}`)).toBe(true)
      expect(await grant()).toBe(0)
    } finally {
      await ds.query('UPDATE fs_storage SET is_primary = 0 WHERE id = ?', [s3Id])
      await ds.query('UPDATE fs_storage SET is_primary = 1 WHERE id = ?', [localId])
    }
  })

  it("a storage holding another tenant's files is in use, keeps its secret until they are purged; the purge takes every tenant's", async () => {
    const id = await insertRow(ds.manager, 'fs_storage', {
      name: `${PREFIX}gone`,
      driver: 's3',
      config: s3Config(),
    })
    const key = `2000/01/01/${randomUUID()}.pdf`
    objects.set(`/qw-files/private/${key}`, { body: pdfOf(key), type: 'application/pdf' })
    const obj = await objectRow(B.id, B.ownerId, { storage_id: id, object_key: key })
    const secretKept = async () =>
      Number(
        (
          await ds.query(
            "SELECT JSON_CONTAINS_PATH(config, 'one', '$.secretKey') AS kept FROM fs_storage WHERE id = ?",
            [id],
          )
        )[0].kept,
      )
    // a platform page: not B's
    expect((await call('bOwner', 'get', '/storage/configs')).status).toBe(403)
    const del = await call('root', 'delete', `/storage/configs/${id}`)
    expect(del.status).toBe(409)
    expect(del.body.code).toBe(Err.IN_USE.code)
    // B deletes its file: the storage goes, its secret stays for the purge of B's file
    await ds.query('UPDATE fs_object SET deleted_at = ? WHERE id = ?', [new Date(2000, 0, 1), obj])
    await call('root', 'delete', `/storage/configs/${id}`).expect(200)
    expect(await secretKept()).toBe(1)
    // a caller in the default tenant: the purge still reaches B's file, body and row
    const purged = await inTenant1(() =>
      on.get(StorageService).purgeDeleted(new Date(2001, 0, 1), new AbortController().signal),
    )
    expect(purged).toBeGreaterThanOrEqual(1)
    expect(await rowOf(obj)).toBeUndefined()
    expect(objects.has(`/qw-files/private/${key}`)).toBe(false)
    expect(await secretKept()).toBe(0)
  })
})
