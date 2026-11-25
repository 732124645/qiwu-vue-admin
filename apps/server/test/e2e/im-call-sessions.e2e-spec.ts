import { AsyncLocalStorage } from 'node:async_hooks'
import { appSessionParams } from '@qiwu/shared'
import type { DataSource, EntityManager } from 'typeorm'
import { SessionCurrent } from '../../src/core/auth/session-current.js'
import { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ImMediaKit } from './im-media-kit.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(() => kit.clearThrottle())
afterAll(() => kit.close())

it('marks the entire bound call ending when a session is revoked, even after normal group leave', async () => {
  const a = await kit.person('sid-a'),
    b = await kit.person('sid-b'),
    c = await kit.person('sid-c')
  const room = await kit.group(a, [b, c]),
    id = await kit.create(room, a, [b, c])
  for (const user of [b, c]) await kit.call('post', `/calls/${id}/accept`, user, {})
  await kit.call('post', `/calls/${id}/leave`, b, {})
  const session = await kit.app.get(TokenService).authenticate(await kit.token(b))
  await kit.app.get(SessionRevoker).revokeSession(session!.sid, 'signout')
  const [row] = await kit.ds.query<{ state_code: string; end_reason: string }[]>(
    'SELECT state_code,end_reason FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect(row).toMatchObject({ state_code: 'ending', end_reason: 'session_ended' })
})

it('rejects an App session past the newly shortened original-login limit before any refresh or sweep', async () => {
  const a = await kit.person('app-a'),
    b = await kit.person('app-b')
  const tokens = kit.app.get(TokenService)
  const ordinary = await tokens.authenticate(await kit.token(a))
  const app = await tokens.issue(ordinary!, {
    keepSignedIn: true,
    ip: '127.0.0.1',
    ua: 'native voice test',
    clientId: 'mobile',
    mobileKind: 'app',
  })
  const room = await kit.direct(a, b)
  const created = await kit.call(
    'post',
    `/rooms/${room}/calls`,
    a,
    { clientCallId: 'old-app', mode: 'audio' },
    app.accessToken,
  )
  expect(created.status).toBe(201)
  const redis = kit.app.get<Redis>(REDIS)
  const key = redisKey('authSession', app.session.sid)
  const stored = JSON.parse((await redis.get(key))!)
  stored.loginAt = Date.now() - 40 * 86400_000
  await redis.set(key, JSON.stringify(stored), {
    expiration: { type: 'PX', value: 400 * 86400_000 },
  })
  await kit.param(appSessionParams.sessionDays, '30')
  try {
    expect(
      (await kit.call('post', `/calls/${created.body.data.id}/join`, a, {}, app.accessToken))
        .status,
    ).toBe(401)
    const [row] = await kit.ds.query<{ state_code: string }[]>(
      'SELECT state_code FROM im_call WHERE tenant_id=1 AND id=?',
      [created.body.data.id],
    )
    expect(row.state_code).toBe('ending')
    expect(await redis.get(key)).toBeNull()
  } finally {
    await kit.param(appSessionParams.sessionDays, '0')
  }
})

it('runs full session reloads only outside business transactions while using unchanged checks inside them', async () => {
  const a = await kit.person('tx-a'),
    b = await kit.person('tx-b'),
    room = await kit.direct(a, b)
  const context = new AsyncLocalStorage<boolean>()
  const transaction = kit.ds.transaction.bind(kit.ds)
  type Work = (tx: EntityManager) => Promise<unknown>
  const txSpy = vi.spyOn(kit.ds, 'transaction').mockImplementation((async (
    arg: unknown,
    work?: Work,
  ) => {
    if (typeof arg === 'function')
      return transaction((tx) => context.run(true, () => (arg as Work)(tx)))
    return transaction(arg as Parameters<DataSource['transaction']>[0], (tx) =>
      context.run(true, () => work!(tx)),
    )
  }) as DataSource['transaction'])
  const current = kit.app.get(SessionCurrent),
    reload = current.current.bind(current)
  const contexts: boolean[] = []
  const authSpy = vi.spyOn(current, 'current').mockImplementation(async (session) => {
    contexts.push(context.getStore() === true)
    return reload(session)
  })
  try {
    const id = await kit.create(room, a)
    expect((await kit.call('post', `/calls/${id}/join`, a, {})).status).toBe(200)
    expect(contexts.length).toBeGreaterThan(0)
    expect(contexts.every((locked) => !locked)).toBe(true)
  } finally {
    authSpy.mockRestore()
    txSpy.mockRestore()
  }
})

it('publishes the sid-ended hook even when the session key has already expired', async () => {
  const a = await kit.person('gone-a'),
    b = await kit.person('gone-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const session = await kit.app.get(TokenService).authenticate(await kit.token(a))
  const redis = kit.app.get<Redis>(REDIS),
    key = redisKey('authSession', session!.sid)
  await redis.pExpire(key, 1)
  for (let i = 0; (await redis.get(key)) !== null && i < 100; i++)
    await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await redis.get(key)).toBeNull()
  await kit.app.get(SessionRevoker).revokeSession(session!.sid, 'signout')
  const [row] = await kit.ds.query<{ state_code: string }[]>(
    'SELECT state_code FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect(row.state_code).toBe('ending')
})
