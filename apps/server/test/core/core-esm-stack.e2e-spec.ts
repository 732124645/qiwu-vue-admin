// docs/adr/001-module-format.md, criterion ①: one TestingModule carries CLS + transactional (TypeORM adapter), nestjs-pino,
// throttler and nestjs-i18n, all loaded as ESM under Vitest; each piece is asserted usable.
import { readFileSync } from 'node:fs'
import { Controller, Get, UseGuards, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { TypeOrmModule, getDataSourceToken } from '@nestjs/typeorm'
import { ClsPluginTransactional, TransactionHost } from '@nestjs-cls/transactional'
import { TransactionalAdapterTypeOrm } from '@nestjs-cls/transactional-adapter-typeorm'
import { ClsModule, ClsService } from 'nestjs-cls'
import { I18nContext } from 'nestjs-i18n'
import { PinoLogger } from 'nestjs-pino'
import request from 'supertest'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreThrottlerModule } from '../../src/core/guard/throttler.module.js'
import { CoreI18nModule } from '../../src/core/i18n/i18n.module.js'
import { CoreLoggerModule } from '../../src/core/logger/logger.module.js'
import { CoreRedisModule, REDIS } from '../../src/core/redis/redis.module.js'
import { cleanRedis } from '../setup/redis.js'

const greeting = (lang: string) =>
  (JSON.parse(readFileSync(`src/i18n/${lang}/common.json`, 'utf8')).greeting as string).replace(
    '{name}',
    'Nest',
  )

@Controller('probe')
class ProbeController {
  constructor(
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {}

  @Get('greet')
  greet() {
    return I18nContext.current()!.t('common.greeting', { args: { name: 'Nest' } })
  }

  @Get('limited')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  limited() {
    return 'ok'
  }

  @Get('context')
  context() {
    this.logger.warn('esm stack context')
    return { clsId: this.cls.getId(), bindings: this.logger.logger.bindings() }
  }
}

describe('ESM: cls + transactional + pino + throttler + i18n in one TestingModule', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreConfigModule.forRoot(),
        CoreContextModule,
        TypeOrmModule.forRootAsync({
          useFactory: () => ({
            type: 'mysql',
            host: process.env.DB_HOST,
            port: Number(process.env.DB_PORT),
            username: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            synchronize: false,
          }),
        }),
        ClsModule.registerPlugins([
          new ClsPluginTransactional({
            imports: [TypeOrmModule],
            adapter: new TransactionalAdapterTypeOrm({ dataSourceToken: getDataSourceToken() }),
          }),
        ]),
        CoreLoggerModule,
        CoreRedisModule,
        CoreThrottlerModule,
        CoreI18nModule,
      ],
      controllers: [ProbeController],
    }).compile()
    app = moduleRef.createNestApplication()
    await cleanRedis(app.get(REDIS))
    // listen once: otherwise supertest listens/closes the server around every request, which
    // intermittently hung a request past the 5 s timeout (1 in ~40 runs)
    await app.listen(0, '127.0.0.1')
  })

  afterAll(() => app?.close())

  it('ClsService + TransactionHost: a transaction runs on the TypeORM DataSource', async () => {
    const cls = app.get(ClsService)
    const txHost: TransactionHost<TransactionalAdapterTypeOrm> = app.get(TransactionHost)
    const row = await cls.run(() =>
      txHost.withTransaction(async () => {
        expect(txHost.isTransactionActive()).toBe(true)
        const [r] = await txHost.tx.query('SELECT ? AS one', [1])
        return r
      }),
    )
    expect(Number(row.one)).toBe(1)
  })

  it('PinoLogger is request-scoped: reqId = CLS id = incoming X-Request-Id', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/context')
      .set('X-Request-Id', 'esm-stack-req-1')
      .expect(200)
    expect(res.body.clsId).toBe('esm-stack-req-1')
    expect(res.body.bindings.req.id).toBe('esm-stack-req-1')
  })

  it('CLS id falls back to a UUID when X-Request-Id is missing or unsafe', async () => {
    const server = app.getHttpServer()
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    const unsafe = await request(server).get('/probe/context').set('X-Request-Id', 'x'.repeat(65))
    expect(unsafe.body.clsId).toMatch(uuid)
    expect(unsafe.body.bindings.req.id).toBe(unsafe.body.clsId)
    expect((await request(server).get('/probe/context')).body.clsId).toMatch(uuid)
  })

  it('ThrottlerGuard answers 429 on the 3rd call within the window', async () => {
    const server = app.getHttpServer()
    await request(server).get('/probe/limited').expect(200)
    await request(server).get('/probe/limited').expect(200)
    await request(server).get('/probe/limited').expect(429)
  })

  it('i18n: zh-CN by default, en-US via ?lang= and Accept-Language, regional fallbacks', async () => {
    const server = app.getHttpServer()
    const zh = greeting('zh-CN')
    const en = greeting('en-US')
    expect((await request(server).get('/probe/greet').expect(200)).text).toBe(zh)
    expect((await request(server).get('/probe/greet?lang=en-US').expect(200)).text).toBe(en)
    const byHeader = await request(server).get('/probe/greet').set('Accept-Language', 'en-US')
    expect(byHeader.text).toBe(en)
    expect((await request(server).get('/probe/greet?lang=en-GB')).text).toBe(en)
    expect((await request(server).get('/probe/greet?lang=zh-TW')).text).toBe(zh)
  })
})
