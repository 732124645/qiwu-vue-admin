// storage (acceptance; see docs/design-notes.md#storage, #security): upload with magic-number + extension whitelist + 413,
// business tag → public (images only) / private; public objects at /files without a token, private
// ones never there; private download (attachment, nosniff, sandbox) for the uploader,
// storage.object.view or a registered StorageAccess checker (401 without a session, 403 otherwise);
// traversal → 404; delete; action log; Swagger. S3 downloads (302 to a presigned GET); storage
// configs (SecretBox, masked secret, SSRF refusals, test connection {ok} only, primary switch);
// direct upload (presign → PUT → confirm by its owner only, the grant kept for anyone else, bytes
// checked again) against an in-memory S3 stand-in; the file list (filters, names, detail, export,
// delete; soft, the files go with the retention purge, a public one leaves /files at once).
// The private `wf.attachment` tag and `bindRefs` (own, unbound, that tag, all or nothing).
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer, request as nodeRequest, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, FS_OBJECT_KEY, storageObjectPerms, storageParams } from '@qiwu/shared'
import { ZipArchive } from 'archiver'
import ExcelJS from 'exceljs'
import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { SecretBox } from '../../src/core/crypto/secret-box.js'
import { uploadRoot } from '../../src/core/paths.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { StorageAccess } from '../../src/modules/platform/storage/storage-access.js'
import {
  PRESIGN_TTL_SEC,
  StorageService,
} from '../../src/modules/platform/storage/storage.service.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'fs-e2e-'
const URL = '/api/storage/objects'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
const tokens: Record<'admin' | 'owner' | 'other' | 'viewer', string> = {
  admin: '',
  owner: '',
  other: '',
  viewer: '',
}
const ids: Record<string, number> = {}
let roleId: number
let menuId: number
let png: Buffer
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n')
const exe = Buffer.concat([
  Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00\xff\xff\x00\x00', 'latin1'),
  Buffer.alloc(200, 120),
])

const http = () => request(app.getHttpServer())
const upload = (
  who: keyof typeof tokens,
  file: Buffer | null,
  name: string,
  bizTag = 'attachment',
) => {
  const req = http().post(URL).set(bearer(tokens[who])).field('bizTag', bizTag)
  return file ? req.attach('file', file, name) : req
}
/** Binary body as a Buffer whatever the content type. */
const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => cb(null, Buffer.concat(chunks)))
  })
const download = (who: keyof typeof tokens | null, id: number, query = '') => {
  const req = http().get(`${URL}/${id}/download${query}`)
  return binary(who ? req.set(bearer(tokens[who])) : req)
}

/** Status of a GET sent with `path` byte for byte (supertest/URL would resolve `..` client-side). */
const rawStatus = (path: string) =>
  new Promise<number>((resolve, reject) => {
    const { port } = app.getHttpServer().address() as AddressInfo
    nodeRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

async function user(name: string, roles: number[] = []) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  ids[name] = id
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  return (await signIn(app, PREFIX + name)).accessToken
}

/** Sets a param for `fn`, then restores the stored value (seeds keep edited values: leave none behind). */
async function withParam(key: string, value: string, fn: () => Promise<unknown>) {
  const [{ param_value: before }] = await ds.query(
    'SELECT param_value FROM cfg_param WHERE param_key = ?',
    [key],
  )
  const set = async (v: string) => {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [v, key])
    await params.invalidate(key)
  }
  await set(value)
  try {
    await fn()
  } finally {
    await set(before)
  }
}

beforeAll(async () => {
  // this mode's own upload root (.env.test): safe to wipe
  if (!uploadRoot().endsWith('test-upload'))
    throw new Error(`not the test upload root: ${uploadRoot()}`)
  await rm(uploadRoot(), { recursive: true, force: true })
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  params = app.get(ParamService)
  await cleanRedis(redis)
  await ds.query('DELETE FROM fs_object')
  png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: '#1f6feb' },
  })
    .png()
    .toBuffer()
  // no storage menu page here: a bare action row carries the perm for this role
  menuId = await insertRow(ds.manager, 'iam_menu', {
    kind: 'action',
    name: 'menu.action.view',
    perms: storageObjectPerms.view,
  })
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}viewer`,
    name: `${PREFIX}viewer`,
    data_scope: 'all',
  })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, menuId])
  tokens.admin = (await signIn(app)).accessToken
  tokens.owner = await user('owner')
  tokens.other = await user('other')
  tokens.viewer = await user('viewer', [roleId])
  // tag checker: `attachment` objects whose biz_ref names the caller
  app.get(StorageAccess).register('attachment', async (obj, p) => obj.bizRef === `test:${p.userId}`)
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM fs_object')
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [Object.values(ids)])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [Object.values(ids)])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    await ds.query('DELETE FROM iam_menu WHERE id = ?', [menuId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
  await rm(uploadRoot(), { recursive: true, force: true })
})

describe('upload', () => {
  it('public tag + image → 201, url /files/yyyy/MM/dd/<uuid>.png served without a token (nosniff)', async () => {
    const res = await upload('owner', png, '头像.png', 'avatar').expect(201)
    const obj = res.body.data
    expect(obj).toEqual({
      id: expect.any(Number),
      originalName: '头像.png',
      mime: 'image/png',
      size: png.length,
      url: expect.stringMatching(/^\/files\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.png$/),
      isPublic: true,
      bizTag: 'avatar',
      createdAt: expect.any(String),
    })
    const [row] = await ds.query('SELECT * FROM fs_object WHERE id = ?', [obj.id])
    expect(row).toMatchObject({ uploader_id: ids.owner, is_public: 1, public_url: obj.url })
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
    const file = await binary(http().get(obj.url)).expect(200)
    expect(file.headers['content-type']).toBe('image/png')
    expect(file.headers['x-content-type-options']).toBe('nosniff')
    expect(Buffer.compare(file.body, png)).toBe(0)
    expect(existsSync(join(uploadRoot(), 'public', obj.url.slice('/files/'.length)))).toBe(true)
    expect(await rawStatus(obj.url)).toBe(200)
  })

  it('private tag → url null, stored under private/, never reachable through /files (traversal → 404)', async () => {
    const obj = (await upload('owner', pdf, 'report.pdf').expect(201)).body.data
    expect(obj).toMatchObject({ isPublic: false, url: null, mime: 'application/pdf' })
    ids.pdf = obj.id
    const [{ object_key: key }] = await ds.query('SELECT object_key FROM fs_object WHERE id = ?', [
      obj.id,
    ])
    expect(existsSync(join(uploadRoot(), 'private', key))).toBe(true)
    for (const path of [
      `/files/${key}`,
      `/files/../private/${key}`,
      `/files/..%2fprivate%2f${key.replaceAll('/', '%2f')}`,
      `/files/%2e%2e/private/${key}`,
      `/files/%2e%2e%2fprivate%2f${key.replaceAll('/', '%2f')}`,
      `/files/./../private/${key}`,
      `/files/..\\private\\${key}`,
      '/files/',
    ]) {
      expect([path, await rawStatus(path)]).toEqual([path, 404])
    }
  })

  it('magic number and whitelist: fake extensions, exe, html, svg rejected (422); plain text accepted', async () => {
    const rejected: [Buffer, string][] = [
      [exe, 'photo.png'], // exe content behind an allowed extension
      [exe, 'setup.exe'], // not on the whitelist
      [png, 'photo.pdf'], // an image is not a pdf
      [Buffer.from('<html><script>alert(1)</script></html>'), 'page.html'],
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        'x.svg',
      ],
      [Buffer.from('<html><body>x</body></html>'), 'page.htm'],
      [Buffer.from('plain text'), 'no-extension'],
      [png, 'x.PNG.exe'],
    ]
    for (const [file, name] of rejected) {
      const res = await upload('owner', file, name)
      expect([name, res.status, res.body.code]).toEqual([name, 422, Err.STORAGE_TYPE_REJECTED.code])
    }
    const ok = await upload('owner', Buffer.from('hello\nworld\n'), 'notes.txt').expect(201)
    expect(ok.body.data).toMatchObject({ mime: 'text/plain', isPublic: false })
    // an uppercase extension is the same extension
    await upload('owner', png, 'PHOTO.PNG').expect(201)
  })

  it('html/svg stay refused even when an admin adds them to storage.allowed_exts', async () => {
    await withParam(storageParams.allowedExts, 'png,html,svg,txt', async () => {
      await upload(
        'owner',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'x.svg',
      ).expect(422)
      await upload('owner', Buffer.from('<p>x</p>'), 'x.html').expect(422)
      await upload('owner', pdf, 'listed.pdf').expect(422) // no longer listed
      await upload('owner', png, 'ok.png').expect(201)
    })
    await withParam(
      storageParams.allowedExts,
      ' ',
      () => upload('owner', pdf, 'defaults.pdf').expect(201), // blank param → the defaults
    )
  })

  it('office documents must be what the extension says (a renamed zip or CFB file is refused)', async () => {
    const xlsx = Buffer.from(
      await (() => {
        const wb = new ExcelJS.Workbook()
        wb.addWorksheet('a').addRow([1])
        return wb.xlsx.writeBuffer()
      })(),
    )
    // same-length rename: still a valid zip, no longer an OOXML package
    const zip = Buffer.from(
      xlsx.toString('latin1').replaceAll('[Content_Types].xml', 'content-types-x.xml'),
      'latin1',
    )
    const cfb = (stream: string) =>
      Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.alloc(600),
        Buffer.from(stream, 'utf16le'),
        Buffer.alloc(100),
      ])
    for (const [file, name, status] of [
      [xlsx, 'sheet.xlsx', 201],
      [xlsx, 'sheet.docx', 422], // an xlsx is no docx
      [zip, 'renamed.xlsx', 422],
      [zip, 'archive.zip', 201],
      [cfb('WordDocument'), 'old.doc', 201],
      [cfb('Workbook'), 'old.xls', 201],
      [cfb('Workbook'), 'wrong.doc', 422],
      [cfb('Anything'), 'setup.doc', 422],
    ] as const) {
      const res = await upload('owner', file, name)
      expect([name, res.status]).toEqual([name, status])
    }
  })

  it('the same file submitted twice within 3 s → 429 (@Idempotent over the parsed file); another file passes', async () => {
    const txt = Buffer.from(`dup ${Date.now()}`)
    await upload('owner', txt, 'dup.txt').expect(201)
    const again = await upload('owner', txt, 'dup.txt').expect(429)
    expect(again.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
    await upload('owner', Buffer.from(`${txt}!`), 'dup.txt').expect(201)
    await upload('owner', txt, 'dup-2.txt').expect(201)
  })

  it('public tags take images only (422 public_image_only)', async () => {
    const res = await upload('owner', pdf, 'cover.pdf', 'cover').expect(422)
    expect(res.body.code).toBe(Err.STORAGE_PUBLIC_IMAGE_ONLY.code)
  })

  it('over storage.max_size_mb → 413; no file → 400; unknown business tag → 400; no session → 401', async () => {
    await withParam(storageParams.maxSizeMb, '1', async () => {
      const big = Buffer.concat([png, Buffer.alloc(1024 * 1024 + 1)])
      const res = await upload('owner', big, 'big.png', 'avatar').expect(413)
      expect(res.body.code).toBe(Err.PAYLOAD_TOO_LARGE.code)
      await upload('owner', Buffer.concat([png, Buffer.alloc(1024)]), 'small.png', 'avatar').expect(
        201,
      )
    })
    const none = await upload('owner', null, '').expect(400)
    expect(none.body.code).toBe(Err.STORAGE_FILE_REQUIRED.code)
    await upload('owner', png, 'a.png', 'secret-tag').expect(400)
    await http().post(URL).field('bizTag', 'avatar').attach('file', png, 'a.png').expect(401)
  })
})

describe('private download', () => {
  it('no session 401; uploader 200 as attachment with nosniff + sandbox; others 403; storage.object.view 200', async () => {
    await download(null, ids.pdf!).expect(401)
    const res = await download('owner', ids.pdf!).expect(200)
    expect(Buffer.compare(res.body, pdf)).toBe(0)
    expect(res.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    })
    expect(res.headers['content-security-policy']).toContain('sandbox')
    const denied = await download('other', ids.pdf!).expect(403)
    expect(JSON.parse(denied.body.toString()).code).toBe(Err.FORBIDDEN.code)
    await download('viewer', ids.pdf!).expect(200)
    await download('admin', ids.pdf!).expect(200)
  })

  it('a registered StorageAccess checker grants its business tag (by biz_ref)', async () => {
    const id = (await upload('owner', pdf, 'shared.pdf').expect(201)).body.data.id
    await download('other', id).expect(403)
    await ds.query('UPDATE fs_object SET biz_ref = ? WHERE id = ?', [`test:${ids.other}`, id])
    await download('other', id).expect(200)
    await download('viewer', id).expect(200) // perm, not the checker
    // the checker belongs to `attachment` only
    const imported = (await upload('owner', pdf, 'data.pdf', 'import').expect(201)).body.data.id
    await ds.query('UPDATE fs_object SET biz_ref = ? WHERE id = ?', [`test:${ids.other}`, imported])
    await download('other', imported).expect(403)
  })

  it('inline only for images when asked; UTF-8 names in filename*; public objects for anyone signed in', async () => {
    const img = (await upload('owner', png, '图 1.png').expect(201)).body.data
    const inline = await download('owner', img.id, '?inline=true').expect(200)
    expect(inline.headers['content-disposition']).toBe(
      `inline; filename="_ 1.png"; filename*=UTF-8''%E5%9B%BE%201.png`,
    )
    expect(
      (await download('owner', ids.pdf!, '?inline=true')).headers['content-disposition'],
    ).toMatch(/^attachment;/)
    const avatar = (await upload('owner', png, 'a.png', 'avatar').expect(201)).body.data
    await download('other', avatar.id).expect(200)
  })

  it('S3 object: the same authorization, then 302 to a 60 s presigned GET with type and disposition', async () => {
    const storageId = await insertRow(ds.manager, 'fs_storage', {
      name: `${PREFIX}s3`,
      driver: 's3',
      config: JSON.stringify({
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'qw-files',
        accessKey: 'AKIDEXAMPLE',
        secretKey: app.get(SecretBox).encrypt('s3-secret-of-this-spec'),
        forcePathStyle: true,
        publicDomain: null,
      }),
    })
    const key = '2026/09/28/0b6f7a3e-1d2c-4e5f-8a9b-0c1d2e3f4a5b.pdf'
    const id = await insertRow(ds.manager, 'fs_object', {
      storage_id: storageId,
      object_key: key,
      original_name: '报告.pdf',
      mime: 'application/pdf',
      size: 10,
      is_public: 0,
      biz_tag: 'attachment',
      uploader_id: ids.owner,
    })
    try {
      await download(null, id).expect(401)
      await download('other', id).expect(403)
      for (const who of ['owner', 'viewer'] as const) {
        const res = await download(who, id).expect(302)
        const url = new globalThis.URL(res.headers.location!)
        expect(url.origin + url.pathname).toBe(`https://s3.example.com/qw-files/private/${key}`)
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
          'X-Amz-Expires': '60',
          'response-content-type': 'application/pdf',
          'response-content-disposition': `attachment; filename="__.pdf"; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf`,
        })
        expect(res.headers.location).not.toContain('s3-secret-of-this-spec')
      }
    } finally {
      await ds.query('DELETE FROM fs_object WHERE id = ?', [id])
      await ds.query('DELETE FROM fs_storage WHERE id = ?', [storageId])
    }
  })

  it('404 unknown id, 400 malformed id, 404 when the file is gone', async () => {
    await download('admin', 999_999).expect(404)
    await download('admin', Number.NaN).expect(400)
    const id = (await upload('owner', pdf, 'gone.pdf').expect(201)).body.data.id
    const [{ object_key: key }] = await ds.query('SELECT object_key FROM fs_object WHERE id = ?', [
      id,
    ])
    await rm(join(uploadRoot(), 'private', key))
    await download('owner', id).expect(404)
  })
})

describe('bindRefs', () => {
  const WF = 'wf.attachment'
  const bind = (
    list: number[],
    who = ids.owner!,
    ref = 'wf:1',
    tag: typeof WF | 'attachment' = WF,
  ) => ds.transaction((tx) => app.get(StorageService).bindRefs(list, tag, ref, who, tx))
  const refOf = async (id: number) =>
    (
      (await ds.query('SELECT biz_ref FROM fs_object WHERE id = ?', [id])) as { biz_ref: string }[]
    )[0]!.biz_ref
  let storageId = 0
  let n = 0
  beforeAll(async () => {
    ;[{ id: storageId }] = await ds.query(
      'SELECT id FROM fs_storage WHERE is_primary = 1 AND deleted_at IS NULL',
    )
  })
  /** A row only (bindRefs never reads the body; uploads here would pass the route's 60/min limit). */
  const up = (who: 'owner' | 'other' = 'owner', tag = WF) =>
    insertRow(ds.manager, 'fs_object', {
      storage_id: storageId,
      object_key: `bind/${process.pid}-${n++}.pdf`,
      original_name: 'form.pdf',
      mime: 'application/pdf',
      size: pdf.length,
      is_public: 0,
      biz_tag: tag,
      uploader_id: ids[who],
    })

  it('wf.attachment is private: uploads take it, others get 403 while it is unbound', async () => {
    const res = await upload('owner', pdf, 'form.pdf', WF).expect(201)
    expect(res.body.data).toMatchObject({ bizTag: WF, url: null })
    await download('other', res.body.data.id).expect(403)
    await download('owner', res.body.data.id).expect(200)
  })

  it('bind: own unbound objects of the tag get biz_ref in the caller transaction; repeated ids count once', async () => {
    const [a, b] = [await up(), await up()]
    await bind([a, b, a], ids.owner!, 'wf:101')
    expect([await refOf(a), await refOf(b)]).toEqual(['wf:101', 'wf:101'])
    await bind([]) // nothing to bind
    // the caller's rollback undoes the bind
    const c = await up()
    await expect(
      ds.transaction(async (tx) => {
        await app.get(StorageService).bindRefs([c], WF, 'wf:102', ids.owner!, tx)
        throw new Error('caller fails later')
      }),
    ).rejects.toThrow('caller fails later')
    expect(await refOf(c)).toBeNull()
    // no transaction (e.g. `txHost.tx` outside `@Transactional`): refused before anything is written
    await expect(
      app.get(StorageService).bindRefs([c], WF, 'wf:103', ids.owner!, ds.manager),
    ).rejects.toThrow('bindRefs needs a transaction')
    expect(await refOf(c)).toBeNull()
  })

  it("bind refuses (400 C1009, nothing bound) someone else's, bound, other-tag, deleted or unknown ids", async () => {
    const mine = await up()
    const bound = await up()
    await bind([bound], ids.owner!, 'wf:201')
    const deleted = await up()
    await ds.query('UPDATE fs_object SET deleted_at = NOW(3) WHERE id = ?', [deleted])
    const bad = [await up('other'), bound, await up('owner', 'attachment'), deleted, 999_999_999]
    for (const id of bad)
      await expect(bind([mine, id], ids.owner!, 'wf:202')).rejects.toMatchObject({
        err: { code: Err.STORAGE_REF_INVALID.code, status: 400 },
      })
    expect(await refOf(mine)).toBeNull()
    expect(await refOf(bound)).toBe('wf:201')
    // the right tag asked for the wrong object, and another user binding the owner's object
    await expect(bind([mine], ids.owner!, 'wf:203', 'attachment')).rejects.toMatchObject({
      err: { code: Err.STORAGE_REF_INVALID.code },
    })
    await expect(bind([mine], ids.other!, 'wf:203')).rejects.toMatchObject({
      err: { code: Err.STORAGE_REF_INVALID.code },
    })
    expect(await refOf(mine)).toBeNull()
  })
})

describe('delete', () => {
  it('storage.object.remove only: 403 for the uploader without it; admin deletes (soft: the body stays until the purge, out of the public area); then 404', async () => {
    const obj = (await upload('owner', png, 'del.png', 'avatar').expect(201)).body.data
    const key = obj.url.slice('/files/'.length)
    await http().get(obj.url).expect(200)
    const call = (who: keyof typeof tokens, id: number) =>
      http().delete(`${URL}/${id}`).set(bearer(tokens[who]))
    await call('owner', obj.id).expect(403)
    const t = `${PREFIX}${process.pid}-del`
    await call('admin', obj.id).set('X-Request-Id', t).expect(200)
    const [admin] = await ds.query("SELECT id FROM iam_user WHERE username = 'admin'")
    expect(
      await ds.query('SELECT updated_by FROM fs_object WHERE id = ? AND deleted_at IS NOT NULL', [
        obj.id,
      ]),
    ).toEqual([{ updated_by: admin.id }])
    // gone for the API and for its public URL at once: the body waits for the purge in private/
    await download('admin', obj.id).expect(404)
    await http().get(`${URL}/${obj.id}`).set(bearer(tokens.admin)).expect(404)
    await http().get(obj.url).expect(404)
    expect(existsSync(join(uploadRoot(), 'public', key))).toBe(false)
    expect(existsSync(join(uploadRoot(), 'private', key))).toBe(true)
    await call('admin', obj.id).expect(404)
    expect(await logOf(ds, t)).toMatchObject({
      domain: 'storage.object',
      verb: 'remove',
      biz_id: String(obj.id),
      ok: 1,
    })
  })

  it('purge: objects deleted before the retention go for good, body first; live ones and recent deletions stay', async () => {
    const storage = app.get(StorageService)
    const purge = (before: Date) => storage.purgeDeleted(before, new AbortController().signal)
    const add = async (name: string) => {
      // other bytes each: the same file again within 3 s is a duplicate submit (429)
      const { id } = (await upload('owner', Buffer.from(`${PREFIX}${name}`), name).expect(201)).body
        .data
      const [{ object_key: key }] = await ds.query(
        'SELECT object_key FROM fs_object WHERE id = ?',
        [id],
      )
      return { id: Number(id), file: join(uploadRoot(), 'private', key) }
    }
    const [live, gone, recent] = [
      await add('live.txt'),
      await add('gone.txt'),
      await add('recent.txt'),
    ]
    // a public one: its body went to private/ with the delete, the purge removes it there
    const other = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#2da44e' },
    })
      .png()
      .toBuffer()
    const pub = (await upload('owner', other, 'purged.png', 'avatar').expect(201)).body.data
    const pubFile = join(uploadRoot(), 'private', pub.url.slice('/files/'.length))
    // a public one deleted before remove moved bodies (soft-deleted by SQL): its body is still in public/
    const oldPng = await sharp({
      create: { width: 3, height: 3, channels: 3, background: '#cf222e' },
    })
      .png()
      .toBuffer()
    const old = (await upload('owner', oldPng, 'old.png', 'avatar').expect(201)).body.data
    const oldFile = join(uploadRoot(), 'public', old.url.slice('/files/'.length))
    for (const { id } of [gone, recent, pub])
      await http().delete(`${URL}/${id}`).set(bearer(tokens.admin)).expect(200)
    await ds.query('UPDATE fs_object SET deleted_at = ? WHERE id IN (?)', [
      new Date(2000, 0, 1),
      [gone.id, pub.id, old.id],
    ])
    expect([existsSync(pubFile), existsSync(oldFile)]).toEqual([true, true])
    await ds.query('UPDATE fs_object SET created_at = ? WHERE id = ?', [
      new Date(2000, 0, 1),
      live.id,
    ])
    expect([live, gone, recent].map((o) => existsSync(o.file))).toEqual([true, true, true])

    expect(await purge(new Date(2001, 0, 1))).toBe(3)
    expect([live, gone, recent].map((o) => existsSync(o.file))).toEqual([true, false, true])
    expect([existsSync(pubFile), existsSync(oldFile)]).toEqual([false, false])
    await http().get(old.url).expect(404)
    const left = await ds.query('SELECT id FROM fs_object WHERE id IN (?) ORDER BY id', [
      [live.id, gone.id, recent.id],
    ])
    expect(left.map((r: { id: number }) => Number(r.id))).toEqual([live.id, recent.id])
    await download('owner', live.id).expect(200)
  })

  it('uploads are action-logged with the new id', async () => {
    const t = `${PREFIX}${process.pid}-up`
    const obj = (await upload('owner', png, 'log.png', 'avatar').set('X-Request-Id', t).expect(201))
      .body.data
    expect(await logOf(ds, t)).toMatchObject({
      domain: 'storage.object',
      verb: 'upload',
      biz_id: String(obj.id),
      username: `${PREFIX}owner`,
      ok: 1,
    })
  })
})

describe('config', () => {
  const CONFIGS = '/api/storage/configs'
  const SECRET = 's3-secret-never-answered-9f2c'
  const cfgCall = (method: 'get' | 'post' | 'put' | 'delete', path = '', body?: object) => {
    const req = http()[method](`${CONFIGS}${path}`).set(bearer(tokens.admin))
    return body ? req.send(body) : req
  }
  const s3Body = (name: string, over: object = {}) => ({
    name: `${PREFIX}${name}`,
    driver: 's3',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'qw-files',
    accessKey: 'AKIDEXAMPLE',
    secretKey: SECRET,
    forcePathStyle: true,
    publicDomain: null,
    ...over,
  })
  const stored = async (id: number) =>
    (await ds.query('SELECT * FROM fs_storage WHERE id = ?', [id]))[0] as {
      config: Record<string, unknown>
      is_primary: number
    }
  /** ALLOW_PRIVATE_ENDPOINTS as the production default (false) for `fn`; `env` overrides more keys. */
  async function strict<T>(fn: () => Promise<T>, env: Record<string, unknown> = {}): Promise<T> {
    const cfg = app.get(AppConfigService)
    const get = cfg.get.bind(cfg)
    const values: Record<string, unknown> = { ALLOW_PRIVATE_ENDPOINTS: false, ...env }
    const spy = vi
      .spyOn(cfg, 'get')
      .mockImplementation(((k: string) =>
        k in values ? values[k] : get(k as never)) as typeof cfg.get)
    try {
      return await fn()
    } finally {
      spy.mockRestore()
    }
  }
  /** A local stand-in for an S3 service: HEAD on the bucket → 200; the Redis port answers its own text. */
  let fakeS3: Server
  let fakePort: number
  beforeAll(async () => {
    fakeS3 = createServer((req, res) => res.writeHead(req.method === 'HEAD' ? 200 : 403).end())
    await new Promise<void>((resolve) => fakeS3.listen(0, '127.0.0.1', resolve))
    fakePort = (fakeS3.address() as AddressInfo).port
  })
  afterAll(async () => {
    await new Promise((resolve) => fakeS3.close(resolve))
    await ds.query('UPDATE fs_storage SET is_primary = 0 WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query("UPDATE fs_storage SET is_primary = 1 WHERE name = 'seed.storage.local'")
    await ds.query('DELETE FROM fs_storage WHERE name LIKE ?', [`${PREFIX}%`])
  })

  it('s3: secretKey boxed by SecretBox, masked in the detail, absent from the list and the action log', async () => {
    const t = `${PREFIX}${process.pid}-cfg`
    const res = await cfgCall('post', '', s3Body('s3-a')).set('X-Request-Id', t).expect(201)
    const row = res.body.data
    expect(row).toMatchObject({
      driver: 's3',
      secretKey: '******',
      isPrimary: false,
      enabled: true,
    })
    const { config } = await stored(row.id)
    expect(config.secretKey).toMatch(/^v1:/)
    expect(app.get(SecretBox).decrypt(config.secretKey as string)).toBe(SECRET)
    expect(JSON.stringify(config)).not.toContain(SECRET)
    const got = await cfgCall('get', `/${row.id}`).expect(200)
    expect(got.body.data).toEqual(row)
    const list = await cfgCall('get')
      .query({ name: `${PREFIX}s3-a` })
      .expect(200)
    expect(list.body.data.items).toEqual([
      expect.not.objectContaining({ config: expect.anything() }),
    ])
    expect(JSON.stringify(list.body)).not.toContain('AKIDEXAMPLE')
    expect(JSON.stringify(await logOf(ds, t))).not.toContain(SECRET)
  })

  it('edit: the whole form; secretKey left out or masked keeps it, a new one replaces it; the driver stays', async () => {
    const { id } = (await cfgCall('post', '', s3Body('s3-edit')).expect(201)).body.data
    const secretOf = async () =>
      app.get(SecretBox).decrypt((await stored(id)).config.secretKey as string)
    const { secretKey: _, ...noSecret } = s3Body('s3-edit')
    await cfgCall('put', `/${id}`, noSecret).expect(200)
    expect(await secretOf()).toBe(SECRET)
    expect((await stored(id)).config.bucket).toBe('qw-files')
    await cfgCall('put', `/${id}`, s3Body('s3-edit', { secretKey: '******' })).expect(200)
    expect(await secretOf()).toBe(SECRET)
    await cfgCall(
      'put',
      `/${id}`,
      s3Body('s3-edit', {
        bucket: 'other-bucket',
        secretKey: 'rotated-secret',
      }),
    ).expect(200)
    expect(await secretOf()).toBe('rotated-secret')
    expect((await stored(id)).config.bucket).toBe('other-bucket')
    const moved = await cfgCall('put', `/${id}`, {
      name: `${PREFIX}s3-edit`,
      driver: 'local',
    }).expect(422)
    expect(moved.body.code).toBe(Err.STORAGE_DRIVER_FIXED.code)
  })

  it('local: no root field (STORAGE_LOCAL_ROOT only): a sent root is dropped', async () => {
    const res = await cfgCall('post', '', {
      name: `${PREFIX}local`,
      driver: 'local',
      publicPrefix: '/assets',
      root: '/etc',
    }).expect(201)
    expect(res.body.data).not.toHaveProperty('root')
    expect((await stored(res.body.data.id)).config).toEqual({ publicPrefix: '/assets' })
    expect((await cfgCall('post', `/${res.body.data.id}/test`).expect(200)).body.data).toEqual({
      ok: true,
    })
  })

  it('SSRF (ALLOW_PRIVATE_ENDPOINTS=false): inner endpoints refused on save with a generic 422', async () => {
    await strict(async () => {
      for (const endpoint of [
        'http://127.0.0.1:6379',
        'http://169.254.169.254',
        'http://[::1]:443',
        'http://localhost',
        'https://s3.example.com:6379',
      ]) {
        const res = await cfgCall('post', '', s3Body(`ssrf-${endpoint.length}`, { endpoint }))
        expect([endpoint, res.status, res.body.code]).toEqual([
          endpoint,
          422,
          Err.STORAGE_ENDPOINT_REFUSED.code,
        ])
      }
    })
  })

  it('a custom S3 port only when the deployer registered it (env OUTBOUND_S3_PORTS), still no inner hosts', async () => {
    const custom = s3Body('port-9000', { endpoint: 'https://s3.example.com:9000' })
    await strict(async () => {
      const res = await cfgCall('post', '', custom).expect(422)
      expect(res.body.code).toBe(Err.STORAGE_ENDPOINT_REFUSED.code)
    })
    await strict(
      async () => {
        await cfgCall('post', '', custom).expect(201)
        const inner = s3Body('port-9000-inner', { endpoint: 'http://127.0.0.1:9000' })
        await cfgCall('post', '', inner).expect(422)
        const other = s3Body('port-9001', { endpoint: 'https://s3.example.com:9001' })
        await cfgCall('post', '', other).expect(422)
      },
      { OUTBOUND_S3_PORTS: [9000] },
    )
  })

  it('test connection: through the guard, {ok} only, nothing from the remote end', async () => {
    const redisPort = Number(process.env.REDIS_PORT ?? 6379)
    const toRedis = (
      await cfgCall('post', '', s3Body('redis', { endpoint: `http://127.0.0.1:${redisPort}` }))
    ).body.data
    const toMeta = (
      await cfgCall('post', '', s3Body('meta', { endpoint: 'http://169.254.169.254' }))
    ).body.data
    const ok = (
      await cfgCall('post', '', s3Body('fake', { endpoint: `http://127.0.0.1:${fakePort}` }))
    ).body.data
    // allowed in tests (.env.test): a Redis port is still no S3 service, and says so only as false
    const redisRes = await cfgCall('post', `/${toRedis.id}/test`).expect(200)
    expect(redisRes.body.data).toEqual({ ok: false })
    expect(JSON.stringify(redisRes.body)).not.toMatch(/ERR|redis|NOAUTH/i)
    expect((await cfgCall('post', `/${ok.id}/test`).expect(200)).body.data).toEqual({ ok: true })
    await strict(async () => {
      for (const id of [toRedis.id, toMeta.id, ok.id]) {
        const res = await cfgCall('post', `/${id}/test`).expect(200)
        expect(res.body).toEqual({ code: 0, msg: expect.any(String), data: { ok: false } })
      }
    })
  })

  it('primary: only an enabled storage becomes primary; the primary is never disabled or deleted', async () => {
    const { id } = (
      await cfgCall('post', '', s3Body('primary', { endpoint: `http://127.0.0.1:${fakePort}` }))
    ).body.data
    const [{ id: local }] = await ds.query(
      "SELECT id FROM fs_storage WHERE name = 'seed.storage.local'",
    )
    await cfgCall('put', `/${id}/enabled`, { enabled: false }).expect(200)
    const off = await cfgCall('put', `/${id}/primary`).expect(422)
    expect(off.body.code).toBe(Err.STORAGE_PRIMARY_LOCKED.code)
    await cfgCall('put', `/${id}/enabled`, { enabled: true }).expect(200)
    try {
      await cfgCall('put', `/${id}/primary`).expect(200)
      expect((await stored(id)).is_primary).toBe(1)
      expect((await stored(local)).is_primary).toBe(0)
      for (const res of [
        await cfgCall('put', `/${id}/enabled`, { enabled: false }),
        await cfgCall('put', `/${id}`, s3Body('primary', { enabled: false })),
        await cfgCall('delete', `/${id}`),
        await cfgCall('post', '/batch-delete', { ids: [local, id] }),
      ])
        expect([res.status, res.body.code]).toEqual([422, Err.STORAGE_PRIMARY_LOCKED.code])
    } finally {
      await cfgCall('put', `/${local}/primary`).expect(200)
    }
    expect((await stored(local)).is_primary).toBe(1)
    expect((await stored(id)).is_primary).toBe(0)
  })

  it('a storage still holding live files is not deleted (409 in_use), deleted ones do not count (its secret stays until they are purged); the seeded local one is found by its text', async () => {
    const { id } = (await cfgCall('post', '', s3Body('in-use')).expect(201)).body.data
    const obj = await insertRow(ds.manager, 'fs_object', {
      storage_id: id,
      object_key: '2026/09/28/00000000-0000-4000-8000-000000000001.txt',
      original_name: 'x.txt',
      mime: 'text/plain',
      size: 1,
      biz_tag: 'attachment',
      uploader_id: ids.owner,
    })
    const res = await cfgCall('delete', `/${id}`).expect(409)
    expect(res.body.code).toBe(Err.IN_USE.code)
    // the object deleted (soft: its body waits for the purge, which reads the deleted storage's config)
    await http().delete(`${URL}/${obj}`).set(bearer(tokens.admin)).expect(200)
    await cfgCall('delete', `/${id}`).expect(200)
    const secretKept = async (storage: number) =>
      Number(
        (
          await ds.query(
            "SELECT JSON_CONTAINS_PATH(config, 'one', '$.secretKey') AS kept FROM fs_storage WHERE id = ?",
            [storage],
          )
        )[0].kept,
      )
    expect(await secretKept(id)).toBe(1)
    // its last object purged (the row gone): the purge drops the deleted storage's secret
    await ds.query('DELETE FROM fs_object WHERE id = ?', [obj])
    await app.get(StorageService).purgeDeleted(new Date(2001, 0, 1), new AbortController().signal)
    expect(await secretKept(id)).toBe(0)
    // a storage deleted with no object left: its secret goes with the delete
    const bare = (await cfgCall('post', '', s3Body('no-files')).expect(201)).body.data.id
    expect(await secretKept(bare)).toBe(1)
    await cfgCall('delete', `/${bare}`).expect(200)
    expect(await secretKept(bare)).toBe(0)
    // its name is free again (unique among live rows)
    await cfgCall('post', '', s3Body('in-use', { region: 'eu-west-1' })).expect(201)
    const seeded = await cfgCall('get').query({ name: '本地' }).expect(200)
    expect(seeded.body.data.items.map((r: { name: string }) => r.name)).toContain(
      'seed.storage.local',
    )
  })
})

describe('presign', () => {
  /**
   * In-memory S3 stand-in (path-style): PUT keeps body, type and checksum; copy; HEAD; ranged GET;
   * DELETE. Every object has an ETag (MD5 of its body); GET honours If-Match and the copy
   * x-amz-copy-source-if-match (else 412 PreconditionFailed), as S3 does.
   */
  const objects = new Map<string, { body: Buffer; type: string; sha256?: string }>()
  /** paths whose DELETE the stand-in refuses (403 AccessDenied: the SDK does not retry it) */
  const refuseDelete = new Set<string>()
  /** runs after a GET of a path was answered (a PUT racing confirm between its check and its copy) */
  const afterGet = new Map<string, () => void>()
  let s3: Server
  let s3Port: number
  let s3Id: number
  let localId: number
  const objectPath = (key: string, area: 'public' | 'private' | 'staging' = 'private') =>
    `/qw-files/${area}/${key}`
  const etagOf = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`
  const xmlError = (res: ServerResponse, status: number, code: string) =>
    res
      .writeHead(status, { 'content-type': 'application/xml' })
      .end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`)

  beforeAll(async () => {
    s3 = createServer((req, res) => {
      const path = decodeURIComponent(new globalThis.URL(req.url!, 'http://s3').pathname)
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const obj = objects.get(path)
        const copyOf = req.headers['x-amz-copy-source']
        if (req.method === 'PUT' && typeof copyOf === 'string') {
          const src = objects.get(`/${decodeURIComponent(copyOf).replace(/^\//, '')}`)
          if (!src) return res.writeHead(404).end()
          const ifMatch = req.headers['x-amz-copy-source-if-match']
          if (ifMatch !== undefined && ifMatch !== etagOf(src.body))
            return xmlError(res, 412, 'PreconditionFailed')
          objects.set(path, { ...src, type: String(req.headers['content-type']) })
          return res
            .writeHead(200, { 'content-type': 'application/xml' })
            .end(`<CopyObjectResult><ETag>${etagOf(src.body)}</ETag></CopyObjectResult>`)
        }
        if (req.method === 'PUT') {
          objects.set(path, {
            body: Buffer.concat(chunks),
            type: String(req.headers['content-type']),
            sha256: req.headers['x-amz-checksum-sha256'] as string | undefined,
          })
          return res.writeHead(200).end()
        }
        if (req.method === 'DELETE') {
          if (refuseDelete.has(path)) return xmlError(res, 403, 'AccessDenied')
          objects.delete(path)
          return res.writeHead(204).end()
        }
        if (!obj) return res.writeHead(404).end()
        const headers = { 'content-type': obj.type, etag: etagOf(obj.body) }
        if (req.method === 'HEAD')
          return res
            .writeHead(200, {
              ...headers,
              'content-length': obj.body.length,
              ...(obj.sha256 ? { 'x-amz-checksum-sha256': obj.sha256 } : {}),
            })
            .end()
        if (req.headers['if-match'] !== undefined && req.headers['if-match'] !== headers.etag)
          return xmlError(res, 412, 'PreconditionFailed')
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
        const part = m ? obj.body.subarray(Number(m[1]), Number(m[2]) + 1) : obj.body
        res
          .writeHead(m ? 206 : 200, {
            ...headers,
            'content-length': part.length,
            ...(m
              ? {
                  'content-range': `bytes ${m[1]}-${Number(m[1]) + part.length - 1}/${obj.body.length}`,
                }
              : {}),
          })
          .end(part, () => afterGet.get(path)?.())
      })
    })
    await new Promise<void>((resolve) => s3.listen(0, '127.0.0.1', resolve))
    s3Port = (s3.address() as AddressInfo).port
    s3Id = await insertRow(ds.manager, 'fs_storage', {
      name: `${PREFIX}direct`,
      driver: 's3',
      config: {
        endpoint: `http://127.0.0.1:${s3Port}`,
        region: 'us-east-1',
        bucket: 'qw-files',
        accessKey: 'AKIDEXAMPLE',
        secretKey: app.get(SecretBox).encrypt('direct-upload-secret'),
        forcePathStyle: true,
        publicDomain: null,
      },
    })
    ;[{ id: localId }] = await ds.query(
      "SELECT id FROM fs_storage WHERE name = 'seed.storage.local'",
    )
  })
  afterAll(async () => {
    await new Promise((resolve) => s3.close(resolve))
    await ds.query('DELETE FROM fs_object WHERE storage_id = ?', [s3Id])
    await ds.query('DELETE FROM fs_storage WHERE id = ?', [s3Id])
  })

  /** Runs `fn` with the S3 stand-in as the primary storage, then the seeded local one again. */
  async function onS3(fn: () => Promise<void>) {
    await ds.query('UPDATE fs_storage SET is_primary = 0 WHERE id = ?', [localId])
    await ds.query('UPDATE fs_storage SET is_primary = 1 WHERE id = ?', [s3Id])
    try {
      await fn()
    } finally {
      await ds.query('UPDATE fs_storage SET is_primary = 0 WHERE id = ?', [s3Id])
      await ds.query('UPDATE fs_storage SET is_primary = 1 WHERE id = ?', [localId])
    }
  }
  const presign = (who: keyof typeof tokens, body: object) =>
    http().post(`${URL}/presign`).set(bearer(tokens[who])).send(body)
  const confirm = (who: keyof typeof tokens, key: string) =>
    http().post(`${URL}/confirm`).set(bearer(tokens[who])).send({ key })
  /** The browser's PUT to the presigned URL with the headers it was told to send. */
  const put = (p: { url: string; headers: Record<string, string> }, body: Buffer) =>
    fetch(p.url, { method: 'PUT', headers: p.headers, body: new Uint8Array(body) })
  const grant = (key: string) => redis.exists(redisKey('presign', key))
  const pdfBody = (over: object = {}) => ({
    filename: '合同.pdf',
    size: pdf.length,
    mime: 'application/pdf',
    bizTag: 'attachment',
    ...over,
  })

  it('a local primary storage takes no direct upload (422)', async () => {
    const res = await presign('owner', pdfBody()).expect(422)
    expect(res.body.code).toBe(Err.STORAGE_DIRECT_UNAVAILABLE.code)
  })

  it("presign → PUT → confirm; user B confirming A's key → 404 with the grant kept; A confirms once", () =>
    onS3(async () => {
      const p = (await presign('owner', pdfBody()).expect(200)).body.data
      expect(p.key).toMatch(FS_OBJECT_KEY)
      expect(p.key).toMatch(/\.pdf$/)
      expect(p.headers).toEqual({ 'Content-Type': 'application/pdf' })
      const url = new globalThis.URL(p.url)
      // the browser writes to staging/, never to the object's area
      expect(url.origin + url.pathname).toBe(
        `http://127.0.0.1:${s3Port}${objectPath(p.key, 'staging')}`,
      )
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host')
      expect(url.searchParams.get('X-Amz-Expires')).toBe(String(PRESIGN_TTL_SEC))
      expect(await redis.ttl(redisKey('presign', p.key))).toBeGreaterThan(PRESIGN_TTL_SEC - 10)
      expect((await put(p, pdf)).status).toBe(200)

      for (const who of ['other', 'viewer', 'admin'] as const) {
        const res = await confirm(who, p.key).expect(404)
        expect(res.body.code).toBe(Err.NOT_FOUND.code)
        expect(await grant(p.key)).toBe(1)
      }
      const t = `${PREFIX}${process.pid}-confirm`
      const obj = (await confirm('owner', p.key).set('X-Request-Id', t).expect(201)).body.data
      expect(obj).toMatchObject({
        originalName: '合同.pdf',
        mime: 'application/pdf',
        size: pdf.length,
        isPublic: false,
        url: null,
        bizTag: 'attachment',
      })
      const [row] = await ds.query('SELECT * FROM fs_object WHERE id = ?', [obj.id])
      expect(row).toMatchObject({ storage_id: s3Id, object_key: p.key, uploader_id: ids.owner })
      expect(row.sha256).toBeNull()
      expect(await grant(p.key)).toBe(0)
      expect(objects.has(objectPath(p.key, 'staging'))).toBe(false)
      expect(objects.get(objectPath(p.key))).toMatchObject({ type: 'application/pdf' })
      await confirm('owner', p.key).expect(404)
      // the PUT URL is still valid, but only for staging/: the registered object stays as confirmed
      expect((await put(p, Buffer.from('%PDF-1.4 replaced bytes'))).status).toBe(200)
      expect(Buffer.compare(objects.get(objectPath(p.key))!.body, pdf)).toBe(0)
      expect(await logOf(ds, t)).toMatchObject({ verb: 'upload', biz_id: String(obj.id), ok: 1 })
      const dl = await download('owner', obj.id).expect(302)
      expect(dl.headers.location).toContain(objectPath(p.key))
      await download('other', obj.id).expect(403)
      // deleting it from the list is soft: the S3 object stays for the purge (tested below)
      await http().delete(`${URL}/${obj.id}`).set(bearer(tokens.admin)).expect(200)
      expect(objects.has(objectPath(p.key))).toBe(true)
      await download('owner', obj.id).expect(404)
    }))

  it('a public image is public only once checked, served with the sniffed type; the SHA-256 is signed and recorded', () =>
    onS3(async () => {
      const p = (
        await presign('owner', {
          filename: 'me.png',
          size: png.length,
          mime: 'image/png',
          bizTag: 'avatar',
        }).expect(200)
      ).body.data
      // a PUT with another type (S3 would refuse the signature; the stand-in keeps it)
      expect((await put({ ...p, headers: { 'Content-Type': 'text/html' } }, png)).status).toBe(200)
      expect(objects.has(objectPath(p.key, 'public'))).toBe(false)
      const obj = (await confirm('owner', p.key).expect(201)).body.data
      expect(obj).toMatchObject({ isPublic: true, mime: 'image/png' })
      expect(obj.url).toBe(`http://127.0.0.1:${s3Port}${objectPath(p.key, 'public')}`)
      expect(objects.get(objectPath(p.key, 'public'))).toMatchObject({ type: 'image/png' })
      // deleted: the body leaves public/ at once; a move the bucket refuses keeps the object as it was
      const del = () => http().delete(`${URL}/${obj.id}`).set(bearer(tokens.admin))
      refuseDelete.add(objectPath(p.key, 'public'))
      try {
        await del().expect(500)
      } finally {
        refuseDelete.clear()
      }
      expect(
        await ds.query('SELECT id FROM fs_object WHERE id = ? AND deleted_at IS NULL', [obj.id]),
      ).toHaveLength(1)
      await del().expect(200)
      expect(objects.has(objectPath(p.key, 'public'))).toBe(false)
      expect(objects.get(objectPath(p.key, 'private'))?.body).toEqual(png)

      const sha256 = createHash('sha256').update(pdf).digest('hex')
      const signed = (await presign('owner', pdfBody({ sha256 })).expect(200)).body.data
      const b64 = Buffer.from(sha256, 'hex').toString('base64')
      expect(signed.headers).toEqual({
        'Content-Type': 'application/pdf',
        'x-amz-checksum-sha256': b64,
      })
      expect(new globalThis.URL(signed.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
        'content-length;content-type;host;x-amz-checksum-sha256',
      )
      expect((await put(signed, pdf)).status).toBe(200)
      const kept = (await confirm('owner', signed.key).expect(201)).body.data
      expect((await ds.query('SELECT sha256 FROM fs_object WHERE id = ?', [kept.id]))[0]).toEqual({
        sha256,
      })
    }))

  it('the staged bytes are checked again: another type or size → 422 and the upload deleted', () =>
    onS3(async () => {
      const cases: [
        object,
        (p: { url: string; headers: Record<string, string> }) => Promise<unknown>,
      ][] = [
        // exe bytes behind a .png name
        [{ filename: 'x.png', size: exe.length, mime: 'image/png' }, (p) => put(p, exe)],
        // fewer bytes than presigned (S3 enforces the signed length; the stand-in does not)
        [pdfBody({ size: pdf.length + 5 }), (p) => put(p, pdf)],
        // a pdf behind a public image name
        [
          { filename: 'a.png', size: pdf.length, mime: 'image/png', bizTag: 'avatar' },
          (p) => put(p, pdf),
        ],
      ]
      for (const [body, upload] of cases) {
        const p = (await presign('owner', { bizTag: 'attachment', ...body }).expect(200)).body.data
        await upload(p)
        expect(objects.has(objectPath(p.key, 'staging'))).toBe(true)
        const res = await confirm('owner', p.key).expect(422)
        expect(res.body.code).toBe(Err.STORAGE_UPLOAD_MISMATCH.code)
        expect([...objects.keys()].filter((k) => k.endsWith(p.key))).toEqual([])
        expect(await ds.query('SELECT id FROM fs_object WHERE object_key = ?', [p.key])).toEqual([])
      }
      // confirmed before the PUT: nothing stored → 404
      const early = (await presign('owner', pdfBody()).expect(200)).body.data
      await confirm('owner', early.key).expect(404)
    }))

  it('bytes PUT between the check and the copy are never published: confirm refuses (422), nothing kept', () =>
    onS3(async () => {
      const p = (await presign('owner', pdfBody()).expect(200)).body.data
      await put(p, pdf)
      // the still-valid PUT URL overwrites staging/ right after confirm has read the checked bytes
      const staged = objectPath(p.key, 'staging')
      afterGet.set(staged, () => {
        afterGet.delete(staged)
        objects.set(staged, { body: exe, type: 'application/pdf' })
      })
      try {
        const res = await confirm('owner', p.key).expect(422)
        expect(res.body.code).toBe(Err.STORAGE_UPLOAD_MISMATCH.code)
      } finally {
        afterGet.clear()
      }
      expect([...objects.keys()].filter((k) => k.endsWith(p.key))).toEqual([])
      expect(await ds.query('SELECT id FROM fs_object WHERE object_key = ?', [p.key])).toEqual([])
    }))

  it('office documents are checked whole, like a server upload: a docx or .doc past the first 4100 bytes passes', () =>
    onS3(async () => {
      // a real docx whose first part is a 2 MiB thumbnail: its first 4100 bytes sniff as a plain zip,
      // its central directory lies far past them (streamed: only the head and the tail are kept)
      const zip = new ZipArchive({ store: true })
      const ooxml = (type: string) => `<?xml version="1.0" encoding="UTF-8"?>${type}`
      zip.append(Buffer.alloc(2 * 1024 * 1024, 7), { name: 'docProps/thumbnail.jpeg' })
      zip.append(
        ooxml(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        ),
        { name: '[Content_Types].xml' },
      )
      zip.append(
        ooxml(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        ),
        { name: '_rels/.rels' },
      )
      zip.append(
        ooxml(
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>direct</w:t></w:r></w:p></w:body></w:document>',
        ),
        { name: 'word/document.xml' },
      )
      void zip.finalize().catch(() => undefined)
      const parts: Buffer[] = []
      for await (const chunk of zip) parts.push(chunk as Buffer)
      const docx = Buffer.concat(parts)
      expect((await fileTypeFromBuffer(docx.subarray(0, 4100)))?.ext).toBe('zip')
      const cfb = (stream: string) =>
        Buffer.concat([
          Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
          Buffer.alloc(1536 * 1024),
          Buffer.from(stream, 'utf16le'),
          Buffer.alloc(100),
        ])
      const wb = new ExcelJS.Workbook()
      wb.addWorksheet('a').addRow([1])
      const xlsx = Buffer.from(await wb.xlsx.writeBuffer())
      for (const [file, name, status] of [
        [docx, 'report.docx', 201],
        [cfb('WordDocument'), 'old.doc', 201],
        [cfb('Workbook'), 'wrong.doc', 422],
        [xlsx, 'sheet.docx', 422],
      ] as const) {
        expect(file.length).toBeGreaterThan(4100)
        const p = (
          await presign('owner', {
            filename: name,
            size: file.length,
            mime: 'application/octet-stream',
            bizTag: 'attachment',
          }).expect(200)
        ).body.data
        await put(p, file)
        const res = await confirm('owner', p.key)
        // the same verdict as the upload through the server
        const up = await upload('owner', file, name)
        expect([name, res.status, up.status]).toEqual([name, status, status])
      }
    }))

  it('purge: a body the storage fails to delete keeps its row, so the next purge tries it again', () =>
    onS3(async () => {
      const p = (await presign('owner', pdfBody()).expect(200)).body.data
      await put(p, pdf)
      const obj = (await confirm('owner', p.key).expect(201)).body.data
      // the delete itself is soft: the body stays for the purge
      await http().delete(`${URL}/${obj.id}`).set(bearer(tokens.admin)).expect(200)
      expect(objects.has(objectPath(p.key))).toBe(true)
      await ds.query('UPDATE fs_object SET deleted_at = ? WHERE id = ?', [
        new Date(2000, 0, 1),
        obj.id,
      ])
      const purge = () =>
        app.get(StorageService).purgeDeleted(new Date(2001, 0, 1), new AbortController().signal)
      refuseDelete.add(objectPath(p.key))
      try {
        expect(await purge()).toBe(0)
      } finally {
        refuseDelete.clear()
      }
      // still tracked (deleted), and the body is still there
      expect(await ds.query('SELECT id FROM fs_object WHERE id = ?', [obj.id])).toHaveLength(1)
      expect(objects.has(objectPath(p.key))).toBe(true)
      expect(await purge()).toBe(1)
      expect(await ds.query('SELECT id FROM fs_object WHERE id = ?', [obj.id])).toEqual([])
      expect(objects.has(objectPath(p.key))).toBe(false)
    }))

  it('presign checks the name, size and tag like an upload; bad bodies 400, no session 401', () =>
    onS3(async () => {
      for (const [body, status, code] of [
        [
          pdfBody({ filename: 'page.html', mime: 'text/html' }),
          422,
          Err.STORAGE_TYPE_REJECTED.code,
        ],
        [pdfBody({ filename: 'noext' }), 422, Err.STORAGE_TYPE_REJECTED.code],
        [pdfBody({ bizTag: 'cover' }), 422, Err.STORAGE_PUBLIC_IMAGE_ONLY.code],
        [pdfBody({ size: 20 * 1024 * 1024 + 1 }), 413, Err.PAYLOAD_TOO_LARGE.code],
        [pdfBody({ size: 0 }), 400, Err.VALIDATION_FAILED.code],
        [pdfBody({ mime: 'not a type' }), 400, Err.VALIDATION_FAILED.code],
        [pdfBody({ bizTag: 'secret-tag' }), 400, Err.VALIDATION_FAILED.code],
        [pdfBody({ sha256: 'xyz' }), 400, Err.VALIDATION_FAILED.code],
      ] as const) {
        const res = await presign('owner', body)
        expect([body, res.status, res.body.code]).toEqual([body, status, code])
      }
      await http().post(`${URL}/presign`).send(pdfBody()).expect(401)
      await confirm('owner', '2026/09/28/00000000-0000-4000-8000-00000000abcd.pdf').expect(404)
      await confirm('owner', '../../etc/passwd').expect(400)
      await http().post(`${URL}/confirm`).send({ key: 'x' }).expect(401)
    }))
})

describe('list', () => {
  const tag = `${process.pid}-list`
  const listed: number[] = []
  const list = (who: keyof typeof tokens, query: object = {}) =>
    http().get(URL).set(bearer(tokens[who])).query(query)
  beforeAll(async () => {
    for (const [file, name, bizTag] of [
      [pdf, `${tag}-a.pdf`, 'attachment'],
      [png, `${tag}-b.png`, 'avatar'],
      [Buffer.from(`${tag} 50%_off`), `${tag}-50%_off.txt`, 'import'],
    ] as const)
      listed.push((await upload('owner', file, name, bizTag).expect(201)).body.data.id)
  })

  it('browse: every object newest first with its storage and uploader names; 403 without browse', async () => {
    const res = await list('admin', { originalName: tag }).expect(200)
    expect(res.body.data.total).toBe(3)
    expect(res.body.data.items.map((r: { id: number }) => r.id)).toEqual([...listed].reverse())
    expect(res.body.data.items[2]).toEqual({
      id: listed[0],
      originalName: `${tag}-a.pdf`,
      mime: 'application/pdf',
      size: pdf.length,
      url: null,
      isPublic: false,
      bizTag: 'attachment',
      createdAt: expect.any(String),
      storageId: expect.any(Number),
      storageName: 'seed.storage.local',
      uploaderId: ids.owner,
      uploaderName: 'owner',
    })
    for (const who of ['owner', 'viewer'] as const) await list(who).expect(403)
  })

  it('filters: name contains (wildcards literal), tag, public, storage, upload time; sort by size', async () => {
    const names = async (query: object) =>
      (await list('admin', { originalName: tag, ...query }).expect(200)).body.data.items.map(
        (r: { originalName: string }) => r.originalName,
      )
    expect(await names({ originalName: `${tag}-50%_` })).toEqual([`${tag}-50%_off.txt`])
    expect(await names({ bizTag: 'avatar' })).toEqual([`${tag}-b.png`])
    expect(await names({ isPublic: 'true' })).toEqual([`${tag}-b.png`])
    const [{ id: local }] = await ds.query(
      "SELECT id FROM fs_storage WHERE name = 'seed.storage.local'",
    )
    expect(await names({ storageId: local })).toHaveLength(3)
    expect(await names({ storageId: 999_999 })).toEqual([])
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
    expect(await names({ createdAtFrom: hourAgo })).toHaveLength(3)
    expect(await names({ createdAtTo: hourAgo })).toEqual([])
    const sizes: Record<string, number> = {
      [`${tag}-a.pdf`]: pdf.length,
      [`${tag}-b.png`]: png.length,
      [`${tag}-50%_off.txt`]: Buffer.byteLength(`${tag} 50%_off`),
    }
    expect(await names({ sort: 'size' })).toEqual(
      Object.keys(sizes).sort((a, b) => sizes[a]! - sizes[b]!),
    )
    await list('admin', { sort: 'mime' }).expect(400)
    await list('admin', { bizTag: 'nope' }).expect(400)
  })

  it('detail: view perm (the uploader alone is not enough); key, hash, driver; 404 unknown', async () => {
    const res = await http().get(`${URL}/${listed[0]}`).set(bearer(tokens.viewer)).expect(200)
    const [row] = await ds.query('SELECT object_key, sha256 FROM fs_object WHERE id = ?', [
      listed[0],
    ])
    expect(res.body.data).toMatchObject({
      id: listed[0],
      storageDriver: 'local',
      storageName: 'seed.storage.local',
      objectKey: row.object_key,
      sha256: row.sha256,
      bizRef: null,
    })
    await http().get(`${URL}/${listed[0]}`).set(bearer(tokens.owner)).expect(403)
    await http().get(`${URL}/999999`).set(bearer(tokens.admin)).expect(404)
  })

  it('export: the filtered rows as .xlsx with translated headers; export perm; action-logged', async () => {
    const t = `${PREFIX}${process.pid}-export`
    const res = await binary(
      http().get(`${URL}/export`).set(bearer(tokens.admin)).set('X-Request-Id', t).query({
        originalName: tag,
        sort: 'id',
      }),
    ).expect(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body as never)
    const ws = wb.worksheets[0]!
    expect(ws.getRow(1).values).toEqual([
      undefined,
      '文件名',
      '业务标签',
      '文件类型',
      '文件大小',
      '是否公开',
      '存储',
      '上传人',
      '上传时间',
    ])
    expect(ws.rowCount).toBe(4)
    expect(ws.getRow(2).getCell(1).value).toBe(`${tag}-a.pdf`)
    expect(ws.getRow(2).getCell(6).value).toBe('本地存储')
    expect(await logOf(ds, t)).toMatchObject({ domain: 'storage.object', verb: 'export', ok: 1 })
    await http().get(`${URL}/export`).set(bearer(tokens.viewer)).expect(403)
  })

  it('delete from the list: gone from the list and the detail, the file kept until the purge (out of the public area: its links break at once)', async () => {
    const [{ object_key: key }] = await ds.query('SELECT object_key FROM fs_object WHERE id = ?', [
      listed[1],
    ])
    expect(existsSync(join(uploadRoot(), 'public', key))).toBe(true)
    await http().delete(`${URL}/${listed[1]}`).set(bearer(tokens.admin)).expect(200)
    expect(existsSync(join(uploadRoot(), 'public', key))).toBe(false)
    expect(existsSync(join(uploadRoot(), 'private', key))).toBe(true)
    expect((await list('admin', { originalName: tag }).expect(200)).body.data.total).toBe(2)
    await http().get(`${URL}/${listed[1]}`).set(bearer(tokens.admin)).expect(404)
  })
})

it('seed: one enabled primary local storage named by a seed key; Swagger documents the routes', async () => {
  expect(
    await ds.query('SELECT name, driver, is_primary, enabled FROM fs_storage WHERE is_primary = 1'),
  ).toEqual([{ name: 'seed.storage.local', driver: 'local', is_primary: 1, enabled: 1 }])
  await expect(
    ds.query("INSERT INTO fs_storage (name, driver, is_primary) VALUES ('second', 'local', 1)"),
  ).rejects.toMatchObject({ driverError: { errno: 1062 } })
  const doc = (await http().get('/api/docs-json').expect(200)).body
  expect(
    Object.keys(doc.paths)
      .filter((p) => p.startsWith(URL))
      .sort(),
  ).toEqual([
    URL,
    `${URL}/confirm`,
    `${URL}/export`,
    `${URL}/presign`,
    `${URL}/{id}`,
    `${URL}/{id}/download`,
  ])
})
