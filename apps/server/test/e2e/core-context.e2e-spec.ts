// core/context: one id per request shared by CLS (traceId), pino (reqId) and the X-Request-Id
// response header; typed CLS keys (traceId, principal, locale, checkedPerm, scopeCache).
import { Controller, Get, type INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { ClsService } from 'nestjs-cls'
import { PinoLogger } from 'nestjs-pino'
import request from 'supertest'
import { CoreConfigModule } from '../../src/core/config/config.module.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { clsGet, clsSet } from '../../src/core/context/cls.js'
import { CoreContextModule } from '../../src/core/context/context.module.js'
import { CoreLoggerModule } from '../../src/core/logger/logger.module.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

@Controller('ctx')
class CtxController {
  constructor(
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {}

  @Get()
  ids() {
    return {
      clsId: this.cls.getId(),
      traceId: clsGet('traceId'),
      reqId: (this.logger.logger.bindings().req as { id: string }).id,
    }
  }
}

let app: INestApplication
const http = () => request(app.getHttpServer())

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [CoreConfigModule.forRoot(), CoreContextModule, CoreLoggerModule],
    controllers: [CtxController],
  }).compile()
  app = moduleRef.createNestApplication()
  await app.listen(0, '127.0.0.1')
})

afterAll(() => app?.close())

it('a safe incoming X-Request-Id is the CLS id, traceId, pino reqId and the echoed header', async () => {
  const res = await http().get('/ctx').set('X-Request-Id', 'ctx-trace.1:a').expect(200)
  expect(res.body).toEqual({
    clsId: 'ctx-trace.1:a',
    traceId: 'ctx-trace.1:a',
    reqId: 'ctx-trace.1:a',
  })
  expect(res.headers['x-request-id']).toBe('ctx-trace.1:a')
})

it.each([
  ['missing', undefined],
  ['too long', 'x'.repeat(65)],
  ['unsafe characters', 'a b<script>'],
])('%s X-Request-Id → a fresh UUID used everywhere', async (_, header) => {
  const req = http().get('/ctx')
  const res = await (header ? req.set('X-Request-Id', header) : req).expect(200)
  expect(res.body.clsId).toMatch(UUID)
  expect(res.body).toEqual({
    clsId: res.body.clsId,
    traceId: res.body.clsId,
    reqId: res.body.clsId,
  })
  expect(res.headers['x-request-id']).toBe(res.body.clsId)
})

it('echoes the id on responses that never reach a handler (404)', async () => {
  const res = await http().get('/nowhere').set('X-Request-Id', 'ctx-404')
  expect(res.status).toBe(404)
  expect(res.headers['x-request-id']).toBe('ctx-404')
})

it('typed helpers: values inside a context, undefined outside one', async () => {
  expect(clsGet('principal')).toBeUndefined()
  expect(() => clsSet('checkedPerm', { perms: ['x.y.z'], all: false })).toThrow()
  const principal: Principal = {
    userId: 7,
    deptId: null,
    deptTreePath: null,
    roles: [],
    perms: [],
    locale: 'en-US',
  }
  const seen = await app.get(ClsService).run(async () => {
    clsSet('principal', principal)
    clsSet('locale', 'zh-CN')
    clsSet('checkedPerm', { perms: ['iam.user.browse'], all: false })
    clsSet('scopeCache', new Map([['k', 1]]))
    return {
      principal: clsGet('principal'),
      locale: clsGet('locale'),
      perm: clsGet('checkedPerm'),
      cache: clsGet('scopeCache')?.get('k'),
    }
  })
  expect(seen).toEqual({
    principal,
    locale: 'zh-CN',
    perm: { perms: ['iam.user.browse'], all: false },
    cache: 1,
  })
})
