// 聊天文件、表情与清理三个规格共用的夹具：员工账号与令牌、建会话、上传与发送、临时改参数、按用户清理。
// 测试图片都由 sharp 当场生成，不提交二进制文件。
import { randomUUID } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import type { ImEntry } from '@qiwu/shared'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { ParamService } from '../../src/core/settings/param.service.js'
import { bearer } from '../setup/auth.js'
import { addUser, signInDirect } from '../setup/tenants.js'

export const MB = 1024 * 1024

/** 员工与其访问令牌。 */
export interface Person {
  id: number
  tenantId: number
  token: string
}

/** 二进制响应体（图片、文件）收成 Buffer；错误响应仍是 JSON 包络，照常解析。 */
export const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => {
      const body = Buffer.concat(chunks)
      const json = String(res.headers['content-type']).includes('json')
      cb(null, json ? JSON.parse(body.toString() || 'null') : body)
    })
  })

let shade = 0

/**
 * 一张测试图片：每次颜色不同（字节不同，不触发重复提交）；`noise` 生成难压缩的噪点；`frames` 生成多帧 GIF。
 */
export async function picture(
  width: number,
  height: number,
  opts: { noise?: boolean; frames?: number } = {},
): Promise<Buffer> {
  const n = ++shade
  const frames = opts.frames ?? 1
  const img = sharp({
    create: {
      width,
      height: height * frames,
      channels: 3,
      background: { r: (n * 37) % 256, g: (n * 91) % 256, b: (n * 53) % 256 },
      ...(opts.noise ? { noise: { type: 'gaussian' as const, mean: 128, sigma: 60 } } : {}),
      ...(frames > 1 ? { pageHeight: height } : {}),
    },
  })
  return (frames > 1 ? img.gif() : img.png()).toBuffer()
}

/** 一个最小但魔数正确的 PDF。 */
export const pdf = () => Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n%%EOF\n`)

/** 一个规格的聊天夹具：用它建的账号、会话与对象在 `dispose()` 时清掉（他租户的随租户回收）。 */
export function imKit(app: NestExpressApplication, prefix: string) {
  const ds = app.get<DataSource>(getDataSourceToken())
  const users: number[] = []
  const run = randomUUID().slice(0, 8)
  const http = () => request(app.getHttpServer())

  const kit = {
    ds,
    http,
    /** 本租户（默认租户 1）的一个启用员工。 */
    async person(name: string, tenantId = 1): Promise<Person> {
      const id = await addUser(app, tenantId, `${prefix}${run}-${name}`)
      if (tenantId === 1) users.push(id)
      return { id, tenantId, token: (await signInDirect(app, id))!.accessToken }
    },
    get: (p: Person, path: string) => http().get(path).set(bearer(p.token)),
    file: (p: Person, path: string) => binary(http().get(path).set(bearer(p.token))),
    post: (p: Person, path: string, body: object = {}) =>
      http().post(path).set(bearer(p.token)).send(body),
    put: (p: Person, path: string, body: object = {}) =>
      http().put(path).set(bearer(p.token)).send(body),
    del: (p: Person, path: string) => http().delete(path).set(bearer(p.token)),
    attach: (p: Person, path: string, data: Buffer, name: string) =>
      http().post(path).set(bearer(p.token)).attach('file', data, name),
    /** 私聊会话 id。 */
    async direct(a: Person, b: Person): Promise<number> {
      const res = await kit.post(a, '/api/im/rooms/directs', { peerId: b.id }).expect(201)
      return res.body.data.roomId as number
    },
    /** 群会话 id（`owner` 为群主）。 */
    async group(owner: Person, members: Person[], label = 'Files'): Promise<number> {
      const res = await kit
        .post(owner, '/api/im/rooms/groups', { label, userIds: members.map((m) => m.id) })
        .expect(201)
      return res.body.data.roomId as number
    },
    /** 上传一个图片或文件，返回对象 id。 */
    async upload(p: Person, roomId: number, data: Buffer, name: string): Promise<number> {
      const res = await kit.attach(p, `/api/im/rooms/${roomId}/uploads`, data, name).expect(201)
      return res.body.data.objectId as number
    },
    /** 发送一条消息（新的 clientEntryId），返回原始响应。 */
    send: (p: Person, roomId: number, body: object) =>
      kit.post(p, `/api/im/rooms/${roomId}/entries`, { clientEntryId: randomUUID(), ...body }),
    /** 上传并发送一张图片（扩展名须与内容一致，服务端按魔数核对），返回消息。 */
    async sendImage(p: Person, roomId: number, data?: Buffer, ext = 'png'): Promise<ImEntry> {
      const objectId = await kit.upload(
        p,
        roomId,
        data ?? (await picture(80, 60)),
        `${randomUUID()}.${ext}`,
      )
      return (await kit.send(p, roomId, { kind: 'image', objectId }).expect(201)).body
        .data as ImEntry
    },
    /** 发送一条文字，返回消息。 */
    async sendText(p: Person, roomId: number, text = 'hello'): Promise<ImEntry> {
      return (await kit.send(p, roomId, { kind: 'text', text }).expect(201)).body.data as ImEntry
    },
    /** 临时改一个参数（平台表），结束后改回原值。 */
    async withParam<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
      const params = app.get(ParamService)
      const [row] = await ds.query<{ param_value: string }[]>(
        'SELECT param_value FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
        [key],
      )
      const set = async (v: string | null) => {
        await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [v, key])
        await params.invalidate(key)
      }
      await set(value)
      try {
        return await fn()
      } finally {
        await set(row?.param_value ?? null)
      }
    },
    /** 一个对象行。 */
    async object(id: number) {
      const [row] = await ds.query<
        {
          id: number
          biz_tag: string
          biz_ref: string | null
          mime: string
          size: number
          uploader_id: number
          deleted_at: Date | null
        }[]
      >(
        'SELECT id, biz_tag, biz_ref, mime, size, uploader_id, deleted_at FROM fs_object WHERE id = ?',
        [id],
      )
      return row
    },
    /** 删掉本规格在默认租户建的会话、消息、表情、对象与账号。 */
    async dispose(): Promise<void> {
      if (!users.length) return
      const rooms = (
        await ds.query<{ room_id: number }[]>(
          'SELECT DISTINCT room_id FROM im_roster WHERE tenant_id = 1 AND user_id IN (?)',
          [users],
        )
      ).map((r) => Number(r.room_id))
      if (rooms.length) {
        await ds.query('DELETE FROM im_entry WHERE tenant_id = 1 AND room_id IN (?)', [rooms])
        await ds.query('DELETE FROM im_roster WHERE tenant_id = 1 AND room_id IN (?)', [rooms])
        await ds.query('DELETE FROM im_room WHERE tenant_id = 1 AND id IN (?)', [rooms])
      }
      await ds.query('DELETE FROM im_sticker WHERE tenant_id = 1 AND user_id IN (?)', [users])
      await ds.query('DELETE FROM fs_object WHERE tenant_id = 1 AND uploader_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    },
  }
  return kit
}

export type ImKit = ReturnType<typeof imKit>
