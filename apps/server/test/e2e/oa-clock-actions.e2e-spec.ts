import type { NestExpressApplication } from '@nestjs/platform-express'
import { getDataSourceToken } from '@nestjs/typeorm'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import { Repository, type DataSource } from 'typeorm'
import { withTenant } from '../../src/core/context/tenant.js'
import { clsSet } from '../../src/core/context/cls.js'
import { keyPattern } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ClockService } from '../../src/modules/oa/attendance/clock.service.js'
import { ClockTime, workDateAt } from '../../src/modules/oa/attendance/clock-time.js'
import { AttendancePolicyService } from '../../src/modules/oa/attendance/attendance-policy.service.js'
import { AttendancePolicy } from '../../src/modules/oa/attendance/policy.entity.js'
import { ClockRecord } from '../../src/modules/oa/attendance/clock-record.entity.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  bootApp,
  createPackage,
  createTenant,
  signInDirect,
  type PeopledTenant,
} from '../setup/tenants.js'
import { cleanRedis } from '../setup/redis.js'

let app: NestExpressApplication
let ds: DataSource
let first: PeopledTenant
let second: PeopledTenant
let redis: Redis
let now: Date
let seq = 0
let day = 0
const tokens: Record<string, string> = {}
const URL = '/api/oa/clock-records'
const uid = () => `clock-request-${String(++seq).padStart(12, '0')}`
const punch = (extra: object = {}) => ({ action: 'check_in' as const, requestId: uid(), ...extra })
const call = (who: string, method: 'get' | 'post', tail: string, body?: object) => {
  const req = request(app.getHttpServer())
    [method](URL + tail)
    .set(bearer(tokens[who]!))
  return body === undefined ? req : req.send(body)
}
const direct = <T>(userId: number, fn: () => T, tenant = first.id, extra = {}) =>
  withTenant(tenant, () =>
    app.get(ClsService).run(() => {
      clsSet('principal', {
        userId,
        tenantId: tenant,
        deptId: null,
        deptTreePath: null,
        roles: [],
        perms: [],
        ...extra,
      })
      return fn()
    }),
  )
const service = () => app.get(ClockService)
const policy = (extra: object) =>
  withTenant(first.id, () =>
    ds.getRepository(AttendancePolicy).update({ tenantId: first.id }, extra),
  )
async function clearThrottle() {
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 100 }))
    if (keys.length) await redis.unlink(keys)
}
async function blockedOn(table: string) {
  await vi.waitFor(
    async () => {
      const rows =
        await ds.query<{ Info: string | null; db: string | null }[]>('SHOW FULL PROCESSLIST')
      expect(
        rows.some(
          (row) =>
            row.Info?.startsWith('SELECT') &&
            row.Info.includes(table) &&
            row.db === process.env.DB_NAME,
        ),
      ).toBe(true)
    },
    { timeout: 3000, interval: 10 },
  )
}

beforeAll(async () => {
  app = await bootApp({ multiTenant: true })
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
  for (const [who, id] of Object.entries({
    owner: first.ownerId,
    other: first.users.alice,
    foreign: second.ownerId,
    device: first.ownerId,
  })) {
    const signed = await signInDirect(app, id)
    if (!signed) throw new Error('Clock fixture sign-in failed')
    tokens[who] = signed.accessToken
  }
  tokens.root = (await signIn(app)).accessToken
})
beforeEach(async () => {
  now = new Date(Date.UTC(2026, 10, ++day, 1, 0, 0, 123))
  vi.spyOn(app.get(ClockTime), 'now').mockImplementation(() => new Date(now))
  await policy({ enabled: true, timezone: 'Asia/Shanghai', locationMode: 'none' })
  await clearThrottle()
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('native employee clock actions', () => {
  it('uses server identity, current department, time and work date, with a safe explicit response', async () => {
    const [{ dept_id }] = await ds.query<{ dept_id: number }[]>(
      'SELECT dept_id FROM iam_user WHERE id = ? AND tenant_id = ?',
      [first.ownerId, first.id],
    )
    const body = punch()
    const result = (
      await call('owner', 'post', '/punch', body)
        .set('X-Timezone', 'America/Los_Angeles')
        .expect(201)
    ).body.data
    expect(result).toMatchObject({
      userId: first.ownerId,
      deptId: dept_id,
      action: 'check_in',
      punchedAt: now.toISOString(),
      workDate: workDateAt(now, 'Asia/Shanghai'),
      source: 'native',
      validationResult: 'not_required',
      siteSnapshot: null,
    })
    expect(result).not.toHaveProperty('requestDigest')
    expect(result).not.toHaveProperty('tenantId')
    expect(result).not.toHaveProperty('position')
    const today = (await call('owner', 'get', '/today').expect(200)).body.data
    expect(today).toMatchObject({
      serverAt: now.toISOString(),
      workDate: result.workDate,
      checkIn: result,
      checkOut: null,
    })
    expect(
      (await call('owner', 'get', '/mine?sort=-punchedAt').expect(200)).body.data.items,
    ).toContainEqual(result)
    expect(
      (await call('owner', 'get', `/requests/${body.requestId}`).expect(200)).body.data,
    ).toEqual(result)
  })

  it.each(['userId', 'deptId', 'source', 'workDate', 'punchedAt', 'timezone', 'requestDigest'])(
    'rejects client-chosen %s',
    async (field) => {
      await call(
        'owner',
        'post',
        '/punch',
        punch({ [field]: field === 'userId' ? first.users.alice : 'client-value' }),
      ).expect(400)
    },
  )

  it('keeps request results and lists strictly mine, including administrator and cross-tenant requests', async () => {
    const a = punch()
    const b = punch()
    const own = (await call('owner', 'post', '/punch', a).expect(201)).body.data
    const other = (await call('other', 'post', '/punch', b).expect(201)).body.data
    await call('other', 'get', `/requests/${a.requestId}`).expect(404)
    await call('owner', 'get', `/requests/${b.requestId}`).expect(404)
    await call('foreign', 'get', `/requests/${a.requestId}`).expect(404)
    await call('root', 'get', `/requests/${a.requestId}`).expect(404)
    expect(
      (await call('owner', 'get', '/mine?sort=-punchedAt').expect(200)).body.data.items.map(
        (r: { id: number }) => r.id,
      ),
    ).toContain(own.id)
    expect(
      (await call('owner', 'get', '/mine?sort=-punchedAt').expect(200)).body.data.items.map(
        (r: { id: number }) => r.id,
      ),
    ).not.toContain(other.id)
    expect(
      (await call('foreign', 'get', '/mine?sort=-punchedAt').expect(200)).body.data.items,
    ).toEqual([])
    expect((await call('foreign', 'get', '/today').expect(200)).body.data.checkIn).toBeNull()
    for (const query of [
      'userId=1',
      'deptId=1',
      'pageSize=100000',
      'action=made_up',
      'workDateFrom=wrong',
    ])
      await call('owner', 'get', '/mine?' + query).expect(400)
    await call('owner', 'get', '/requests/bad').expect(400)
    await call('owner', 'get', '/requests/unknown-request-identifier').expect(404)
    await request(app.getHttpServer())
      .post(URL + '/punch')
      .send(punch())
      .expect(401)
  })

  it('requires check-in first, a strictly later checkout and one action per local work day', async () => {
    await call('owner', 'post', '/punch', punch({ action: 'check_out' })).expect(422)
    await call('owner', 'post', '/punch', punch()).expect(201)
    await call('owner', 'post', '/punch', punch()).expect(409)
    await call('owner', 'post', '/punch', punch({ action: 'check_out' })).expect(422)
    now = new Date(now.getTime() + 1)
    await call('owner', 'post', '/punch', punch({ action: 'check_out' })).expect(201)
    await call('owner', 'post', '/punch', punch({ action: 'check_out' })).expect(409)
    const today = (await call('owner', 'get', '/today').expect(200)).body.data
    expect(today.checkIn.action).toBe('check_in')
    expect(today.checkOut.action).toBe('check_out')
    expect(
      (
        await call(
          'owner',
          'get',
          `/mine?action=check_out&workDateFrom=${today.workDate}&workDateTo=${today.workDate}`,
        ).expect(200)
      ).body.data.items,
    ).toHaveLength(1)
  })

  it('has persistent same-request idempotency independently from the short HTTP duplicate-submit guard', async () => {
    const body = punch()
    const one = (await call('owner', 'post', '/punch', body).expect(201)).body.data
    await call('owner', 'post', '/punch', body).expect(429)
    const two = await direct(first.ownerId, () => service().punch(body))
    expect(two).toEqual(one)
    expect((await call('device', 'post', '/punch', body).expect(201)).body.data).toEqual(one)
    await expect(
      direct(first.ownerId, () => service().punch({ ...body, action: 'check_out' })),
    ).rejects.toMatchObject({ err: { status: 409 } })
    await expect(
      direct(first.ownerId, () =>
        service().punch({
          ...body,
          position: { siteId: 123, latitude: 1, longitude: 2, accuracyM: 3 },
        }),
      ),
    ).rejects.toMatchObject({ err: { status: 409 } })
    expect(
      await withTenant(first.id, () =>
        ds.getRepository(ClockRecord).countBy({ requestId: body.requestId }),
      ),
    ).toBe(1)
  })

  it('retries across midnight and disabled rules return the original day without manufacturing a new punch', async () => {
    now = new Date('2026-11-30T15:59:59.999Z')
    const body = punch()
    const original = await direct(first.ownerId, () => service().punch(body))
    expect(original.workDate).toBe('2026-11-30')
    now = new Date('2026-11-30T16:00:00.001Z')
    await policy({ enabled: false, timezone: 'America/Los_Angeles' })
    expect(await direct(first.ownerId, () => service().punch(body))).toEqual(original)
    await expect(direct(first.ownerId, () => service().punch(punch()))).rejects.toMatchObject({
      err: { status: 422 },
    })
    await policy({ enabled: true, timezone: 'Asia/Shanghai' })
    await call('owner', 'post', '/punch', punch({ action: 'check_out' })).expect(422)
    expect((await call('owner', 'post', '/punch', punch()).expect(201)).body.data.workDate).toBe(
      '2026-12-01',
    )
  })

  it.each([
    ['America/Los_Angeles', '2026-12-01T00:30:00Z', '2026-11-30'],
    ['Pacific/Kiritimati', '2026-11-30T11:00:00Z', '2026-12-01'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01'],
  ])(
    'uses IANA workdays for %s including month and DST boundaries',
    async (timezone, at, expected) => {
      await policy({ timezone })
      now = new Date(at!)
      const result = await direct(first.users.alice, () => service().punch(punch()))
      expect(result.workDate).toBe(expected)
      expect(result.timezone).toBe(timezone)
    },
  )

  it('serializes two devices for a day action, and identical concurrent requests return one record', async () => {
    const body = punch()
    const [a, b] = await Promise.all([
      direct(first.ownerId, () => service().punch(body)),
      direct(first.ownerId, () => service().punch(body)),
    ])
    expect(a.id).toBe(b.id)
    now = new Date(now.getTime() + 1)
    const results = await Promise.allSettled([
      direct(first.ownerId, () => service().punch(punch({ action: 'check_out' }))),
      direct(first.ownerId, () => service().punch(punch({ action: 'check_out' }))),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason,
    ).toMatchObject({ err: { status: 409 } })
  })

  it('waits for the employee lock and reads server time after crossing midnight, with current department', async () => {
    now = new Date('2026-12-15T15:59:59.999Z')
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let pending: Promise<unknown> | undefined
    try {
      await runner.query('UPDATE iam_user SET dept_id = ? WHERE id = ? AND tenant_id = ?', [
        first.deptId,
        first.ownerId,
        first.id,
      ])
      pending = direct(first.ownerId, () => service().punch(punch()))
      await blockedOn('iam_user')
      now = new Date('2026-12-15T16:00:00.001Z')
      await runner.commitTransaction()
      expect(await pending).toMatchObject({
        workDate: '2026-12-16',
        deptId: first.deptId,
        punchedAt: now.toISOString(),
      })
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await pending?.catch(() => undefined)
      await runner.release()
    }
  })

  it('rejects an authenticated employee soft-deleted while their punch waits for the employee lock', async () => {
    const body = punch()
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let pending: Promise<request.Response> | undefined
    try {
      await runner.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
      pending = call('other', 'post', '/punch', body).then((response) => response)
      await blockedOn('iam_user')
      await runner.commitTransaction()
      expect((await pending).status).toBe(404)
      const [{ total }] = await ds.query<{ total: number }[]>(
        'SELECT COUNT(*) AS total FROM oa_clock_record WHERE request_id = ? AND user_id = ? AND tenant_id = ?',
        [body.requestId, first.users.alice, first.id],
      )
      expect(Number(total)).toBe(0)
      await expect(
        direct(first.users.alice, () => service().request(body.requestId)),
      ).rejects.toMatchObject({ status: 404 })
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await pending?.catch(() => undefined)
      await runner.release()
      await ds.query('UPDATE iam_user SET deleted_at = NULL WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
    }
  })

  it('takes the employee lock before configuration locks so a policy writer can finish while the employee is locked', async () => {
    now = new Date('2027-02-28T17:30:00.123Z')
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let pending: ReturnType<ClockService['punch']> | undefined
    let writer: Promise<unknown> | undefined
    try {
      await runner.query('SELECT id FROM iam_user WHERE id = ? AND tenant_id = ? FOR UPDATE', [
        first.ownerId,
        first.id,
      ])
      pending = direct(first.ownerId, () => service().punch(punch()))
      await blockedOn('iam_user')
      let completed = false
      writer = direct(first.ownerId, () =>
        app.get(AttendancePolicyService).update({ timezone: 'UTC' }),
      ).then((value) => {
        completed = true
        return value
      })
      // 真实写入必须在员工锁尚未释放时提交；错误的先配置后员工锁序会阻塞这个事务。
      await vi.waitFor(() => expect(completed).toBe(true), { timeout: 3000, interval: 10 })
      await blockedOn('iam_user')
      await runner.commitTransaction()
      expect(await pending).toMatchObject({
        timezone: 'UTC',
        workDate: '2027-02-28',
        punchedAt: now.toISOString(),
      })
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await Promise.allSettled([pending, writer])
      await runner.release()
    }
  })

  it('rechecks enabled employees inside the lock and refuses acting-tenant administrator identity', async () => {
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
      first.users.alice,
      first.id,
    ])
    try {
      await expect(direct(first.users.alice, () => service().punch(punch()))).rejects.toMatchObject(
        { status: 404 },
      )
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
    }
    await expect(
      direct(first.ownerId, () => service().punch(punch()), first.id, {
        actingTenantId: first.id,
        root: true,
      }),
    ).rejects.toMatchObject({ status: 404 })
    await request(app.getHttpServer())
      .post(`/api/iam/tenants/${first.id}/enter`)
      .set(bearer(tokens.root!))
      .send({ reason: 'Clock identity test' })
      .expect(200)
    try {
      await call('root', 'post', '/punch', punch()).expect(404)
      await call('root', 'get', '/today').expect(404)
      await call('root', 'get', '/mine').expect(404)
    } finally {
      await request(app.getHttpServer())
        .post('/api/iam/tenants/leave')
        .set(bearer(tokens.root!))
        .send({})
        .expect(200)
    }
  })

  it('enforces the office feature while clocking remains independent from workflow', async () => {
    const menus = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE deleted_at IS NULL AND (route_name = ? OR perms LIKE ?)',
      ['oa', 'oa.%'],
    )
    const officePackage = await createPackage(app, { menuIds: menus.map((row) => row.id) })
    const limited = await createTenant(app, { packageId: officePackage.id })
    const noOffice = await createTenant(app, { packageId: null })
    try {
      for (const tenant of [limited, noOffice])
        await ds.query(
          'UPDATE iam_user SET password_changed_at = NOW(3) WHERE id = ? AND tenant_id = ?',
          [tenant.ownerId, tenant.id],
        )
      tokens.limited = (await signInDirect(app, limited.ownerId))!.accessToken
      tokens.noOffice = (await signInDirect(app, noOffice.ownerId))!.accessToken
      await call('limited', 'post', '/punch', punch()).expect(201)
      for (const tail of ['/today', '/mine', '/requests/unknown-request-identifier'])
        await call('noOffice', 'get', tail).expect(404)
      await call('noOffice', 'post', '/punch', punch()).expect(404)
    } finally {
      await limited.dispose()
      await noOffice.dispose()
      await officePackage.dispose()
    }
  })

  it('limits by authenticated employee rather than shared IP or client-supplied tracker headers', async () => {
    for (let i = 0; i < 20; i++)
      await call('owner', 'post', '/punch', { action: 'invalid', requestId: uid() }).expect(400)
    await call('owner', 'post', '/punch', punch())
      .set('X-Forwarded-For', '203.0.113.9')
      .set('X-User-Id', String(first.users.alice))
      .expect(429)
    await call('other', 'post', '/punch', punch()).expect(201)
  })

  it('rolls back failures after inserting a punch, without losing its request identity', async () => {
    const original = Repository.prototype.save
    const body = punch()
    const fail = vi.spyOn(Repository.prototype, 'save').mockImplementation(async function (
      this: Repository<ClockRecord>,
      ...args: Parameters<typeof original>
    ) {
      const result = await Reflect.apply(original, this, args)
      if (this.target === ClockRecord) throw new Error('Clock save failed')
      return result
    } as typeof original)
    await expect(direct(first.ownerId, () => service().punch(body))).rejects.toThrow(
      'Clock save failed',
    )
    fail.mockRestore()
    await call('owner', 'get', `/requests/${body.requestId}`).expect(404)
    await call('owner', 'post', '/punch', body).expect(201)
  })
})
