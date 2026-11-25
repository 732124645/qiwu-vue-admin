import type { DataSource } from 'typeorm'
import type { SessionRevoker } from '../../src/core/auth/session-revoker.js'
import type { RedisLock } from '../../src/core/guard/redis-lock.js'
import { ImCallMaintenance } from '../../src/modules/platform/im/im-call-maintenance.module.js'
import type { ImCallsService } from '../../src/modules/platform/im/im-calls.service.js'
import type { ImMediaGateway } from '../../src/modules/platform/im/im-media-gateway.js'

function fixture(count = 0) {
  const controller = new AbortController()
  const release = vi.fn<() => Promise<boolean>>(async () => true)
  const lease = { key: 'qw:lock:im-call-maintenance', held: true, lost: controller.signal, release }
  const query = vi.fn<
    (sql: string) => Promise<({ count: number } | { id: number; tenant_id: number })[]>
  >(async (sql) =>
    sql.includes('COUNT')
      ? [{ count }]
      : [
          { id: 1, tenant_id: 1 },
          { id: 2, tenant_id: 1 },
        ],
  )
  const sessionEnded = vi.fn<ImCallsService['sessionEnded']>(async () => {})
  const reconcile = vi.fn<ImCallsService['reconcile']>(async () => {})
  const configured = vi.fn<ImMediaGateway['configured']>(() => true)
  const register = vi.fn<SessionRevoker['onSessionEnded']>()
  const acquire = vi.fn<RedisLock['acquire']>(async () => lease)
  const job = new ImCallMaintenance(
    { query } as unknown as DataSource,
    { sessionEnded, reconcile } as unknown as ImCallsService,
    { configured } as unknown as ImMediaGateway,
    { acquire } as unknown as RedisLock,
    { onSessionEnded: register } as unknown as SessionRevoker,
  )
  return {
    job,
    query,
    reconcile,
    configured,
    register,
    sessionEnded,
    acquire,
    lease,
    controller,
    release,
  }
}

it('registers a generic ended-session callback and refuses unresolved records without control credentials', async () => {
  const f = fixture(1)
  f.configured.mockReturnValue(false)
  await expect(f.job.onApplicationBootstrap()).rejects.toThrow('required to drain existing calls')
  expect(f.register).toHaveBeenCalledTimes(1)
  await f.register.mock.calls[0][0]('ended-sid', 'signout')
  expect(f.sessionEnded).toHaveBeenCalledWith('ended-sid')
})

it('does no provider work for an unconfigured empty startup and exposes an oldest-first bounded batch', async () => {
  const f = fixture()
  f.configured.mockReturnValue(false)
  await f.job.onApplicationBootstrap()
  expect(f.reconcile).not.toHaveBeenCalled()
  await f.job.tick()
  expect(f.query.mock.calls.some(([sql]) => /ORDER BY checked_at,id LIMIT 20/.test(sql))).toBe(true)
  expect(f.reconcile.mock.calls.map(([id]) => id)).toEqual([1, 2])
  expect(f.release).toHaveBeenCalledTimes(1)
})

it('propagates the lease-lost signal and never starts another record after loss', async () => {
  const f = fixture()
  f.reconcile.mockImplementation(async (_id, signal) => {
    expect(signal?.aborted).toBe(false)
    f.controller.abort()
  })
  await f.job.tick()
  expect(f.reconcile).toHaveBeenCalledTimes(1)
  expect(f.release).toHaveBeenCalledTimes(1)
})

it('releases the global lease after loss while retaining local occupancy until uncancellable work retires', async () => {
  const f = fixture()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  f.reconcile.mockImplementation(async () => {
    enter()
    await pending
  })
  const tick = f.job.tick()
  try {
    await entered
    f.controller.abort()
    await tick
    expect(f.release).toHaveBeenCalledTimes(1)
    await f.job.tick()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.reconcile).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await tick
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  await f.job.tick()
  expect(f.acquire).toHaveBeenCalledTimes(2)
})
