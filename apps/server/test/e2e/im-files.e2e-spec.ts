// 聊天上传与附件文件路由（see docs/im.md）：上传上限取聊天参数与存储上限的较小值（413）；类型白名单与存储
// 允许清单取交集、内容按魔数识别；超像素图片 422；缩略图是同一 biz_ref 下的第二个对象、≤360px webp、动图
// 取第 1 帧；文件路由只给当前成员、可见区间内、未撤回、确有附件且对象确实绑定在这一条上的消息，上传者本人
// 退群后也拒；proxy=1 超 20MiB 413，S3 非 proxy 302；对象不能绑定第二次；通用存储接口对已绑定的聊天对象
// 一律拒绝；他租户 404。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Err, type ImEntry, storageObjectPerms, storageParams, imParams } from '@qiwu/shared'
import sharp from 'sharp'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { ImObjectsService } from '../../src/modules/platform/im/im-objects.service.js'
import { S3Storage } from '../../src/modules/platform/storage/s3-storage.js'
import type { StorageConfig } from '../../src/modules/platform/storage/config/config.entity.js'
import { StorageService } from '../../src/modules/platform/storage/storage.service.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  bootApp,
  createTenant,
  inTenant1,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'
import { binary, imKit, MB, pdf, type Person, picture } from './im-objects.helpers.js'

let app: NestExpressApplication
let kit: ReturnType<typeof imKit>
let other: PeopledTenant
let owner: Person
let bob: Person
let carol: Person
let dave: Person
let viewer: Person
let rootToken = ''
let room = 0
let menuId = 0
let roleId = 0

const fileOf = (p: Person, roomId: number, seq: number, query = '') =>
  kit.file(p, `/api/im/rooms/${roomId}/entries/${seq}/file${query}`)

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  kit = imKit(app, 'im-files-')
  owner = await kit.person('owner')
  bob = await kit.person('bob')
  carol = await kit.person('carol')
  dave = await kit.person('dave')
  // 持有全局文件查看权限的员工：通用接口对聊天对象也不能放行
  menuId = await insertRow(kit.ds.manager, 'iam_menu', {
    kind: 'action',
    name: 'menu.action.view',
    perms: storageObjectPerms.view,
  })
  roleId = await inTenant1(() =>
    insertRow(kit.ds.manager, 'iam_role', {
      code: `im-files-viewer-${Date.now()}`,
      name: 'im-files-viewer',
      data_scope: 'all',
    }),
  )
  await kit.ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
    roleId,
    menuId,
  ])
  viewer = await kit.person('viewer')
  await kit.ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
    viewer.id,
    roleId,
  ])
  viewer.token = (await signInDirect(app, viewer.id))!.accessToken
  rootToken = (await signIn(app)).accessToken
  other = await createTenant(app, { users: true })
  room = await kit.group(owner, [bob, carol, viewer])
})

afterEach(() => vi.restoreAllMocks())

afterAll(async () => {
  await other?.dispose()
  if (kit) {
    await kit.dispose()
    await kit.ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await kit.ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    await kit.ds.query('DELETE FROM iam_menu WHERE id = ?', [menuId])
  }
  await app?.close()
})

describe('uploads', () => {
  it('the limit is the smaller of the chat param and storage.max_size_mb: 413 either way', async () => {
    const objects = app.get(ImObjectsService)
    const big = Buffer.alloc(Math.floor(1.5 * MB), 97)
    // 存储上限更小：聊天参数仍是 20，生效上限是 1MiB
    await kit.withParam(storageParams.maxSizeMb, '1', async () => {
      expect(await objects.limits()).toMatchObject({ fileMaxMb: 20, maxBytes: MB })
      const res = await kit.attach(owner, `/api/im/rooms/${room}/uploads`, big, 'big.txt')
      expect([res.status, res.body.code]).toEqual([413, Err.PAYLOAD_TOO_LARGE.code])
      // 表情上传不经过 putImObject：只有这里的取小挡得住
      const image = await picture(1000, 1000, { noise: true })
      expect(image.length).toBeGreaterThan(MB)
      const sticker = await kit.attach(owner, '/api/im/stickers', image, 'big.png')
      expect([sticker.status, sticker.body.code]).toEqual([413, Err.PAYLOAD_TOO_LARGE.code])
    })
    // 聊天参数更小：在读完文件之前就按参数截断
    await kit.withParam(imParams.fileMaxMb, '1', async () => {
      expect(await objects.limits()).toMatchObject({ fileMaxMb: 1, maxBytes: MB })
      const res = await kit.attach(owner, `/api/im/rooms/${room}/uploads`, big, 'big2.txt')
      expect(res.status).toBe(413)
    })
    // 两个上限都放得下
    const ok = await kit.attach(owner, `/api/im/rooms/${room}/uploads`, big, 'fits.txt').expect(201)
    expect(ok.body.data).toMatchObject({ name: 'fits.txt', size: big.length, mime: 'text/plain' })
    expect(await kit.object(ok.body.data.objectId)).toMatchObject({
      biz_tag: 'im.attachment',
      biz_ref: null,
      uploader_id: owner.id,
    })
  })

  it('types: the chat list meets storage.allowed_exts, the content must match its extension', async () => {
    const up = (data: Buffer, name: string) =>
      kit.attach(owner, `/api/im/rooms/${room}/uploads`, data, name)
    const rejected = Err.STORAGE_TYPE_REJECTED.code
    expect((await up(Buffer.from('MZ binary'), 'tool.exe')).body.code).toBe(rejected)
    expect((await up(Buffer.from('plain text, not an image'), 'fake.png')).body.code).toBe(rejected)
    expect((await up(Buffer.from('<svg/>'), 'x.svg')).body.code).toBe(rejected)
    await up(pdf(), 'doc.pdf').expect(201)
    // 聊天清单里有 pdf，但存储允许清单没有：取交集后拒绝
    await kit.withParam(storageParams.allowedExts, 'png,jpg,txt', async () => {
      const limits = await app.get(ImObjectsService).limits()
      expect(limits.fileExts).toEqual(['txt'])
      expect(limits.imageExts).toEqual(['jpg', 'png'])
      const res = await up(pdf(), 'doc2.pdf')
      expect([res.status, res.body.code]).toEqual([422, rejected])
    })
  })

  it('a non-member and another tenant cannot upload', async () => {
    const res = await kit.attach(dave, `/api/im/rooms/${room}/uploads`, pdf(), 'a.pdf')
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ROOM_NOT_FOUND.code])
    const stranger = {
      id: other.users.alice,
      tenantId: other.id,
      token: (await signInDirect(app, other.users.alice))!.accessToken,
    }
    const cross = await kit.attach(stranger, `/api/im/rooms/${room}/uploads`, pdf(), 'b.pdf')
    expect([cross.status, cross.body.code]).toEqual([404, Err.IM_ROOM_NOT_FOUND.code])
  })
})

describe('thumbnails', () => {
  it('an image gets a ≤360px webp thumbnail: a second object under the same biz_ref', async () => {
    const entry = await kit.sendImage(owner, room, await picture(800, 600))
    const a = entry.attachment!
    expect(a).toMatchObject({ mime: 'image/png', width: 800, height: 600 })
    expect(a.thumbObjectId).toBeDefined()
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    const ref = `im:${room}:${entry.seq}`
    expect(await kit.object(a.objectId)).toMatchObject({ biz_tag: 'im.attachment', biz_ref: ref })
    expect(await kit.object(a.thumbObjectId!)).toMatchObject({
      biz_tag: 'im.attachment',
      biz_ref: ref,
      mime: 'image/webp',
    })
    const thumb = await fileOf(bob, room, entry.seq, '?thumb=1').expect(200)
    expect(thumb.headers['content-type']).toBe('image/webp')
    expect(await sharp(thumb.body as Buffer).metadata()).toMatchObject({
      format: 'webp',
      width: 360,
      height: 270,
    })
    const original = await fileOf(bob, room, entry.seq).expect(200)
    expect(original.headers['content-type']).toBe('image/png')
    expect(original.headers['x-content-type-options']).toBe('nosniff')
    expect(await sharp(original.body as Buffer).metadata()).toMatchObject({
      width: 800,
      height: 600,
    })
  })

  it('an animated GIF: one frame high, the thumbnail is its first frame only', async () => {
    const entry = await kit.sendImage(owner, room, await picture(120, 40, { frames: 3 }), 'gif')
    expect(entry.attachment).toMatchObject({ mime: 'image/gif', width: 120, height: 40 })
    const thumb = await fileOf(owner, room, entry.seq, '?thumb=1').expect(200)
    const meta = await sharp(thumb.body as Buffer, { animated: true }).metadata()
    expect([meta.width, meta.pageHeight ?? meta.height, meta.pages ?? 1]).toEqual([120, 40, 1])
  })

  it('an image over the input pixel limit is refused 422 and nothing gets bound', async () => {
    const huge = await sharp({
      create: { width: 7000, height: 6000, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer()
    const objectId = await kit.upload(owner, room, huge, 'huge.png')
    const res = await kit.send(owner, room, { kind: 'image', objectId })
    expect(res.status).toBe(422)
    expect((await kit.object(objectId))!.biz_ref).toBeNull()
  })
})

describe('the file route', () => {
  let photo: ImEntry

  beforeAll(async () => {
    photo = await kit.sendImage(owner, room)
  })

  it('members read it; a non-member 404 B5002, another tenant 404', async () => {
    await fileOf(bob, room, photo.seq).expect(200)
    const res = await fileOf(dave, room, photo.seq)
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ROOM_NOT_FOUND.code])
    const token = (await signInDirect(app, other.users.alice))!.accessToken
    const cross = await binary(
      kit.http().get(`/api/im/rooms/${room}/entries/${photo.seq}/file`).set(bearer(token)),
    )
    expect(cross.status).toBe(404)
  })

  it('a member who joined later cannot read what came before (out of the visible range)', async () => {
    const late = await kit.group(owner, [bob], 'Later')
    const before = await kit.sendImage(owner, late)
    await kit.post(owner, `/api/im/rooms/${late}/members`, { userIds: [dave.id] }).expect(200)
    const after = await kit.sendImage(owner, late)
    const res = await fileOf(dave, late, before.seq)
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
    await fileOf(dave, late, after.seq).expect(200)
  })

  it('a recalled entry is refused even while its object is still there', async () => {
    const entry = await kit.sendImage(owner, room)
    await fileOf(bob, room, entry.seq).expect(200)
    // 只标撤回、不动附件与对象：拒绝必须来自“未撤回”判定本身
    await kit.ds.query(
      'UPDATE im_entry SET recalled_at = NOW(3), recalled_by = ? WHERE tenant_id = 1 AND room_id = ? AND seq = ?',
      [owner.id, room, entry.seq],
    )
    expect((await kit.object(entry.attachment!.objectId))!.deleted_at).toBeNull()
    for (const query of ['', '?thumb=1']) {
      const res = await fileOf(bob, room, entry.seq, query)
      expect([res.status, res.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
    }
    // 真正的撤回：对象一并软删，同样 404
    const real = await kit.sendImage(owner, room)
    await kit.post(owner, `/api/im/rooms/${room}/entries/${real.seq}/recall`).expect(200)
    expect((await kit.object(real.attachment!.objectId))!.deleted_at).not.toBeNull()
    const res = await fileOf(owner, room, real.seq)
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
  })

  it('an entry without an attachment, and a file without a thumbnail, are 404 B5012', async () => {
    const text = await kit.sendText(owner, room)
    const res = await fileOf(bob, room, text.seq)
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
    const objectId = await kit.upload(owner, room, pdf(), 'report.pdf')
    const doc = (await kit.send(owner, room, { kind: 'file', objectId }).expect(201)).body
      .data as ImEntry
    expect(doc.attachment).toMatchObject({ name: 'report.pdf', mime: 'application/pdf' })
    expect(doc.attachment!.thumbObjectId).toBeUndefined()
    const file = await fileOf(bob, room, doc.seq).expect(200)
    expect(file.headers['content-disposition']).toMatch(/^attachment;/)
    const thumb = await fileOf(bob, room, doc.seq, '?thumb=1')
    expect([thumb.status, thumb.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
  })

  it('the object must really be bound to this entry: an attachment pointing at another is refused', async () => {
    const entry = await kit.sendImage(owner, room)
    await fileOf(bob, room, entry.seq).expect(200)
    await kit.ds.query(
      `UPDATE im_entry SET attachment = JSON_SET(attachment, '$.objectId', ?)
        WHERE tenant_id = 1 AND room_id = ? AND seq = ?`,
      [photo.attachment!.objectId, room, entry.seq],
    )
    const res = await fileOf(bob, room, entry.seq)
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
  })

  it('the uploader who left the group is refused their own file too', async () => {
    const team = await kit.group(owner, [carol], 'Leaving')
    const mine = await kit.sendImage(carol, team)
    await fileOf(carol, team, mine.seq).expect(200)
    await kit.post(carol, `/api/im/rooms/${team}/leave`).expect(200)
    const res = await fileOf(carol, team, mine.seq)
    expect([res.status, res.body.code]).toEqual([404, Err.IM_ROOM_NOT_FOUND.code])
    await fileOf(owner, team, mine.seq).expect(200)
  })

  it('proxy=1 serves same-origin up to 20 MiB: larger 413', async () => {
    const id = photo.attachment!.objectId
    await fileOf(bob, room, photo.seq, '?proxy=1').expect(200)
    const [{ size }] = await kit.ds.query<{ size: number }[]>(
      'SELECT size FROM fs_object WHERE id = ?',
      [id],
    )
    await kit.ds.query('UPDATE fs_object SET size = ? WHERE id = ?', [20 * MB + 1, id])
    try {
      expect((await fileOf(bob, room, photo.seq, '?proxy=1')).status).toBe(413)
    } finally {
      await kit.ds.query('UPDATE fs_object SET size = ? WHERE id = ?', [size, id])
    }
  })

  it('on S3 without proxy: 302 to a presigned GET', async () => {
    const fake = Object.create(S3Storage.prototype) as S3Storage
    const signed = vi
      .spyOn(fake, 'presignGet')
      .mockResolvedValue('https://storage.example.test/signed')
    vi.spyOn(
      app.get(StorageService) as unknown as { clientFor(config: StorageConfig): S3Storage },
      'clientFor',
    ).mockReturnValue(fake)
    const res = await fileOf(bob, room, photo.seq, '?thumb=1').expect(302)
    expect(res.headers.location).toBe('https://storage.example.test/signed')
    expect(signed).toHaveBeenCalledOnce()
  })

  it('an object binds once: sending it again, or someone else sending it, is 400', async () => {
    const again = await kit.send(owner, room, {
      kind: 'image',
      objectId: photo.attachment!.objectId,
    })
    expect([again.status, again.body.code]).toEqual([400, Err.STORAGE_REF_INVALID.code])
    const loose = await kit.upload(owner, room, pdf(), 'loose.pdf')
    const theirs = await kit.send(bob, room, { kind: 'file', objectId: loose })
    expect([theirs.status, theirs.body.code]).toEqual([400, Err.STORAGE_REF_INVALID.code])
    expect((await kit.object(loose))!.biz_ref).toBeNull()
  })

  it('generic storage routes refuse a bound chat object: uploader, root, storage.object.view', async () => {
    const id = photo.attachment!.objectId
    for (const token of [owner.token, rootToken, viewer.token]) {
      await binary(kit.http().get(`/api/storage/objects/${id}/download`).set(bearer(token))).expect(
        403,
      )
      await binary(kit.http().get(`/api/storage/objects/${id}/content`).set(bearer(token))).expect(
        403,
      )
      await kit.http().get(`/api/storage/objects/${id}`).set(bearer(token)).expect(403)
    }
    // 聊天自己的路由对成员照常
    await fileOf(viewer, room, photo.seq).expect(200)
  })
})
