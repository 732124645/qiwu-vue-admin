// core/http (see docs/design-notes.md#api-envelope): success envelope, error envelope shapes (400/401/403/404/409/413/429/500) with
// Err codes, translated msg and traceId, MySQL errno mapping, @ApiEnvelope in Swagger.
import { readdirSync, readFileSync } from 'node:fs'
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Test } from '@nestjs/testing'
import { Throttle, ThrottlerGuard } from '@nestjs/throttler'
import { InjectDataSource, getDataSourceToken } from '@nestjs/typeorm'
import { Err, fieldDomains } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { ApiEnvelope } from '../../src/core/http/api-envelope.decorator.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { REDIS } from '../../src/core/redis/redis.module.js'
import { agentFor } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const DDL = [
  `CREATE TABLE IF NOT EXISTS test_envelope_parent (
    id int unsigned NOT NULL PRIMARY KEY COMMENT 'Parent id',
    name varchar(20) NOT NULL COMMENT 'Unique name',
    UNIQUE KEY uk_test_envelope_parent_name (name)
  ) ENGINE=InnoDB COMMENT='Test fixture: envelope errno mapping'`,
  `CREATE TABLE IF NOT EXISTS test_envelope_child (
    id int unsigned NOT NULL PRIMARY KEY COMMENT 'Child id',
    parent_id int unsigned NOT NULL COMMENT 'Parent id',
    CONSTRAINT fk_test_envelope_child_parent FOREIGN KEY (parent_id)
      REFERENCES test_envelope_parent (id) ON DELETE RESTRICT
  ) ENGINE=InnoDB COMMENT='Test fixture: envelope errno mapping'`,
]

const Item = z.object({ id: z.number().int(), name: z.string() })
const ItemCreate = z
  .object({ title: z.string().min(3).max(20) })
  .register(fieldDomains, { domain: 'demo' })

@Controller('probe')
class ProbeController {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  @Get('item')
  @ApiEnvelope(Item)
  item(): z.output<typeof Item> {
    return { id: 1, name: 'one' }
  }

  @Post('void')
  @HttpCode(200)
  @ApiEnvelope()
  nothing(): void {}

  @Post('items')
  create(@Body({ schema: ItemCreate }) body: z.output<typeof ItemCreate>) {
    return body
  }

  @Post('parents')
  async addParent(@Body() body: { id: number; name: string }) {
    await this.ds.query('INSERT INTO test_envelope_parent (id, name) VALUES (?, ?)', [
      body.id,
      body.name,
    ])
  }

  @Delete('parents')
  async removeParents() {
    await this.ds.query('DELETE FROM test_envelope_parent')
  }

  @Get('biz')
  biz() {
    throw new BizError(Err.AUTH_PASSWORD_CHANGE_REQUIRED)
  }

  @Get('http/unauthorized')
  unauthorized() {
    throw new UnauthorizedException('token abc123 expired')
  }

  @Get('http/forbidden')
  forbidden() {
    throw new ForbiddenException('perm iam.user.remove missing')
  }

  @Get('limited')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  limited() {
    return 'ok'
  }

  @Get('boom')
  boom() {
    throw new Error('connect ECONNREFUSED db-password=hunter2')
  }

  /** statuses that are not the client's fault: an upstream's 401 (no `expose`), an exposed 5xx */
  @Get('upstream')
  upstream() {
    throw Object.assign(new Error('upstream replied 401'), { status: 401 })
  }

  @Get('exposed-5xx')
  exposed5xx() {
    throw Object.assign(new Error('unavailable'), { status: 503, expose: true })
  }
}

let app: NestExpressApplication
let ds: DataSource
// every request is signed in as the seeded admin (AuthGuard is global)
let agent: Awaited<ReturnType<typeof agentFor>>
const http = () => agent

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ProbeController],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await cleanRedis(app.get(REDIS))
  await app.listen(0, '127.0.0.1')
  agent = await agentFor(app)
  ds = app.get<DataSource>(getDataSourceToken())
  await ds.query('DROP TABLE IF EXISTS test_envelope_child, test_envelope_parent')
  for (const sql of DDL) await ds.query(sql)
})

afterAll(async () => {
  await ds?.query('DROP TABLE IF EXISTS test_envelope_child, test_envelope_parent')
  await app?.close()
})

/** Asserts the error envelope shape and returns the body. */
async function fails(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status)
  expect(res.body).toMatchObject({ code, data: null, traceId: res.headers['x-request-id'] })
  expect(Object.keys(res.body).sort()).toEqual(
    ['code', 'data', 'msg', 'traceId', ...('errors' in res.body ? ['errors'] : [])].sort(),
  )
  return res.body as { msg: string; errors?: { path: string; msg: string }[] }
}

describe('success envelope', () => {
  it('wraps handler data as { code: 0, msg: ok, data }', async () => {
    const res = await http().get('/api/probe/item').expect(200)
    expect(res.body).toEqual({ code: 0, msg: 'ok', data: { id: 1, name: 'one' } })
  })

  it('void handlers answer data: null', async () => {
    const res = await http().post('/api/probe/void').expect(200)
    expect(res.body).toEqual({ code: 0, msg: 'ok', data: null })
  })

  it('health wraps the terminus result', async () => {
    const res = await http().get('/api/health').expect(200)
    expect(res.body).toMatchObject({ code: 0, msg: 'ok', data: { status: 'ok' } })
  })
})

describe('error envelope', () => {
  it('400 VALIDATION_FAILED with translated errors[]; msg = first error; traceId = X-Request-Id', async () => {
    const res = await http()
      .post('/api/probe/items')
      .set('X-Request-Id', 'env-400')
      .send({ title: 'x' })
    const body = await fails(res, 400, Err.VALIDATION_FAILED.code)
    expect(res.body.traceId).toBe('env-400')
    expect(body.errors).toEqual([{ path: 'title', msg: '标题至少 3 个字符' }])
    expect(body.msg).toBe(body.errors![0]!.msg)
  })

  it('400 BAD_REQUEST for a malformed JSON body', async () => {
    const res = await http()
      .post('/api/probe/items')
      .set('Content-Type', 'application/json')
      .send('{"title":')
    const body = await fails(res, 400, Err.BAD_REQUEST.code)
    expect(body.msg).toBe('请求无效')
  })

  it('413 PAYLOAD_TOO_LARGE for a JSON body over the 100 KB limit (the body parser), not a 500', async () => {
    const res = await http()
      .post('/api/probe/items')
      .send({ title: 'x'.repeat(110_000) })
    const body = await fails(res, 413, Err.PAYLOAD_TOO_LARGE.code)
    expect(body.msg).toBe('请求内容过大')
  })

  it.each([
    ['unauthorized', 401, Err.UNAUTHENTICATED, '未登录或登录已失效，请重新登录'],
    ['forbidden', 403, Err.FORBIDDEN, '没有执行此操作的权限'],
  ])(
    '%s HttpException → %i with the common code, never the exception text',
    async (name, status, err, msg) => {
      const body = await fails(await http().get(`/api/probe/http/${name}`), status, err.code)
      expect(body.msg).toBe(msg)
    },
  )

  it('404 NOT_FOUND for an unknown route', async () => {
    const body = await fails(await http().get('/api/nowhere'), 404, Err.NOT_FOUND.code)
    expect(body.msg).toBe('请求的资源不存在')
  })

  it('BizError → its own status/code/message', async () => {
    const body = await fails(
      await http().get('/api/probe/biz'),
      403,
      Err.AUTH_PASSWORD_CHANGE_REQUIRED.code,
    )
    expect(body.msg).toBe('请先修改密码')
  })

  it('409 DUPLICATE for MySQL errno 1062, 409 IN_USE for errno 1451', async () => {
    await http().post('/api/probe/parents').send({ id: 1, name: 'p' }).expect(201)
    const dup = await fails(
      await http().post('/api/probe/parents').send({ id: 2, name: 'p' }),
      409,
      Err.DUPLICATE.code,
    )
    expect(dup.msg).toBe('数据已存在，不能重复')
    await ds.query('INSERT INTO test_envelope_child (id, parent_id) VALUES (1, 1)')
    const used = await fails(await http().delete('/api/probe/parents'), 409, Err.IN_USE.code)
    expect(used.msg).toBe('数据正在被使用，不能删除')
  })

  it('429 TOO_MANY_REQUESTS from the throttler', async () => {
    await http().get('/api/probe/limited').expect(200)
    const body = await fails(
      await http().get('/api/probe/limited'),
      429,
      Err.TOO_MANY_REQUESTS.code,
    )
    expect(body.msg).toBe('请求过于频繁，请稍后再试')
  })

  it('500 INTERNAL for anything else, without leaking the error', async () => {
    const res = await http().get('/api/probe/boom')
    const body = await fails(res, 500, Err.INTERNAL.code)
    expect(body.msg).toBe('服务器出错了，请稍后再试')
    expect(res.text).not.toMatch(/hunter2|ECONNREFUSED|stack/)
  })

  it.each(['upstream', 'exposed-5xx'])(
    '500 INTERNAL for a status not the client fault (%s)',
    async (p) => {
      await fails(await http().get(`/api/probe/${p}`), 500, Err.INTERNAL.code)
    },
  )

  it('translates for the request language (en-US)', async () => {
    const res = await http().get('/api/probe/boom?lang=en-US')
    expect(res.body.msg).toBe('Something went wrong on the server. Please try again later')
  })
})

it('every Err code has a message in zh-CN and en-US', () => {
  for (const lang of ['zh-CN', 'en-US']) {
    // error.json plus the `error` part of module fragments (messaging.mail.json, …), merged at runtime
    const messages = JSON.parse(readFileSync(`src/i18n/${lang}/error.json`, 'utf8'))
    for (const file of readdirSync(`src/i18n/${lang}`).filter((f) => f !== 'error.json')) {
      const fragment = JSON.parse(readFileSync(`src/i18n/${lang}/${file}`, 'utf8')).error ?? {}
      for (const [ns, texts] of Object.entries(fragment))
        messages[ns] = { ...messages[ns], ...(texts as object) }
    }
    for (const { key } of Object.values(Err)) {
      const text = key
        .split('.')
        .slice(1)
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages)
      expect(typeof text === 'string' && text.length > 0, `${lang}: ${key}`).toBe(true)
    }
  }
})

it('@ApiEnvelope documents the envelope around the data schema', () => {
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build())
  const schemaOf = (path: string, method: 'get' | 'post', status: string) => {
    const res = doc.paths[path]?.[method]?.responses[status]
    return res && 'content' in res ? res.content?.['application/json']?.schema : undefined
  }
  expect(schemaOf('/api/probe/item', 'get', '200')).toMatchObject({
    type: 'object',
    required: ['code', 'msg', 'data'],
    properties: {
      code: { type: 'integer' },
      msg: { type: 'string' },
      data: {
        type: 'object',
        required: ['id', 'name'],
        properties: { id: { type: 'integer' }, name: { type: 'string' } },
      },
    },
  })
  expect(schemaOf('/api/probe/void', 'post', '200')).toMatchObject({
    properties: { data: { nullable: true } },
  })
  expect(schemaOf('/api/health', 'get', '200')).toMatchObject({
    properties: { data: { properties: { status: { enum: ['ok'] } } } },
  })
})
