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
import { ClockTime } from '../../src/modules/oa/attendance/clock-time.js'
import { AttendancePolicy } from '../../src/modules/oa/attendance/policy.entity.js'
import { AttendancePolicyService } from '../../src/modules/oa/attendance/attendance-policy.service.js'
import { AttendanceSiteService } from '../../src/modules/oa/attendance/attendance-site.service.js'
import { ClockRecord } from '../../src/modules/oa/attendance/clock-record.entity.js'
import { bearer } from '../setup/auth.js'
import { bootApp, createTenant, signInDirect, type PeopledTenant } from '../setup/tenants.js'
import { logOf } from '../setup/audit.js'
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
const POLICY = '/api/oa/attendance-policies/current'
const SITES = '/api/oa/attendance-sites'
const CLOCK = '/api/oa/clock-records'
const uid = () => `policy-request-${String(++seq).padStart(12, '0')}`
const punch = (extra: object = {}) => ({ action: 'check_in' as const, requestId: uid(), ...extra })
const siteBody = (extra: object = {}) => ({
  name: `Office ${++seq}`,
  latitude: '31.230416',
  longitude: '121.473701',
  radiusM: 100,
  maxAccuracyM: 30,
  enabled: true,
  ...extra,
})
const call = (
  who: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](path).set(bearer(tokens[who]!))
  return body === undefined ? req : req.send(body)
}
const direct = <T>(fn: () => T) =>
  withTenant(first.id, () =>
    app.get(ClsService).run(() => {
      clsSet('principal', {
        userId: first.ownerId,
        tenantId: first.id,
        deptId: null,
        deptTreePath: null,
        roles: [],
        perms: [],
      })
      return fn()
    }),
  )
const policy = (extra: object) =>
  withTenant(first.id, () =>
    ds.getRepository(AttendancePolicy).update({ tenantId: first.id }, extra),
  )
const addSite = async (extra = {}) =>
  (await call('owner', 'post', SITES, siteBody(extra)).expect(201)).body.data
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
    employee: first.users.alice,
    foreign: second.ownerId,
  })) {
    const signed = await signInDirect(app, id)
    if (!signed) throw new Error('Policy fixture sign-in failed')
    tokens[who] = signed.accessToken
  }
})
beforeEach(async () => {
  now = new Date(Date.UTC(2027, 0, ++day, 1, 0, 0, 123))
  vi.spyOn(app.get(ClockTime), 'now').mockImplementation(() => new Date(now))
  await policy({ enabled: true, timezone: 'Asia/Shanghai', locationMode: 'none' })
  for await (const keys of redis.scanIterator({ MATCH: keyPattern('throttle'), COUNT: 100 }))
    if (keys.length) await redis.unlink(keys)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  await app?.close()
})

describe('attendance policy and office sites', () => {
  it('exposes only the current tenant policy, validates strict changes and preserves the single row', async () => {
    const original = (await call('owner', 'get', POLICY).expect(200)).body.data
    const foreign = (await call('foreign', 'get', POLICY).expect(200)).body.data
    expect(foreign.id).not.toBe(original.id)
    expect(original).not.toHaveProperty('tenantId')
    const updated = (
      await call('owner', 'put', POLICY, {
        timezone: 'America/Los_Angeles',
        retentionDays: 365,
      }).expect(200)
    ).body.data
    expect(updated).toMatchObject({
      id: original.id,
      timezone: 'America/Los_Angeles',
      retentionDays: 365,
    })
    expect((await call('foreign', 'get', POLICY).expect(200)).body.data.timezone).toBe(
      'Asia/Shanghai',
    )
    for (const body of [
      { timezone: 'Bad/Zone' },
      { timezone: '+08:00' },
      { locationMode: 'fallback' },
      { retentionDays: 1 },
      { tenantId: second.id },
      { id: foreign.id },
      { enabled: 'true' },
    ])
      await call('owner', 'put', POLICY, body).expect(400)
    await call('owner', 'post', '/api/oa/attendance-policies', { enabled: true }).expect(404)
    expect(await withTenant(first.id, () => ds.getRepository(AttendancePolicy).count())).toBe(1)
    for (const method of ['get', 'put'] as const)
      await call(
        'employee',
        method,
        POLICY,
        method === 'put' ? { enabled: false } : undefined,
      ).expect(403)
    expect(
      (await call('owner', 'get', POLICY + '?tenantId=' + second.id).expect(200)).body.data.id,
    ).toBe(original.id)
  })

  it('supports tenant-isolated site CRUD, enabled employee options and bounded strict lists', async () => {
    const a = await addSite()
    const b = await addSite({ enabled: false })
    const foreign = (await call('foreign', 'post', SITES, siteBody()).expect(201)).body.data
    expect(a).toMatchObject({ latitude: '31.230416', longitude: '121.473701' })
    expect(a).not.toHaveProperty('tenantId')
    await call('owner', 'put', `${SITES}/${a.id}`, { name: 'Updated office', radiusM: 150 }).expect(
      200,
    )
    expect((await call('owner', 'get', `${SITES}/${a.id}`).expect(200)).body.data).toMatchObject({
      name: 'Updated office',
      radiusM: 150,
    })
    const options = (
      await call('employee', 'get', SITES + '/options?pageSize=1&name=Updated').expect(200)
    ).body.data
    expect(options.total).toBe(1)
    expect(options.items).toHaveLength(1)
    expect(options.items[0]).toMatchObject({ id: a.id, name: 'Updated office' })
    expect(options.items[0]).not.toHaveProperty('createdAt')
    expect(options.items[0]).not.toHaveProperty('enabled')
    expect(
      (await call('employee', 'get', SITES + '/options').expect(200)).body.data.items.map(
        (r: { id: number }) => r.id,
      ),
    ).not.toContain(b.id)
    expect(
      (await call('owner', 'get', SITES).expect(200)).body.data.items.map(
        (r: { id: number }) => r.id,
      ),
    ).not.toContain(foreign.id)
    for (const method of ['get', 'put', 'delete'] as const)
      await call(
        'owner',
        method,
        `${SITES}/${foreign.id}`,
        method === 'put' ? { name: 'Cannot edit' } : undefined,
      ).expect(404)
    await call('foreign', 'get', `${SITES}/${a.id}`).expect(404)
    await call('owner', 'delete', `${SITES}/${b.id}`).expect(200)
    await call('owner', 'get', `${SITES}/${b.id}`).expect(404)
    for (const query of ['pageSize=99999', 'enabled=false', 'tenantId=1', 'sort=password'])
      await call('employee', 'get', SITES + '/options?' + query).expect(400)
    for (const method of ['get', 'post'] as const)
      await call('employee', method, SITES, method === 'post' ? siteBody() : undefined).expect(403)
    for (const method of ['get', 'put', 'delete'] as const)
      await call(
        'employee',
        method,
        `${SITES}/${a.id}`,
        method === 'put' ? { name: 'Cannot edit' } : undefined,
      ).expect(403)
    await call('owner', 'post', SITES, siteBody({ latitude: '91' })).expect(400)
    await call('owner', 'post', SITES, siteBody({ longitude: '181' })).expect(400)
    await call('owner', 'post', SITES, siteBody({ latitude: '1.0000001' })).expect(400)
    await call('owner', 'post', SITES, siteBody({ radiusM: 1 })).expect(400)
    await call('owner', 'post', SITES, siteBody({ tenantId: second.id })).expect(400)
    await call('owner', 'put', `${SITES}/${a.id}`, { latitude: 'bad' }).expect(400)
    await call('owner', 'get', SITES + '?enabled=invalid').expect(400)
  })

  it('uses live unique site names and allows recreating a removed unused name', async () => {
    const body = siteBody()
    const site = (await call('owner', 'post', SITES, body).expect(201)).body.data
    await call('owner', 'post', SITES, { ...body, latitude: '1.000000' }).expect(409)
    const another = await addSite()
    await call('owner', 'put', `${SITES}/${another.id}`, { name: body.name }).expect(409)
    await call('owner', 'delete', `${SITES}/${site.id}`).expect(200)
    // 不用同一个 HTTP body 命中三秒重复提交键，持久唯一性已由上面的不同 body 反证。
    await call('owner', 'post', SITES, { ...body, radiusM: 101 }).expect(201)
  })

  it('requires location under site policy and rejects disabled, unknown or foreign sites without fallback', async () => {
    const site = await addSite({ enabled: false })
    const foreign = (await call('foreign', 'post', SITES, siteBody()).expect(201)).body.data
    await policy({ locationMode: 'site' })
    await call('employee', 'post', CLOCK + '/punch', punch()).expect(422)
    const position = { siteId: site.id, latitude: 31.230416, longitude: 121.473701, accuracyM: 10 }
    await call('employee', 'post', CLOCK + '/punch', punch({ position })).expect(422)
    await call(
      'employee',
      'post',
      CLOCK + '/punch',
      punch({ position: { ...position, siteId: foreign.id } }),
    ).expect(404)
    await call(
      'employee',
      'post',
      CLOCK + '/punch',
      punch({ position: { ...position, siteId: 99999999 } }),
    ).expect(404)
    await call('owner', 'put', `${SITES}/${site.id}`, { enabled: true }).expect(200)
    expect(
      (await call('employee', 'post', CLOCK + '/punch', punch({ position })).expect(201)).body.data,
    ).toMatchObject({
      validationResult: 'passed',
      siteId: site.id,
      distanceM: 0,
      accuracyM: '10.00',
    })
    expect(
      await withTenant(first.id, () =>
        ds
          .getRepository(ClockRecord)
          .countBy({ userId: first.users.alice, workDate: now.toISOString().slice(0, 10) }),
      ),
    ).toBe(1)
  })

  it.each([
    { latitude: 91 },
    { latitude: -91 },
    { longitude: 181 },
    { longitude: -181 },
    { accuracyM: 0 },
    { accuracyM: 10001 },
    { siteId: -1 },
    { coordinateSystem: 'gcj02' },
  ])('rejects malformed position %j', async (extra) => {
    await call(
      'employee',
      'post',
      CLOCK + '/punch',
      punch({ position: { siteId: 1, latitude: 1, longitude: 2, accuracyM: 10, ...extra } }),
    ).expect(400)
  })

  it('checks accuracy thresholds and unrounded haversine distance at the office radius boundary', async () => {
    const site = await addSite({ latitude: '0', longitude: '0', radiusM: 50, maxAccuracyM: 10 })
    await policy({ locationMode: 'site' })
    const position = { siteId: site.id, latitude: 0, longitude: 0, accuracyM: 10 }
    await call(
      'employee',
      'post',
      CLOCK + '/punch',
      punch({ position: { ...position, accuracyM: 10.001 } }),
    ).expect(422)
    const latitudeAt = (m: number) => ((m / 6371008.8) * 180) / Math.PI
    await call(
      'employee',
      'post',
      CLOCK + '/punch',
      punch({ position: { ...position, latitude: latitudeAt(50.1) } }),
    ).expect(422)
    const result = (
      await call(
        'employee',
        'post',
        CLOCK + '/punch',
        punch({ position: { ...position, latitude: latitudeAt(49.999) } }),
      ).expect(201)
    ).body.data
    expect(result).toMatchObject({
      distanceM: 50,
      accuracyM: '10.00',
      siteSnapshot: { latitude: '0.000000', longitude: '0.000000', radiusM: 50 },
    })
  })

  it('keeps configuration snapshots stable after office changes, without storing employee coordinates in responses or logs', async () => {
    const site = await addSite()
    await policy({ locationMode: 'site' })
    const position = {
      siteId: site.id,
      latitude: 31.230421123,
      longitude: 121.473712345,
      accuracyM: 10.123,
    }
    const body = punch({ position })
    const trace = `native-clock-${process.pid}-${++seq}`
    const response = await call('owner', 'post', CLOCK + '/punch', body)
      .set('X-Request-Id', trace)
      .expect(201)
    const result = response.body.data
    expect(result).not.toHaveProperty('requestDigest')
    expect(result.siteSnapshot).toEqual({
      id: site.id,
      name: site.name,
      latitude: site.latitude,
      longitude: site.longitude,
      radiusM: site.radiusM,
      maxAccuracyM: site.maxAccuracyM,
    })
    expect(JSON.stringify(result)).not.toContain(String(position.latitude))
    expect(JSON.stringify(result)).not.toContain(String(position.longitude))
    const action = await logOf(ds, trace)
    const http = await logOf(ds, trace, 'aud_http_trace')
    expect(action).not.toBeNull()
    expect(http).not.toBeNull()
    for (const log of [action, http]) {
      const encoded = JSON.stringify(log)
      expect(encoded).not.toContain(String(position.latitude))
      expect(encoded).not.toContain(String(position.longitude))
      expect(encoded).not.toContain('requestDigest')
      expect(encoded).toContain('***')
    }
    const stored = await withTenant(first.id, () =>
      ds.getRepository(ClockRecord).findOneByOrFail({ id: result.id }),
    )
    expect(stored.requestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(String(position.latitude))
    expect(JSON.stringify(stored)).not.toContain(String(position.longitude))
    await call('owner', 'put', `${SITES}/${site.id}`, {
      latitude: '32',
      name: 'Moved office',
      radiusM: 200,
    }).expect(200)
    await call('owner', 'put', POLICY, { locationMode: 'none', timezone: 'UTC' }).expect(200)
    expect(
      (await call('owner', 'get', `${CLOCK}/requests/${body.requestId}`).expect(200)).body.data,
    ).toEqual(result)
    await call('owner', 'delete', `${SITES}/${site.id}`).expect(409)
  })

  it('masks employee positions on rejected and malformed requests as well as successful punches', async () => {
    const site = await addSite()
    await policy({ locationMode: 'site' })
    for (const [extra, status] of [
      [{ latitude: 32.123456789 }, 422],
      [{ latitude: 91.123456789 }, 400],
    ] as const) {
      const position = {
        siteId: site.id,
        longitude: 121.987654321,
        accuracyM: 10,
        ...extra,
      }
      const trace = `native-refused-${process.pid}-${++seq}`
      const res = await call('owner', 'post', CLOCK + '/punch', punch({ position }))
        .set('X-Request-Id', trace)
        .expect(status)
      expect(JSON.stringify(res.body)).not.toContain(String(position.longitude))
      for (const table of ['aud_action_log', 'aud_http_trace'] as const) {
        const log = await logOf(ds, trace, table)
        expect(log).not.toBeNull()
        expect(JSON.stringify(log)).not.toContain(String(position.longitude))
        expect(JSON.stringify(log)).not.toContain(String(position.latitude))
      }
    }
  })

  it('masks position in the real HTTP fault record when server-side processing fails', async () => {
    const site = await addSite()
    await policy({ locationMode: 'site' })
    const position = {
      siteId: site.id,
      latitude: 31.230421123,
      longitude: 121.473712345,
      accuracyM: 10,
    }
    const trace = `native-fault-${process.pid}-${++seq}`
    vi.spyOn(app.get(ClockTime), 'now').mockImplementationOnce(() => {
      throw new Error('Clock unavailable')
    })
    await call('owner', 'post', CLOCK + '/punch', punch({ position }))
      .set('X-Request-Id', trace)
      .expect(500)
    for (const table of ['aud_action_log', 'aud_http_trace', 'aud_http_fault'] as const) {
      const log = await logOf(ds, trace, table)
      expect(log).not.toBeNull()
      expect(JSON.stringify(log)).not.toContain(String(position.latitude))
      expect(JSON.stringify(log)).not.toContain(String(position.longitude))
      expect(JSON.stringify(log)).toContain('***')
    }
  })

  it('masks misplaced employee coordinates on rejected requests without masking office configuration logs', async () => {
    const latitude = 31.23456789123
    const longitude = 121.98765432123
    const trace = `native-top-level-${process.pid}-${++seq}`
    await call(
      'owner',
      'post',
      CLOCK + '/punch',
      punch({ latitude, longitude, legacy: { latitude, longitude } }),
    )
      .set('X-Request-Id', trace)
      .expect(400)
    for (const table of ['aud_action_log', 'aud_http_trace'] as const) {
      const log = await logOf(ds, trace, table)
      expect(log).not.toBeNull()
      expect(JSON.stringify(log)).not.toContain(String(latitude))
      expect(JSON.stringify(log)).not.toContain(String(longitude))
      expect(JSON.stringify(log)).toContain('***')
    }
    const officeTrace = `native-office-${process.pid}-${++seq}`
    const office = siteBody({ latitude: '31.234567', longitude: '121.987654' })
    await call('owner', 'post', SITES, office).set('X-Request-Id', officeTrace).expect(201)
    for (const table of ['aud_action_log', 'aud_http_trace'] as const) {
      const log = await logOf(ds, officeTrace, table)
      expect(log).not.toBeNull()
      expect(JSON.stringify(log)).toContain(office.latitude)
      expect(JSON.stringify(log)).toContain(office.longitude)
    }
  })

  it.each(['policy', 'site'] as const)(
    'samples time after a %s writer lock wait crosses midnight',
    async (kind) => {
      const site = kind === 'site' ? await addSite() : null
      if (site) await policy({ locationMode: 'site' })
      const boundary = site ? '2027-04-30' : '2027-03-31'
      now = new Date(`${boundary}T15:59:59.999Z`)
      const runner = ds.createQueryRunner()
      await runner.connect()
      await runner.startTransaction()
      let pending: ReturnType<ClockService['punch']> | undefined
      try {
        if (site)
          await runner.query(
            'UPDATE oa_attendance_site SET radius_m = 101 WHERE id = ? AND tenant_id = ?',
            [site.id, first.id],
          )
        else
          await runner.query(
            'UPDATE oa_attendance_policy SET retention_days = 181 WHERE tenant_id = ?',
            [first.id],
          )
        const body = punch(
          site
            ? {
                position: {
                  siteId: site.id,
                  latitude: 31.230416,
                  longitude: 121.473701,
                  accuracyM: 10,
                },
              }
            : {},
        )
        pending = direct(() => app.get(ClockService).punch(body))
        await blockedOn(site ? 'oa_attendance_site' : 'oa_attendance_policy')
        expect(app.get(ClockTime).now).not.toHaveBeenCalled()
        now = new Date(`${boundary}T16:00:00.001Z`)
        await runner.commitTransaction()
        expect(await pending).toMatchObject({
          punchedAt: now.toISOString(),
          workDate: site ? '2027-05-01' : '2027-04-01',
        })
      } finally {
        if (runner.isTransactionActive) await runner.rollbackTransaction()
        await pending?.catch(() => undefined)
        await runner.release()
      }
    },
  )

  it('waits for a policy writer and uses the committed current rule instead of an old snapshot', async () => {
    const row = await withTenant(first.id, () =>
      ds.getRepository(AttendancePolicy).findOneByOrFail({}),
    )
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let result: Promise<unknown> | undefined
    try {
      await runner.query(
        'UPDATE oa_attendance_policy SET enabled = 0 WHERE id = ? AND tenant_id = ?',
        [row.id, first.id],
      )
      result = direct(() => app.get(ClockService).punch(punch())).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      await blockedOn('oa_attendance_policy')
      await runner.commitTransaction()
      expect(await result).toMatchObject({
        error: { err: { status: 422, key: 'validation.oa.clock_disabled' } },
      })
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await result
      await runner.release()
    }
  })

  it('waits for a site writer and rechecks committed enabled status', async () => {
    const site = await addSite()
    await policy({ locationMode: 'site' })
    const runner = ds.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    let result: Promise<unknown> | undefined
    try {
      await runner.query(
        'UPDATE oa_attendance_site SET enabled = 0 WHERE id = ? AND tenant_id = ?',
        [site.id, first.id],
      )
      result = direct(() =>
        app.get(ClockService).punch(
          punch({
            position: {
              siteId: site.id,
              latitude: 31.230416,
              longitude: 121.473701,
              accuracyM: 10,
            },
          }),
        ),
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      await blockedOn('oa_attendance_site')
      await runner.commitTransaction()
      expect(await result).toMatchObject({
        error: { err: { status: 422, key: 'validation.oa.clock_site_disabled' } },
      })
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction()
      await result
      await runner.release()
    }
  })

  it('holds policy and site read locks through save, so concurrent configuration changes wait for the punch snapshot', async () => {
    const site = await addSite()
    await policy({ locationMode: 'site' })
    let reached!: () => void
    let release!: () => void
    const saving = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = Repository.prototype.save
    const hold = vi.spyOn(Repository.prototype, 'save').mockImplementation(async function (
      this: Repository<ClockRecord>,
      ...args: Parameters<typeof original>
    ) {
      if (this.target === ClockRecord) {
        reached()
        await gate
      }
      return Reflect.apply(original, this, args)
    } as typeof original)
    const pending = direct(() =>
      app.get(ClockService).punch(
        punch({
          position: {
            siteId: site.id,
            latitude: 31.230416,
            longitude: 121.473701,
            accuracyM: 10,
          },
        }),
      ),
    )
    let policyChange: Promise<unknown> | undefined
    let siteChange: Promise<unknown> | undefined
    try {
      await saving
      policyChange = direct(() =>
        app.get(AttendancePolicyService).update({ enabled: false, timezone: 'UTC' }),
      )
      siteChange = direct(() =>
        app
          .get(AttendanceSiteService)
          .change(site.id, { enabled: false, name: 'Changed after punch' }),
      )
      await blockedOn('oa_attendance_policy')
      await blockedOn('oa_attendance_site')
      release()
      const result = await pending
      expect(result.policySnapshot).toMatchObject({ enabled: true, timezone: 'Asia/Shanghai' })
      expect(result.siteSnapshot?.name).toBe(site.name)
      await Promise.all([policyChange, siteChange])
    } finally {
      release()
      await Promise.allSettled([pending, policyChange, siteChange])
      hold.mockRestore()
    }
  })
})
