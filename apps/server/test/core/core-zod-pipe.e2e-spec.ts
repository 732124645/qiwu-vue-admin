// docs/adr/003-validation.md: shared zod schemas through Nest 12's Standard Schema pipe,
// translated 400s, Swagger reflection, and the build-time copy of the shared validation messages.
import { existsSync, readFileSync } from 'node:fs'
import { Body, Controller, Get, type INestApplication, Post, Query } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger'
import { Err, pageQuery } from '@qiwu/shared'
import { DemoNoteCreate } from '@qiwu/shared/testing'
import type { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { agentFor } from '../setup/auth.js'

const SHARED_I18N = '../../packages/shared/src/i18n'
const NoteQuery = pageQuery(['createdAt', 'id'])

@Controller('zod-pipe/notes')
class ZodNotesController {
  @Get()
  list(@Query({ schema: NoteQuery }) query: z.output<typeof NoteQuery>) {
    return query
  }

  @Post()
  create(@Body({ schema: DemoNoteCreate }) body: DemoNoteCreate) {
    return body
  }
}

let app: INestApplication
// signed in as the seeded admin: AuthGuard is global
let agent: Awaited<ReturnType<typeof agentFor>>
const http = () => agent

// CoreI18nModule loads src/i18n + the shared JSON as a second source when run from source (core/i18n)
beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [ZodNotesController],
  }).compile()
  app = moduleRef.createNestApplication()
  app.setGlobalPrefix('api')
  await app.listen(0, '127.0.0.1')
  agent = await agentFor(app)
})

afterAll(() => app?.close())

describe('a) @Query({ schema }) pagination', () => {
  it('coerces query strings and parses the sort whitelist', async () => {
    const res = await http().get('/api/zod-pipe/notes?page=2&pageSize=50&sort=createdAt,-id')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      page: 2,
      pageSize: 50,
      sort: [
        { field: 'createdAt', order: 'ASC' },
        { field: 'id', order: 'DESC' },
      ],
    })
  })

  it('defaults page=1, pageSize=20', async () => {
    const res = await http().get('/api/zod-pipe/notes')
    expect(res.body.data).toEqual({ page: 1, pageSize: 20 })
  })

  it.each([
    ['page=0', 'page', '页码不能小于 1'],
    ['page=abc', 'page', '页码的类型不正确'],
    ['page=1&page=2', 'page', '页码的类型不正确'],
    ['pageSize=201', 'pageSize', '每页条数不能大于 200'],
    ['sort=password', 'sort', '排序只能使用以下字段：createdAt, id'],
    ['sort=-createdAt,name', 'sort', '排序只能使用以下字段：createdAt, id'],
  ])('rejects %s', async (qs, path, msg) => {
    const res = await http().get(`/api/zod-pipe/notes?${qs}`)
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual([{ path, msg }])
  })

  it('translates query errors to en-US', async () => {
    const res = await http().get('/api/zod-pipe/notes?pageSize=500&lang=en-US')
    expect(res.body.errors).toEqual([{ path: 'pageSize', msg: 'Page size must be at most 200' }])
  })
})

describe('b) @Body({ schema }) failure → 400 envelope with translated errors', () => {
  const invalid = { title: ' ab ', email: 'nope' }

  it('zh-CN by default', async () => {
    const res = await http()
      .post('/api/zod-pipe/notes')
      .set('X-Request-Id', 'zod-pipe-trace')
      .send(invalid)
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      code: Err.VALIDATION_FAILED.code,
      msg: '标题至少 3 个字符',
      data: null,
      errors: [
        { path: 'title', msg: '标题至少 3 个字符' },
        { path: 'email', msg: '邮箱不是有效的邮箱地址' },
        { path: 'quantity', msg: '数量不能为空' },
      ],
      traceId: 'zod-pipe-trace',
    })
  })

  it.each([
    ['?lang=en-US', {}],
    ['', { 'Accept-Language': 'en-US,en;q=0.9' }],
  ])('en-US via %o %o', async (qs, headers) => {
    const res = await http().post(`/api/zod-pipe/notes${qs}`).set(headers).send(invalid)
    expect(res.status).toBe(400)
    expect(res.body.msg).toBe('Title must be at least 3 characters')
    expect(res.body.errors).toEqual([
      { path: 'title', msg: 'Title must be at least 3 characters' },
      { path: 'email', msg: 'Email must be a valid email address' },
      { path: 'quantity', msg: 'Quantity is required' },
    ])
  })

  it('reports type and range errors', async () => {
    const res = await http()
      .post('/api/zod-pipe/notes')
      .send({ title: 'x'.repeat(51), email: 'a@b.co', quantity: 1.5 })
    expect(res.body.errors).toEqual([
      { path: 'title', msg: '标题最多 50 个字符' },
      { path: 'quantity', msg: '数量必须是整数' },
    ])
  })

  it('labels a missing body as the request data', async () => {
    const res = await http().post('/api/zod-pipe/notes')
    expect(res.status).toBe(400)
    expect(res.body.errors).toEqual([{ path: '', msg: '请求参数不能为空' }])
  })

  it('passes the parsed (trimmed, stripped) body to the handler', async () => {
    const res = await http()
      .post('/api/zod-pipe/notes')
      .send({ title: '  Hello  ', email: 'a@b.co', quantity: 3, extra: true })
    expect(res.status).toBe(201)
    expect(res.body.data).toEqual({ title: 'Hello', email: 'a@b.co', quantity: 3 })
  })

  it('keeps non-validation errors in the same envelope', async () => {
    const res = await http().get('/api/zod-pipe/nowhere').set('X-Request-Id', 'nf-1')
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: Err.NOT_FOUND.code, data: null, traceId: 'nf-1' })
    expect(res.body.errors).toBeUndefined()
  })
})

describe('c) Swagger reflects the zod schemas', () => {
  it('documents query parameters and the request body', () => {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build())
    const path = doc.paths['/api/zod-pipe/notes']
    const params = Object.fromEntries(
      (path?.get?.parameters ?? []).map((p) => ('name' in p ? [p.name, p] : [])),
    )
    expect(params.page).toMatchObject({ in: 'query', schema: { type: 'integer', minimum: 1 } })
    expect(params.pageSize).toMatchObject({ schema: { type: 'integer', maximum: 200 } })
    expect(params.sort).toMatchObject({ in: 'query', schema: { type: 'string' } })

    const body = path?.post?.requestBody
    let schema: unknown = body && 'content' in body && body.content['application/json']?.schema
    if (schema && typeof schema === 'object' && '$ref' in schema)
      schema = doc.components?.schemas?.[String(schema.$ref).split('/').pop() ?? '']
    expect(schema).toMatchObject({
      type: 'object',
      required: ['title', 'email', 'quantity'],
      properties: {
        title: { type: 'string', minLength: 3, maxLength: 50 },
        email: { type: 'string', format: 'email' },
        quantity: { type: 'integer', minimum: 1, maximum: 99 },
      },
    })
  })
})

describe('build copy of the shared messages', () => {
  // `nest build` copies packages/shared/src/i18n into dist/i18n (nest-cli assets); ci:local builds first.
  it.skipIf(!existsSync('dist/i18n'))('dist/i18n holds the shared validation + field JSON', () => {
    for (const lang of ['zh-CN', 'en-US'])
      for (const ns of ['validation', 'field'])
        expect(readFileSync(`dist/i18n/${lang}/${ns}.json`, 'utf8')).toBe(
          readFileSync(`${SHARED_I18N}/${lang}/${ns}.json`, 'utf8'),
        )
  })
})
