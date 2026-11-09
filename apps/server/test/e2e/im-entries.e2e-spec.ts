// 员工聊天的发送、编辑与撤回（see docs/im.md）：并发发送在会话锁内得到连续无洞的 seq；同一 clientEntryId
// 并发两次只得一行同一个 seq，同内容重发回原行当前状态、不同内容 409，查重在成员判断之后；文字的控制字符、
// 长度与表情码校验；向停用对象的私聊发送 404；按用户限流；编辑只限本人文字、时间窗与修订号；撤回按当前
// 角色与时间窗（moderator 只能撤回作者当前为普通成员的，系统事件行谁都不能撤回），已撤回再撤回不追加事件，
// 撤回软删附件对象；编辑/撤回事件不改会话时间；别的租户一律 404。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type ErrorDef, IM_STICKER_CODES, imParams } from '@qiwu/shared'
import sharp from 'sharp'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'im-entries-'

let app: NestExpressApplication
let ds: DataSource
let other: PeopledTenant
let rootId = 0
const made: number[] = []
const tokens = new Map<number, string>()
let n = 0

type Method = 'get' | 'post' | 'put' | 'delete'

async function person(name = 'u'): Promise<number> {
  const id = await addUser(app, 1, `${PREFIX}${name}-${++n}`)
  made.push(id)
  return id
}

async function tokenOf(userId: number): Promise<string> {
  if (!tokens.has(userId)) tokens.set(userId, (await signInDirect(app, userId))!.accessToken)
  return tokens.get(userId)!
}

/** 一次请求；`.expect(status)` 断言状态并返回响应（失败时带上响应体）。 */
function call(method: Method, path: string, userId: number, body?: object, token?: string) {
  const res = (async () => {
    const req = request(app.getHttpServer())
      [method](`/api/im${path}`)
      .set(bearer(token ?? (await tokenOf(userId))))
    return body === undefined ? req : req.send(body)
  })()
  return Object.assign(res, {
    expect: async (status: number) => {
      const r = await res
      expect({ status: r.status, body: r.body }).toMatchObject({ status })
      return r
    },
  })
}

function expectErr(res: request.Response, err: ErrorDef) {
  expect([res.status, res.body.code]).toEqual([err.status, err.code])
}

const cid = () => `c-${Date.now()}-${++n}`

/** 发一条文字，返回 seq。 */
async function say(roomId: number, userId: number, text = `hello ${++n}`): Promise<number> {
  const res = await call('post', `/rooms/${roomId}/entries`, userId, {
    clientEntryId: cid(),
    kind: 'text',
    text,
  })
  expect(res.status).toBe(201)
  return res.body.data.seq as number
}

async function group(ownerId: number, userIds: number[]): Promise<number> {
  const res = await call('post', '/rooms/groups', ownerId, { label: `g${++n}`, userIds })
  expect(res.status).toBe(201)
  return res.body.data.roomId as number
}

const setRole = (roomId: number, owner: number, userId: number, role: string) =>
  call('put', `/rooms/${roomId}/members/${userId}/role`, owner, { role })

/** 把第 seq 条的发送时刻往前挪（越过编辑/撤回时间窗）。 */
const age = (roomId: number, seq: number, minutes: number) =>
  ds.query(
    'UPDATE im_entry SET created_at = created_at - INTERVAL ? MINUTE WHERE room_id = ? AND seq = ?',
    [minutes, roomId, seq],
  )

const rows = (roomId: number) =>
  ds.query<
    {
      seq: number
      entry_kind: string
      target_seq: number | null
      event_data: { code: string } | null
    }[]
  >('SELECT seq, entry_kind, target_seq, event_data FROM im_entry WHERE room_id = ? ORDER BY seq', [
    roomId,
  ])

const roomRow = async (roomId: number) =>
  (
    await ds.query<{ last_seq: number; last_entry_at: Date | null }[]>(
      'SELECT last_seq, last_entry_at FROM im_room WHERE id = ?',
      [roomId],
    )
  )[0]!

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  other = await createTenant(app, { users: true })
  rootId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE tenant_id = 1 AND username = 'admin' AND deleted_at IS NULL",
      )
    )[0]!.id,
  )
  tokens.set(rootId, (await signIn(app)).accessToken)
})

beforeEach(async () => {
  const redis = app.get<Redis>(REDIS)
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 100 }))
    if (keys.length) await redis.unlink(keys)
})

afterAll(async () => {
  if (ds && made.length) {
    const rooms = (
      await ds.query<{ room_id: number }[]>(
        'SELECT DISTINCT room_id FROM im_roster WHERE user_id IN (?)',
        [made],
      )
    ).map((r) => r.room_id)
    if (rooms.length) {
      await ds.query('DELETE FROM im_entry WHERE room_id IN (?)', [rooms])
      await ds.query('DELETE FROM im_roster WHERE room_id IN (?)', [rooms])
      await ds.query('DELETE FROM im_room WHERE id IN (?)', [rooms])
    }
    await ds.query('DELETE FROM fs_object WHERE uploader_id IN (?)', [made])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [made])
  }
  await other?.dispose()
  await app?.close()
})

describe('sending', () => {
  it('20 concurrent sends all succeed with contiguous seqs; the 21st within the window is limited for that user only', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const sent = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        call('post', `/rooms/${roomId}/entries`, p, {
          clientEntryId: `burst-${roomId}-${i}`,
          kind: 'text',
          text: `burst ${i}`,
        }),
      ),
    )
    expect(sent.map((r) => r.status)).toEqual(Array(20).fill(201))
    const seqs = sent.map((r) => r.body.data.seq as number).sort((a, b) => a - b)
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
    expect((await rows(roomId)).map((r) => Number(r.seq))).toEqual(
      Array.from({ length: 21 }, (_, i) => i + 1),
    )
    expect(Number((await roomRow(roomId)).last_seq)).toBe(21)
    // 同一用户第 21 次 429；同一 IP 的另一个用户不受影响
    expectErr(
      await call('post', `/rooms/${roomId}/entries`, p, {
        clientEntryId: cid(),
        kind: 'text',
        text: 'x',
      }),
      Err.TOO_MANY_REQUESTS,
    )
    expect(await say(roomId, o)).toBe(22)
  })

  it('the same clientEntryId sent twice at once (two devices) gives one row and one seq', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const t1 = (await signInDirect(app, p))!.accessToken
    const t2 = (await signInDirect(app, p))!.accessToken
    const body = { clientEntryId: `twice-${roomId}`, kind: 'text', text: 'once' }
    const [a, b] = await Promise.all([
      call('post', `/rooms/${roomId}/entries`, p, body, t1),
      call('post', `/rooms/${roomId}/entries`, p, body, t2),
    ])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.body.data.seq).toBe(b.body.data.seq)
    const found = await ds.query(
      'SELECT id FROM im_entry WHERE room_id = ? AND client_entry_id = ?',
      [roomId, body.clientEntryId],
    )
    expect(found).toHaveLength(1)
    expect(Number((await roomRow(roomId)).last_seq)).toBe(2)
  })

  it('a resend returns the current state of the original; other content under the same id is a conflict', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const id = cid()
    const first = await call('post', `/rooms/${roomId}/entries`, p, {
      clientEntryId: id,
      kind: 'text',
      text: 'v1',
    })
    expect(first.status).toBe(201)
    expect(first.body.data).toMatchObject({ clientEntryId: id, text: 'v1', rev: 1, authorId: p })
    const seq = first.body.data.seq as number
    await call('put', `/rooms/${roomId}/entries/${seq}`, p, { text: 'v2', rev: 1 }).expect(200)
    // 另一台设备（另一个会话）重发：原行当前状态，不新增
    const t2 = (await signInDirect(app, p))!.accessToken
    const again = await call(
      'post',
      `/rooms/${roomId}/entries`,
      p,
      { clientEntryId: id, kind: 'text', text: 'v1' },
      t2,
    )
    expect(again.status).toBe(201)
    expect(again.body.data).toMatchObject({ seq, text: 'v2', rev: 2 })
    expectErr(
      await call(
        'post',
        `/rooms/${roomId}/entries`,
        p,
        { clientEntryId: id, kind: 'text', text: 'other' },
        t2,
      ),
      Err.IM_CLIENT_ID_CONFLICT,
    )
    // 别人看到的行不带作者的 clientEntryId
    const seen = (await call('get', `/rooms/${roomId}/entries?seqs=${seq}`, o)).body.data.items[0]
    expect(seen.clientEntryId).toBeNull()
    // 非成员拿别人的 id：404，不是重放
    const x = await person('x')
    expectErr(
      await call('post', `/rooms/${roomId}/entries`, x, {
        clientEntryId: id,
        kind: 'text',
        text: 'v1',
      }),
      Err.IM_ROOM_NOT_FOUND,
    )
    // 退群之后用自己用过的 id 重发：同样 404（查重在成员判断之后）
    await call('post', `/rooms/${roomId}/leave`, p).expect(200)
    const t3 = (await signInDirect(app, p))!.accessToken
    expectErr(
      await call(
        'post',
        `/rooms/${roomId}/entries`,
        p,
        { clientEntryId: id, kind: 'text', text: 'v1' },
        t3,
      ),
      Err.IM_ROOM_NOT_FOUND,
    )
  })

  it('refuses control characters, over-long text, unknown sticker codes and mixed bodies (400)', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    await setParam(imParams.textMaxChars, '10')
    try {
      for (const body of [
        { kind: 'text', text: 'a\u0000b' },
        { kind: 'text', text: 'a\u0007b' },
        { kind: 'text', text: 'a\u009bb' },
        { kind: 'text', text: '   ' },
        { kind: 'text', text: '12345678901' },
        { kind: 'text' },
        { kind: 'text', text: 'x', objectId: 1 },
        { kind: 'sticker', stickerCode: 'no-such-sticker' },
        { kind: 'sticker' },
        { kind: 'sticker', stickerCode: IM_STICKER_CODES[0], stickerId: 1 },
        { kind: 'image' },
        { kind: 'event', text: 'x' },
        { kind: 'text', text: 'x', extra: true },
      ])
        expect([
          body,
          (await call('post', `/rooms/${roomId}/entries`, p, { clientEntryId: cid(), ...body }))
            .status,
        ]).toEqual([body, 400])
      for (const clientEntryId of ['', 'has space', 'x'.repeat(65)])
        expect(
          (
            await call('post', `/rooms/${roomId}/entries`, p, {
              clientEntryId,
              kind: 'text',
              text: 'x',
            })
          ).status,
        ).toBe(400)
      // 换行与制表符可以；emoji 按码点计（10 个代理对 = 10）
      expect(await say(roomId, p, 'a\n\tb')).toBeGreaterThan(1)
      expect(await say(roomId, p, '😀'.repeat(10))).toBeGreaterThan(1)
    } finally {
      await setParam(imParams.textMaxChars, '5000')
    }
    const sticker = await call('post', `/rooms/${roomId}/entries`, p, {
      clientEntryId: cid(),
      kind: 'sticker',
      stickerCode: IM_STICKER_CODES[0],
    })
    expect(sticker.status).toBe(201)
    expect(sticker.body.data).toMatchObject({
      kind: 'sticker',
      stickerCode: IM_STICKER_CODES[0],
      text: null,
    })
  })

  it('a direct conversation whose peer was disabled takes no more messages', async () => {
    const a = await person('a')
    const b = await person('b')
    const roomId = (await call('post', '/rooms/directs', a, { peerId: b })).body.data.roomId
    await say(roomId, a)
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [b])
    expectErr(
      await call('post', `/rooms/${roomId}/entries`, a, {
        clientEntryId: cid(),
        kind: 'text',
        text: 'x',
      }),
      Err.IM_USER_UNAVAILABLE,
    )
    // 历史照常可读
    expect((await call('get', `/rooms/${roomId}/entries`, a)).body.data.items).toHaveLength(1)
  })

  it('a member identity gets 403', async () => {
    const o = await person('o')
    const roomId = await group(o, [await person('p')])
    const member = await person('member')
    await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [member])
    for (const [method, path, body] of [
      ['get', '/entries', undefined],
      ['post', '/entries', { clientEntryId: cid(), kind: 'text', text: 'x' }],
      ['put', '/entries/1', { text: 'x', rev: 1 }],
      ['post', '/entries/1/recall', undefined],
    ] as const)
      expectErr(await call(method, `/rooms/${roomId}${path}`, member, body), Err.IM_STAFF_ONLY)
  })
})

describe('editing', () => {
  it('only the own text, within the window, at the current rev; never an event or a recalled row', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const seq = await say(roomId, p, 'draft')
    const before = await roomRow(roomId)
    const edited = await call('put', `/rooms/${roomId}/entries/${seq}`, p, {
      text: 'final',
      rev: 1,
    })
    expect(edited.status).toBe(200)
    expect(edited.body.data).toMatchObject({ seq, text: 'final', rev: 2 })
    expect(edited.body.data.editedAt).not.toBeNull()
    const last = (await rows(roomId)).at(-1)!
    expect([last.entry_kind, Number(last.target_seq), last.event_data?.code]).toEqual([
      'event',
      seq,
      'entry.edit',
    ])
    // 编辑事件不改会话时间
    expect((await roomRow(roomId)).last_entry_at).toEqual(before.last_entry_at)
    expectErr(
      await call('put', `/rooms/${roomId}/entries/${seq}`, p, { text: 'again', rev: 1 }),
      Err.IM_REV_CONFLICT,
    )
    expectErr(
      await call('put', `/rooms/${roomId}/entries/${seq}`, o, { text: 'theirs', rev: 2 }),
      Err.IM_EDIT_DENIED,
    )
    expectErr(
      await call('put', `/rooms/${roomId}/entries/1`, o, { text: 'event', rev: 1 }),
      Err.IM_EDIT_DENIED,
    )
    const sticker = (
      await call('post', `/rooms/${roomId}/entries`, p, {
        clientEntryId: cid(),
        kind: 'sticker',
        stickerCode: IM_STICKER_CODES[1],
      })
    ).body.data.seq
    expectErr(
      await call('put', `/rooms/${roomId}/entries/${sticker}`, p, { text: 'x', rev: 1 }),
      Err.IM_EDIT_DENIED,
    )
    const old = await say(roomId, p, 'old')
    await age(roomId, old, 6)
    expectErr(
      await call('put', `/rooms/${roomId}/entries/${old}`, p, { text: 'late', rev: 1 }),
      Err.IM_EDIT_DENIED,
    )
    const gone = await say(roomId, p, 'gone')
    await call('post', `/rooms/${roomId}/entries/${gone}/recall`, p).expect(200)
    expectErr(
      await call('put', `/rooms/${roomId}/entries/${gone}`, p, { text: 'back', rev: 1 }),
      Err.IM_EDIT_DENIED,
    )
    await setParam(imParams.editMinutes, '0')
    try {
      const fresh = await say(roomId, p, 'fresh')
      expectErr(
        await call('put', `/rooms/${roomId}/entries/${fresh}`, p, { text: 'no', rev: 1 }),
        Err.IM_EDIT_DENIED,
      )
    } finally {
      await setParam(imParams.editMinutes, '5')
    }
    expectErr(
      await call('put', `/rooms/${roomId}/entries/9999`, p, { text: 'x', rev: 1 }),
      Err.IM_ENTRY_NOT_FOUND,
    )
    for (const body of [
      { text: 'x' },
      { text: '', rev: 1 },
      { text: 'a\u0001', rev: 1 },
      { text: 'x', rev: 0 },
    ])
      expect((await call('put', `/rooms/${roomId}/entries/${seq}`, p, body)).status).toBe(400)
  })
})

describe('recalling', () => {
  it('own messages within the recall window only, owners and moderators included', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const mine = await say(roomId, p)
    const before = await roomRow(roomId)
    const res = await call('post', `/rooms/${roomId}/entries/${mine}/recall`, p)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ seq: mine, text: null, recalledBy: p })
    expect(res.body.data.recalledAt).not.toBeNull()
    expect((await roomRow(roomId)).last_entry_at).toEqual(before.last_entry_at)
    const last = (await rows(roomId)).at(-1)!
    expect([Number(last.target_seq), last.event_data?.code]).toEqual([mine, 'entry.recall'])
    const late = await say(roomId, p)
    await age(roomId, late, 3)
    expectErr(
      await call('post', `/rooms/${roomId}/entries/${late}/recall`, p),
      Err.IM_RECALL_DENIED,
    )
    const ownerLate = await say(roomId, o)
    await age(roomId, ownerLate, 3)
    expectErr(
      await call('post', `/rooms/${roomId}/entries/${ownerLate}/recall`, o),
      Err.IM_RECALL_DENIED,
    )
    await setParam(imParams.recallMinutes, '0')
    try {
      const fresh = await say(roomId, p)
      expectErr(
        await call('post', `/rooms/${roomId}/entries/${fresh}/recall`, p),
        Err.IM_RECALL_DENIED,
      )
    } finally {
      await setParam(imParams.recallMinutes, '2')
    }
  })

  it('in a group: owner any, moderator only current participants, participants nobody else', async () => {
    const o = await person('o')
    const m = await person('m')
    const m2 = await person('m2')
    const p1 = await person('p1')
    const p2 = await person('p2')
    const roomId = await group(o, [m, m2, p1, p2])
    await setRole(roomId, o, m, 'moderator').expect(200)
    await setRole(roomId, o, m2, 'moderator').expect(200)
    const recall = (seq: number, by: number) =>
      call('post', `/rooms/${roomId}/entries/${seq}/recall`, by)

    const byP1 = await say(roomId, p1)
    await age(roomId, byP1, 60)
    expectErr(await recall(byP1, p2), Err.IM_ROLE_REQUIRED)
    // 不限时（默认）：owner 撤回一小时前的成员消息
    expect((await recall(byP1, o)).status).toBe(200)

    const byP2 = await say(roomId, p2)
    expect((await recall(byP2, m)).status).toBe(200)

    const byOwner = await say(roomId, o)
    expectErr(await recall(byOwner, m), Err.IM_ROLE_REQUIRED)
    const byM2 = await say(roomId, m2)
    expectErr(await recall(byM2, m), Err.IM_ROLE_REQUIRED)
    expect((await recall(byM2, o)).status).toBe(200)

    // 作者被降级：按当前角色，moderator 可以撤回
    const demoted = await say(roomId, m2)
    await setRole(roomId, o, m2, 'participant').expect(200)
    expect((await recall(demoted, m)).status).toBe(200)

    // 作者已退群：算 participant
    const leaver = await say(roomId, p2)
    await call('post', `/rooms/${roomId}/leave`, p2).expect(200)
    expect((await recall(leaver, m)).status).toBe(200)

    // 作者账号停用：算 participant
    await setRole(roomId, o, m2, 'moderator').expect(200)
    const disabledAuthor = await say(roomId, m2)
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [m2])
    expect((await recall(disabledAuthor, m)).status).toBe(200)
    await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ?', [m2])

    // 已撤回再撤回：200 原状态，不追加事件
    const count = (await rows(roomId)).length
    const again = await recall(byP1, o)
    expect(again.status).toBe(200)
    expect(again.body.data).toMatchObject({ seq: byP1, recalledBy: o, text: null })
    expect((await rows(roomId)).length).toBe(count)
  })

  it('with group recall limited, recalling others follows the recall window too', async () => {
    const o = await person('o')
    const m = await person('m')
    const p = await person('p')
    const roomId = await group(o, [m, p])
    await setRole(roomId, o, m, 'moderator').expect(200)
    await setParam(imParams.groupRecallAnytime, 'false')
    try {
      const fresh = await say(roomId, p)
      expect((await call('post', `/rooms/${roomId}/entries/${fresh}/recall`, m)).status).toBe(200)
      const old = await say(roomId, p)
      await age(roomId, old, 3)
      expectErr(
        await call('post', `/rooms/${roomId}/entries/${old}/recall`, o),
        Err.IM_RECALL_DENIED,
      )
      expectErr(
        await call('post', `/rooms/${roomId}/entries/${old}/recall`, m),
        Err.IM_RECALL_DENIED,
      )
    } finally {
      await setParam(imParams.groupRecallAnytime, 'true')
    }
  })

  it('system event rows cannot be recalled by anyone, owner and root included; direct peers cannot recall each other', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const added = await call('post', `/rooms/${roomId}/members`, o, { userIds: [rootId] }).expect(
      200,
    )
    // root 从加入事件起可见：拿它自己的加入事件试
    const joined = added.body.data.lastSeq as number
    expectErr(await call('post', `/rooms/${roomId}/entries/1/recall`, o), Err.IM_RECALL_DENIED)
    expectErr(
      await call('post', `/rooms/${roomId}/entries/${joined}/recall`, o),
      Err.IM_RECALL_DENIED,
    )
    expectErr(
      await call('post', `/rooms/${roomId}/entries/${joined}/recall`, rootId),
      Err.IM_RECALL_DENIED,
    )
    expectErr(
      await call('put', `/rooms/${roomId}/entries/${joined}`, rootId, { text: 'x', rev: 1 }),
      Err.IM_EDIT_DENIED,
    )
    await call('post', `/rooms/${roomId}/leave`, rootId).expect(200)

    const direct = (await call('post', '/rooms/directs', o, { peerId: p })).body.data.roomId
    const theirs = await say(direct, p)
    expectErr(
      await call('post', `/rooms/${direct}/entries/${theirs}/recall`, o),
      Err.IM_ROLE_REQUIRED,
    )
    expectErr(await call('post', `/rooms/${direct}/entries/9999/recall`, o), Err.IM_ENTRY_NOT_FOUND)
  })

  it('recalling clears the attachment and soft-deletes its objects', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const png = await sharp({
      create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .png()
      .toBuffer()
    const up = await request(app.getHttpServer())
      .post(`/api/im/rooms/${roomId}/uploads`)
      .set(bearer(await tokenOf(p)))
      .attach('file', png, 'photo.png')
    expect(up.status).toBe(201)
    const sent = await call('post', `/rooms/${roomId}/entries`, p, {
      clientEntryId: cid(),
      kind: 'image',
      objectId: up.body.data.objectId,
    })
    expect(sent.status).toBe(201)
    const att = sent.body.data.attachment as { objectId: number; thumbObjectId?: number }
    const ids = [att.objectId, ...(att.thumbObjectId ? [att.thumbObjectId] : [])]
    const alive = async () =>
      (
        await ds.query<{ id: number }[]>(
          'SELECT id FROM fs_object WHERE id IN (?) AND deleted_at IS NULL',
          [ids],
        )
      ).length
    expect(await alive()).toBe(ids.length)
    const res = await call('post', `/rooms/${roomId}/entries/${sent.body.data.seq}/recall`, o)
    expect(res.status).toBe(200)
    expect(res.body.data.attachment).toBeNull()
    expect(await alive()).toBe(0)
    expectErr(
      await call('get', `/rooms/${roomId}/entries/${sent.body.data.seq}/file`, p),
      Err.IM_ENTRY_NOT_FOUND,
    )
  })
})

it('another tenant gets 404 on every entry route', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  const seq = await say(roomId, p)
  const theirs = (await signInDirect(app, other.users.alice))!.accessToken
  for (const [method, path, body] of [
    ['get', '/entries', undefined],
    ['post', '/entries', { clientEntryId: cid(), kind: 'text', text: 'x' }],
    ['put', `/entries/${seq}`, { text: 'x', rev: 1 }],
    ['post', `/entries/${seq}/recall`, undefined],
    ['get', `/entries/${seq}/file`, undefined],
  ] as const)
    expectErr(await call(method, `/rooms/${roomId}${path}`, 0, body, theirs), Err.IM_ROOM_NOT_FOUND)
  const up = await request(app.getHttpServer())
    .post(`/api/im/rooms/${roomId}/uploads`)
    .set(bearer(theirs))
    .attach('file', Buffer.from('hello'), 'note.txt')
  expectErr(up, Err.IM_ROOM_NOT_FOUND)
  expect((await rows(roomId)).length).toBe(2)
})
