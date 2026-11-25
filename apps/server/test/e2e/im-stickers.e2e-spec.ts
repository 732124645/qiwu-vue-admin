// 个人自定义表情（see docs/im.md）：上传与“存为我的表情”都规范化为 ≤240px webp；每人 100 个上限、规范化后
// 超 512KiB 都是 B5013；同图去重；from-entry 只收可见、未撤回的图片或表情消息；表情文件只给本人；删除表情
// 同时软删其对象；发送自定义表情复制出新的消息对象：删收藏后消息照常可读、撤回消息后收藏仍在；列表 304；
// 他租户 404。
import { createHash } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Err, IM_STICKER_CODES, type ImEntry, type ImSticker } from '@qiwu/shared'
import sharp from 'sharp'
import { bootApp, createTenant, type PeopledTenant, signInDirect } from '../setup/tenants.js'
import { imKit, pdf, type Person, picture } from './im-objects.helpers.js'

let app: NestExpressApplication
let kit: ReturnType<typeof imKit>
let other: PeopledTenant
let stranger: Person
let owner: Person
let bob: Person
let carol: Person
let room = 0

const add = (p: Person, data: Buffer, name = `${Date.now()}-${Math.random()}.png`) =>
  kit.attach(p, '/api/im/stickers', data, name)
const mine = async (p: Person) =>
  (await kit.get(p, '/api/im/stickers').expect(200)).body.data as ImSticker[]
const stickerRow = async (id: number) =>
  (
    await kit.ds.query<{ object_id: number; deleted_at: Date | null }[]>(
      'SELECT object_id, deleted_at FROM im_sticker WHERE id = ?',
      [id],
    )
  )[0]!

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  kit = imKit(app, 'im-stickers-')
  owner = await kit.person('owner')
  bob = await kit.person('bob')
  carol = await kit.person('carol')
  other = await createTenant(app, { users: true })
  stranger = {
    id: other.users.alice,
    tenantId: other.id,
    token: (await signInDirect(app, other.users.alice))!.accessToken,
  }
  room = await kit.direct(owner, bob)
})

afterAll(async () => {
  await other?.dispose()
  await kit?.dispose()
  await app?.close()
})

describe('adding', () => {
  it('an upload is normalized to a ≤240px webp object bound to stk:<id>; the same image again is the same sticker', async () => {
    const image = await picture(600, 400)
    const made = (await add(owner, image).expect(201)).body.data as ImSticker
    expect(made).toMatchObject({ mime: 'image/webp', width: 240, height: 160 })
    const row = await stickerRow(made.id)
    expect(await kit.object(row.object_id)).toMatchObject({
      biz_tag: 'im.sticker',
      biz_ref: `stk:${made.id}`,
      mime: 'image/webp',
      uploader_id: owner.id,
    })
    const file = await kit.file(owner, `/api/im/stickers/${made.id}/file`).expect(200)
    expect(file.headers['content-type']).toBe('image/webp')
    expect(
      createHash('sha256')
        .update(file.body as Buffer)
        .digest('hex'),
    ).toBe(made.sha256)
    expect(await sharp(file.body as Buffer).metadata()).toMatchObject({ width: 240, height: 160 })
    // 同一张图换个文件名：规范化结果相同 → 原表情
    const again = (await add(owner, image, 'same-again.png').expect(201)).body.data as ImSticker
    expect(again.id).toBe(made.id)
    expect((await mine(owner)).filter((s) => s.sha256 === made.sha256)).toHaveLength(1)
  })

  it('only images: a pdf or text named .png is refused', async () => {
    expect((await add(owner, pdf(), 'doc.pdf')).body.code).toBe(Err.STORAGE_TYPE_REJECTED.code)
    expect((await add(owner, Buffer.from('not an image'), 'x.png')).body.code).toBe(
      Err.STORAGE_TYPE_REJECTED.code,
    )
  })

  it('more than 512 KiB after normalizing is B5013, and nothing is added', async () => {
    const before = (await mine(carol)).length
    const heavy = await sharp({
      create: {
        width: 240,
        height: 240 * 60,
        channels: 3,
        background: '#808080',
        noise: { type: 'gaussian', mean: 128, sigma: 60 },
        pageHeight: 240,
      },
    })
      .webp({ effort: 0, quality: 100 })
      .toBuffer()
    const res = await add(carol, heavy, 'heavy.webp')
    expect([res.status, res.body.code]).toEqual([422, Err.IM_STICKER_LIMIT.code])
    expect(await mine(carol)).toHaveLength(before)
  })

  it('an image over 40 megapixels is refused (422) before decoding, and nothing is added', async () => {
    const before = (await mine(carol)).length
    // 8000×6000 单色：文件很小，像素数超过解码上限
    const huge = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: '#808080' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer()
    const res = await add(carol, huge, 'huge.png')
    expect([res.status, res.body.code]).toEqual([422, Err.UNPROCESSABLE.code])
    expect(await mine(carol)).toHaveLength(before)
  })

  it('at most 100 per user: the 101st is B5013', async () => {
    const full = await kit.person('full')
    const values = Array.from({ length: 100 }, (_, i) => [
      1,
      full.id,
      1_000_000 + i,
      createHash('sha256').update(`filler-${full.id}-${i}`).digest('hex'),
      'image/webp',
      240,
      240,
      i,
    ])
    await kit.ds.query(
      `INSERT INTO im_sticker (tenant_id, user_id, object_id, sha256, mime, width, height, sort_no)
       VALUES ?`,
      [values],
    )
    const res = await add(full, await picture(50, 50))
    expect([res.status, res.body.code]).toEqual([422, Err.IM_STICKER_LIMIT.code])
    // 删掉一个就又能加
    await kit.ds.query('DELETE FROM im_sticker WHERE user_id = ? AND sort_no = 0', [full.id])
    await add(full, await picture(50, 50)).expect(201)
  })

  it('from-entry keeps a visible image or custom sticker; text, built-in stickers, recalled and out-of-range are refused', async () => {
    const photo = await kit.sendImage(bob, room, await picture(500, 500))
    const kept = (
      await kit
        .post(owner, '/api/im/stickers/from-entry', { roomId: room, seq: photo.seq })
        .expect(201)
    ).body.data as ImSticker
    expect(kept).toMatchObject({ mime: 'image/webp', width: 240, height: 240 })
    // 收到的自定义表情也能存
    const bobs = (await add(bob, await picture(100, 80)).expect(201)).body.data as ImSticker
    const sent = (await kit.send(bob, room, { kind: 'sticker', stickerId: bobs.id }).expect(201))
      .body.data as ImEntry
    const second = (
      await kit
        .post(owner, '/api/im/stickers/from-entry', { roomId: room, seq: sent.seq })
        .expect(201)
    ).body.data as ImSticker
    expect(second).toMatchObject({ mime: 'image/webp', width: 100, height: 80 })

    const text = await kit.sendText(bob, room)
    const builtin = (
      await kit.send(bob, room, { kind: 'sticker', stickerCode: IM_STICKER_CODES[0] }).expect(201)
    ).body.data as ImEntry
    for (const seq of [text.seq, builtin.seq]) {
      const res = await kit.post(owner, '/api/im/stickers/from-entry', { roomId: room, seq })
      expect(res.status).toBe(422)
    }
    const gone = await kit.sendImage(bob, room)
    await kit.post(bob, `/api/im/rooms/${room}/entries/${gone.seq}/recall`).expect(200)
    const recalled = await kit.post(owner, '/api/im/stickers/from-entry', {
      roomId: room,
      seq: gone.seq,
    })
    expect([recalled.status, recalled.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
    const beyond = await kit.post(owner, '/api/im/stickers/from-entry', {
      roomId: room,
      seq: gone.seq + 1000,
    })
    expect([beyond.status, beyond.body.code]).toEqual([404, Err.IM_ENTRY_NOT_FOUND.code])
    // 非成员与他租户
    const outsider = await kit.post(carol, '/api/im/stickers/from-entry', {
      roomId: room,
      seq: photo.seq,
    })
    expect([outsider.status, outsider.body.code]).toEqual([404, Err.IM_ROOM_NOT_FOUND.code])
    const cross = await kit.post(stranger, '/api/im/stickers/from-entry', {
      roomId: room,
      seq: photo.seq,
    })
    expect(cross.status).toBe(404)
  })
})

describe('own only', () => {
  it('the file, the delete and the order are the owner’s alone; another tenant 404', async () => {
    const made = (await add(owner, await picture(90, 90)).expect(201)).body.data as ImSticker
    await kit.file(owner, `/api/im/stickers/${made.id}/file`).expect(200)
    for (const p of [bob, stranger]) {
      const res = await kit.file(p, `/api/im/stickers/${made.id}/file`)
      expect(res.status).toBe(404)
      expect((await kit.del(p, `/api/im/stickers/${made.id}`)).status).toBe(404)
    }
    expect((await stickerRow(made.id)).deleted_at).toBeNull()
    const ids = (await mine(owner)).map((s) => s.id)
    // 别人的重排不改动本人的顺序
    await kit.put(bob, '/api/im/stickers/order', { ids: [...ids].reverse() }).expect(200)
    expect((await mine(owner)).map((s) => s.id)).toEqual(ids)
    await kit.put(owner, '/api/im/stickers/order', { ids: [...ids].reverse() }).expect(200)
    expect((await mine(owner)).map((s) => s.id)).toEqual([...ids].reverse())
  })

  it('the list answers 304 to its ETag and changes after an add', async () => {
    const first = await kit.get(owner, '/api/im/stickers').expect(200)
    const etag = first.headers.etag as string
    expect(first.headers['cache-control']).toBe('private, no-cache')
    await kit.get(owner, '/api/im/stickers').set('If-None-Match', etag).expect(304)
    await add(owner, await picture(70, 70)).expect(201)
    const changed = await kit.get(owner, '/api/im/stickers').set('If-None-Match', etag).expect(200)
    expect(changed.headers.etag).not.toBe(etag)
  })

  it('a delete soft-deletes the sticker and its object together', async () => {
    const made = (await add(owner, await picture(60, 90)).expect(201)).body.data as ImSticker
    const { object_id } = await stickerRow(made.id)
    await kit.del(owner, `/api/im/stickers/${made.id}`).expect(200)
    expect((await stickerRow(made.id)).deleted_at).not.toBeNull()
    expect((await kit.object(object_id))!.deleted_at).not.toBeNull()
    expect((await kit.file(owner, `/api/im/stickers/${made.id}/file`)).status).toBe(404)
    expect((await mine(owner)).map((s) => s.id)).not.toContain(made.id)
  })
})

describe('sending a custom sticker', () => {
  it('copies it into a new message object: deleting the sticker keeps the message readable', async () => {
    const made = (await add(owner, await picture(120, 120)).expect(201)).body.data as ImSticker
    const { object_id: stickerObject } = await stickerRow(made.id)
    const entry = (await kit.send(owner, room, { kind: 'sticker', stickerId: made.id }).expect(201))
      .body.data as ImEntry
    const a = entry.attachment!
    expect(a.objectId).not.toBe(stickerObject)
    expect(a).toMatchObject({ mime: 'image/webp', width: 120, height: 120, sha256: made.sha256 })
    expect(await kit.object(a.objectId)).toMatchObject({
      biz_tag: 'im.attachment',
      biz_ref: `im:${room}:${entry.seq}`,
    })
    expect(await kit.object(stickerObject)).toMatchObject({ biz_ref: `stk:${made.id}` })
    await kit.file(bob, `/api/im/rooms/${room}/entries/${entry.seq}/file`).expect(200)
    await kit.del(owner, `/api/im/stickers/${made.id}`).expect(200)
    const after = await kit.file(bob, `/api/im/rooms/${room}/entries/${entry.seq}/file`).expect(200)
    expect(
      createHash('sha256')
        .update(after.body as Buffer)
        .digest('hex'),
    ).toBe(made.sha256)
    // 已删除的表情不能再发
    const res = await kit.send(owner, room, { kind: 'sticker', stickerId: made.id })
    expect([res.status, res.body.code]).toEqual([400, Err.STORAGE_REF_INVALID.code])
  })

  it('recalling the message leaves the sticker; someone else’s sticker cannot be sent', async () => {
    const made = (await add(owner, await picture(110, 70)).expect(201)).body.data as ImSticker
    const { object_id: stickerObject } = await stickerRow(made.id)
    const entry = (await kit.send(owner, room, { kind: 'sticker', stickerId: made.id }).expect(201))
      .body.data as ImEntry
    await kit.post(owner, `/api/im/rooms/${room}/entries/${entry.seq}/recall`).expect(200)
    expect((await kit.object(entry.attachment!.objectId))!.deleted_at).not.toBeNull()
    expect((await mine(owner)).map((s) => s.id)).toContain(made.id)
    expect((await kit.object(stickerObject))!.deleted_at).toBeNull()
    await kit.file(owner, `/api/im/stickers/${made.id}/file`).expect(200)
    const theirs = await kit.send(bob, room, { kind: 'sticker', stickerId: made.id })
    expect([theirs.status, theirs.body.code]).toEqual([400, Err.STORAGE_REF_INVALID.code])
  })
})
