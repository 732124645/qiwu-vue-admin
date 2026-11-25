// 员工聊天的同步、读位置与可见区间（see docs/im.md）：全量元组随发送、读、退群、再加入、清理与改名变化
// （消失、periodId、floorSeq、metaRev），带 If-None-Match 得 304；`?ids=` 只回本人当前会话，未读不计本人、
// 事件与撤回且封顶 100，预览跳过编辑/撤回事件；读位置只增且不超过 lastSeq；`afterSeq/beforeSeq/seqs` 都夹在
// 可见区间里；`im:entry`/`im:room` 提示在提交之后发出、只有编号；别的租户的行一律不进同步与未读。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  Err,
  type ErrorDef,
  IM_LIMITS,
  imParams,
  type ImRoomDetail,
  type ImSync,
  type RealtimeMessage,
  RT,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { bearer } from '../setup/auth.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'im-sync-'

let app: NestExpressApplication
let ds: DataSource
let other: PeopledTenant
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
function call(method: Method, path: string, userId: number, body?: object) {
  const res = (async () => {
    const req = request(app.getHttpServer())
      [method](`/api/im${path}`)
      .set(bearer(await tokenOf(userId)))
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

const cid = () => `s-${Date.now()}-${++n}`

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

const full = async (userId: number) => (await call('get', '/sync', userId)).body.data as ImSync
const tupleOf = async (userId: number, roomId: number) =>
  (await full(userId)).rooms.find((t) => t[0] === roomId)
const details = async (userId: number, ids: number[]) =>
  (await call('get', `/sync?ids=${ids.join(',')}`, userId)).body.data as ImRoomDetail[]
const detailOf = async (userId: number, roomId: number) => (await details(userId, [roomId]))[0]!

/**
 * 直接写入别人发的 count 条文字（越过限流，未读封顶用）。默认接在本租户会话末尾并推进 last_seq；给了
 * `tenantId` 与 `from` 时只在那个租户写同号的行（伪造的别的租户数据），不动会话。
 */
async function bulk(
  roomId: number,
  authorId: number,
  count: number,
  foreign?: { tenantId: number; from: number; text?: string },
) {
  const [room] = await ds.query<{ last_seq: number }[]>(
    'SELECT last_seq FROM im_room WHERE id = ?',
    [roomId],
  )
  const from = foreign?.from ?? Number(room!.last_seq) + 1
  const values = Array.from({ length: count }, (_, i) => [
    foreign?.tenantId ?? 1,
    roomId,
    from + i,
    authorId,
    'admin',
    'bulk',
    'text',
    foreign?.text ?? `bulk ${i}`,
  ])
  await ds.query(
    'INSERT INTO im_entry (tenant_id, room_id, seq, author_id, author_kind, author_label, entry_kind, text_value) VALUES ?',
    [values],
  )
  if (!foreign)
    await ds.query('UPDATE im_room SET last_seq = ? WHERE id = ?', [from + count - 1, roomId])
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  // 参数缓存比测试库活得久：库重建后 epoch 是新值，缓存里的旧值要先清掉
  const redis = app.get<Redis>(REDIS)
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('param'), COUNT: 100 }))
    if (keys.length) await redis.unlink(keys)
  other = await createTenant(app, { users: true })
})

beforeEach(async () => {
  const redis = app.get<Redis>(REDIS)
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 100 }))
    if (keys.length) await redis.unlink(keys)
})

afterEach(() => vi.restoreAllMocks())

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
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [made])
  }
  await other?.dispose()
  await app?.close()
})

it('options: the limits and the epoch', async () => {
  const me = await person()
  const res = await call('get', '/options', me)
  expect(res.status).toBe(200)
  const [epoch] = await ds.query<{ v: string }[]>(
    'SELECT param_value AS v FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
    [imParams.epoch],
  )
  expect(res.body.data).toMatchObject({
    textMaxChars: 5000,
    recallMinutes: 2,
    editMinutes: 5,
    groupRecallAnytime: true,
    groupMaxMembers: 200,
    stickerMax: IM_LIMITS.stickerMax,
    epoch: epoch!.v,
  })
})

it('tuples follow sends, reads, leaving, rejoining, purging and renaming', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  const start = await tupleOf(p, roomId)
  expect(start).toEqual([roomId, expect.any(Number), 1, 0, 1, 1])
  const period = start![1]
  // 元组按 roomId 升序
  const second = await group(o, [p])
  const ids = (await full(p)).rooms.map((t) => t[0])
  expect(ids).toEqual([...ids].sort((a, b) => a - b))
  expect(ids).toEqual(expect.arrayContaining([roomId, second]))

  const s = await say(roomId, o)
  expect((await tupleOf(p, roomId))!.slice(2)).toEqual([s, 0, 1, 1])
  await call('put', `/rooms/${roomId}/read`, p, { seq: s }).expect(200)
  expect((await tupleOf(p, roomId))![3]).toBe(s)
  await call('put', `/rooms/${roomId}/label`, o, { label: 'renamed' }).expect(200)
  expect((await tupleOf(p, roomId))![5]).toBe(2)

  await call('post', `/rooms/${roomId}/leave`, p).expect(200)
  expect(await tupleOf(p, roomId)).toBeUndefined()
  await call('post', `/rooms/${roomId}/members`, o, { userIds: [p] }).expect(200)
  const back = await tupleOf(p, roomId)
  expect(back![1]).not.toBe(period)

  // 清理推进 floor_seq（清理任务的效果）
  await ds.query('DELETE FROM im_entry WHERE room_id = ? AND seq < 3', [roomId])
  await ds.query('UPDATE im_room SET floor_seq = 3 WHERE id = ?', [roomId])
  expect((await tupleOf(o, roomId))![4]).toBe(3)
})

it('the full sync answers 304 to its ETag until something changes', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  const token = await tokenOf(p)
  const get = (etag?: string) => {
    const req = request(app.getHttpServer()).get('/api/im/sync').set(bearer(token))
    return etag ? req.set('If-None-Match', etag) : req
  }
  const first = await get()
  expect(first.headers['cache-control']).toBe('private, no-cache')
  const etag = first.headers.etag as string
  expect(etag).toBeTruthy()
  expect((await get(etag)).status).toBe(304)
  await say(roomId, o)
  const changed = await get(etag)
  expect(changed.status).toBe(200)
  expect(changed.headers.etag).not.toBe(etag)
})

it('details only for the own current rooms', async () => {
  const o = await person('o')
  const p = await person('p')
  const x = await person('x')
  const mine = await group(o, [p])
  const left = await group(o, [p])
  const notMine = await group(o, [x])
  await call('post', `/rooms/${left}/leave`, p).expect(200)
  const theirs = await group(o, [x])
  const list = await details(p, [notMine, left, mine, theirs, 999_999_999])
  expect(list.map((d) => d.roomId)).toEqual([mine])
  expect(list[0]).toMatchObject({
    roomId: mine,
    kind: 'group',
    role: 'participant',
    memberCount: 2,
    visibleFromSeq: 1,
    lastSeq: 1,
    readSeq: 0,
    floorSeq: 1,
    metaRev: 1,
    closedAt: null,
    unread: 0,
    preview: { seq: 1, kind: 'event', eventCode: 'room.create', text: null, authorId: null },
  })
  const direct = (await call('post', '/rooms/directs', o, { peerId: p })).body.data.roomId
  expect(await detailOf(p, direct)).toMatchObject({
    kind: 'direct',
    peerId: o,
    label: null,
    preview: null,
  })
})

it('unread counts others’ messages after the read position only, without events or recalled ones, capped at 100', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  await say(roomId, p) // 自己的不计
  const a = await say(roomId, o)
  const b = await say(roomId, o)
  await call('put', `/rooms/${roomId}/label`, o, { label: 'event' }).expect(200) // 事件不计
  await call('post', `/rooms/${roomId}/entries/${b}/recall`, o).expect(200) // 撤回的不计
  expect((await detailOf(p, roomId)).unread).toBe(1)
  await call('put', `/rooms/${roomId}/read`, p, { seq: a }).expect(200)
  expect((await detailOf(p, roomId)).unread).toBe(0)
  await bulk(roomId, o, IM_LIMITS.unreadCap + 5)
  expect((await detailOf(p, roomId)).unread).toBe(IM_LIMITS.unreadCap)
})

it('the preview skips edit and recall events, has no text for a recalled row and cuts text to 60 characters', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  const long = '😀'.repeat(70)
  const s = await say(roomId, o, long)
  let preview = (await detailOf(p, roomId)).preview!
  expect(preview).toMatchObject({
    seq: s,
    kind: 'text',
    authorId: o,
    recalled: false,
    eventCode: null,
  })
  expect([...preview.text!]).toHaveLength(IM_LIMITS.previewChars)
  await call('put', `/rooms/${roomId}/entries/${s}`, o, { text: 'edited', rev: 1 }).expect(200)
  preview = (await detailOf(p, roomId)).preview!
  expect(preview).toMatchObject({ seq: s, text: 'edited' })
  await call('post', `/rooms/${roomId}/entries/${s}/recall`, o).expect(200)
  preview = (await detailOf(p, roomId)).preview!
  expect(preview).toMatchObject({ seq: s, text: null, recalled: true })
  const detail = await detailOf(p, roomId)
  expect(detail.lastSeq).toBe(s + 2)
  await call('put', `/rooms/${roomId}/label`, o, { label: 'next' }).expect(200)
  expect((await detailOf(p, roomId)).preview).toMatchObject({
    kind: 'event',
    eventCode: 'room.rename',
    text: null,
  })
})

it('the read position only moves forward and never past the last seq', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  for (let i = 0; i < 11; i++) await say(roomId, o)
  expect((await call('put', `/rooms/${roomId}/read`, p, { seq: 10 })).body.data).toEqual({
    readSeq: 10,
  })
  expect((await call('put', `/rooms/${roomId}/read`, p, { seq: 5 })).body.data).toEqual({
    readSeq: 10,
  })
  expect((await call('put', `/rooms/${roomId}/read`, p, { seq: 9999 })).body.data).toEqual({
    readSeq: 12,
  })
  expect((await tupleOf(p, roomId))![3]).toBe(12)
  for (const body of [{ seq: -1 }, { seq: 'x' }, {}, { seq: 1, extra: 1 }])
    expect((await call('put', `/rooms/${roomId}/read`, p, body)).status).toBe(400)
})

it('entry lists keep to the visible range: from joining and from the purge floor', async () => {
  const o = await person('o')
  const p = await person('p')
  const roomId = await group(o, [p])
  for (let i = 0; i < 4; i++) await say(roomId, o) // 2..5
  await call('post', `/rooms/${roomId}/leave`, p).expect(200) // 6
  await say(roomId, o) // 7：离开期间
  await call('post', `/rooms/${roomId}/members`, o, { userIds: [p] }).expect(200) // 8
  for (let i = 0; i < 3; i++) await say(roomId, o) // 9..11
  const list = async (q: string) => (await call('get', `/rooms/${roomId}/entries${q}`, p)).body.data
  const seqs = (body: { items: { seq: number }[] }) => body.items.map((e) => e.seq)

  const page = await list('')
  expect([seqs(page), page.hasMore, page.visibleFromSeq, page.lastSeq]).toEqual([
    [8, 9, 10, 11],
    false,
    8,
    11,
  ])
  expect(seqs(await list('?afterSeq=0'))).toEqual([8, 9, 10, 11])
  const after = await list('?afterSeq=8&limit=2')
  expect([seqs(after), after.hasMore]).toEqual([[9, 10], true])
  const before = await list('?beforeSeq=11&limit=2')
  expect([seqs(before), before.hasMore]).toEqual([[9, 10], true])
  expect(seqs(await list('?beforeSeq=9'))).toEqual([8])
  expect(seqs(await list('?beforeSeq=8'))).toEqual([])
  expect(seqs(await list('?seqs=1,5,7,8,11,99'))).toEqual([8, 11])
  expectErr(await call('get', `/rooms/${roomId}/entries/7/file`, p), Err.IM_ENTRY_NOT_FOUND)
  // 群主从 1 可见；清理把下界推到 10 之后两人都从 10 起
  expect(
    seqs(await call('get', `/rooms/${roomId}/entries?seqs=1,7`, o).then((r) => r.body.data)),
  ).toEqual([1, 7])
  await ds.query('UPDATE im_room SET floor_seq = 10 WHERE id = ?', [roomId])
  expect(
    seqs(await call('get', `/rooms/${roomId}/entries?afterSeq=0`, o).then((r) => r.body.data)),
  ).toEqual([10, 11])
  expect(seqs(await list('?seqs=8,9,10'))).toEqual([10])
  expect(seqs(await list('?beforeSeq=11'))).toEqual([10])
  for (const q of [
    '?afterSeq=1&beforeSeq=5',
    '?seqs=a',
    '?limit=0',
    '?limit=101',
    '?afterSeq=-1',
    '?x=1',
  ])
    expect((await call('get', `/rooms/${roomId}/entries${q}`, p)).status).toBe(400)
})

it('hints go out after the commit, carry only ids and reach the right people', async () => {
  const o = await person('o')
  const p = await person('p')
  const q = await person('q')
  const roomId = await group(o, [p, q])
  const rt = app.get(RealtimeService)
  const sent: { to: number[]; msg: RealtimeMessage; visible: Promise<number> }[] = []
  const seen = (msg: RealtimeMessage) => {
    const payload = msg.payload as { roomId: number; seq?: number }
    // 提示发出的那一刻，另一条连接已经能读到那一行：说明在提交之后
    return payload.seq === undefined
      ? Promise.resolve(1)
      : ds
          .query('SELECT id FROM im_entry WHERE room_id = ? AND seq = ?', [
            payload.roomId,
            payload.seq,
          ])
          .then((r: unknown[]) => r.length)
  }
  vi.spyOn(rt, 'toUsers').mockImplementation((to, msg) => {
    sent.push({ to: [...to], msg, visible: seen(msg) })
  })
  vi.spyOn(rt, 'toUser').mockImplementation((to, msg) => {
    sent.push({ to: [to], msg, visible: seen(msg) })
  })

  const s = await say(roomId, p, 'secret words')
  await call('put', `/rooms/${roomId}/read`, q, { seq: s }).expect(200)
  await call('put', `/rooms/${roomId}/label`, o, { label: 'hinted' }).expect(200)
  await call('delete', `/rooms/${roomId}/members/${q}`, o).expect(200)

  for (const h of sent) expect(await h.visible).toBe(1)
  expect(JSON.stringify(sent.map((h) => h.msg))).not.toContain('secret')
  const byType = (type: string) => sent.filter((h) => h.msg.type === type)
  const entries = byType(RT.imEntry)
  expect(entries[0]).toMatchObject({
    msg: { payload: { roomId, seq: s, authorId: p, kind: 'text' } },
  })
  for (const h of entries)
    expect(Object.keys(h.msg.payload as object).sort()).toEqual([
      'authorId',
      'kind',
      'roomId',
      'seq',
    ])
  expect(entries[0]!.to.sort()).toEqual([o, p, q].sort())
  const rooms = byType(RT.imRoom)
  // 读位置只发本人且带 readSeq
  expect(rooms[0]).toEqual(
    expect.objectContaining({ to: [q], msg: { type: RT.imRoom, payload: { roomId, readSeq: s } } }),
  )
  // 改名：全体成员；移人：被移除者也收到
  expect(rooms[1]!.msg.payload).toEqual({ roomId })
  expect(rooms[1]!.to.sort()).toEqual([o, p, q].sort())
  expect(rooms[2]!.to.sort()).toEqual([o, p, q].sort())
  expect(entries.at(-1)!.to.sort()).toEqual([o, p].sort())
  expect(entries.at(-1)!.msg.payload).toMatchObject({ kind: 'event', authorId: null })
})

it("another tenant's rows never reach the sync or the unread count", async () => {
  const me = await person('me')
  const peer = await person('peer')
  const roomId = await group(peer, [me])
  const notMine = await group(peer, [await person('x')])
  // 别的租户的会话
  const { insertId: foreign } = await ds.query<{ insertId: number }>(
    "INSERT INTO im_room (tenant_id, room_kind, label, last_seq) VALUES (?, 'group', 'foreign', 1)",
    [other.id],
  )
  // 伪造：别的租户的成员行指向本租户的会话；本租户的成员行指向别的租户的会话
  await ds.query(
    "INSERT INTO im_roster (tenant_id, room_id, user_id, role_code, member_label, visible_from_seq) VALUES (?, ?, ?, 'participant', 'x', 1)",
    [other.id, notMine, me],
  )
  await ds.query(
    "INSERT INTO im_roster (tenant_id, room_id, user_id, role_code, member_label, visible_from_seq) VALUES (1, ?, ?, 'participant', 'x', 1)",
    [foreign, me],
  )
  // 本会话：第 2 条是对方的消息，第 3 条是它的编辑事件（预览跳过）；别的租户里同号的两行与成员行——
  // 第 3 条是那边唯一能当预览的行，漏了租户条件预览就会变成它
  const said = await say(roomId, peer)
  await call('put', `/rooms/${roomId}/entries/${said}`, peer, { text: 'edited', rev: 1 }).expect(
    200,
  )
  await bulk(roomId, other.users.alice, 2, { tenantId: other.id, from: said, text: 'foreign' })
  await ds.query(
    "INSERT INTO im_roster (tenant_id, room_id, user_id, role_code, member_label, visible_from_seq) VALUES (?, ?, ?, 'participant', 'x', 1)",
    [other.id, roomId, other.users.alice],
  )
  try {
    const ids = (await full(me)).rooms.map((t) => t[0])
    expect(ids).toContain(roomId)
    expect(ids).not.toContain(notMine)
    expect(ids).not.toContain(Number(foreign))
    const list = await details(me, [roomId, notMine, Number(foreign)])
    expect(list.map((d) => d.roomId)).toEqual([roomId])
    expect(list[0]!.unread).toBe(1)
    expect(list[0]!.memberCount).toBe(2)
    expect(list[0]!.preview).toMatchObject({ seq: said, authorId: peer, text: 'edited' })
    // 别的租户的员工：看不到本租户的会话
    const alice = other.users.alice
    expect((await details(alice, [roomId])).length).toBe(0)
    expect((await full(alice)).rooms.map((t) => t[0])).not.toContain(roomId)
  } finally {
    await ds.query('DELETE FROM im_roster WHERE room_id = ? AND user_id = ?', [Number(foreign), me])
    await ds.query('DELETE FROM im_room WHERE id = ?', [Number(foreign)])
  }
})

it('validates the ids (400) and refuses a member identity (403)', async () => {
  const me = await person()
  for (const q of [
    '?ids=',
    '?ids=a',
    '?ids=0',
    `?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(',')}`,
    '?other=1',
  ])
    expect((await call('get', `/sync${q}`, me)).status).toBe(400)
  const member = await person('member')
  await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [member])
  expectErr(await call('get', '/sync', member), Err.IM_STAFF_ONLY)
  expectErr(await call('put', '/rooms/1/read', member, { seq: 1 }), Err.IM_STAFF_ONLY)
})
