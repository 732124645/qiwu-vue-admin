import { PermVersion } from '../../src/core/auth/perm-version.js'
import { ImCallsService } from '../../src/modules/platform/im/im-calls.service.js'
import { ImMediaKit } from './im-media-kit.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(() => kit.clearThrottle())
afterAll(() => kit.close())

/** 保留真实认证，只在业务接收认证快照前推进权限版本，形成确定的锁前变化窗口。 */
function moveAfterAuthentication(userId: number) {
  const calls = kit.app.get(ImCallsService),
    original = calls.qualified.bind(calls)
  let moved = false
  const spy = vi.spyOn(calls, 'qualified').mockImplementation(async (...args) => {
    const session = await original(...args)
    if (!moved && session?.userId === userId) {
      moved = true
      await kit.app.get(PermVersion).bumpUser(userId)
    }
    return session
  })
  return {
    spy,
    get moved() {
      return moved
    },
  }
}

/** 签名确实完成后暂停返回，允许真实 HTTP 动作改变业务资格，不持有房间事务。 */
function holdSignedGrant() {
  const original = kit.gateway.grant.bind(kit.gateway)
  let reached = false,
    release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  const spy = vi.spyOn(kit.gateway, 'grant').mockImplementation(async (...args) => {
    const grant = await original(...args)
    reached = true
    await ready
    return grant
  })
  return {
    spy,
    release,
    get reached() {
      return reached
    },
  }
}

it('refuses creation before inserting any call when the authenticated permission snapshot moves', async () => {
  const a = await kit.person('create-version-a'),
    b = await kit.person('create-version-b')
  const room = await kit.direct(a, b),
    move = moveAfterAuthentication(a)
  try {
    const answer = await kit.call('post', `/rooms/${room}/calls`, a, {
      clientCallId: 'moved-permission-create',
      mode: 'audio',
    })
    expect(move.moved).toBe(true)
    expect(answer.status).toBe(401)
    expect(answer.body.data).toBeNull()
    const [row] = await kit.ds.query<{ count: string }[]>(
      'SELECT COUNT(*) AS count FROM im_call WHERE tenant_id=1 AND room_id=?',
      [room],
    )
    expect(Number(row.count)).toBe(0)
  } finally {
    move.spy.mockRestore()
  }
})

it.each(['accept', 'join'] as const)(
  'refuses %s under a changed authenticated snapshot and ends the original call',
  async (action) => {
    const a = await kit.person(`${action}-version-a`),
      b = await kit.person(`${action}-version-b`)
    const room = await kit.direct(a, b),
      id = await kit.create(room, a)
    const actor = action === 'accept' ? b : a,
      move = moveAfterAuthentication(actor)
    try {
      const answer = await kit.call('post', `/calls/${id}/${action}`, actor, {})
      expect(move.moved).toBe(true)
      expect(answer.status).toBe(401)
      expect(answer.body.data).toBeNull()
      const [row] = await kit.ds.query<{ state_code: string }[]>(
        'SELECT state_code FROM im_call WHERE tenant_id=1 AND id=?',
        [id],
      )
      expect(row.state_code).toBe('ending')
    } finally {
      move.spy.mockRestore()
    }
  },
)

it('discards a signed grant when the call ends before the signing response is returned', async () => {
  const a = await kit.person('signed-end-a'),
    b = await kit.person('signed-end-b')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const signing = holdSignedGrant(),
    pending = kit.call('post', `/calls/${id}/join`, a, {})
  try {
    await vi.waitFor(() => expect(signing.reached).toBe(true), { timeout: 3000 })
    const ending = await kit.call('post', `/calls/${id}/end`, a, {})
    expect(ending.status).toBe(200)
    signing.release()
    const answer = await pending
    expect(answer.status).toBe(409)
    expect(answer.body.data).toBeNull()
  } finally {
    signing.release()
    await pending.catch(() => {})
    signing.spy.mockRestore()
  }
})

it('discards a signed grant after removal and a new membership period cannot receive it', async () => {
  const a = await kit.person('signed-period-a'),
    b = await kit.person('signed-period-b')
  const room = await kit.group(a, [b]),
    id = await kit.create(room, a, [b])
  expect((await kit.call('post', `/calls/${id}/accept`, b, {})).status).toBe(200)
  const signing = holdSignedGrant(),
    pending = kit.call('post', `/calls/${id}/join`, b, {})
  try {
    await vi.waitFor(() => expect(signing.reached).toBe(true), { timeout: 3000 })
    expect((await kit.call('delete', `/rooms/${room}/members/${b}`, a)).status).toBe(200)
    expect((await kit.call('post', `/rooms/${room}/members`, a, { userIds: [b] })).status).toBe(200)
    signing.release()
    const answer = await pending
    expect(answer.status).toBe(404)
    expect(answer.body.data).toBeNull()
  } finally {
    signing.release()
    await pending.catch(() => {})
    signing.spy.mockRestore()
  }
})
