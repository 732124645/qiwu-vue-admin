import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import request from 'supertest'
import { AppModule } from '../../src/app.module.js'
import { AuditWriter } from '../../src/core/audit/audit-writer.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'

describe('GET /api/health', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    app = moduleRef.createNestApplication({ logger: false })
    app.setGlobalPrefix('api')
    // a bound port: with init() alone supertest listens per request, and about 1 run in 40 hung
    await app.listen(0, '127.0.0.1')
  })

  afterEach(() => vi.restoreAllMocks())

  afterAll(() => app.close())

  it('public: MySQL and Redis up → 200 with each check', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200)
    expect(res.body).toMatchObject({
      code: 0,
      msg: 'ok',
      data: {
        status: 'ok',
        details: { db: { status: 'up' }, redis: { status: 'up' } },
      },
    })
  })

  it('a dependency down (Redis ping fails) → 503 error envelope, no internals, no API log rows', async () => {
    vi.spyOn(app.get<Redis>(REDIS), 'ping').mockRejectedValue(new Error('redis secret detail'))
    const audit = app.get(AuditWriter)
    const fault = vi.spyOn(audit, 'fault')
    const trace = vi.spyOn(audit, 'trace')
    const res = await request(app.getHttpServer()).get('/api/health').expect(503)
    expect(res.body).toMatchObject({ code: 'A0500', data: null })
    expect(JSON.stringify(res.body)).not.toContain('secret')
    // @SkipHttpTrace: neither the access log nor the error log (one row per probe otherwise)
    expect(fault).not.toHaveBeenCalled()
    expect(trace).not.toHaveBeenCalled()
  })
})
