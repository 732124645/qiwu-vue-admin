import { seedOaAttendanceJob } from '../../src/db/seeds/project/oa-attendance.seed.js'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { EntityManager, type DataSource } from 'typeorm'
import { ClsService } from 'nestjs-cls'
import { JOB_HANDLER, type JobHandlerMeta } from '../../src/core/scheduler/job-handler.js'
import { DEFAULT_TENANT_ID, withTenant } from '../../src/core/context/tenant.js'
import { ClockRetentionJob } from '../../src/modules/oa/attendance/clock-retention.job.js'
import { ClockTime } from '../../src/modules/oa/attendance/clock-time.js'
import { AttendancePolicy } from '../../src/modules/oa/attendance/policy.entity.js'
import { ClockRecord } from '../../src/modules/oa/attendance/clock-record.entity.js'
import { bootApp, createTenant, type TestTenant } from '../setup/tenants.js'

let app: NestExpressApplication, ds: DataSource, first: TestTenant, second: TestTenant
let now = new Date('2026-11-22T12:00:00Z')
let serial = 0
const policyValues = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  locationMode: 'none' as const,
  retentionDays: 30,
}
const policy = (tenant: TestTenant, extra: object = {}) =>
  withTenant(tenant.id, () =>
    ds
      .getRepository(AttendancePolicy)
      .update({ tenantId: tenant.id }, { ...policyValues, ...extra }),
  )
const run = (signal = new AbortController().signal) =>
  app.get(ClsService).run(() => app.get(ClockRetentionJob).run({}, { signal, log: () => {} }))
async function record(
  tenant: Pick<TestTenant, 'id' | 'ownerId'> = first,
  extra: Partial<ClockRecord> = {},
) {
  return withTenant(tenant.id, async () => {
    const p = await ds.getRepository(AttendancePolicy).findOneByOrFail({})
    return ds.getRepository(ClockRecord).save({
      userId: tenant.ownerId,
      deptId: null,
      workDate: '2026-09-01',
      action: 'check_in',
      punchedAt: new Date('2026-09-01T01:00:00Z'),
      timezone: 'Asia/Shanghai',
      policyId: p.id,
      policySnapshot: policyValues,
      source: 'native',
      validationResult: 'not_required',
      requestId: `retention-${++serial}-request`,
      requestDigest: 'b'.repeat(64),
      ...extra,
    })
  })
}
async function count(tenant = first) {
  const [r] = await ds.query<{ amount: number }[]>(
    'SELECT COUNT(*) AS amount FROM oa_clock_record WHERE tenant_id=?',
    [tenant.id],
  )
  return Number(r!.amount)
}
async function waitForPolicyLock() {
  await vi.waitFor(
    async () => {
      const rows =
        await ds.query<{ Info: string | null; db: string | null }[]>('SHOW FULL PROCESSLIST')
      expect(
        rows.some(
          (r) =>
            r.db === process.env.DB_NAME &&
            r.Info?.includes('SELECT timezone,retention_days') &&
            r.Info.includes('FOR UPDATE'),
        ),
      ).toBe(true)
    },
    { timeout: 3000, interval: 10 },
  )
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get(getDataSourceToken())
  first = await createTenant(app)
  second = await createTenant(app)
})
beforeEach(async () => {
  now = new Date('2026-11-22T12:00:00Z')
  vi.spyOn(app.get(ClockTime), 'now').mockImplementation(() => new Date(now))
  await ds.query('DELETE FROM oa_clock_record WHERE tenant_id IN (?,?)', [first.id, second.id])
  await ds.query('UPDATE iam_tenant SET enabled=1,expires_at=NULL WHERE id IN (?,?)', [
    first.id,
    second.id,
  ])
  await policy(first)
  await policy(second)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('tenant attendance retention', () => {
  it('installs a single disabled test task and preserves administrator edits and deletion', async () => {
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      const initial = await runner.query(
        'SELECT id,name,cron,enabled,misfire,timeout_ms FROM job_task WHERE handler=? AND deleted_at IS NULL',
        ['oa.clock.retention'],
      )
      expect(initial).toHaveLength(1)
      expect(initial[0]).toMatchObject({
        name: 'seed.task.clockRetention',
        cron: '0 15 4 * * *',
        enabled: 0,
        misfire: 'run_once',
        timeout_ms: 600000,
      })
      await runner.query('UPDATE job_task SET name=?,cron=?,enabled=0 WHERE id=?', [
        'Custom attendance cleanup',
        '0 0 2 * * *',
        initial[0].id,
      ])
      await seedOaAttendanceJob(runner.manager)
      const [edited] = await runner.query('SELECT name,cron,enabled FROM job_task WHERE id=?', [
        initial[0].id,
      ])
      expect(edited).toEqual({ name: 'Custom attendance cleanup', cron: '0 0 2 * * *', enabled: 0 })
      await runner.query('UPDATE job_task SET deleted_at=NOW(3) WHERE id=?', [initial[0].id])
      await seedOaAttendanceJob(runner.manager)
      const after = await runner.query('SELECT id,deleted_at FROM job_task WHERE handler=?', [
        'oa.clock.retention',
      ])
      expect(after).toHaveLength(1)
      expect(after[0].id).toBe(initial[0].id)
      expect(after[0].deleted_at).not.toBeNull()
    } finally {
      await runner.rollbackTransaction()
      await runner.release()
    }
  })

  it('registers a no-parameter platform job and removes expired rows without an employee principal', async () => {
    const metadata = Reflect.getMetadata(
      JOB_HANDLER,
      ClockRetentionJob.prototype.run,
    ) as JobHandlerMeta
    expect(metadata.name).toBe('oa.clock.retention')
    expect(metadata.params.safeParse({}).success).toBe(true)
    for (const input of [{ tenantId: first.id }, { days: 1 }, { tenantId: first.id, days: 1 }])
      expect(metadata.params.safeParse(input).success).toBe(false)
    await record()
    await record(second)
    expect(await run()).toEqual({ deleted: 2 })
    expect(await count()).toBe(0)
    expect(await count(second)).toBe(0)
  })

  it('uses independent tenant policies, retains recent and current records, and purges old soft-deleted rows', async () => {
    await record()
    await record(first, { workDate: '2026-09-02', deletedAt: new Date('2026-10-01T00:00:00Z') })
    await record(first, { workDate: '2026-11-01', punchedAt: new Date('2026-11-01T01:00:00Z') })
    await record(first, { workDate: '2026-11-22', punchedAt: new Date('2026-11-22T01:00:00Z') })
    await policy(second, { retentionDays: 180 })
    await record(second)
    expect(await run()).toEqual({ deleted: 2 })
    expect(await count()).toBe(2)
    expect(await count(second)).toBe(1)
  })

  it('requires both the calendar cutoff and a full elapsed retention period across timezone changes', async () => {
    await policy(first, { timezone: 'Pacific/Kiritimati' })
    await record(first, {
      workDate: '2026-09-01',
      punchedAt: new Date(now.getTime() - 30 * 86400000 + 3600000),
    })
    await record(first, { workDate: '2026-10-24', punchedAt: new Date('2026-08-01T00:00:00Z') })
    await record(first, { workDate: '2026-11-23', punchedAt: new Date('2026-08-01T00:00:00Z') })
    expect(await run()).toEqual({ deleted: 0 })
    expect(await count()).toBe(3)
  })

  it('does not delete the cutoff day or a timestamp exactly at the elapsed boundary', async () => {
    await record(first, { workDate: '2026-10-23', punchedAt: new Date('2026-10-01T00:00:00Z') })
    await record(first, {
      workDate: '2026-10-01',
      punchedAt: new Date(now.getTime() - 30 * 86400000),
    })
    expect(await run()).toEqual({ deleted: 0 })
  })

  it('skips disabled and expired tenants while a disabled punch policy still retains its privacy deadline', async () => {
    await record()
    await record(second)
    await ds.query('UPDATE iam_tenant SET enabled=0 WHERE id=?', [first.id])
    await ds.query('UPDATE iam_tenant SET expires_at=? WHERE id=?', [
      new Date(now.getTime() - 1000),
      second.id,
    ])
    expect(await run()).toEqual({ deleted: 0 })
    await ds.query('UPDATE iam_tenant SET enabled=1 WHERE id=?', [first.id])
    await policy(first, { enabled: false })
    expect(await run()).toEqual({ deleted: 1 })
    expect(await count(second)).toBe(1)
  })

  it('rechecks a policy lengthened while the cleaner is waiting on its row lock', async () => {
    await record()
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let pending: ReturnType<typeof run> | undefined
    try {
      await runner.query(
        'UPDATE oa_attendance_policy SET retention_days=180 WHERE tenant_id=? AND deleted_at IS NULL',
        [first.id],
      )
      pending = run()
      await waitForPolicyLock()
      await runner.commitTransaction()
      expect(await pending).toEqual({ deleted: 0 })
      expect(await count()).toBe(1)
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await pending?.catch(() => {})
      await runner.release()
    }
  })

  it('rechecks tenant lifecycle after waiting for the locked rule', async () => {
    await record()
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let pending: ReturnType<typeof run> | undefined
    try {
      await runner.query(
        'SELECT id FROM oa_attendance_policy WHERE tenant_id=? AND deleted_at IS NULL FOR UPDATE',
        [first.id],
      )
      pending = run()
      await waitForPolicyLock()
      await runner.query('UPDATE iam_tenant SET enabled=0 WHERE id=?', [first.id])
      await runner.commitTransaction()
      expect(await pending).toEqual({ deleted: 0 })
      expect(await count()).toBe(1)
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await pending?.catch(() => {})
      await runner.release()
    }
  })

  it('reads time after the tenant lock so expiry during a wait prevents deletion', async () => {
    await record()
    await ds.query('UPDATE iam_tenant SET expires_at=? WHERE id=?', [
      new Date(now.getTime() + 3600000),
      first.id,
    ])
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let pending: ReturnType<typeof run> | undefined
    try {
      await runner.query('SELECT id FROM iam_tenant WHERE id=? FOR UPDATE', [first.id])
      pending = run()
      await vi.waitFor(
        async () => {
          const rows =
            await ds.query<{ Info: string | null; db: string | null }[]>('SHOW FULL PROCESSLIST')
          expect(
            rows.some(
              (r) =>
                r.db === process.env.DB_NAME &&
                r.Info?.startsWith('SELECT enabled,expires_at') &&
                r.Info.includes('FOR SHARE'),
            ),
          ).toBe(true)
        },
        { timeout: 3000, interval: 10 },
      )
      now = new Date(now.getTime() + 2 * 3600000)
      await runner.commitTransaction()
      expect(await pending).toEqual({ deleted: 0 })
      expect(await count()).toBe(1)
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await pending?.catch(() => {})
      await runner.release()
    }
  })

  it('stops immediately when aborted and rolls back a batch aborted after its delete', async () => {
    await record()
    const controller = new AbortController()
    controller.abort(new Error('stop retention'))
    await expect(run(controller.signal)).rejects.toThrow('stop retention')
    expect(await count()).toBe(1)
    const mid = new AbortController()
    const original = EntityManager.prototype.query
    vi.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      const result = await original.apply(this, args)
      if (args[0].startsWith('DELETE FROM oa_clock_record WHERE tenant_id='))
        mid.abort(new Error('stop batch'))
      return result
    })
    await expect(run(mid.signal)).rejects.toThrow('stop batch')
    expect(await count()).toBe(1)
  })

  it('deletes at most 500 per transaction and 5000 per invocation', async () => {
    const p = await withTenant(first.id, () =>
      ds.getRepository(AttendancePolicy).findOneByOrFail({}),
    )
    const values = []
    for (let i = 0; i < 5001; i++) {
      const stamp = new Date(Date.UTC(2010, 0, i + 1, 1))
      const day = stamp.toISOString().slice(0, 10)
      values.push([
        first.id,
        first.ownerId,
        day,
        'check_in',
        stamp,
        'Asia/Shanghai',
        p.id,
        JSON.stringify(policyValues),
        'native',
        'not_required',
        `bounded-retention-${i}-request`,
        'c'.repeat(64),
      ])
    }
    for (let i = 0; i < values.length; i += 500)
      await ds.query(
        'INSERT INTO oa_clock_record (tenant_id,user_id,work_date,action,punched_at,timezone,policy_id,policy_snapshot,source,validation_result,request_id,request_digest) VALUES ?',
        [values.slice(i, i + 500)],
      )
    const batches: number[] = []
    const original = EntityManager.prototype.query
    vi.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      const result = await original.apply(this, args)
      if (args[0].startsWith('DELETE FROM oa_clock_record WHERE tenant_id='))
        batches.push((args[1]?.length ?? 3) - 3)
      return result
    })
    expect(await run()).toEqual({ deleted: 5000 })
    expect(batches).toEqual(Array(10).fill(500))
    expect(await count()).toBe(1)
  })
  it('cleans only the default tenant when a single-tenant application still has customer tenant data in its database', async () => {
    await record()
    await record(second)
    const [owner] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_user WHERE tenant_id=? AND username=? AND deleted_at IS NULL',
      [DEFAULT_TENANT_ID, 'admin'],
    )
    const own = await record(
      { id: DEFAULT_TENANT_ID, ownerId: owner!.id },
      { workDate: '2025-01-02', punchedAt: new Date('2025-01-02T01:00:00Z') },
    )
    let off: NestExpressApplication | undefined
    try {
      off = await bootApp({ multiTenant: false })
      vi.spyOn(off.get(ClockTime), 'now').mockImplementation(() => new Date(now))
      const result = await off
        .get(ClsService)
        .run(() =>
          off!
            .get(ClockRetentionJob)
            .run({}, { signal: new AbortController().signal, log: () => {} }),
        )
      expect(result).toEqual({ deleted: 1 })
      const rows = await ds.query('SELECT id FROM oa_clock_record WHERE tenant_id=? AND id=?', [
        DEFAULT_TENANT_ID,
        own.id,
      ])
      expect(rows).toEqual([])
      expect(await count(first)).toBe(1)
      expect(await count(second)).toBe(1)
    } finally {
      await off?.close()
      await ds.query('DELETE FROM oa_clock_record WHERE tenant_id=? AND id=?', [
        DEFAULT_TENANT_ID,
        own.id,
      ])
    }
  })
})
