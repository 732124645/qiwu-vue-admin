// core/logger (see docs/design-notes.md#audit): the process log masks requests like the API logs.
// The real pino-http options write to a captured stream; nothing the client sent as a secret (query
// values: key-named or plain-named like @Sensitive ones, Authorization, Cookie) nor a driver error's SQL
// parameters reaches the output.
import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { LoggerModule, PinoLogger } from 'nestjs-pino'
import request from 'supertest'
import { QueryFailedError } from 'typeorm'
import { AppConfigService, CoreConfigModule } from '../../src/core/config/config.module.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { pinoHttpOptions } from '../../src/core/logger/logger.module.js'

const lines: string[] = []

@Controller('log-probe')
class LogProbeController {
  constructor(private readonly logger: PinoLogger) {}

  @Get()
  probe() {
    this.logger.info('inside the handler')
    return 'ok'
  }

  @Get('db')
  db() {
    // what mysql2 rejects: its message quotes the value, `sql` inlines it, TypeORM adds `parameters`
    const message = "Incorrect integer value: 'VALUE-S3CRET' for column 'age' at row 1"
    const driver = Object.assign(new Error(message), {
      code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
      sqlState: 'HY000',
      sqlMessage: message,
      sql: "INSERT INTO t (age) VALUES ('SQL-S3CRET')",
    })
    const failed = new QueryFailedError('INSERT INTO t (age) VALUES (?)', ['PARAM-S3CRET'], driver)
    this.logger.error(failed)
    this.logger.error(new Error('import failed; token=TOKEN-S3CRET', { cause: failed }))
    return 'logged'
  }
}

let app: INestApplication

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      CoreConfigModule.forRoot(),
      CoreContextModule,
      LoggerModule.forRootAsync({
        inject: [AppConfigService],
        useFactory: (cfg: AppConfigService) => ({
          pinoHttp: [
            { ...pinoHttpOptions(cfg), level: 'info' },
            { write: (line: string) => void lines.push(line) },
          ],
        }),
      }),
    ],
    controllers: [LogProbeController],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.listen(0, '127.0.0.1')
})

afterAll(() => app?.close())

it('request lines keep the path and query names, never a query value or a secret header', async () => {
  lines.length = 0
  await request(app.getHttpServer())
    .get('/log-probe?token=T0KEN-S3CRET&paramValue=PV-S3CRET&page=2')
    .set('Authorization', 'Bearer BEARER-S3CRET')
    .set('Cookie', 'qw_rt=COOKIE-S3CRET')
    .set('X-Request-Id', 'log-probe-1')
    .expect(200)
  const out = lines.join('')
  // the handler's line and pino-http's "request completed" line, both with the request
  const logged = lines.map((l) => JSON.parse(l) as { msg: string; req?: Record<string, unknown> })
  expect(logged.map((l) => l.msg)).toEqual(['inside the handler', 'request completed'])
  for (const l of logged)
    expect(l.req).toMatchObject({
      id: 'log-probe-1',
      method: 'GET',
      url: '/log-probe?token=***&paramValue=***&page=***',
    })
  expect(logged[0]!.req).not.toHaveProperty('query')
  for (const secret of ['T0KEN-S3CRET', 'PV-S3CRET', 'BEARER-S3CRET', 'COOKIE-S3CRET'])
    expect(out).not.toContain(secret)
})

it('errors keep a masked message (causes too) and their stack frames, never a driver dump or quoted value', async () => {
  lines.length = 0
  await request(app.getHttpServer()).get('/log-probe/db').expect(200)
  const out = lines.join('')
  const [failed, wrapped] = lines.map((l) => JSON.parse(l) as { err: Record<string, unknown> })
  const driverMessage =
    "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: Incorrect integer value: '***' for column '***' at row 1"
  expect(failed!.err).toMatchObject({
    type: 'QueryFailedError',
    message: driverMessage,
    code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
  })
  expect(failed!.err.stack).toMatch(/^\s+at /)
  expect(wrapped!.err.message).toBe(`import failed; token=***: ${driverMessage}`)
  for (const secret of ['VALUE-S3CRET', 'PARAM-S3CRET', 'SQL-S3CRET', 'TOKEN-S3CRET'])
    expect(out).not.toContain(secret)
})
