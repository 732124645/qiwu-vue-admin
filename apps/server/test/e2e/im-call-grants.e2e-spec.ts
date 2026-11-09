import { TokenVerifier } from 'livekit-server-sdk'
import { ImMediaKit, MEDIA_FIXTURE_KEY, MEDIA_FIXTURE_SECRET } from './im-media-kit.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(() => kit.clearThrottle())
afterAll(() => kit.close())

it('signs a one-minute exact-room grant only for an accepted original session with limited track sources', async () => {
  const a = await kit.person('grant-a'),
    b = await kit.person('grant-b'),
    room = await kit.direct(a, b)
  const id = await kit.create(room, a)
  expect((await kit.call('post', `/calls/${id}/join`, b, {})).status).toBe(409)
  await kit.call('post', `/calls/${id}/accept`, b, {})
  const response = await kit.call('post', `/calls/${id}/join`, b, {})
  expect(response.status).toBe(200)
  const claims = await new TokenVerifier(MEDIA_FIXTURE_KEY, MEDIA_FIXTURE_SECRET).verify(
    response.body.data.token,
  )
  expect(claims.sub).toBe(`u_${b}`)
  expect(claims.exp! - claims.nbf!).toBe(60)
  expect(claims.video).toMatchObject({
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canPublishSources: ['microphone'],
  })
  expect(claims.video?.roomCreate).not.toBe(true)
  expect(claims.video?.roomAdmin).not.toBe(true)
  expect(claims.video?.roomRecord).not.toBe(true)
  const publicCall = await kit.call('get', `/calls/${id}`, b)
  expect(JSON.stringify(publicCall.body.data)).not.toMatch(/"token"|"sid"|mediaRoom|apiSecret/)
  const summaries = await kit.ds.query<{ event_data: object }[]>(
    'SELECT event_data FROM im_entry WHERE tenant_id=1 AND room_id=?',
    [room],
  )
  expect(JSON.stringify(summaries)).not.toContain(response.body.data.token)
})

it('rechecks the session after signing and never returns a grant revoked during the signing wait', async () => {
  const a = await kit.person('post-a'),
    b = await kit.person('post-b'),
    room = await kit.direct(a, b)
  const id = await kit.create(room, a)
  const original = kit.gateway.grant.bind(kit.gateway)
  let released!: () => void
  let signed = false
  vi.spyOn(kit.gateway, 'grant').mockImplementation(async (...args) => {
    const value = await original(...args)
    signed = true
    await new Promise<void>((resolve) => {
      released = resolve
    })
    return value
  })
  const pending = kit.call('post', `/calls/${id}/join`, a, {})
  for (let i = 0; !signed && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(signed).toBe(true)
  await kit.ds.query('UPDATE iam_user SET enabled=0 WHERE tenant_id=1 AND id=?', [a])
  released()
  const answer = await pending
  expect(answer.status).toBe(401)
  expect(answer.body.data).toBeNull()
  const [row] = await kit.ds.query<{ state_code: string }[]>(
    'SELECT state_code FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect(row.state_code).toBe('ending')
  await kit.ds.query('UPDATE iam_user SET enabled=1 WHERE tenant_id=1 AND id=?', [a])
})

it('ends expired invitations and never signs for ended or session-mismatched participants', async () => {
  const a = await kit.person('expiry-a'),
    b = await kit.person('expiry-b'),
    room = await kit.direct(a, b)
  const id = await kit.create(room, a)
  await kit.ds.query(
    'UPDATE im_call SET invite_expires_at=DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE tenant_id=1 AND id=?',
    [id],
  )
  await kit.reconcile(id)
  expect((await kit.call('post', `/calls/${id}/join`, a, {})).status).toBe(409)
  const different = await kit.token(a, true)
  expect((await kit.call('post', `/calls/${id}/end`, a, {}, different)).status).toBe(409)
})
