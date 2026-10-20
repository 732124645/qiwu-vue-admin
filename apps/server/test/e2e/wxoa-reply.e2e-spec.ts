// WeChat Official Account auto-reply rules (see docs/design-notes.md#wxoa): list, get, create, change
// as a whole, delete; one enabled subscribe and one enabled default rule per account, one rule per click
// key or scan scene (409); a media reply's material must be the account's own and of the reply's kind
// (404), and is then held by the rule (deleting it 409); 500 rules per account; every route goes
// through the rule's account (missing or deleted 404, disabled B6011); 403 per permission; 400
// translated; @Idempotent; @ActionLog. Accounts and materials are written straight into the tables.
import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, WXOA_RULES_MAX, wxoaPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { softDeleteRows } from '../../src/core/db/references.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const findId = (...args: Parameters<typeof findIdRaw>) => inTenant1(() => findIdRaw(...args))
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-reply-'
const URL = '/api/wxoa/reply-rules'
const MISSING = 999_999

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', reader: '', plain: '' }
const userIds: number[] = []
const accountIds: number[] = []
let roleId: number
/** enabled accounts A and B, a disabled one */
let a: number
let b: number
let off: number
/** materials: A's image, voice and thumb, B's image */
let aImage: number
let aVoice: number
let aThumb: number
let bImage: number

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
let seq = 0
const unique = () => `${PREFIX}${++seq}`
/** A keyword rule of `accountId` (unique name: no two creates are the same submission). */
const keyword = (accountId: number, over: object = {}) => ({
  accountId,
  name: unique(),
  triggerKind: 'keyword',
  matchMode: 'exact',
  keywords: ['hello'],
  replyKind: 'text',
  replyBody: { content: 'hi there' },
  ...over,
})
/** A PUT body: the rule as a whole, without `accountId`. */
const whole = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'accountId'))
const add = async (body: object) => (await call('admin', 'post', '', body).expect(201)).body.data
const ruleRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_reply_rule WHERE id = ?', [id]))[0]

async function account(enabled = true) {
  const id = await insertRow(ds.manager, 'wxoa_account', {
    label: unique(),
    app_id: `wx${randomBytes(8).toString('hex')}`,
    account_kind: 'service',
    app_secret_enc: 'not-used-by-this-spec',
    push_token_enc: 'not-used-by-this-spec',
    callback_key: randomBytes(16).toString('base64url'),
    enabled,
  })
  accountIds.push(id)
  return id
}
const material = (accountId: number, mediaKind: string) =>
  insertRow(ds.manager, 'wxoa_material', {
    account_id: accountId,
    media_kind: mediaKind,
    media_id: unique(),
    origin: 'pulled',
  })

async function user(name: string, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (tenant_id, user_id, role_id) VALUES (1, ?, ?)', [
      id,
      r,
    ])
  userIds.push(id)
  return (await signIn(app, PREFIX + name)).accessToken
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}reader`,
    name: `${PREFIX}reader`,
    data_scope: 'all',
  })
  const browse = await findId(ds.manager, 'iam_menu', { perms: wxoaPerms.reply.browse })
  await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
    roleId,
    browse,
  ])
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await user('reader', [roleId])
  tokens.plain = await user('plain', [])
  a = await account()
  b = await account()
  off = await account(false)
  aImage = await material(a, 'image')
  aVoice = await material(a, 'voice')
  aThumb = await material(a, 'thumb')
  bImage = await material(b, 'image')
})

afterAll(async () => {
  if (ds) {
    if (accountIds.length) {
      for (const table of ['wxoa_reply_rule', 'wxoa_material'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
      await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
    }
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('create, read, change, delete', () => {
  it('a keyword rule is created, read, listed with filters and only under its own account', async () => {
    const rule = await add(keyword(a, { priority: 5, keywords: ['Hello', '你好'] }))
    expect(rule).toMatchObject({
      accountId: a,
      triggerKind: 'keyword',
      matchMode: 'exact',
      keywords: ['Hello', '你好'],
      eventKey: null,
      priority: 5,
      replyKind: 'text',
      replyBody: { content: 'hi there' },
      materialId: null,
      enabled: true,
    })
    expect((await call('admin', 'get', `/${rule.id}`).expect(200)).body.data).toMatchObject(rule)
    const list = async (query: string) =>
      (await call('admin', 'get', `?accountId=${a}&${query}`).expect(200)).body.data
    expect((await list(`name=${encodeURIComponent(rule.name)}`)).items).toEqual([
      expect.objectContaining({ id: rule.id }),
    ])
    expect((await list(`name=${encodeURIComponent(rule.name)}&triggerKind=click`)).total).toBe(0)
    expect((await list(`name=${encodeURIComponent(rule.name)}&enabled=false`)).total).toBe(0)
    const ofB = (await call('admin', 'get', `?accountId=${b}&pageSize=200`).expect(200)).body.data
    expect(ofB.items.map((r: { id: number }) => r.id)).not.toContain(rule.id)
  })

  it('a change replaces the rule as a whole: fields the new trigger does not use are cleared', async () => {
    const body = keyword(a)
    const { id } = await add(body)
    await call('admin', 'put', `/${id}`, {
      ...whole(body),
      triggerKind: 'click',
      matchMode: undefined,
      keywords: undefined,
      eventKey: unique(),
      enabled: false,
    }).expect(200)
    expect(await ruleRow(id)).toMatchObject({
      trigger_kind: 'click',
      match_mode: null,
      keywords: null,
      enabled: 0,
    })
  })

  it('a deleted rule is gone; an unknown id is 404', async () => {
    const { id } = await add(keyword(a))
    await call('admin', 'delete', `/${id}`).expect(200)
    expect((await ruleRow(id)).deleted_at).not.toBeNull()
    for (const [method, body] of [
      ['get', undefined],
      ['put', whole(keyword(a))],
      ['delete', undefined],
    ] as const) {
      await call('admin', method, `/${id}`, body).expect(404)
      await call('admin', method, `/${MISSING}`, body).expect(404)
    }
  })

  it('the same create submitted twice within 3 s → 429', async () => {
    const body = keyword(a)
    await call('admin', 'post', '', body).expect(201)
    const again = await call('admin', 'post', '', body).expect(429)
    expect(again.body.code).toBe(Err.TOO_MANY_REQUESTS.code)
  })
})

describe('uniqueness', () => {
  it('one enabled subscribe rule and one enabled default rule per account (409); disabled ones do not count', async () => {
    for (const triggerKind of ['subscribe', 'default']) {
      const rule = (over: object = {}) => ({
        accountId: a,
        name: unique(),
        triggerKind,
        replyKind: 'text',
        replyBody: { content: 'welcome' },
        ...over,
      })
      const first = await add(rule())
      const dup = await call('admin', 'post', '', rule()).expect(409)
      expect(dup.body.code).toBe(Err.DUPLICATE.code)
      // another account has its own
      await add(rule({ accountId: b }))
      const spare = rule({ enabled: false })
      const { id } = await add(spare)
      await call('admin', 'put', `/${id}`, { ...whole(spare), enabled: true }).expect(409)
      await call('admin', 'delete', `/${first.id}`).expect(200)
      await call('admin', 'put', `/${id}`, { ...whole(spare), enabled: true }).expect(200)
    }
  })

  it('a non-ASCII click key is saved exactly as given; one rule per click key or scan scene, the two never collide', async () => {
    const key = '菜单·关于我们'
    const click = { ...keyword(a), triggerKind: 'click', eventKey: key }
    delete (click as Record<string, unknown>).matchMode
    delete (click as Record<string, unknown>).keywords
    const { id } = await add(click)
    expect((await ruleRow(id)).event_key).toBe(key)
    const dup = await call('admin', 'post', '', { ...click, name: unique() }).expect(409)
    expect(dup.body.code).toBe(Err.DUPLICATE.code)
    // 42 three-byte characters = 126 bytes: fits
    await add({ ...click, name: unique(), eventKey: '键'.repeat(42) })
    const scene = 'promo_2026'
    await add({ ...click, name: unique(), eventKey: scene })
    await add({ ...click, name: unique(), triggerKind: 'scan', eventKey: scene })
    await call('admin', 'post', '', {
      ...click,
      name: unique(),
      triggerKind: 'scan',
      eventKey: scene,
    }).expect(409)
  })
})

describe('400', () => {
  const base = () => keyword(a)
  const cases: [string, () => object, string][] = [
    [
      'a control character in the reply text',
      () => ({ ...base(), replyBody: { content: 'a\u0001b' } }),
      'replyBody.content',
    ],
    [
      'an unpaired surrogate in the reply text',
      () => ({ ...base(), replyBody: { content: 'a\ud800' } }),
      'replyBody.content',
    ],
    [
      'a click key over 128 bytes',
      () => ({
        ...base(),
        triggerKind: 'click',
        matchMode: undefined,
        keywords: undefined,
        eventKey: '键'.repeat(43),
      }),
      'eventKey',
    ],
    [
      'a scan scene outside [A-Za-z0-9_-]',
      () => ({
        ...base(),
        triggerKind: 'scan',
        matchMode: undefined,
        keywords: undefined,
        eventKey: 'a b',
      }),
      'eventKey',
    ],
    ['a keyword rule without keywords', () => ({ ...base(), keywords: undefined }), 'keywords'],
    [
      'keywords on a subscribe rule',
      () => ({ ...base(), triggerKind: 'subscribe', matchMode: undefined }),
      'keywords',
    ],
    [
      'an image reply without a material',
      () => ({ ...base(), replyKind: 'image', replyBody: {} }),
      'materialId',
    ],
    ['a text reply with a material', () => ({ ...base(), materialId: aImage }), 'materialId'],
    ['no account', () => ({ ...base(), accountId: undefined }), 'accountId'],
  ]
  it.each(cases)('create: %s', async (_name, body, field) => {
    const res = await call('admin', 'post', '', body()).expect(400)
    expect(res.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(field)
  })

  it('change: accountId in the body, or an illegal character', async () => {
    const body = keyword(a)
    const { id } = await add(body)
    await call('admin', 'put', `/${id}`, { ...whole(body), accountId: b }).expect(400)
    await call('admin', 'put', `/${id}`, {
      ...whole(body),
      replyBody: { content: '\u0000' },
    }).expect(400)
    expect((await ruleRow(id)).account_id).toBe(a)
  })

  it('list: no accountId', async () => {
    await call('admin', 'get', '').expect(400)
  })
})

describe('materials', () => {
  const media = (accountId: number, materialId: number, over: object = {}) => ({
    ...keyword(accountId),
    replyKind: 'image',
    replyBody: {},
    materialId,
    ...over,
  })

  it('a media reply takes a material of its own account and kind; another account’s or another kind → 404', async () => {
    const image = await add(media(a, aImage))
    expect(image.materialId).toBe(aImage)
    await add(
      media(a, aThumb, {
        replyKind: 'music',
        replyBody: { title: 't', description: 'd', musicUrl: 'https://example.com/a.mp3' },
      }),
    )
    await add(media(a, aVoice, { replyKind: 'voice' }))
    await call('admin', 'post', '', media(a, bImage)).expect(404)
    await call('admin', 'post', '', media(a, aVoice)).expect(404)
    await call('admin', 'post', '', media(a, MISSING)).expect(404)
    const body = media(a, aImage)
    const { id } = await add(body)
    await call('admin', 'put', `/${id}`, { ...whole(body), materialId: bImage }).expect(404)
    await call('admin', 'put', `/${id}`, { ...whole(body), replyKind: 'voice' }).expect(404)
    expect((await ruleRow(id)).material_id).toBe(aImage)
  })

  it('a material a rule replies with cannot be deleted (409) until the rule is', async () => {
    const mat = await material(a, 'image')
    const { id } = await add(media(a, mat))
    const del = () =>
      inTenant1(() => ds.transaction((q) => softDeleteRows(q, 'wxoa_material', [mat])))
    await expect(del()).rejects.toMatchObject({ err: Err.IN_USE })
    await call('admin', 'delete', `/${id}`).expect(200)
    await del()
    // a deleted material is no longer referable
    await call('admin', 'post', '', media(a, mat)).expect(404)
  })
})

describe('the account', () => {
  it('an unknown or deleted account → 404 on every route; a disabled one → B6011', async () => {
    await call('admin', 'post', '', keyword(MISSING)).expect(404)
    await call('admin', 'get', `?accountId=${MISSING}`).expect(404)
    const gone = await account()
    const ruleOfGone = await add(keyword(gone))
    const ruleOfOff = await add(keyword(gone))
    await ds.query('UPDATE wxoa_reply_rule SET account_id = ? WHERE id = ?', [off, ruleOfOff.id])
    await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [gone])
    const routes = (id: number) =>
      [
        ['get', `/${id}`, undefined],
        ['put', `/${id}`, whole(keyword(a))],
        ['delete', `/${id}`, undefined],
      ] as const
    await call('admin', 'get', `?accountId=${gone}`).expect(404)
    await call('admin', 'post', '', keyword(gone)).expect(404)
    for (const [method, path, body] of routes(ruleOfGone.id))
      await call('admin', method, path, body).expect(404)
    const disabled = (res: request.Response) => {
      expect(res.status).toBe(Err.WXOA_ACCOUNT_DISABLED.status)
      expect(res.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    }
    disabled(await call('admin', 'get', `?accountId=${off}`))
    disabled(await call('admin', 'post', '', keyword(off)))
    for (const [method, path, body] of routes(ruleOfOff.id))
      disabled(await call('admin', method, path, body))
    expect((await ruleRow(ruleOfOff.id)).deleted_at).toBeNull()
  })

  it(`at most ${WXOA_RULES_MAX} rules per account (422); deleted rules do not count`, async () => {
    const full = await account()
    const values = Array.from({ length: WXOA_RULES_MAX }, (_, i) => [
      full,
      `${PREFIX}bulk-${i}`,
      'keyword',
      'text',
      JSON.stringify({ content: 'x' }),
    ])
    await ds.query(
      'INSERT INTO wxoa_reply_rule (tenant_id, account_id, name, trigger_kind, reply_kind, reply_body) VALUES ?',
      [values.map(([accountId, ...rest]) => [1, accountId, ...rest])],
    )
    const over = await call('admin', 'post', '', keyword(full)).expect(422)
    expect(over.body.code).toBe(Err.UNPROCESSABLE.code)
    await ds.query(
      'UPDATE wxoa_reply_rule SET deleted_at = NOW(3) WHERE account_id = ? ORDER BY id LIMIT 1',
      [full],
    )
    await add(keyword(full))
  })
})

describe('403', () => {
  it('without the permission of a route the request is refused', async () => {
    const { id } = await add(keyword(a))
    await call('plain', 'get', `?accountId=${a}`).expect(403)
    await call('plain', 'get', `/${id}`).expect(403)
    await call('reader', 'get', `?accountId=${a}`).expect(200)
    await call('reader', 'get', `/${id}`).expect(200)
    await call('reader', 'post', '', keyword(a)).expect(403)
    await call('reader', 'put', `/${id}`, whole(keyword(a))).expect(403)
    await call('reader', 'delete', `/${id}`).expect(403)
    expect((await ruleRow(id)).deleted_at).toBeNull()
  })
})

it('every write leaves an action log row with domain wxoa.reply, its verb and the id', async () => {
  const trace = `${PREFIX}${process.pid}-`
  const body = keyword(a)
  const created = await call('admin', 'post', '', body).set('X-Request-Id', `${trace}c`).expect(201)
  const { id } = created.body.data
  await call('admin', 'put', `/${id}`, whole(body)).set('X-Request-Id', `${trace}u`).expect(200)
  await call('admin', 'delete', `/${id}`).set('X-Request-Id', `${trace}d`).expect(200)
  for (const [suffix, verb] of [
    ['c', 'create'],
    ['u', 'modify'],
    ['d', 'remove'],
  ])
    expect(await logOf(ds, `${trace}${suffix}`)).toMatchObject({
      domain: 'wxoa.reply',
      verb,
      biz_id: String(id),
      ok: 1,
    })
})

it('Swagger documents every route', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  expect(
    Object.keys(doc.paths)
      .filter((p) => p.startsWith(URL))
      .sort(),
  ).toEqual([URL, `${URL}/{id}`])
  expect(Object.keys(doc.paths[URL]).sort()).toEqual(['get', 'post'])
  expect(Object.keys(doc.paths[`${URL}/{id}`]).sort()).toEqual(['delete', 'get', 'put'])
})
