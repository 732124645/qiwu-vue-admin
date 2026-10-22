import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ClsService } from 'nestjs-cls'
import {
  clockSummaryQuery,
  clockMySummaryQuery,
  clockSummaryPageVo,
  clockPerms,
} from '@qiwu/shared'
import request from 'supertest'
import { EntityManager, type DataSource } from 'typeorm'
import { clsSet } from '../../src/core/context/cls.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { ClockQueryService } from '../../src/modules/oa/attendance/clock-query.service.js'
import { ClockTime } from '../../src/modules/oa/attendance/clock-time.js'
import { clockDayBounds } from '../../src/modules/oa/attendance/clock-report-time.js'
import { ClockRecord } from '../../src/modules/oa/attendance/clock-record.entity.js'
import { AttendancePolicy } from '../../src/modules/oa/attendance/policy.entity.js'
import { Leave } from '../../src/modules/biz/leave/leave.entity.js'
import { OaTripRequest } from '../../src/modules/oa/trip/trip.entity.js'
import { WfTaskRow } from '../../src/modules/workflow/runtime/wf-runtime.entity.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  bootApp,
  createPackage,
  createTenant,
  signInDirect,
  type PeopledTenant,
} from '../setup/tenants.js'

let app: NestExpressApplication, ds: DataSource, first: PeopledTenant, second: PeopledTenant
const tokens: Record<string, string> = {}
let serial = 0
const DAY = '2026-11-01'
const policyValues = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  locationMode: 'none' as const,
  retentionDays: 180,
}
const http = (who: string, path: string) =>
  request(app.getHttpServer())
    .get('/api/oa/' + path)
    .set(bearer(tokens[who]!))
const summary = (who: string, query = '') => http(who, `clock-summaries?workDate=${DAY}&${query}`)
const ownSummary = (who: string, query = '') =>
  http(who, `clock-summaries/mine?workDate=${DAY}&${query}`)
async function record(
  tenant = first,
  userId = first.users.alice,
  deptId: number | null = first.deptId,
  extra: Partial<ClockRecord> = {},
) {
  return withTenant(tenant.id, async () => {
    const policy = await ds.getRepository(AttendancePolicy).findOneByOrFail({})
    return ds.getRepository(ClockRecord).save({
      userId,
      deptId,
      workDate: DAY,
      action: 'check_in',
      punchedAt: new Date(DAY + 'T01:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      policyId: policy.id,
      policySnapshot: policyValues,
      validationResult: 'not_required',
      source: 'native',
      requestId: `query-clock-${++serial}-request`,
      requestDigest: 'a'.repeat(64),
      ...extra,
    })
  })
}
async function absence(
  type: 'leave' | 'trip',
  userId = first.users.alice,
  deptId: number | null = first.deptId,
  extra: Record<string, unknown> = {},
) {
  return withTenant(first.id, () => {
    const base = {
      userId,
      deptId,
      startAt: new Date(DAY + 'T02:00:00Z'),
      endAt: new Date(DAY + 'T04:00:00Z'),
      state: 'approved' as const,
      reason: 'Private medical details',
      ...extra,
    }
    return type === 'leave'
      ? ds.getRepository(Leave).save({ ...base, leaveKind: 'personal', days: 1 })
      : ds
          .getRepository(OaTripRequest)
          .save({ ...base, destination: 'Private customer location', estimatedAmount: '9999.99' })
  })
}
const scoped = <T>(
  fn: () => T,
  scope = 'own_dept',
  perms: string[] = [clockPerms.browse, clockPerms.view],
) =>
  withTenant(first.id, () =>
    app.get(ClsService).run(() => {
      clsSet('principal', {
        userId: first.users.alice,
        tenantId: first.id,
        deptId: first.deptId,
        deptTreePath: `/${first.deptId}/`,
        roles: [{ code: 'reader', dataScope: scope as 'own_dept', perms }],
        perms,
      })
      clsSet('checkedPerm', { perms: [clockPerms.browse], all: false })
      return fn()
    }),
  )

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get(getDataSourceToken())
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at=NOW(3) WHERE tenant_id IN (?,?)', [
    first.id,
    second.id,
  ])
  for (const [who, id] of Object.entries({
    owner: first.ownerId,
    alice: first.users.alice,
    foreign: second.ownerId,
  }))
    tokens[who] = (await signInDirect(app, id))!.accessToken
  tokens.root = (await signIn(app)).accessToken
})
beforeEach(async () => {
  for (const table of ['oa_clock_record', 'biz_leave_request', 'oa_trip_request'])
    await ds.query(`DELETE FROM ${table} WHERE tenant_id IN (?,?)`, [first.id, second.id])
  vi.spyOn(app.get(ClockTime), 'now').mockReturnValue(new Date(DAY + 'T01:00:00Z'))
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('attendance history and daily activity', () => {
  it('returns safe original records and restricts both detail routes to their actual tenant and owner', async () => {
    const row = await record()
    const foreign = await record(second, second.ownerId, second.deptId)
    const page = (await http('owner', 'clock-records/admin').expect(200)).body.data
    expect(page.total).toBe(1)
    expect(page.items[0]).toMatchObject({
      id: row.id,
      userId: first.users.alice,
      employeeName: expect.any(String),
    })
    for (const hidden of ['requestDigest', 'tenantId', 'position', 'latitude', 'longitude'])
      expect(page.items[0]).not.toHaveProperty(hidden)
    await http('owner', `clock-records/admin/${row.id}`).expect(200)
    await http('alice', `clock-records/mine/${row.id}`).expect(200)
    await http('owner', `clock-records/mine/${row.id}`).expect(404)
    await http('foreign', `clock-records/mine/${row.id}`).expect(404)
    await http('foreign', `clock-records/admin/${row.id}`).expect(404)
    await http('owner', `clock-records/admin/${foreign.id}`).expect(404)
    await http('root', `clock-records/admin/${row.id}`).expect(404)
    expect(
      (await http('foreign', `clock-records/admin?userId=${first.users.alice}`).expect(200)).body
        .data.items,
    ).toEqual([])
  })

  it('requires separate browse and view permissions while signed-in employees retain their own summary', async () => {
    const row = await record()
    await http('alice', 'clock-records/admin').expect(403)
    await http('alice', `clock-records/admin/${row.id}`).expect(403)
    await summary('alice').expect(403)
    const own = (await ownSummary('alice').expect(200)).body.data
    expect(own.items[0].recordCount).toBe(1)
  })

  it('rejects a real package without the office feature even when it holds clock management permissions', async () => {
    const menuIds: number[] = []
    let limited: PeopledTenant | undefined
    let limitedPackage: Awaited<ReturnType<typeof createPackage>> | undefined
    try {
      // 独立权限动作不属于办公菜单组，验证功能检查不能被管理权限代替。
      for (const perm of Object.values(clockPerms)) {
        const result = await ds.query<{ insertId: number }>(
          "INSERT INTO iam_menu (parent_id,tree_path,kind,name,perms) VALUES (0,'/','action','Standalone clock permission',?)",
          [perm],
        )
        menuIds.push(Number(result.insertId))
      }
      limitedPackage = await createPackage(app, { menuIds })
      limited = await createTenant(app, { users: true, packageId: limitedPackage.id })
      await ds.query('UPDATE iam_user SET password_changed_at=NOW(3) WHERE id=? AND tenant_id=?', [
        limited.ownerId,
        limited.id,
      ])
      tokens.noOffice = (await signInDirect(app, limited.ownerId))!.accessToken
      const me = (
        await request(app.getHttpServer())
          .get('/api/auth/me')
          .set(bearer(tokens.noOffice))
          .expect(200)
      ).body.data
      expect(me.features).not.toContain('oa')
      expect(me.perms).toEqual(expect.arrayContaining(Object.values(clockPerms)))
      const row = await record(limited, limited.ownerId, limited.deptId)
      for (const path of [
        'clock-records/admin',
        `clock-records/admin/${row.id}`,
        `clock-records/mine/${row.id}`,
        `clock-summaries?workDate=${DAY}`,
        `clock-summaries/mine?workDate=${DAY}`,
      ])
        await http('noOffice', path).expect(404)
    } finally {
      await limited?.dispose()
      await limitedPackage?.dispose()
      if (menuIds.length) await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menuIds])
    }
  })

  it('keeps another employee raw-clock subject, name and totals out of my day summary', async () => {
    await record()
    await record(first, first.ownerId, null, { punchedAt: new Date(DAY + 'T03:00:00Z') })
    await ds.query('UPDATE iam_user SET display_name=? WHERE tenant_id=? AND id=?', [
      'Other employee private name',
      first.id,
      first.ownerId,
    ])
    try {
      const result = (await ownSummary('alice').expect(200)).body.data
      expect(result.total).toBe(1)
      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toMatchObject({
        userId: first.users.alice,
        deptId: first.deptId,
        recordCount: 1,
        checkIn: DAY + 'T01:00:00.000Z',
      })
      expect(JSON.stringify(result)).not.toContain('Other employee private name')
      expect(result.items.some((item: { userId: number }) => item.userId === first.ownerId)).toBe(
        false,
      )
    } finally {
      await ds.query('UPDATE iam_user SET display_name=? WHERE tenant_id=? AND id=?', [
        'owner',
        first.id,
        first.ownerId,
      ])
    }
  })

  it('keeps count and page in one snapshot when a pending trip is approved between the two reads', async () => {
    await record()
    const trip = (
      await request(app.getHttpServer())
        .post('/api/oa/trips')
        .set(bearer(tokens.owner!))
        .send({
          destination: 'North office',
          startAt: DAY + 'T02:00:00Z',
          endAt: DAY + 'T04:00:00Z',
          reason: 'Customer visit',
        })
        .expect(201)
    ).body.data
    expect(trip.state).toBe('in_review')
    const pendingTask = await withTenant(first.id, () =>
      ds
        .getRepository(WfTaskRow)
        .findOneByOrFail({ instanceId: trip.instanceId, nodeId: 'review', state: 'pending' }),
    )
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let paused = false
    const original = EntityManager.prototype.query
    const spy = vi.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['query']>
    ) {
      const result = await original.apply(this, args)
      if (
        !paused &&
        args[0].startsWith('SELECT COUNT(*) AS total FROM (') &&
        args[0].includes('oa_clock_record')
      ) {
        paused = true
        await gate
      }
      return result
    })
    const pending = summary('owner')
      .expect(200)
      .then((response) => response.body.data)
    try {
      await vi.waitFor(() => expect(paused).toBe(true), { timeout: 3000, interval: 10 })
      await request(app.getHttpServer())
        .post(`/api/wf/tasks/${pendingTask.id}/approve`)
        .set(bearer(tokens.owner!))
        .send({})
        .expect(200)
      expect(
        (
          await withTenant(first.id, () =>
            ds.getRepository(OaTripRequest).findOneByOrFail({ id: trip.id }),
          )
        ).state,
      ).toBe('approved')
      release()
      const stable = await pending
      expect(stable.total).toBe(1)
      expect(stable.items).toHaveLength(1)
      expect(stable.items[0]).toMatchObject({
        userId: first.users.alice,
        recordCount: 1,
        absenceCount: 0,
      })
      const current = (await summary('owner').expect(200)).body.data
      expect(current.total).toBe(2)
      expect(
        current.items.find((item: { userId: number }) => item.userId === first.ownerId),
      ).toMatchObject({ recordCount: 0, absenceCount: 1 })
    } finally {
      release()
      await pending.catch(() => {})
      spy.mockRestore()
    }
  })

  it('uses recorded department snapshots for every list, detail and absence branch after employees move', async () => {
    const visible = await record()
    const hidden = await record(first, first.users.alice, null, {
      action: 'check_out',
      punchedAt: new Date(DAY + 'T09:00:00Z'),
    })
    await absence('leave')
    await absence('trip', first.users.alice, null)
    await ds.query('UPDATE iam_user SET dept_id=NULL WHERE tenant_id=? AND id=?', [
      first.id,
      first.users.alice,
    ])
    try {
      const service = app.get(ClockQueryService)
      const page = await scoped(() => service.admin({ page: 1, pageSize: 20 }))
      expect(page.items.map((r) => r.id)).toEqual([visible.id])
      await expect(scoped(() => service.adminDetail(hidden.id))).rejects.toMatchObject({
        status: 404,
      })
      const result = await scoped(() => service.summary({ page: 1, pageSize: 20, workDate: DAY }))
      expect(result.total).toBe(1)
      expect(result.items[0]).toMatchObject({
        deptId: first.deptId,
        recordCount: 1,
        absenceCount: 1,
        checkOut: null,
      })
      expect(result.items[0]!.absences.map((a) => a.type)).toEqual(['leave'])
      const own = (await ownSummary('alice').expect(200)).body.data
      expect(
        own.items.reduce((sum: number, row: { recordCount: number }) => sum + row.recordCount, 0),
      ).toBe(2)
      expect(
        own.items.reduce((sum: number, row: { absenceCount: number }) => sum + row.absenceCount, 0),
      ).toBe(2)
    } finally {
      await ds.query('UPDATE iam_user SET dept_id=? WHERE tenant_id=? AND id=?', [
        first.deptId,
        first.id,
        first.users.alice,
      ])
    }
  })

  it('does not widen a checked narrow permission with an unrelated all-scope role', async () => {
    await record()
    await record(first, first.ownerId, null)
    const service = app.get(ClockQueryService)
    const result = await scoped(() => {
      clsSet('principal', {
        userId: first.users.alice,
        tenantId: first.id,
        deptId: first.deptId,
        deptTreePath: null,
        roles: [
          { code: 'clock-reader', dataScope: 'own_dept', perms: [clockPerms.browse] },
          { code: 'unrelated', dataScope: 'all', perms: ['iam.user.browse'] },
        ],
        perms: [clockPerms.browse, 'iam.user.browse'],
      })
      return service.summary({ page: 1, pageSize: 20, workDate: DAY })
    })
    expect(result.total).toBe(1)
    expect(result.items[0]!.userId).toBe(first.users.alice)
  })

  it('includes approved absence-only activity, clips coverage and never exposes private business payloads', async () => {
    const leave = await absence('leave', first.users.alice, first.deptId, {
      startAt: new Date('2026-10-31T00:00:00Z'),
      endAt: new Date('2026-11-02T00:00:00Z'),
    })
    await absence('trip', first.ownerId, null)
    await absence('leave', first.users.admin, first.deptId, { state: 'in_review' })
    const result = (await summary('owner').expect(200)).body.data
    expect(result.total).toBe(2)
    expect(clockSummaryPageVo.safeParse(result).success).toBe(true)
    const item = result.items.find((r: { userId: number }) => r.userId === first.users.alice)
    expect(item).toMatchObject({ recordCount: 0, checkIn: null, checkOut: null, absenceCount: 1 })
    expect(item.absences).toEqual([
      {
        type: 'leave',
        sourceId: leave.id,
        state: 'approved',
        startAt: result.dayStart,
        endAt: result.dayEnd,
      },
    ])
    expect(Object.keys(item.absences[0]).sort()).toEqual(
      ['type', 'sourceId', 'state', 'startAt', 'endAt'].sort(),
    )
    expect(
      (await summary('foreign', `userId=${first.users.alice}`).expect(200)).body.data.items,
    ).toEqual([])
  })

  it('reflects current approval state without altering the immutable punch and paginates activity subjects', async () => {
    const row = await record()
    const trip = await absence('trip')
    await absence('leave', first.ownerId, null)
    const before = (await summary('owner', 'pageSize=1').expect(200)).body.data
    expect(before.total).toBe(2)
    expect(before.items).toHaveLength(1)
    await withTenant(first.id, () =>
      ds.getRepository(OaTripRequest).update(trip.id, { state: 'canceled' }),
    )
    const after = (await ownSummary('alice').expect(200)).body.data.items[0]
    expect(after).toMatchObject({ recordCount: 1, absenceCount: 0, absences: [] })
    expect(
      (await http('alice', `clock-records/mine/${row.id}`).expect(200)).body.data.punchedAt,
    ).toBe(row.punchedAt.toISOString())
  })

  it('uses half-open absence day boundaries and consistent user/department filters', async () => {
    await absence('leave', first.users.alice, first.deptId, {
      startAt: new Date('2026-10-31T00:00:00Z'),
      endAt: new Date('2026-10-31T16:00:00Z'),
    })
    await absence('trip', first.ownerId, null, {
      startAt: new Date('2026-11-01T16:00:00Z'),
      endAt: new Date('2026-11-02T16:00:00Z'),
    })
    expect((await summary('owner').expect(200)).body.data.total).toBe(0)
    await record()
    await absence('trip')
    await absence('leave', first.ownerId, null)
    const filtered = (
      await summary('owner', `userId=${first.users.alice}&deptId=${first.deptId}`).expect(200)
    ).body.data
    expect(filtered.total).toBe(1)
    expect(filtered.items[0]).toMatchObject({
      userId: first.users.alice,
      deptId: first.deptId,
      recordCount: 1,
      absenceCount: 1,
    })
    expect(
      (await summary('root', `userId=${first.users.alice}`).expect(200)).body.data.items,
    ).toEqual([])
  })

  it('returns one zero-activity own row and no fabricated full employee roster', async () => {
    expect((await summary('owner').expect(200)).body.data).toMatchObject({ total: 0, items: [] })
    const mine = (await ownSummary('alice').expect(200)).body.data
    expect(mine.total).toBe(1)
    expect(mine.items).toHaveLength(1)
    expect(mine.items[0]).toMatchObject({
      userId: first.users.alice,
      recordCount: 0,
      absenceCount: 0,
      absences: [],
      checkIn: null,
      checkOut: null,
    })
    expect((await ownSummary('alice', 'page=2').expect(200)).body.data.items).toEqual([])
  })

  it('caps absence output with an exact count and explicit truncation', async () => {
    for (let i = 0; i < 23; i++) await absence(i % 2 ? 'leave' : 'trip')
    const item = (await ownSummary('alice').expect(200)).body.data.items[0]
    expect(item).toMatchObject({ absenceCount: 23, absencesTruncated: true })
    expect(item.absences).toHaveLength(20)
  })

  it('keeps stored work dates while using the requested DST-aware timezone for absence boundaries', async () => {
    await record(first, first.users.alice, first.deptId, { timezone: 'Asia/Tokyo' })
    const result = (await ownSummary('alice', 'timezone=America/New_York').expect(200)).body.data
    expect(result).toMatchObject({
      workDate: DAY,
      dayStart: '2026-11-01T04:00:00.000Z',
      dayEnd: '2026-11-02T05:00:00.000Z',
    })
    expect(result.items[0]).toMatchObject({ recordCount: 1, clockTimezones: ['Asia/Tokyo'] })
    expect(clockDayBounds('2026-03-08', 'America/New_York')).toEqual({
      start: new Date('2026-03-08T05:00:00Z'),
      end: new Date('2026-03-09T04:00:00Z'),
    })
    expect(
      clockDayBounds('2026-10-04', 'Australia/Lord_Howe').end.getTime() -
        clockDayBounds('2026-10-04', 'Australia/Lord_Howe').start.getTime(),
    ).toBe(23.5 * 3600000)
    expect(() => clockDayBounds('2011-12-30', 'Pacific/Apia')).toThrow()
  })

  it('rejects client identity and invalid day/timezone filters', async () => {
    for (const q of [
      'userId=1',
      'deptId=1',
      'timezone=not/a-zone',
      'workDate=2026-02-30',
      'pageSize=10000',
      'sort=-id',
    ]) {
      const path = q.startsWith('workDate=')
        ? 'clock-summaries/mine?' + q
        : `clock-summaries/mine?workDate=${DAY}&${q}`
      await http('alice', path).expect(400)
    }
    await summary('owner', 'userId=not-a-number').expect(400)
    await http('owner', 'clock-records/admin/invalid').expect(400)
    expect(clockMySummaryQuery.safeParse({ userId: 1 }).success).toBe(false)
    expect(clockSummaryQuery.safeParse({ timezone: 'Bad/Zone' }).success).toBe(false)
  })
})
