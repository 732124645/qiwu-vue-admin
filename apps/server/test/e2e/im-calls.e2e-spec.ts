import { randomUUID } from 'node:crypto'
import { bearer } from '../setup/auth.js'
import request from 'supertest'
import { ImMediaKit } from './im-media-kit.js'
import { signInDirect } from '../setup/tenants.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { RealtimeService } from '../../src/core/realtime/realtime.service.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(() => kit.clearThrottle())
afterAll(() => kit.close())

it('creates an accepted caller, serializes the room slot and replays only the same creation content', async () => {
  const a = await kit.person('caller'),
    b = await kit.person('peer')
  const room = await kit.direct(a, b),
    clientCallId = randomUUID()
  const id = await kit.create(room, a, undefined, 'audio', clientCallId)
  const initial = await kit.call('get', `/calls/${id}`, a)
  expect(initial.body.data).toMatchObject({ state: 'ringing', callerId: a, canJoin: true })
  expect(initial.body.data.members).toEqual(
    expect.arrayContaining([
      { userId: a, displayName: expect.any(String), identity: `u_${a}`, state: 'accepted' },
    ]),
  )
  expect(
    (await kit.call('post', `/rooms/${room}/calls`, a, { clientCallId, mode: 'audio' })).status,
  ).toBe(429)
  await kit.clearDuplicateGuard()
  expect(await kit.create(room, a, undefined, 'audio', clientCallId)).toBe(id)
  expect(
    (await kit.call('post', `/rooms/${room}/calls`, a, { clientCallId, mode: 'video' })).status,
  ).toBe(409)
  expect(
    (
      await kit.call('post', `/rooms/${room}/calls`, a, {
        clientCallId: randomUUID(),
        mode: 'audio',
      })
    ).status,
  ).toBe(409)
  const accepted = await kit.call('post', `/calls/${id}/accept`, b, {})
  expect(accepted.status).toBe(200)
  expect(accepted.body.data.state).toBe('active')
  await kit.clearDuplicateGuard()
  expect((await kit.call('post', `/calls/${id}/accept`, b, {})).status).toBe(200)
  expect((await kit.call('post', `/calls/${id}/end`, b, {})).status).toBe(409)
  expect((await kit.call('post', `/calls/${id}/end`, a, {})).body.data.state).toBe('ended')
  const [summary] = await kit.ds.query<{ count: string }[]>(
    "SELECT COUNT(*) AS count FROM im_entry WHERE tenant_id=1 AND room_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_data,'$.code'))='call.ended'",
    [room],
  )
  expect(Number(summary.count)).toBe(1)
  await kit.call('post', `/calls/${id}/end`, a, {})
  const [again] = await kit.ds.query<{ count: string }[]>(
    "SELECT COUNT(*) AS count FROM im_entry WHERE tenant_id=1 AND room_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_data,'$.code'))='call.ended'",
    [room],
  )
  expect(Number(again.count)).toBe(1)
})

it('allows exactly one of two concurrent live sessions to bind an invitation', async () => {
  const a = await kit.person('race-a'),
    b = await kit.person('race-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const first = await kit.token(b),
    second = await kit.token(b, true)
  const results = await Promise.all(
    [first, second].map((token) => kit.call('post', `/calls/${id}/accept`, b, {}, token)),
  )
  expect(results.map((response) => response.status).sort()).toEqual([200, 409])
  const winner = results[0].status === 200 ? first : second,
    loser = winner === first ? second : first
  expect((await kit.call('post', `/calls/${id}/join`, b, {}, winner)).status).toBe(200)
  expect((await kit.call('post', `/calls/${id}/join`, b, {}, loser)).status).toBe(409)
  const [row] = await kit.ds.query<{ count: string }[]>(
    "SELECT COUNT(*) AS count FROM im_call_member WHERE tenant_id=1 AND call_id=? AND user_id=? AND state_code='accepted'",
    [id, b],
  )
  expect(Number(row.count)).toBe(1)
})

it('refreshes heartbeat and same-session accept without changing the public revision or broadcasting hints', async () => {
  const a = await kit.person('quiet-a'),
    b = await kit.person('quiet-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const accepted = await kit.call('post', `/calls/${id}/accept`, b, {})
  const revision = accepted.body.data.rev
  await kit.clearDuplicateGuard()
  await kit.ds.query(
    'UPDATE im_call_member SET last_seen_at=DATE_SUB(NOW(3),INTERVAL 10 SECOND) WHERE tenant_id=1 AND call_id=? AND user_id=?',
    [id, b],
  )
  const hints = vi.spyOn(kit.app.get(RealtimeService), 'toUsers')
  try {
    expect((await kit.call('post', `/calls/${id}/heartbeat`, b, {})).body.data.rev).toBe(revision)
    expect((await kit.call('post', `/calls/${id}/accept`, b, {})).body.data.rev).toBe(revision)
    await kit.reconcile(id)
    const [row] = await kit.ds.query<{ fresh: number }[]>(
      'SELECT last_seen_at>DATE_SUB(NOW(3),INTERVAL 5 SECOND) AS fresh FROM im_call_member WHERE tenant_id=1 AND call_id=? AND user_id=?',
      [id, b],
    )
    expect(Number(row.fresh)).toBe(1)
    expect(hints).not.toHaveBeenCalled()
  } finally {
    hints.mockRestore()
  }
})

it('keeps a departed group participant bound to its original session and requires explicit accept to rejoin', async () => {
  const a = await kit.person('owner'),
    b = await kit.person('member'),
    c = await kit.person('third')
  const room = await kit.group(a, [b, c]),
    id = await kit.create(room, a, [b, c])
  for (const user of [b, c])
    expect((await kit.call('post', `/calls/${id}/accept`, user, {})).status).toBe(200)
  expect((await kit.call('post', `/calls/${id}/leave`, b, {})).body.data.state).toBe('active')
  expect((await kit.call('post', `/calls/${id}/join`, b, {})).status).toBe(409)
  expect((await kit.call('post', `/calls/${id}/heartbeat`, b, {})).status).toBe(409)
  const original = await kit.token(b)
  const different = await kit.token(b, true)
  expect((await kit.call('post', `/calls/${id}/accept`, b, {}, different)).status).toBe(409)
  await kit.clearDuplicateGuard()
  expect((await kit.call('post', `/calls/${id}/accept`, b, {}, original)).status).toBe(200)
  expect((await kit.call('post', `/calls/${id}/join`, b, {}, original)).status).toBe(200)
  expect((await kit.call('post', `/calls/${id}/decline`, b, {}, original)).status).toBe(409)
})

it('refuses noninvited current room members and every cross-tenant route without leaking metadata', async () => {
  const a = await kit.person('a'),
    b = await kit.person('b'),
    outsider = await kit.person('outside')
  const room = await kit.group(a, [b, outsider]),
    id = await kit.create(room, a, [b])
  expect((await kit.call('get', `/calls/${id}`, outsider)).status).toBe(404)
  for (const action of ['accept', 'decline', 'join', 'leave', 'end', 'heartbeat'])
    expect((await kit.call('post', `/calls/${id}/${action}`, outsider, {})).status).toBe(404)
  const foreign = (await signInDirect(kit.app, kit.other.users.admin))!.accessToken
  for (const path of [`/calls/${id}`])
    expect(
      (await request(kit.app.getHttpServer()).get(`/api/im${path}`).set(bearer(foreign))).status,
    ).toBe(404)
  for (const action of ['accept', 'decline', 'join', 'leave', 'end', 'heartbeat']) {
    expect(
      (
        await request(kit.app.getHttpServer())
          .post(`/api/im/calls/${id}/${action}`)
          .set(bearer(foreign))
          .send({})
      ).status,
    ).toBe(404)
  }
  expect(
    (
      await request(kit.app.getHttpServer())
        .post(`/api/im/rooms/${room}/calls`)
        .set(bearer(foreign))
        .send({ clientCallId: randomUUID(), mode: 'audio', userIds: [a] })
    ).status,
  ).toBe(404)
})

it('uses strict request bodies, refuses unsupported media and never lets a bystander claim caller privileges', async () => {
  const a = await kit.person('strict-a'),
    b = await kit.person('strict-b')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  for (const body of [
    { mode: 'screen', clientCallId: randomUUID() },
    { mode: 'video', clientCallId: randomUUID(), mediaRoom: 'selected-by-client' },
  ]) {
    expect((await kit.call('post', `/rooms/${room}/calls`, a, body)).status).toBe(400)
  }
  for (const action of ['accept', 'decline', 'join', 'leave', 'end', 'heartbeat'])
    expect((await kit.call('post', `/calls/${id}/${action}`, b, { sid: 'forged' })).status).toBe(
      400,
    )
})

it('ends on member-period loss and never restores access after a re-add', async () => {
  const a = await kit.person('period-a'),
    b = await kit.person('period-b'),
    c = await kit.person('period-c')
  const room = await kit.group(a, [b, c]),
    id = await kit.create(room, a, [b])
  await kit.call('post', `/calls/${id}/accept`, b, {})
  expect((await kit.call('delete', `/rooms/${room}/members/${b}`, a)).status).toBe(200)
  const state = await kit.call('get', `/calls/${id}`, a)
  expect(state.body.data.state).toBe('ending')
  await kit.call('post', `/rooms/${room}/members`, a, { userIds: [b] })
  expect((await kit.call('get', `/calls/${id}`, b)).status).toBe(404)
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.state).toBe('ended')
})

it('allows one accepted caller in ringing until timeout, but stops a group once fewer than two remain', async () => {
  const a = await kit.person('count-a'),
    b = await kit.person('count-b'),
    c = await kit.person('count-c')
  const room = await kit.group(a, [b, c]),
    id = await kit.create(room, a, [b, c])
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.state).toBe('ringing')
  await kit.call('post', `/calls/${id}/accept`, b, {})
  const result = await kit.call('post', `/calls/${id}/leave`, b, {})
  expect(result.body.data.state).toBe('ended')
})

it('returns 403 for a current nonemployee on every new call route', async () => {
  const a = await kit.person('staff-a'),
    b = await kit.person('staff-b'),
    member = await kit.person('not-staff')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const token = await kit.token(member)
  await kit.ds.query("UPDATE iam_user SET user_type='member' WHERE tenant_id=1 AND id=?", [member])
  await kit.app.get(PermVersion).bumpUser(member)
  for (const path of ['/calls/active', `/calls/${id}`])
    expect((await kit.call('get', path, member, undefined, token)).status).toBe(403)
  for (const action of ['accept', 'decline', 'join', 'leave', 'end', 'heartbeat'])
    expect((await kit.call('post', `/calls/${id}/${action}`, member, {}, token)).status).toBe(403)
  expect(
    (
      await kit.call(
        'post',
        `/rooms/${room}/calls`,
        member,
        { clientCallId: 'not-staff-call', mode: 'audio' },
        token,
      )
    ).status,
  ).toBe(403)
})
