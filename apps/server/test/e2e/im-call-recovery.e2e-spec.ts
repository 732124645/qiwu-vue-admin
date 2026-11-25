import { setTimeout as delay } from 'node:timers/promises'
import type { DataSource, EntityManager } from 'typeorm'
import { SessionCurrent } from '../../src/core/auth/session-current.js'
import { TokenService } from '../../src/core/auth/token.service.js'
import type { RedisLock } from '../../src/core/guard/redis-lock.js'
import { ImCallMaintenance } from '../../src/modules/platform/im/im-call-maintenance.module.js'
import { ImCallsService } from '../../src/modules/platform/im/im-calls.service.js'
import { ImMediaGatewayError } from '../../src/modules/platform/im/im-media-gateway.js'
import { ImMediaKit } from './im-media-kit.js'

const kit = new ImMediaKit()
beforeAll(() => kit.boot())
beforeEach(async () => {
  await kit.clearThrottle()
  kit.provider()
  for (const method of ['createRoom', 'deleteRoom', 'hasRoom'] as const)
    vi.mocked(kit.gateway[method]).mockClear()
})
afterAll(() => kit.close())

/** 预算只能停止外层等待，测试收尾还要等待真实 reconcile 退场，不能遗留后台写入。 */
function captureReconciliations() {
  const service = Reflect.get(kit.app.get(ImCallMaintenance), 'calls') as ImCallsService,
    original = service.reconcile.bind(service)
  const jobs: Promise<void>[] = []
  const spy = vi.spyOn(service, 'reconcile').mockImplementation((...args) => {
    const work = original(...args)
    jobs.push(work)
    return work
  })
  return { jobs, restore: () => spy.mockRestore() }
}

it('stops waiting for slow authentication at the four-second batch deadline without starting a late write', async () => {
  const a = await kit.person('budget-auth-a'),
    b = await kit.person('budget-auth-b')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const tokens = kit.app.get(TokenService),
    load = tokens.load.bind(tokens)
  const retirement = captureReconciliations()
  const reads: Promise<unknown>[] = []
  const spy = vi.spyOn(tokens, 'load').mockImplementation((...args) => {
    const work = delay(4700).then(() => load(...args))
    reads.push(work)
    return work
  })
  const [before] = await kit.ds.query<{ revision: number }[]>(
    'SELECT revision FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  let elapsed = 0
  try {
    const start = Date.now()
    await kit.app.get(ImCallMaintenance).tick()
    elapsed = Date.now() - start
    expect(elapsed).toBeLessThanOrEqual(4300)
    expect(retirement.jobs.length).toBeGreaterThan(0)
    await Promise.allSettled(reads)
    await Promise.allSettled(retirement.jobs)
    const [after] = await kit.ds.query<{ revision: number; state_code: string }[]>(
      'SELECT revision,state_code FROM im_call WHERE tenant_id=1 AND id=?',
      [id],
    )
    expect(after).toMatchObject({ revision: before.revision, state_code: 'ringing' })
  } finally {
    spy.mockRestore()
    await Promise.allSettled(reads)
    await Promise.allSettled(retirement.jobs)
    retirement.restore()
    await kit.call('post', `/calls/${id}/end`, a, {})
  }
})

it('releases the SQL room lock at deadline even when a pure session snapshot read has not retired', async () => {
  const a = await kit.person('snapshot-budget-a'),
    b = await kit.person('snapshot-budget-b')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  const current = kit.app.get(SessionCurrent),
    unchanged = current.unchanged.bind(current)
  const retirement = captureReconciliations()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const reads: Promise<unknown>[] = []
  const spy = vi.spyOn(current, 'unchanged').mockImplementation((snapshot) => {
    enter()
    const work = pending.then(() => unchanged(snapshot))
    reads.push(work)
    return work
  })
  const runner = kit.ds.createQueryRunner()
  const job = kit.app.get(ImCallMaintenance)
  const acquire = vi.spyOn(Reflect.get(job, 'locks') as RedisLock, 'acquire')
  const start = Date.now(),
    tick = job.tick()
  try {
    await entered
    await tick
    expect(Date.now() - start).toBeLessThanOrEqual(4300)
    await runner.connect()
    await runner.startTransaction()
    // 回滚指令也有网络往返；在短窗口内确认真实锁已释放，不等待仍未退场的纯读。
    let acquired = false
    const rollbackDeadline = Date.now() + 500
    while (Date.now() < rollbackDeadline) {
      try {
        const rows = (await runner.query(
          'SELECT id FROM im_room WHERE tenant_id=1 AND id=? FOR UPDATE NOWAIT',
          [room],
        )) as { id: number }[]
        acquired = rows.length === 1
        break
      } catch (error) {
        if ((error as { code?: string }).code !== 'ER_LOCK_NOWAIT') throw error
        await delay(10)
      }
    }
    expect(acquired).toBe(true)
    await runner.rollbackTransaction()
    const [row] = await kit.ds.query<{ state_code: string }[]>(
      'SELECT state_code FROM im_call WHERE tenant_id=1 AND id=?',
      [id],
    )
    expect(row.state_code).toBe('ringing')
    expect(retirement.jobs.length).toBeGreaterThan(0)
    let retired = false
    retirement.jobs.at(-1)!.then(
      () => {
        retired = true
      },
      () => {
        retired = true
      },
    )
    // 给真实 SQL 回滚留出往返窗口后，纯读仍未完成；此时不能丢掉本地退场责任。
    const retirementDeadline = Date.now() + 500
    while (!retired && Date.now() < retirementDeadline) await delay(10)
    expect(retired).toBe(false)
    expect(acquire).toHaveBeenCalledTimes(1)
    await job.tick()
    expect(acquire).toHaveBeenCalledTimes(1)
  } finally {
    release()
    spy.mockRestore()
    await Promise.allSettled(reads)
    await Promise.allSettled(retirement.jobs)
    retirement.restore()
    acquire.mockRestore()
    await tick
    if (runner.isTransactionActive) await runner.rollbackTransaction()
    await runner.release()
    await kit.call('post', `/calls/${id}/end`, a, {})
  }
})

it('does not wait for a contested media-result room lock or commit a terminal result after losing its budget', async () => {
  const a = await kit.person('budget-lock-a'),
    b = await kit.person('budget-lock-b')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  await kit.ds.query(
    "UPDATE im_call SET state_code='ending',ending_at=NOW(3),end_reason='ended' WHERE tenant_id=1 AND id=?",
    [id],
  )
  const runner = kit.ds.createQueryRunner()
  const retirement = captureReconciliations()
  let release: Promise<void> | undefined
  const spy = vi.mocked(kit.gateway.deleteRoom).mockImplementation(async (name) => {
    await runner.connect()
    await runner.startTransaction()
    await runner.query('SELECT id FROM im_room WHERE tenant_id=1 AND id=? FOR UPDATE', [room])
    release = delay(4700).then(async () => {
      await runner.rollbackTransaction()
      await runner.release()
    })
    kit.remote.delete(name)
  })
  try {
    const start = Date.now()
    await kit.app.get(ImCallMaintenance).tick()
    expect(Date.now() - start).toBeLessThanOrEqual(4300)
    expect(kit.gateway.deleteRoom).toHaveBeenCalledTimes(1)
    expect(retirement.jobs.length).toBeGreaterThan(0)
    let retired = false
    retirement.jobs.at(-1)!.then(
      () => {
        retired = true
      },
      () => {
        retired = true
      },
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    // 外部父房间锁还未释放时，真实 reconcile 已经退场，不能只靠外层四秒返回伪装 NOWAIT。
    expect(runner.isTransactionActive).toBe(true)
    expect(runner.isReleased).toBe(false)
    expect(retired).toBe(true)
    const [row] = await kit.ds.query<{ state_code: string; summary_seq: number | null }[]>(
      'SELECT state_code,summary_seq FROM im_call WHERE tenant_id=1 AND id=?',
      [id],
    )
    expect(row).toMatchObject({ state_code: 'ending', summary_seq: null })
  } finally {
    await release
    if (!runner.isReleased) {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await runner.release()
    }
    await Promise.allSettled(retirement.jobs)
    retirement.restore()
    spy.mockRestore()
  }
  kit.provider()
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.state).toBe('ended')
})

it('freezes business duration before delayed remote deletion and keeps media completion separate', async () => {
  const a = await kit.person('duration-a'),
    b = await kit.person('duration-b')
  const room = await kit.direct(a, b),
    id = await kit.create(room, a)
  await kit.call('post', `/calls/${id}/accept`, b, {})
  await kit.ds.query(
    'UPDATE im_call SET started_at=DATE_SUB(NOW(3),INTERVAL 10 SECOND) WHERE tenant_id=1 AND id=?',
    [id],
  )
  vi.mocked(kit.gateway.deleteRoom).mockRejectedValue(new ImMediaGatewayError())
  const ending = await kit.call('post', `/calls/${id}/end`, a, {})
  expect(ending.body.data).toMatchObject({ state: 'ending', endedAt: null })
  expect(ending.body.data).not.toHaveProperty('endingAt')
  const [business] = await kit.ds.query<{ ending_at: Date; started_at: Date }[]>(
    'SELECT ending_at,started_at FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  await delay(2100)
  vi.mocked(kit.gateway.deleteRoom).mockImplementation(async (name) => {
    kit.remote.delete(name)
  })
  await kit.reconcile(id)
  const [row] = await kit.ds.query<{ duration: number }[]>(
    "SELECT JSON_EXTRACT(event_data,'$.call.durationSeconds') AS duration FROM im_entry WHERE tenant_id=1 AND room_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_data,'$.code'))='call.ended'",
    [room],
  )
  const [finished] = await kit.ds.query<{ ending_at: Date; ended_at: Date }[]>(
    'SELECT ending_at,ended_at FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect(finished.ending_at).toEqual(business.ending_at)
  expect(finished.ended_at.getTime() - finished.ending_at.getTime()).toBeGreaterThanOrEqual(2000)
  expect(Number(row.duration)).toBe(
    Math.floor((business.ending_at.getTime() - business.started_at.getTime()) / 1000),
  )
})

it('freezes business duration when a participant is removed before delayed media cleanup', async () => {
  const a = await kit.person('removed-duration-a'),
    b = await kit.person('removed-duration-b'),
    c = await kit.person('removed-duration-c')
  const room = await kit.group(a, [b, c]),
    id = await kit.create(room, a, [b])
  await kit.call('post', `/calls/${id}/accept`, b, {})
  await kit.ds.query(
    'UPDATE im_call SET started_at=DATE_SUB(NOW(3),INTERVAL 10 SECOND) WHERE tenant_id=1 AND id=?',
    [id],
  )
  vi.mocked(kit.gateway.deleteRoom).mockRejectedValue(new ImMediaGatewayError())
  expect((await kit.call('delete', `/rooms/${room}/members/${b}`, a)).status).toBe(200)
  const [business] = await kit.ds.query<{ ending_at: Date | null; started_at: Date }[]>(
    'SELECT ending_at,started_at FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect(business.ending_at).not.toBeNull()
  await delay(2100)
  vi.mocked(kit.gateway.deleteRoom).mockImplementation(async (name) => {
    kit.remote.delete(name)
  })
  await kit.reconcile(id)
  const [finished] = await kit.ds.query<{ ending_at: Date; ended_at: Date }[]>(
    'SELECT ending_at,ended_at FROM im_call WHERE tenant_id=1 AND id=?',
    [id],
  )
  const [summary] = await kit.ds.query<{ duration: number }[]>(
    "SELECT JSON_EXTRACT(event_data,'$.call.durationSeconds') AS duration FROM im_entry WHERE tenant_id=1 AND room_id=? AND JSON_UNQUOTE(JSON_EXTRACT(event_data,'$.code'))='call.ended'",
    [room],
  )
  expect(finished.ending_at).toEqual(business.ending_at)
  expect(finished.ended_at.getTime() - finished.ending_at.getTime()).toBeGreaterThanOrEqual(2000)
  expect(Number(summary.duration)).toBe(
    Math.floor((business.ending_at!.getTime() - business.started_at.getTime()) / 1000),
  )
})

it('finishes a committed intent that never dispatched creation without making a remote request', async () => {
  const a = await kit.person('intent-interrupt-a'),
    b = await kit.person('intent-interrupt-b'),
    room = await kit.direct(a, b)
  const service = kit.app.get(ImCallsService)
  for (const method of ['createRoom', 'deleteRoom', 'hasRoom'] as const)
    vi.mocked(kit.gateway[method]).mockClear()
  const spy = vi
    .spyOn(service, 'hint')
    .mockRejectedValueOnce(new Error('dispatch interrupted after intent commit'))
  try {
    const response = await kit.call('post', `/rooms/${room}/calls`, a, {
      clientCallId: 'interrupted-intent',
      mode: 'audio',
    })
    expect(response.status).toBe(500)
  } finally {
    spy.mockRestore()
  }
  const [row] = await kit.ds.query<
    { id: number; media_status: string; create_in_flight: number }[]
  >('SELECT id,media_status,create_in_flight FROM im_call WHERE tenant_id=1 AND room_id=?', [room])
  expect(row).toMatchObject({ media_status: 'intent', create_in_flight: 0 })
  const id = Number(row.id),
    end = await kit.call('post', `/calls/${id}/end`, a, {})
  await kit.reconcile(id)
  const [after] = await kit.ds.query<
    { state_code: string; media_status: string; create_in_flight: number }[]
  >('SELECT state_code,media_status,create_in_flight FROM im_call WHERE tenant_id=1 AND id=?', [id])
  expect(end.body.data.state).toBe('ended')
  expect(after).toMatchObject({ state_code: 'ended', media_status: 'closed', create_in_flight: 0 })
  for (const method of ['createRoom', 'deleteRoom', 'hasRoom'] as const)
    expect(kit.gateway[method]).not.toHaveBeenCalled()
})

it('expires a caller-only ringing invitation after its forty-five-second window', async () => {
  const a = await kit.person('invite-a'),
    b = await kit.person('invite-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  await kit.ds.query(
    'UPDATE im_call SET invite_expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE tenant_id=1 AND id=?',
    [id],
  )
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data).toMatchObject({
    state: 'ended',
    endReason: 'no_answer',
  })
})

it('enforces the two-hour ceiling while accepted sessions and heartbeats remain healthy', async () => {
  const a = await kit.person('maximum-a'),
    b = await kit.person('maximum-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  await kit.call('post', `/calls/${id}/accept`, b, {})
  await kit.ds.query(
    'UPDATE im_call SET created_at=DATE_SUB(NOW(3),INTERVAL 7201 SECOND) WHERE tenant_id=1 AND id=?',
    [id],
  )
  await kit.ds.query(
    'UPDATE im_call_member SET last_seen_at=NOW(3) WHERE tenant_id=1 AND call_id=?',
    [id],
  )
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data).toMatchObject({
    state: 'ended',
    endReason: 'timeout',
  })
})

it('recovers a rolled-back result transaction without issuing a second media creation', async () => {
  const a = await kit.person('sql-a'),
    b = await kit.person('sql-b'),
    room = await kit.direct(a, b)
  const transaction = kit.ds.transaction.bind(kit.ds)
  type Work = (tx: EntityManager) => Promise<unknown>
  let inject = false,
    rolledBack = 0
  const spy = vi.spyOn(kit.ds, 'transaction').mockImplementation((async (
    arg: unknown,
    work?: Work,
  ) => {
    const fail = inject
    inject = false
    const wrapped = async (tx: EntityManager) => {
      const value = await (typeof arg === 'function' ? (arg as Work)(tx) : work!(tx))
      if (fail) {
        rolledBack++
        throw new Error('media result write rolled back')
      }
      return value
    }
    return typeof arg === 'function'
      ? transaction(wrapped)
      : transaction(arg as Parameters<DataSource['transaction']>[0], wrapped)
  }) as DataSource['transaction'])
  vi.mocked(kit.gateway.createRoom).mockImplementation(async (name) => {
    kit.remote.add(name)
    inject = true
  })
  let id = 0
  try {
    id = await kit.create(room, a)
    const [row] = await kit.ds.query<{ media_status: string; create_in_flight: number }[]>(
      'SELECT media_status,create_in_flight FROM im_call WHERE tenant_id=1 AND id=?',
      [id],
    )
    expect(rolledBack).toBe(1)
    expect(row).toMatchObject({ media_status: 'unknown', create_in_flight: 1 })
    expect(kit.gateway.createRoom).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.canJoin).toBe(true)
  expect(kit.gateway.createRoom).toHaveBeenCalledTimes(1)
  await kit.call('post', `/calls/${id}/end`, a, {})
})

it('keeps an outstanding creation single-claimed when end and concurrent reconciliations arrive before its response', async () => {
  const a = await kit.person('late-a'),
    b = await kit.person('late-b'),
    room = await kit.direct(a, b)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
      enter = resolve
    }),
    released = new Promise<void>((resolve) => {
      release = resolve
    })
  vi.mocked(kit.gateway.createRoom).mockImplementation(async (name) => {
    enter()
    await released
    kit.remote.add(name)
  })
  const pending = kit.create(room, a)
  let id = 0
  try {
    await entered
    const [row] = await kit.ds.query<{ id: number }[]>(
      'SELECT id FROM im_call WHERE tenant_id=1 AND room_id=?',
      [room],
    )
    id = Number(row.id)
    expect((await kit.call('post', `/calls/${id}/end`, a, {})).body.data.state).toBe('ending')
    await Promise.all([kit.reconcile(id), kit.reconcile(id)])
    expect(kit.gateway.createRoom).toHaveBeenCalledTimes(1)
    expect(kit.gateway.deleteRoom).not.toHaveBeenCalled()
    const [summary] = await kit.ds.query<{ summary_seq: number | null }[]>(
      'SELECT summary_seq FROM im_call WHERE tenant_id=1 AND id=?',
      [id],
    )
    expect(summary.summary_seq).toBeNull()
  } finally {
    release()
    await pending
  }
  await kit.reconcile(id)
  expect((await kit.call('get', `/calls/${id}`, a)).body.data.state).toBe('ended')
  expect(kit.gateway.createRoom).toHaveBeenCalledTimes(1)
  expect(kit.gateway.deleteRoom).toHaveBeenCalledTimes(1)
})

it('does not accept an expired invitation before maintenance has swept it', async () => {
  const a = await kit.person('accept-expired-a'),
    b = await kit.person('accept-expired-b'),
    room = await kit.direct(a, b),
    id = await kit.create(room, a)
  await kit.ds.query(
    'UPDATE im_call SET invite_expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE tenant_id=1 AND id=?',
    [id],
  )
  expect((await kit.call('post', `/calls/${id}/accept`, b, {})).body.data).toMatchObject({
    state: 'ended',
    endReason: 'no_answer',
  })
})
