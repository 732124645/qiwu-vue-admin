import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  attendancePolicyPerms,
  attendanceSitePerms,
  clockPerms,
  attendancePolicyCreate,
  attendancePolicyUpdate,
  attendanceSiteCreate,
  attendanceSiteUpdate,
  attendanceTimezone,
  clockPunch,
  clockMyQuery,
  clockQuery,
  clockRecordVo,
} from '@qiwu/shared'
import type { DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { dataScopeOf } from '../../src/core/data-scope/data-scope.js'
import { assertReferencesLive } from '../../src/core/db/references.js'
import {
  seedOaAttendance,
  seedOaAttendanceMenus,
} from '../../src/db/seeds/project/oa-attendance.seed.js'
import { runTenantSeeds } from '../../src/db/seeds/index.js'
import { AttendancePolicy } from '../../src/modules/oa/attendance/policy.entity.js'
import { AttendanceSite } from '../../src/modules/oa/attendance/site.entity.js'
import { ClockRecord } from '../../src/modules/oa/attendance/clock-record.entity.js'
import { bootApp, createTenant, inTenant1, type TestTenant } from '../setup/tenants.js'

let app: NestExpressApplication
let ds: DataSource
let first: TestTenant
let second: TestTenant
let seq = 0
const policyFields = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  locationMode: 'none' as const,
  retentionDays: 180,
}
const siteFields = {
  name: 'Main office',
  latitude: '31.230416',
  longitude: '121.473701',
  radiusM: 100,
  maxAccuracyM: 30,
  enabled: true,
}
const punch = { action: 'check_in' as const, requestId: 'clock-client-request-0001' }
const policyOf = (tenant: TestTenant) =>
  withTenant(tenant.id, () => ds.getRepository(AttendancePolicy).findOneByOrFail({}))

/** 只创建测试所需原始行，员工身份、时刻及工作日在后续打卡服务中才由服务端计算。 */
async function record(tenant: TestTenant, extra: Partial<ClockRecord> = {}) {
  const policy = await policyOf(tenant)
  return withTenant(tenant.id, () =>
    ds.getRepository(ClockRecord).save({
      userId: tenant.ownerId,
      deptId: null,
      workDate: '2026-10-22',
      action: 'check_in',
      punchedAt: new Date('2026-10-22T01:00:00.123Z'),
      timezone: 'Asia/Shanghai',
      policyId: policy.id,
      policySnapshot: policyFields,
      validationResult: 'not_required',
      source: 'native',
      requestId: `clock-client-${++seq}-request`,
      requestDigest: 'a'.repeat(64),
      ...extra,
    }),
  )
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  first = await createTenant(app)
  second = await createTenant(app)
})

afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('native attendance foundation', () => {
  it('initializes only one default policy per tenant without manufacturing clock records', async () => {
    for (const tenant of [first, second]) {
      expect(await policyOf(tenant)).toMatchObject(policyFields)
      await ds.transaction((q) => runTenantSeeds(q, tenant.id))
      await ds.transaction((q) => runTenantSeeds(q, tenant.id))
      await withTenant(tenant.id, async () => {
        expect(await ds.getRepository(AttendancePolicy).count()).toBe(1)
        expect(await ds.getRepository(AttendanceSite).count()).toBe(0)
        expect(await ds.getRepository(ClockRecord).count()).toBe(0)
        await expect(
          ds.getRepository(AttendancePolicy).save({ ...policyFields }),
        ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } })
      })
    }
  })

  it('loads tenant entities and departmental scope without storing employee coordinates', async () => {
    for (const entity of [AttendancePolicy, AttendanceSite, ClockRecord]) {
      const metadata = ds.getMetadata(entity)
      expect(metadata.findColumnWithDatabaseName('tenant_id')?.isNullable).toBe(false)
      expect(metadata.findColumnWithDatabaseName('deleted_at')).toBeDefined()
      expect(metadata.findColumnWithDatabaseName('alive')).toBeUndefined()
    }
    expect(dataScopeOf(ClockRecord)).toEqual({ dept: 'dept_id', owner: 'user_id' })
    const columns = await ds.query<{ name: string }[]>(
      'SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?',
      ['oa_clock_record'],
    )
    for (const forbidden of ['latitude', 'longitude', 'position', 'raw_position'])
      expect(columns.map((column) => column.name)).not.toContain(forbidden)
  })

  it('keeps policy, site and record reads and writes inside their current tenant', async () => {
    const policy = await policyOf(first)
    const site = await withTenant(first.id, () =>
      ds.getRepository(AttendanceSite).save({ ...siteFields, tenantId: second.id }),
    )
    const clock = await record(first, {
      tenantId: second.id,
      siteId: site.id,
      siteName: site.name,
      distanceM: 25,
      accuracyM: '5.25',
      validationResult: 'passed',
    })
    expect(site.tenantId).toBe(first.id)
    expect(clock.tenantId).toBe(first.id)
    await withTenant(second.id, async () => {
      expect(await ds.getRepository(AttendancePolicy).findOneBy({ id: policy.id })).toBeNull()
      expect(await ds.getRepository(AttendanceSite).findOneBy({ id: site.id })).toBeNull()
      expect(await ds.getRepository(ClockRecord).findOneBy({ id: clock.id })).toBeNull()
      expect(
        (await ds.getRepository(AttendanceSite).update(site.id, { name: 'Wrong tenant' })).affected,
      ).toBe(0)
      expect(
        (await ds.getRepository(ClockRecord).update(clock.id, { source: 'native' })).affected,
      ).toBe(0)
      const own = await ds.getRepository(AttendanceSite).save({ ...siteFields })
      expect(own.name).toBe(site.name)
    })
    await withTenant(first.id, async () => {
      const loaded = await ds.getRepository(AttendanceSite).findOneByOrFail({ id: site.id })
      const loadedClock = await ds.getRepository(ClockRecord).findOneByOrFail({ id: clock.id })
      expect(loaded.latitude).toBe('31.230416')
      expect(loaded.longitude).toBe('121.473701')
      expect(loaded.name).toBe(siteFields.name)
      expect(loadedClock.workDate).toBe('2026-10-22')
      expect(loadedClock.punchedAt.toISOString()).toBe('2026-10-22T01:00:00.123Z')
      expect(loadedClock.accuracyM).toBe('5.25')
    })
  })

  it('enforces persistent action and request identity uniqueness while soft deletion releases both', async () => {
    const original = await record(first, {
      workDate: '2026-10-23',
      requestId: 'clock-request-unique-0001',
    })
    await expect(
      record(first, { workDate: '2026-10-23', requestId: 'clock-request-unique-0002' }),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } })
    await expect(
      record(first, { workDate: '2026-10-24', requestId: original.requestId }),
    ).rejects.toMatchObject({ driverError: { code: 'ER_DUP_ENTRY' } })
    await record(first, {
      workDate: '2026-10-23',
      action: 'check_out',
      requestId: 'clock-request-unique-0003',
    })
    await withTenant(first.id, async () => {
      const uniqueSite = { ...siteFields, name: 'Unique office' }
      await ds.getRepository(AttendanceSite).save({ ...uniqueSite })
      await expect(ds.getRepository(AttendanceSite).save({ ...uniqueSite })).rejects.toMatchObject({
        driverError: { code: 'ER_DUP_ENTRY' },
      })
      await ds.getRepository(ClockRecord).softDelete(original.id)
    })
    const replacement = await record(first, {
      workDate: '2026-10-23',
      requestId: original.requestId,
    })
    expect(replacement.id).not.toBe(original.id)
  })

  it('checks every registered user, department, policy and site reference against live tenant rows', async () => {
    await withTenant(first.id, async () => {
      for (const field of ['userId', 'deptId', 'policyId', 'siteId'])
        await expect(
          ds.transaction((q) =>
            assertReferencesLive(q, 'oa_clock_record', { [field]: Number.MAX_SAFE_INTEGER }),
          ),
        ).rejects.toMatchObject({ status: 404 })
    })
  })

  it('preserves edited, disabled and deleted policies when tenant seeds run again', async () => {
    const policy = await policyOf(first)
    await withTenant(first.id, async () => {
      await ds.getRepository(AttendancePolicy).update(policy.id, {
        enabled: false,
        timezone: 'UTC',
        locationMode: 'site',
        retentionDays: 90,
      })
      await ds.transaction(seedOaAttendance)
      expect(
        await ds.getRepository(AttendancePolicy).findOneByOrFail({ id: policy.id }),
      ).toMatchObject({ enabled: false, timezone: 'UTC', locationMode: 'site', retentionDays: 90 })
      await ds.getRepository(AttendancePolicy).softDelete(policy.id)
      await ds.transaction(seedOaAttendance)
      expect(await ds.getRepository(AttendancePolicy).count()).toBe(0)
      expect(await ds.getRepository(AttendancePolicy).count({ withDeleted: true })).toBe(1)
    })
    expect(await policyOf(second)).toMatchObject(policyFields)
  })

  it('keeps administrator action edits and does not recreate permissions below a deleted group', async () => {
    const [group] = await ds.query<{ id: number; deleted_at: Date | null }[]>(
      'SELECT id, deleted_at FROM iam_menu WHERE route_name = ?',
      ['oa'],
    )
    const [action] = await ds.query<
      { id: number; name: string; sort_no: number; deleted_at: Date | null }[]
    >('SELECT id, name, sort_no, deleted_at FROM iam_menu WHERE perms = ?', [
      'oa.attendance-policy.modify',
    ])
    expect(action).toBeDefined()
    const declaredPerms = [clockPerms, attendancePolicyPerms, attendanceSitePerms].flatMap(
      (perms) => Object.values(perms),
    )
    const permissionRows = await ds.query<{ id: number; perms: string }[]>(
      'SELECT id, perms FROM iam_menu WHERE kind = ? AND perms IN (?) AND deleted_at IS NULL',
      ['action', declaredPerms],
    )
    expect(new Set(permissionRows.map((permission) => permission.perms))).toEqual(
      new Set(declaredPerms),
    )
    const [grants] = await ds.query<{ n: number }[]>(
      'SELECT COUNT(*) AS n FROM iam_role_menus WHERE tenant_id = ? AND menu_id IN (?) AND deleted_at IS NULL',
      [first.id, permissionRows.map((permission) => permission.id)],
    )
    expect(Number(grants.n)).toBe(0)
    const before = await ds.query(
      'SELECT id, name, deleted_at FROM iam_menu WHERE perms LIKE ? ORDER BY id',
      ['oa.attendance-%'],
    )
    await inTenant1(() => ds.transaction(seedOaAttendanceMenus))
    expect(
      await ds.query('SELECT id, name, deleted_at FROM iam_menu WHERE perms LIKE ? ORDER BY id', [
        'oa.attendance-%',
      ]),
    ).toEqual(before)
    try {
      await ds.query('UPDATE iam_menu SET name = ?, sort_no = ? WHERE id = ?', [
        'Live customized action',
        987,
        action.id,
      ])
      await inTenant1(() => ds.transaction(seedOaAttendanceMenus))
      const [live] = await ds.query<{ name: string; sort_no: number; deleted_at: Date | null }[]>(
        'SELECT name, sort_no, deleted_at FROM iam_menu WHERE id = ?',
        [action.id],
      )
      expect(live).toEqual({ name: 'Live customized action', sort_no: 987, deleted_at: null })
      await ds.query('UPDATE iam_menu SET name = ?, deleted_at = NOW(3) WHERE id = ?', [
        'Customized action',
        action.id,
      ])
      await inTenant1(() => ds.transaction(seedOaAttendanceMenus))
      const [kept] = await ds.query<{ name: string; deleted_at: Date | null }[]>(
        'SELECT name, deleted_at FROM iam_menu WHERE id = ?',
        [action.id],
      )
      expect(kept.name).toBe('Customized action')
      expect(kept.deleted_at).not.toBeNull()
      await ds.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE id = ?', [group.id])
      await ds.query('UPDATE iam_menu SET perms = ? WHERE id = ?', [
        'oa.attendance-policy.temporary',
        action.id,
      ])
      await inTenant1(() => ds.transaction(seedOaAttendanceMenus))
      expect(
        await ds.query('SELECT id FROM iam_menu WHERE perms = ?', ['oa.attendance-policy.modify']),
      ).toEqual([])
    } finally {
      await ds.query('DELETE FROM iam_menu WHERE perms = ? AND id <> ?', [
        'oa.attendance-policy.modify',
        action.id,
      ])
      await ds.query(
        'UPDATE iam_menu SET name = ?, sort_no = ?, perms = ?, deleted_at = ? WHERE id = ?',
        [action.name, action.sort_no, 'oa.attendance-policy.modify', action.deleted_at, action.id],
      )
      await ds.query('UPDATE iam_menu SET deleted_at = ? WHERE id = ?', [
        group.deleted_at,
        group.id,
      ])
    }
  })

  it('accepts only bounded IANA policy and precise site configuration fields', () => {
    expect(attendancePolicyCreate.parse(policyFields)).toEqual(policyFields)
    expect(attendancePolicyUpdate.parse({ enabled: false })).toEqual({ enabled: false })
    for (const timezone of [
      'UTC',
      'GMT',
      'CET',
      'Asia/Shanghai',
      'America/Los_Angeles',
      'Etc/GMT+8',
    ])
      expect(attendanceTimezone.safeParse(timezone).success).toBe(true)
    for (const timezone of ['+08:00', 'Invalid/Zone', 'UTC+8', 'Asia/Shanghai\u0000'])
      expect(attendanceTimezone.safeParse(timezone).success).toBe(false)
    for (const retentionDays of [29, 731])
      expect(attendancePolicyUpdate.safeParse({ retentionDays }).success).toBe(false)
    for (const retentionDays of [30, 730])
      expect(attendancePolicyUpdate.safeParse({ retentionDays }).success).toBe(true)
    for (const key of ['id', 'tenantId', 'createdBy', 'updatedBy', 'source']) {
      expect(attendancePolicyCreate.safeParse({ ...policyFields, [key]: 1 }).success).toBe(false)
      expect(attendancePolicyUpdate.safeParse({ [key]: 1 }).success).toBe(false)
      expect(attendanceSiteCreate.safeParse({ ...siteFields, [key]: 1 }).success).toBe(false)
      expect(attendanceSiteUpdate.safeParse({ [key]: 1 }).success).toBe(false)
    }
    expect(
      attendanceSiteCreate.parse({ ...siteFields, latitude: '-0.1', longitude: '120' }),
    ).toMatchObject({ latitude: '-0.100000', longitude: '120.000000' })
    for (const latitude of ['90.000001', '-90.000001', '1.1234567', '1e1', '01', 31.230416])
      expect(attendanceSiteCreate.safeParse({ ...siteFields, latitude }).success).toBe(false)
    for (const longitude of ['180.000001', '-180.000001'])
      expect(attendanceSiteCreate.safeParse({ ...siteFields, longitude }).success).toBe(false)
    for (const radiusM of [49, 10001])
      expect(attendanceSiteUpdate.safeParse({ radiusM }).success).toBe(false)
    for (const radiusM of [50, 10000])
      expect(attendanceSiteUpdate.safeParse({ radiusM }).success).toBe(true)
    for (const maxAccuracyM of [4, 1001])
      expect(attendanceSiteUpdate.safeParse({ maxAccuracyM }).success).toBe(false)
    for (const maxAccuracyM of [5, 1000])
      expect(attendanceSiteUpdate.safeParse({ maxAccuracyM }).success).toBe(true)
  })

  it('rejects caller-chosen identity, time, day and source from punch inputs and my queries', () => {
    expect(clockPunch.parse(punch)).toEqual(punch)
    for (const key of [
      'id',
      'userId',
      'tenantId',
      'deptId',
      'workDate',
      'punchedAt',
      'timezone',
      'policyId',
      'policySnapshot',
      'source',
      'validationResult',
      'requestDigest',
      'siteName',
      'distanceM',
      'accuracyM',
    ])
      expect(clockPunch.safeParse({ ...punch, [key]: 'forged' }).success).toBe(false)
    for (const action of ['approve', 'check-in', 'CHECK_IN'])
      expect(clockPunch.safeParse({ ...punch, action }).success).toBe(false)
    for (const requestId of [
      'a'.repeat(15),
      'a'.repeat(65),
      'a'.repeat(15) + '!',
      'contains a space in id',
    ])
      expect(clockPunch.safeParse({ ...punch, requestId }).success).toBe(false)
    for (const requestId of ['a'.repeat(16), 'a'.repeat(64)])
      expect(clockPunch.safeParse({ ...punch, requestId }).success).toBe(true)
    const position = { siteId: 1, latitude: 31, longitude: 121, accuracyM: 10 }
    expect(clockPunch.safeParse({ ...punch, position }).success).toBe(true)
    for (const value of [
      { ...position, latitude: 90.1 },
      { ...position, longitude: -180.1 },
      { ...position, accuracyM: 0 },
      { ...position, accuracyM: 10001 },
      { ...position, userId: 2 },
    ])
      expect(clockPunch.safeParse({ ...punch, position: value }).success).toBe(false)
    for (const key of ['userId', 'deptId', 'tenantId', 'source'])
      expect(clockMyQuery.safeParse({ [key]: 2 }).success).toBe(false)
    expect(clockQuery.parse({ userId: '7', deptId: '8' })).toMatchObject({ userId: 7, deptId: 8 })
  })

  it('strips private digest and employee coordinates from record output contracts', () => {
    const output = clockRecordVo.parse({
      id: 1,
      userId: 2,
      deptId: null,
      workDate: '2026-10-22',
      action: 'check_in',
      punchedAt: '2026-10-22T01:00:00.123Z',
      timezone: 'Asia/Shanghai',
      policyId: 3,
      policySnapshot: policyFields,
      siteId: null,
      siteName: null,
      distanceM: null,
      accuracyM: null,
      validationResult: 'not_required',
      source: 'native',
      requestId: punch.requestId,
      requestDigest: 'private-digest',
      latitude: 31,
      longitude: 121,
      position: { latitude: 31, longitude: 121 },
    })
    for (const key of ['requestDigest', 'latitude', 'longitude', 'position'])
      expect(output).not.toHaveProperty(key)
  })
})
