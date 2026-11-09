import { imParams } from '@qiwu/shared'
import { ImMediaGatewayError } from '../../src/modules/platform/im/im-media-gateway.js'
import { ImCallMaintenance } from '../../src/modules/platform/im/im-call-maintenance.module.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { ImMediaKit } from './im-media-kit.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(async () => {
  await kit.clearThrottle()
  kit.provider()
})
afterAll(() => kit.close())

it('retains an unknown creation and the ending room slot even when the remote room is currently absent', async () => {
  const a = await kit.person('unknown-a'),
    b = await kit.person('unknown-b'),
    room = await kit.direct(a, b)
  let media = ''
  vi.mocked(kit.gateway.createRoom).mockImplementation(async (name) => {
    media = name
    throw new ImMediaGatewayError()
  })
  const id = await kit.create(room, a)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.canJoin).toBe(false)
  expect((await kit.call('post', `/calls/${id}/end`, a, {})).body.data.state).toBe('ending')
  await kit.reconcile(id)
  const [pending] = await kit.ds.query<
    { create_in_flight: number; media_status: string; state_code: string }[]
  >('SELECT create_in_flight,media_status,state_code FROM im_call WHERE tenant_id=1 AND id=?', [id])
  expect(pending).toMatchObject({
    create_in_flight: 1,
    media_status: 'unknown',
    state_code: 'ending',
  })
  expect(kit.gateway.createRoom).toHaveBeenCalledTimes(1)
  expect(kit.gateway.deleteRoom).not.toHaveBeenCalled()
  expect(
    (
      await kit.call('post', `/rooms/${room}/calls`, a, {
        clientCallId: 'new-while-unknown',
        mode: 'audio',
      })
    ).status,
  ).toBe(409)
  // 上游迟到创建终于可观察后才确认创建，下一轮删除并终局。
  kit.remote.add(media)
  await kit.reconcile(id)
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.state).toBe('ended')
  expect(kit.remote.has(media)).toBe(false)
})

it('recovers a lost create response without making a second CreateRoom and never ends after a failed delete', async () => {
  const a = await kit.person('lost-a'),
    b = await kit.person('lost-b'),
    room = await kit.direct(a, b)
  vi.mocked(kit.gateway.createRoom).mockImplementation(async (name) => {
    kit.remote.add(name)
    throw new ImMediaGatewayError()
  })
  const id = await kit.create(room, a)
  await kit.reconcile(id)
  expect((await kit.call('post', `/calls/${id}/join`, a, {})).status).toBe(200)
  vi.mocked(kit.gateway.deleteRoom).mockRejectedValue(new ImMediaGatewayError())
  expect((await kit.call('post', `/calls/${id}/end`, a, {})).body.data.state).toBe('ending')
  expect(
    (
      await kit.call('post', `/rooms/${room}/calls`, a, {
        clientCallId: 'still-closing',
        mode: 'audio',
      })
    ).status,
  ).toBe(409)
  vi.mocked(kit.gateway.deleteRoom).mockImplementation(async (name) => {
    kit.remote.delete(name)
  })
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.state).toBe('ended')
  expect(kit.gateway.createRoom).toHaveBeenCalledTimes(1)
})

it('persists the create intent before issuing the external side effect', async () => {
  const a = await kit.person('intent-a'),
    b = await kit.person('intent-b'),
    room = await kit.direct(a, b)
  let observed = false
  vi.mocked(kit.gateway.createRoom).mockImplementation(async (name) => {
    const rows = await kit.ds.query<{ media_status: string; create_in_flight: number }[]>(
      'SELECT media_status,create_in_flight FROM im_call WHERE tenant_id=1 AND media_room=?',
      [name],
    )
    observed =
      rows.length === 1 &&
      rows[0].media_status === 'creating' &&
      Number(rows[0].create_in_flight) === 1
    kit.remote.add(name)
  })
  await kit.create(room, a)
  expect(observed).toBe(true)
})

it('continues cleanup with the call parameter and global chat switch disabled', async () => {
  const a = await kit.person('off-a'),
    b = await kit.person('off-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  await kit.param(imParams.callEnabled, 'false')
  expect((await kit.call('post', `/calls/${id}/join`, a, {})).status).toBe(503)
  const cfg = kit.app.get(AppConfigService),
    original = cfg.get.bind(cfg)
  const spy = vi
    .spyOn(cfg, 'get')
    .mockImplementation(((key: Parameters<AppConfigService['get']>[0]) =>
      key === 'APP_IM' ? false : original(key)) as AppConfigService['get'])
  try {
    await kit.app.get(ImCallMaintenance).tick()
    const [row] = await kit.ds.query<{ state_code: string }[]>(
      'SELECT state_code FROM im_call WHERE tenant_id=1 AND id=?',
      [id],
    )
    expect(row.state_code).toBe('ended')
  } finally {
    spy.mockRestore()
    await kit.param(imParams.callEnabled, 'true')
  }
})

it('advances unknown checked times so the oldest remaining calls retain batch fairness', async () => {
  const a = await kit.person('fair-a'),
    b = await kit.person('fair-b'),
    room = await kit.direct(a, b)
  vi.mocked(kit.gateway.createRoom).mockRejectedValue(new ImMediaGatewayError())
  const id = await kit.create(room, a)
  await kit.ds.query(
    'UPDATE im_call SET checked_at=DATE_SUB(NOW(3),INTERVAL 10 MINUTE) WHERE tenant_id=1 AND id=?',
    [id],
  )
  await kit.app.get(ImCallMaintenance).tick()
  const [row] = await kit.ds.query<{ fresh: number; create_in_flight: number }[]>(
    'SELECT checked_at>DATE_SUB(NOW(3),INTERVAL 1 MINUTE) AS fresh,create_in_flight FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect(Number(row.fresh)).toBe(1)
  expect(Number(row.create_in_flight)).toBe(1)
})
