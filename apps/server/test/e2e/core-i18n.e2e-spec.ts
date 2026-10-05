// core/i18n (see docs/design-notes.md#api-envelope, #i18n): response language ?lang → Accept-Language → signed-in user's locale →
// zh-CN, for validation errors (shared messages loaded as a second source), business errors and
// handler translations; the error filter uses the same chain.
import { Body, Controller, Get, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, fieldDomains } from '@qiwu/shared'
import { I18nContext } from 'nestjs-i18n'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { BizError } from '../../src/core/http/biz-error.js'
import { currentLocale, matchLocale } from '../../src/core/i18n/locale.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'

const Note = z.object({ title: z.string().min(3) }).register(fieldDomains, { domain: 'demo' })

@Controller('i18n')
class I18nProbeController {
  @Post('notes')
  create(@Body({ schema: Note }) body: z.output<typeof Note>) {
    return body
  }

  @Get('biz')
  biz() {
    throw new BizError(Err.DUPLICATE)
  }

  @Get('lang')
  lang() {
    return { i18nContext: I18nContext.current()?.lang, current: currentLocale() }
  }
}

let app: NestExpressApplication
let ds: DataSource
const http = () => request(app.getHttpServer())
const USERS = { 'en-US': 'i18n-e2e-en', 'zh-CN': 'i18n-e2e-zh' } as const
/** Access tokens: the seeded admin (no locale) and one user per locale. */
const token: Record<string, string> = {}

/**
 * A request with `headers`, signed in as the admin; `X-Test-User: <locale>` signs in as the user with
 * that locale instead, `X-Test-User: none` sends no token.
 */
function send(req: request.Test, headers: Record<string, string>) {
  const { 'X-Test-User': as, ...rest } = headers
  return as === 'none' ? req.set(rest) : req.set(rest).set(bearer(token[as ?? 'admin']!))
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [I18nProbeController],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>())
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  token.admin = (await signIn(app)).accessToken
  for (const [locale, username] of Object.entries(USERS)) {
    await insertRow(ds.manager, 'iam_user', {
      username,
      display_name: username,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
      locale,
    })
    token[locale] = (await signIn(app, username)).accessToken
  }
})

afterAll(async () => {
  await ds?.query('DELETE FROM iam_user WHERE username IN (?)', [Object.values(USERS)])
  await app?.close()
})

const ZH = { validation: '标题至少 3 个字符', biz: '数据已存在，不能重复' }
const EN = { validation: 'Title must be at least 3 characters', biz: 'This record already exists' }

/** Validation + business error messages for the given query string and headers. */
async function messages(qs = '', headers: Record<string, string> = {}) {
  const invalid = await send(http().post(`/api/i18n/notes${qs}`), headers).send({ title: 'x' })
  expect(invalid.status).toBe(400)
  expect(invalid.body.errors).toEqual([{ path: 'title', msg: invalid.body.msg }])
  const biz = await send(http().get(`/api/i18n/biz${qs}`), headers)
  expect(biz.status).toBe(409)
  return { validation: invalid.body.msg, biz: biz.body.msg }
}

describe('resolution order', () => {
  it('zh-CN by default', async () => {
    expect(await messages()).toEqual(ZH)
  })

  it.each([
    ['?lang=en-US', '?lang=en-US', {}],
    ['?lang=en (language only)', '?lang=en', {}],
    ['Accept-Language: en-US', '', { 'Accept-Language': 'en-US,en;q=0.9' }],
    ['Accept-Language: en-GB', '', { 'Accept-Language': 'en-GB' }],
    ['Accept-Language: unsupported first', '', { 'Accept-Language': 'fr-FR, de;q=0.9, en;q=0.5' }],
    ['Accept-Language: by q, not order', '', { 'Accept-Language': 'zh-CN;q=0.4, en-US;q=0.8' }],
    ['unsupported ?lang falls through to the header', '?lang=fr', { 'Accept-Language': 'en' }],
    ['the user locale when neither is given', '', { 'X-Test-User': 'en-US' }],
  ])('English via %s', async (_, qs, headers) => {
    expect(await messages(qs, headers)).toEqual(EN)
  })

  it.each([
    ['?lang beats Accept-Language', '?lang=zh-CN', { 'Accept-Language': 'en-US' }],
    [
      'Accept-Language beats the user locale',
      '',
      { 'Accept-Language': 'zh-TW', 'X-Test-User': 'en-US' },
    ],
    ['q=0 excludes a language', '', { 'Accept-Language': 'en;q=0' }],
  ])('Chinese: %s', async (_, qs, headers) => {
    expect(await messages(qs, headers)).toEqual(ZH)
  })
})

it('handlers see the resolved language, including the user locale set by the guard', async () => {
  const res = await send(http().get('/api/i18n/lang'), { 'X-Test-User': 'en-US' }).expect(200)
  expect(res.body.data).toEqual({ i18nContext: 'en-US', current: 'en-US' })
  const byQuery = await send(http().get('/api/i18n/lang?lang=en-US'), { 'X-Test-User': 'zh-CN' })
  expect(byQuery.body.data).toEqual({ i18nContext: 'en-US', current: 'en-US' })
})

it('errors raised before any handler (guard 401, malformed body, unknown route) are translated', async () => {
  const unauth = await send(http().get('/api/i18n/biz?lang=en-US'), { 'X-Test-User': 'none' })
  expect(unauth.status).toBe(401)
  expect(unauth.body.msg).toBe(
    'You are not signed in or your session has ended. Please sign in again',
  )
  const malformed = await send(http().post('/api/i18n/notes'), {
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US',
  }).send('{"title":')
  expect(malformed.status).toBe(400)
  expect(malformed.body.msg).toBe('Invalid request')
  const missing = await http().get('/api/nowhere?lang=en-US')
  expect(missing.body.msg).toBe('The requested resource does not exist')
})

it('matchLocale: exact tag, then language; anything else is unsupported', () => {
  expect(['en-US', 'EN-us', 'en', 'en-GB', 'zh', 'zh-TW', 'zh-Hant-TW'].map(matchLocale)).toEqual([
    'en-US',
    'en-US',
    'en-US',
    'en-US',
    'zh-CN',
    'zh-CN',
    'zh-CN',
  ])
  expect(['fr', '*', '', 'english'].map(matchLocale)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
  ])
})
