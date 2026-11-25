// 员工聊天的私聊与群（see docs/im.md）：同一对员工并发建私聊只得一个会话、两人从 seq 1 可见且没有创建事件；
// 私聊对象必须是本租户启用员工；群人数上限在会话锁内校验；群角色矩阵（加人、移人、改名、设管理员、转让、
// 解散）每格正反例；群主不能直接退群、只剩自己时退群即解散；群主停用后的转让；退群后 404、再加入看不到
// 离开期间的内容；解散后可读不可写；已删除成员显示入会时的姓名快照；别的租户一律 404。
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, type ErrorDef, imParams } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { bearer } from '../setup/auth.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'im-rooms-'

let app: NestExpressApplication
let ds: DataSource
let other: PeopledTenant
const made: number[] = []
const names = new Map<number, string>()
const tokens = new Map<number, string>()
let seq = 0

type Method = 'get' | 'post' | 'put' | 'delete'

/** 本租户一个新的内部员工。 */
async function person(name = 'u'): Promise<number> {
  const username = `${PREFIX}${name}-${++seq}`
  const id = await addUser(app, 1, username)
  made.push(id)
  names.set(id, username)
  return id
}

async function tokenOf(userId: number, fresh = false): Promise<string> {
  if (fresh || !tokens.has(userId))
    tokens.set(userId, (await signInDirect(app, userId))!.accessToken)
  return tokens.get(userId)!
}

async function call(method: Method, path: string, userId: number, body?: object) {
  const req = request(app.getHttpServer())
    [method](`/api/im${path}`)
    .set(bearer(await tokenOf(userId)))
  return body === undefined ? req : req.send(body)
}

function expectErr(res: request.Response, err: ErrorDef) {
  expect([res.status, res.body.code]).toEqual([err.status, err.code])
}

/** 建群（创建者为群主），返回会话 ID。 */
async function group(ownerId: number, userIds: number[], label = `g${++seq}`): Promise<number> {
  const res = await call('post', '/rooms/groups', ownerId, { label, userIds })
  expect(res.status).toBe(201)
  return res.body.data.roomId as number
}

const roster = (roomId: number) =>
  ds.query<{ user_id: number; role_code: string; visible_from_seq: number }[]>(
    'SELECT user_id, role_code, visible_from_seq FROM im_roster WHERE room_id = ? AND deleted_at IS NULL ORDER BY id',
    [roomId],
  )

const events = async (roomId: number) =>
  (
    await ds.query<{ seq: number; event_data: { code: string } | null }[]>(
      'SELECT seq, event_data FROM im_entry WHERE room_id = ? ORDER BY seq',
      [roomId],
    )
  ).map((e) => e.event_data?.code)

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  other = await createTenant(app, { users: true })
})

// 限流按用户与路由计数：每个用例从空额度开始
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
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [made])
  }
  await other?.dispose()
  await app?.close()
})

describe('direct conversations', () => {
  it('opening the same pair concurrently from both sides makes one room, both visible from 1, without a creation event', async () => {
    const a = await person('a')
    const b = await person('b')
    const [ra, rb] = await Promise.all([
      call('post', '/rooms/directs', a, { peerId: b }),
      call('post', '/rooms/directs', b, { peerId: a }),
    ])
    expect([ra.status, rb.status]).toEqual([201, 201])
    expect(ra.body.data.roomId).toBe(rb.body.data.roomId)
    expect(ra.body.data).toMatchObject({ kind: 'direct', peerId: b, memberCount: 2, lastSeq: 0 })
    expect(rb.body.data.peerId).toBe(a)
    const low = Math.min(a, b)
    const high = Math.max(a, b)
    const rooms = await ds.query<{ id: number }[]>(
      'SELECT id FROM im_room WHERE pair_low_id = ? AND pair_high_id = ?',
      [low, high],
    )
    expect(rooms).toHaveLength(1)
    const roomId = Number(rooms[0]!.id)
    expect((await roster(roomId)).map((r) => Number(r.visible_from_seq))).toEqual([1, 1])
    expect(await events(roomId)).toEqual([])
    // 再开一次（另一个会话，避开防重复提交）得到同一个会话
    const again = request(app.getHttpServer())
      .post('/api/im/rooms/directs')
      .set(bearer(await tokenOf(a, true)))
      .send({ peerId: b })
    expect((await again.expect(201)).body.data.roomId).toBe(roomId)
  })

  it('the peer must be another enabled staff member of the own tenant', async () => {
    const a = await person('a')
    const disabled = await person('disabled')
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [disabled])
    const member = await person('member')
    await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [member])
    const deleted = await person('deleted')
    await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ?', [deleted])
    for (const peerId of [a, disabled, member, deleted, other.users.alice, 999_999_999])
      expectErr(await call('post', '/rooms/directs', a, { peerId }), Err.IM_USER_UNAVAILABLE)
  })

  it('has no member management and no leaving', async () => {
    const a = await person('a')
    const b = await person('b')
    const c = await person('c')
    const roomId = (await call('post', '/rooms/directs', a, { peerId: b })).body.data.roomId
    expectErr(
      await call('post', `/rooms/${roomId}/members`, a, { userIds: [c] }),
      Err.IM_ROLE_REQUIRED,
    )
    expectErr(await call('post', `/rooms/${roomId}/leave`, a), Err.IM_ROLE_REQUIRED)
    expectErr(await call('put', `/rooms/${roomId}/label`, a, { label: 'x' }), Err.IM_ROLE_REQUIRED)
    expect(await roster(roomId)).toHaveLength(2)
  })

  it('validates the body (400) and refuses a member identity (403)', async () => {
    const a = await person('a')
    const b = await person('b')
    for (const body of [{}, { peerId: 'x' }, { peerId: 0 }, { peerId: b, extra: 1 }])
      expect((await call('post', '/rooms/directs', a, body)).status).toBe(400)
    const member = await person('member')
    await ds.query("UPDATE iam_user SET user_type = 'member' WHERE id = ?", [member])
    expectErr(await call('post', '/rooms/directs', member, { peerId: a }), Err.IM_STAFF_ONLY)
  })
})

describe('groups', () => {
  it('the creator owns it, the others take part, the creation event is seq 1 and everyone sees it', async () => {
    const o = await person('o')
    const p1 = await person('p1')
    const p2 = await person('p2')
    const res = await call('post', '/rooms/groups', o, { label: 'Team', userIds: [p1, p2] })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      kind: 'group',
      label: 'Team',
      role: 'owner',
      memberCount: 3,
      lastSeq: 1,
      metaRev: 1,
      visibleFromSeq: 1,
    })
    const roomId = res.body.data.roomId as number
    expect(
      (await roster(roomId)).map((r) => [
        Number(r.user_id),
        r.role_code,
        Number(r.visible_from_seq),
      ]),
    ).toEqual([
      [o, 'owner', 1],
      [p1, 'participant', 1],
      [p2, 'participant', 1],
    ])
    const [ev] = await ds.query<{ author_id: number | null; event_data: object }[]>(
      'SELECT author_id, event_data FROM im_entry WHERE room_id = ? AND seq = 1',
      [roomId],
    )
    expect(ev).toMatchObject({
      author_id: null,
      event_data: {
        code: 'room.create',
        actorId: o,
        label: 'Team',
        users: [
          { id: p1, name: names.get(p1) },
          { id: p2, name: names.get(p2) },
        ],
      },
    })
    const members = (await call('get', `/rooms/${roomId}/members`, p2)).body.data
    expect(members.map((m: { userId: number; role: string }) => [m.userId, m.role])).toEqual([
      [o, 'owner'],
      [p1, 'participant'],
      [p2, 'participant'],
    ])
  })

  it('refuses unavailable members, the creator itself and bad bodies', async () => {
    const o = await person('o')
    const p = await person('p')
    const disabled = await person('disabled')
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [disabled])
    for (const userIds of [
      [p, disabled],
      [p, other.users.alice],
      [o, p],
    ])
      expectErr(
        await call('post', '/rooms/groups', o, { label: `bad${++seq}`, userIds }),
        Err.IM_USER_UNAVAILABLE,
      )
    for (const body of [
      { label: '', userIds: [p] },
      { label: 'x', userIds: [] },
      { label: 'x', userIds: [p, p] },
      { label: 'x'.repeat(81), userIds: [p] },
      { label: 'x', userIds: [p], kind: 'group' },
    ])
      expect((await call('post', '/rooms/groups', o, body)).status).toBe(400)
  })

  it('keeps to the member limit, also under concurrent additions', async () => {
    const o = await person('o')
    const [p1, p2, p3, p4] = [await person(), await person(), await person(), await person()]
    await setParam(imParams.groupMaxMembers, '3')
    try {
      expectErr(
        await call('post', '/rooms/groups', o, { label: `big${++seq}`, userIds: [p1, p2, p3] }),
        Err.IM_MEMBER_LIMIT,
      )
      const roomId = await group(o, [p1])
      const [a, b] = await Promise.all([
        call('post', `/rooms/${roomId}/members`, o, { userIds: [p2] }),
        call('post', `/rooms/${roomId}/members`, o, { userIds: [p3] }),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 422])
      expect((a.status === 422 ? a : b).body.code).toBe(Err.IM_MEMBER_LIMIT.code)
      expect(await roster(roomId)).toHaveLength(3)
      expectErr(
        await call('post', `/rooms/${roomId}/members`, o, { userIds: [p4] }),
        Err.IM_MEMBER_LIMIT,
      )
    } finally {
      await setParam(imParams.groupMaxMembers, '200')
    }
  })

  it('role matrix: who may add, remove, rename, set roles, transfer and dissolve', async () => {
    const o = await person('o')
    const m = await person('m')
    const m2 = await person('m2')
    const p1 = await person('p1')
    const p2 = await person('p2')
    const x = await person('x')
    const y = await person('y')
    const roomId = await group(o, [m, m2, p1, p2])
    const r = `/rooms/${roomId}`
    expect((await call('put', `${r}/members/${m}/role`, o, { role: 'moderator' })).status).toBe(200)
    expect((await call('put', `${r}/members/${m2}/role`, o, { role: 'moderator' })).status).toBe(
      200,
    )

    // 加人：participant 不行，moderator 与 owner 可以
    expectErr(await call('post', `${r}/members`, p1, { userIds: [x] }), Err.IM_ROLE_REQUIRED)
    expect((await call('post', `${r}/members`, m, { userIds: [x] })).status).toBe(200)
    expect((await call('post', `${r}/members`, o, { userIds: [y] })).status).toBe(200)

    // 改名：participant 不行，moderator 与 owner 可以
    expectErr(await call('put', `${r}/label`, p1, { label: 'p' }), Err.IM_ROLE_REQUIRED)
    expect((await call('put', `${r}/label`, m, { label: 'by moderator' })).status).toBe(200)
    expect((await call('put', `${r}/label`, o, { label: 'by owner' })).status).toBe(200)

    // 设管理员：只有 owner
    expectErr(
      await call('put', `${r}/members/${p1}/role`, m, { role: 'moderator' }),
      Err.IM_ROLE_REQUIRED,
    )
    expectErr(
      await call('put', `${r}/members/${p2}/role`, p1, { role: 'moderator' }),
      Err.IM_ROLE_REQUIRED,
    )
    expectErr(
      await call('put', `${r}/members/${o}/role`, o, { role: 'participant' }),
      Err.IM_ROLE_REQUIRED,
    )
    expect((await call('put', `${r}/members/${p1}/role`, o, { role: 'moderator' })).status).toBe(
      200,
    )
    expect((await call('put', `${r}/members/${p1}/role`, o, { role: 'participant' })).status).toBe(
      200,
    )
    expect((await call('put', `${r}/members/${p1}/role`, o, { role: 'owner' })).status).toBe(400)

    // 移人：participant 不行；moderator 不能移 owner 与其他 moderator，能移 participant；owner 能移 moderator
    expectErr(await call('delete', `${r}/members/${p2}`, p1), Err.IM_ROLE_REQUIRED)
    expectErr(await call('delete', `${r}/members/${o}`, m), Err.IM_ROLE_REQUIRED)
    expectErr(await call('delete', `${r}/members/${m2}`, m), Err.IM_ROLE_REQUIRED)
    expect((await call('delete', `${r}/members/${p2}`, m)).status).toBe(200)
    expect((await call('delete', `${r}/members/${m2}`, o)).status).toBe(200)
    expectErr(await call('delete', `${r}/members/${p2}`, o), Err.IM_USER_UNAVAILABLE)

    // 转让：群主账号可用时只有群主
    expectErr(await call('put', `${r}/owner`, m, { userId: m }), Err.IM_ROLE_REQUIRED)
    expectErr(await call('put', `${r}/owner`, p1, { userId: p1 }), Err.IM_ROLE_REQUIRED)
    // 转给现任群主也先过角色检查：无权者拿不到“已是群主”的空操作
    expectErr(await call('put', `${r}/owner`, p1, { userId: o }), Err.IM_ROLE_REQUIRED)
    const moved = await call('put', `${r}/owner`, o, { userId: m })
    expect(moved.status).toBe(200)
    expect(moved.body.data.role).toBe('participant')
    expect(
      (await roster(roomId)).filter((x) => x.role_code === 'owner').map((x) => Number(x.user_id)),
    ).toEqual([m])

    // 解散：只有 owner
    expectErr(await call('post', `${r}/close`, o), Err.IM_ROLE_REQUIRED)
    expectErr(await call('post', `${r}/close`, p1), Err.IM_ROLE_REQUIRED)
    const closed = await call('post', `${r}/close`, m)
    expect(closed.status).toBe(200)
    expect(closed.body.data.closedAt).not.toBeNull()

    expect(await events(roomId)).toEqual([
      'room.create',
      'role.change',
      'role.change',
      'member.add',
      'member.add',
      'room.rename',
      'room.rename',
      'role.change',
      'role.change',
      'member.remove',
      'member.remove',
      'owner.transfer',
      'room.close',
    ])
    // 每个成员、角色、群名、解散变化都让 meta_rev +1
    const [room] = await ds.query<{ meta_rev: number }[]>(
      'SELECT meta_rev FROM im_room WHERE id = ?',
      [roomId],
    )
    expect(Number(room!.meta_rev)).toBe(13)
  })

  it('an owner with other members cannot leave; alone, leaving dissolves the group', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    expectErr(await call('post', `/rooms/${roomId}/leave`, o), Err.IM_OWNER_TRANSFER_REQUIRED)
    expect((await call('post', `/rooms/${roomId}/leave`, p)).status).toBe(200)
    expect((await call('post', `/rooms/${roomId}/leave`, o)).status).toBe(200)
    const [room] = await ds.query<{ closed_at: Date | null }[]>(
      'SELECT closed_at FROM im_room WHERE id = ?',
      [roomId],
    )
    expect(room!.closed_at).not.toBeNull()
    expect(await roster(roomId)).toEqual([])
    expectErr(await call('get', `/rooms/${roomId}/members`, o), Err.IM_ROOM_NOT_FOUND)
  })

  it('an owner who is no longer available: a moderator transfers, or any member when there is none', async () => {
    const o = await person('o')
    const m = await person('m')
    const p = await person('p')
    const roomId = await group(o, [m, p])
    await call('put', `/rooms/${roomId}/members/${m}/role`, o, { role: 'moderator' })
    // 另一个群：唯一的 moderator 也停用后，普通成员可以接手
    const room3 = await group(o, [m, p])
    await call('put', `/rooms/${room3}/members/${m}/role`, o, { role: 'moderator' })
    // 群主还可用：moderator 不能转让
    expectErr(await call('put', `/rooms/${roomId}/owner`, m, { userId: m }), Err.IM_ROLE_REQUIRED)
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [o])
    try {
      expectErr(await call('put', `/rooms/${roomId}/owner`, p, { userId: p }), Err.IM_ROLE_REQUIRED)
      expect((await call('put', `/rooms/${roomId}/owner`, m, { userId: p })).status).toBe(200)
      expect((await roster(roomId)).map((r) => [Number(r.user_id), r.role_code])).toEqual([
        [o, 'participant'],
        [m, 'moderator'],
        [p, 'owner'],
      ])
      await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [m])
      expect((await call('put', `/rooms/${room3}/owner`, p, { userId: p })).status).toBe(200)
      // 没有 moderator 时任一成员可以
      const o2 = await person('o2')
      const q = await person('q')
      const room2 = await group(o2, [q])
      await ds.query('UPDATE iam_user SET user_type = ? WHERE id = ?', ['member', o2])
      expect((await call('put', `/rooms/${room2}/owner`, q, { userId: q })).status).toBe(200)
      // 新群主必须是可用的当前成员
      expectErr(
        await call('put', `/rooms/${roomId}/owner`, p, { userId: o }),
        Err.IM_USER_UNAVAILABLE,
      )
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id IN (?)', [[o, m]])
    }
  })

  it('after leaving: 404; added again, nothing from the time away is visible', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    expect((await call('post', `/rooms/${roomId}/leave`, p)).status).toBe(200)
    for (const [method, path] of [
      ['get', '/members'],
      ['get', '/entries'],
      ['put', '/read'],
      ['post', '/leave'],
    ] as const)
      expectErr(
        await call(method, `/rooms/${roomId}${path}`, p, method === 'put' ? { seq: 1 } : undefined),
        Err.IM_ROOM_NOT_FOUND,
      )
    // 离开期间：改名两次
    await call('put', `/rooms/${roomId}/label`, o, { label: 'away 1' })
    await call('put', `/rooms/${roomId}/label`, o, { label: 'away 2' })
    const back = await call('post', `/rooms/${roomId}/members`, o, { userIds: [p] })
    expect(back.status).toBe(200)
    const joinedAt = back.body.data.lastSeq as number
    const list = (await call('get', `/rooms/${roomId}/entries`, p)).body.data
    expect(list.visibleFromSeq).toBe(joinedAt)
    expect(list.items.map((e: { seq: number }) => e.seq)).toEqual([joinedAt])
    const asked = (await call('get', `/rooms/${roomId}/entries?seqs=1,2,3,4,${joinedAt}`, p)).body
      .data
    expect(asked.items.map((e: { seq: number }) => e.seq)).toEqual([joinedAt])
    expectErr(await call('get', `/rooms/${roomId}/entries/2/file`, p), Err.IM_ENTRY_NOT_FOUND)
    // 两段成员时期：旧行软删，新行 visible_from_seq = 加入事件
    const periods = await ds.query<{ deleted_at: Date | null; visible_from_seq: number }[]>(
      'SELECT deleted_at, visible_from_seq FROM im_roster WHERE room_id = ? AND user_id = ? ORDER BY id',
      [roomId, p],
    )
    expect(periods.map((x) => [x.deleted_at !== null, Number(x.visible_from_seq)])).toEqual([
      [true, 1],
      [false, joinedAt],
    ])
  })

  it('a dissolved group stays readable but takes no writes or management; members may still leave', async () => {
    const o = await person('o')
    const p = await person('p')
    const x = await person('x')
    const roomId = await group(o, [p])
    expect((await call('post', `/rooms/${roomId}/close`, o)).status).toBe(200)
    expect((await call('get', `/rooms/${roomId}/entries`, p)).status).toBe(200)
    expect((await call('get', `/rooms/${roomId}/members`, p)).status).toBe(200)
    expectErr(await call('put', `/rooms/${roomId}/label`, o, { label: 'z' }), Err.IM_ROOM_CLOSED)
    expectErr(
      await call('post', `/rooms/${roomId}/members`, o, { userIds: [x] }),
      Err.IM_ROOM_CLOSED,
    )
    expectErr(await call('post', `/rooms/${roomId}/close`, o), Err.IM_ROOM_CLOSED)
    expectErr(await call('put', `/rooms/${roomId}/owner`, o, { userId: p }), Err.IM_ROOM_CLOSED)
    expectErr(
      await call('post', `/rooms/${roomId}/entries`, p, {
        clientEntryId: `c${++seq}`,
        kind: 'text',
        text: 'hi',
      }),
      Err.IM_ROOM_CLOSED,
    )
    // 解散后群主也可以退（已无法转让）
    expect((await call('post', `/rooms/${roomId}/leave`, o)).status).toBe(200)
    expect((await call('post', `/rooms/${roomId}/leave`, p)).status).toBe(200)
  })

  it('a deleted member shows the name of the time they joined and counts as not enabled', async () => {
    const o = await person('o')
    const p = await person('gone')
    const d = await person('off')
    const roomId = await group(o, [p, d])
    const label = (await call('get', `/rooms/${roomId}/members`, o)).body.data[1].displayName
    await ds.query(
      "UPDATE iam_user SET display_name = 'renamed', deleted_at = NOW(3) WHERE id = ?",
      [p],
    )
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [d])
    const members = (await call('get', `/rooms/${roomId}/members`, o)).body.data as {
      userId: number
      displayName: string
      enabled: boolean
    }[]
    expect(members.map((m) => [m.userId, m.displayName, m.enabled])).toEqual([
      [o, expect.any(String), true],
      [p, label, false],
      [d, expect.any(String), false],
    ])
  })

  it('another tenant sees none of it (404) and cannot be added', async () => {
    const o = await person('o')
    const p = await person('p')
    const roomId = await group(o, [p])
    const alice = other.users.alice
    const theirs = (await signInDirect(app, alice))!.accessToken
    const theirsCall = (method: Method, path: string, body?: object) => {
      const req = request(app.getHttpServer())
        [method](`/api/im/rooms/${roomId}${path}`)
        .set(bearer(theirs))
      return body === undefined ? req : req.send(body)
    }
    for (const [method, path, body] of [
      ['get', '/members', undefined],
      ['post', '/members', { userIds: [other.users.admin] }],
      ['delete', `/members/${p}`, undefined],
      ['post', '/leave', undefined],
      ['put', '/owner', { userId: alice }],
      ['put', `/members/${p}/role`, { role: 'moderator' }],
      ['put', '/label', { label: 'theirs' }],
      ['post', '/close', undefined],
      ['put', '/read', { seq: 1 }],
    ] as const)
      expectErr(await theirsCall(method, path, body), Err.IM_ROOM_NOT_FOUND)
    expectErr(
      await call('post', `/rooms/${roomId}/members`, o, { userIds: [alice] }),
      Err.IM_USER_UNAVAILABLE,
    )
    expect(await roster(roomId)).toHaveLength(2)
    // 一行（伪造的）本租户成员指向别的租户的用户：只显示入会时的姓名快照，算作不可用
    await ds.query(
      `INSERT INTO im_roster (tenant_id, room_id, user_id, role_code, member_label, visible_from_seq)
       VALUES (1, ?, ?, 'participant', 'forged', 1)`,
      [roomId, alice],
    )
    const members = (await call('get', `/rooms/${roomId}/members`, o)).body.data as {
      userId: number
      displayName: string
      enabled: boolean
    }[]
    expect(members.find((m) => m.userId === alice)).toMatchObject({
      displayName: 'forged',
      enabled: false,
    })
  })

  it('path ids must be positive integers (400)', async () => {
    const o = await person('o')
    for (const path of ['/rooms/abc/members', '/rooms/0/members', '/rooms/1.5/members'])
      expect((await call('get', path, o)).status).toBe(400)
  })
})
