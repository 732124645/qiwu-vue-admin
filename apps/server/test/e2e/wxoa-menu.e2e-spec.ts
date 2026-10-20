// WeChat Official Account custom menus (see docs/design-notes.md#wxoa): drafts (one default menu per
// account, conditional menus matching a tag of the account and / or a platform), button limits in UTF-8
// bytes, publish (menu/create; addconditional once the default menu is published, else B6009, also on
// WeChat's 65303; the replaced menuid deleted afterwards), the unpublished-changes flag, delete (a published conditional menu
// on WeChat too), clear (menu/delete, drafts stay), pull (menu/get overwrites, menus without a match
// condition skipped and listed, retired buttons kept read-only, a pulled tag kept), try-match; PUT
// validated against the stored menu; every route through the account (missing or deleted 404, disabled B6011); 403 per
// permission; 400; @ActionLog. WeChat is a fake gateway that records every request body.
import { randomBytes } from 'node:crypto'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, wxoaMenuPullResult, wxoaMenuTryMatchVo, wxoaPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId as findIdRaw, insertRow as insertRowRaw } from '../../src/db/seeds/upsert.js'
import { upstreamError, WxoaGateway } from '../../src/modules/platform/wxoa/core/wxoa-gateway.js'
import { fakeWxoaGateway } from '../fixtures/wxoa/fake-gateway.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
const findId = (...args: Parameters<typeof findIdRaw>) => inTenant1(() => findIdRaw(...args))
const insertRow = (...args: Parameters<typeof insertRowRaw>) =>
  inTenant1(() => insertRowRaw(...args))

const PREFIX = 'e2e-wxoa-menu-'
const URL = '/api/wxoa/menus'
const CREATE = '/cgi-bin/menu/create'
const ADD_COND = '/cgi-bin/menu/addconditional'
const DEL_COND = '/cgi-bin/menu/delconditional'
const GET = '/cgi-bin/menu/get'
const DELETE = '/cgi-bin/menu/delete'
const TRY = '/cgi-bin/menu/trymatch'
const MISSING = 999_999

const fake = fakeWxoaGateway()
let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens = { admin: '', publisher: '', editor: '', reader: '', plain: '' }
const userIds: number[] = []
const roleIds: number[] = []
const accountIds: number[] = []
/** enabled accounts A and B, a disabled one */
let a: number
let b: number
let off: number
let tagSeq = 100

let seq = 0
const unique = () => `${PREFIX}${++seq}`
type Method = 'get' | 'post' | 'put' | 'delete'
const call = (who: keyof typeof tokens, method: Method, path = '', body?: object) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const add = async (body: object) => (await call('admin', 'post', '', body).expect(201)).body.data
const publish = async (id: number) =>
  (await call('admin', 'post', `/${id}/publish`).expect(200)).body.data
const one = async (id: number) => (await call('admin', 'get', `/${id}`).expect(200)).body.data
const menuRow = async (id: number) =>
  (await ds.query('SELECT * FROM wxoa_menu WHERE id = ?', [id]))[0]
const bodies = (path: string) => fake.callsTo(path).map((c) => c.body)

const BUTTONS = [{ name: 'Hi', kind: 'click', key: 'K_HI' }]
/** A default menu draft of `accountId` (unique label: no two creates are the same submission). */
const defaultMenu = (accountId: number, over: object = {}) => ({
  accountId,
  menuKind: 'default',
  label: unique(),
  buttons: BUTTONS,
  ...over,
})
const conditional = (accountId: number, over: object = {}) => ({
  accountId,
  menuKind: 'conditional',
  label: unique(),
  matchPlatform: 'ios',
  buttons: BUTTONS,
  ...over,
})
/** A PUT body: the menu as a whole, without `accountId` and `menuKind`. */
const whole = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'accountId' && k !== 'menuKind'))

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
/** A tag of `accountId`: its upstream id. */
async function tag(accountId: number) {
  const tagId = ++tagSeq
  await insertRow(ds.manager, 'wxoa_tag', { account_id: accountId, tag_id: tagId, name: unique() })
  return tagId
}

async function role(name: string, perms: string[]) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + name,
    name: PREFIX + name,
    data_scope: 'all',
  })
  roleIds.push(id)
  for (const perm of perms)
    await ds.query('INSERT INTO iam_role_menus (tenant_id, role_id, menu_id) VALUES (1, ?, ?)', [
      id,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
    ])
  return id
}
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
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(WxoaGateway)
    .useValue(fake.gateway)
    .compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  const m = wxoaPerms.menu
  tokens.admin = (await signIn(app)).accessToken
  tokens.publisher = await user('publisher', [
    await role('publisher', [m.browse, m.modify, m.publish]),
  ])
  tokens.editor = await user('editor', [await role('editor', [m.browse, m.modify])])
  tokens.reader = await user('reader', [await role('reader', [m.browse])])
  tokens.plain = await user('plain', [])
  a = await account()
  b = await account()
  off = await account(false)
})

beforeEach(() => fake.reset())

afterAll(async () => {
  if (ds) {
    if (accountIds.length) {
      for (const table of ['wxoa_menu', 'wxoa_tag'])
        // arch-allow: sql-concat table names are spec constants; ids bound
        await ds.query(`DELETE FROM ${table} WHERE account_id IN (?)`, [accountIds])
      await ds.query('DELETE FROM wxoa_account WHERE id IN (?)', [accountIds])
    }
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('drafts', () => {
  it('a default menu draft is created, read and listed first, under its own account only; a second default menu → 409', async () => {
    const acc = await account()
    const cond = await add(conditional(acc))
    const menu = await add(defaultMenu(acc))
    expect(menu).toMatchObject({
      accountId: acc,
      menuKind: 'default',
      matchTagId: null,
      matchPlatform: null,
      buttons: BUTTONS,
      wxMenuId: null,
      publishedAt: null,
      unpublished: true,
    })
    expect(await one(menu.id)).toEqual(menu)
    const list = (await call('admin', 'get', `?accountId=${acc}`).expect(200)).body.data
    expect(list.map((x: { id: number }) => x.id)).toEqual([menu.id, cond.id])
    const ofA = (await call('admin', 'get', `?accountId=${a}`).expect(200)).body.data
    expect(ofA.map((x: { id: number }) => x.id)).not.toContain(menu.id)
    const again = await call('admin', 'post', '', defaultMenu(acc)).expect(409)
    expect(again.body.code).toBe(Err.DUPLICATE.code)
    expect(fake.calls).toEqual([])
  })

  it('names, keys and links are counted in UTF-8 bytes: at the limit saved, one byte over → 400', async () => {
    const ok = (buttons: object[]) => call('admin', 'post', '', conditional(a, { buttons }))
    const sub = (name: string) => [{ name: 'Top', subButtons: [{ name, kind: 'click', key: 'K' }] }]
    const link = (url: string) => [{ name: 'Web', kind: 'view', url }]
    const site = 'https://example.com/'
    // 菜单名称一 is 15 bytes
    await ok([{ name: '菜单名称一A', kind: 'click', key: 'K' }]).expect(201)
    await ok([{ name: '菜单名称一AB', kind: 'click', key: 'K' }]).expect(400)
    await ok(sub('一'.repeat(20))).expect(201)
    await ok(sub(`${'一'.repeat(20)}A`)).expect(400)
    await ok([{ name: 'K', kind: 'click', key: `${'键'.repeat(42)}kk` }]).expect(201)
    await ok([{ name: 'K', kind: 'click', key: 'k'.repeat(129) }]).expect(400)
    await ok(link(site + 'a'.repeat(1024 - site.length))).expect(201)
    await ok(link(site + 'a'.repeat(1025 - site.length))).expect(400)
  })

  it('button structure: 1–3 buttons of 1–5 sub-buttons, the fields of each kind exactly, no retired kind → 400', async () => {
    const bad = async (buttons: unknown) =>
      call('admin', 'post', '', conditional(a, { buttons })).expect(400)
    const click = (i: number) => ({ name: `B${i}`, kind: 'click', key: `K${i}` })
    await bad([])
    await bad([click(1), click(2), click(3), click(4)])
    await bad([{ name: 'Top', subButtons: [1, 2, 3, 4, 5, 6].map(click) }])
    await bad([{ name: 'Top', subButtons: [] }])
    await bad([{ name: 'C', kind: 'click' }])
    await bad([{ name: 'C', kind: 'click', key: 'K', url: 'https://example.com/' }])
    await bad([{ name: 'V', kind: 'view', url: 'ftp://example.com/' }])
    await bad([{ name: 'M', kind: 'miniprogram', url: 'https://example.com/', appId: 'wx1' }])
    await bad([{ name: 'P', kind: 'click', key: 'K', subButtons: [click(1)] }])
    await bad([{ name: 'L', kind: 'media_id', mediaId: 'MEDIA' }])
    await bad([{ name: 'L', kind: 'view_limited', mediaId: 'MEDIA' }])
    const res = await call('admin', 'post', '', conditional(a, { buttons: [{ name: 'C' }] }))
    expect(res.status).toBe(400)
    expect(res.body.msg).toBeTruthy()
  })

  it('a conditional menu needs a match condition and a default one takes none; a match tag of another account → 404', async () => {
    const aTag = await tag(a)
    const bTag = await tag(b)
    const gone = await tag(a)
    await ds.query('UPDATE wxoa_tag SET deleted_at = NOW(3) WHERE account_id = ? AND tag_id = ?', [
      a,
      gone,
    ])
    await call('admin', 'post', '', conditional(a, { matchPlatform: null })).expect(400)
    await call('admin', 'post', '', defaultMenu(b, { matchPlatform: 'ios' })).expect(400)
    await call('admin', 'post', '', defaultMenu(b, { matchTagId: bTag })).expect(400)
    await call('admin', 'post', '', conditional(a, { matchTagId: bTag })).expect(404)
    await call('admin', 'post', '', conditional(a, { matchTagId: gone })).expect(404)
    await call('admin', 'post', '', conditional(a, { matchTagId: MISSING })).expect(404)
    const menu = await add(conditional(a, { matchTagId: aTag, matchPlatform: null }))
    expect(menu).toMatchObject({ matchTagId: aTag, matchPlatform: null })
  })

  it('PUT replaces the draft as a whole, checked against the stored menu: accountId, menuKind, wrong match → 400, another account’s tag → 404', async () => {
    const aTag = await tag(a)
    const bTag = await tag(b)
    const body = conditional(a, { matchTagId: aTag })
    const { id } = await add(body)
    const before = await menuRow(id)
    await call('admin', 'put', `/${id}`, { ...whole(body), accountId: b }).expect(400)
    await call('admin', 'put', `/${id}`, { ...whole(body), menuKind: 'default' }).expect(400)
    await call('admin', 'put', `/${id}`, { ...whole(body), matchTagId: bTag }).expect(404)
    await call('admin', 'put', `/${id}`, {
      ...whole(body),
      matchTagId: null,
      matchPlatform: null,
    }).expect(400)
    expect(await menuRow(id)).toEqual(before)
    await call('admin', 'put', `/${id}`, {
      label: 'renamed',
      matchPlatform: 'android',
      buttons: [{ name: 'New', kind: 'view', url: 'https://example.com/n' }],
    }).expect(200)
    expect(await one(id)).toMatchObject({
      label: 'renamed',
      matchTagId: null,
      matchPlatform: 'android',
      buttons: [{ name: 'New', kind: 'view', url: 'https://example.com/n' }],
    })
    const dflt = await add(defaultMenu(await account()))
    await call('admin', 'put', `/${dflt.id}`, {
      ...whole(defaultMenu(0)),
      matchPlatform: 'ios',
    }).expect(400)
  })
})

describe('publish', () => {
  const ALL = [
    { name: 'Click', kind: 'click', key: 'K_CLICK' },
    {
      name: 'Links',
      subButtons: [
        { name: 'Site', kind: 'view', url: 'https://example.com/a' },
        {
          name: 'Mini',
          kind: 'miniprogram',
          url: 'https://example.com/m',
          appId: 'wx0123456789abcdef',
          pagePath: 'pages/index?x=1',
        },
        { name: 'Scan', kind: 'scancode_push', key: 'K_SCAN' },
        { name: 'Wait', kind: 'scancode_waitmsg', key: 'K_WAIT' },
        { name: 'Article', kind: 'article_id', articleId: 'ART_1' },
      ],
    },
    {
      name: '菜单名称一A',
      subButtons: [
        { name: 'Photo', kind: 'pic_sysphoto', key: 'K_P1' },
        { name: 'Album', kind: 'pic_photo_or_album', key: 'K_P2' },
        { name: 'WxPic', kind: 'pic_weixin', key: 'K_P3' },
        { name: 'Loc', kind: 'location_select', key: `${'键'.repeat(42)}kk` },
        { name: 'Limited', kind: 'article_view_limited', articleId: 'ART_2' },
      ],
    },
  ]
  const WIRE = [
    { type: 'click', name: 'Click', key: 'K_CLICK' },
    {
      name: 'Links',
      sub_button: [
        { type: 'view', name: 'Site', url: 'https://example.com/a' },
        {
          type: 'miniprogram',
          name: 'Mini',
          url: 'https://example.com/m',
          appid: 'wx0123456789abcdef',
          pagepath: 'pages/index?x=1',
        },
        { type: 'scancode_push', name: 'Scan', key: 'K_SCAN' },
        { type: 'scancode_waitmsg', name: 'Wait', key: 'K_WAIT' },
        { type: 'article_id', name: 'Article', article_id: 'ART_1' },
      ],
    },
    {
      name: '菜单名称一A',
      sub_button: [
        { type: 'pic_sysphoto', name: 'Photo', key: 'K_P1' },
        { type: 'pic_photo_or_album', name: 'Album', key: 'K_P2' },
        { type: 'pic_weixin', name: 'WxPic', key: 'K_P3' },
        { type: 'location_select', name: 'Loc', key: `${'键'.repeat(42)}kk` },
        { type: 'article_view_limited', name: 'Limited', article_id: 'ART_2' },
      ],
    },
  ]

  it('the default menu goes to menu/create with every kind in WeChat’s shape; a change shows as unpublished until published again', async () => {
    fake.on(CREATE, { errcode: 0, errmsg: 'ok' })
    const body = defaultMenu(await account(), { buttons: ALL })
    const { id } = await add(body)
    const published = await publish(id)
    expect(bodies(CREATE)).toEqual([{ button: WIRE }])
    expect(published).toMatchObject({ unpublished: false, wxMenuId: null })
    expect(published.publishedAt).not.toBeNull()
    // read back from the JSON column (its own key order): still the published buttons
    expect(await one(id)).toMatchObject({ unpublished: false })
    await call('admin', 'put', `/${id}`, { ...whole(body), label: 'renamed' }).expect(200)
    expect(await one(id)).toMatchObject({ unpublished: false })
    const changed = structuredClone(ALL)
    changed[0]!.key = 'K_OTHER'
    await call('admin', 'put', `/${id}`, { ...whole(body), buttons: changed }).expect(200)
    expect(await one(id)).toMatchObject({ unpublished: true })
    await call('admin', 'put', `/${id}`, whole(body)).expect(200)
    expect(await one(id)).toMatchObject({ unpublished: false })
  })

  it('a refused publish changes nothing', async () => {
    fake.on(CREATE, upstreamError(40018))
    const { id } = await add(defaultMenu(await account()))
    const res = await call('admin', 'post', `/${id}/publish`).expect(422)
    expect(res.body.code).toBe(Err.WXOA_UPSTREAM_REFUSED.code)
    expect(await one(id)).toMatchObject({ publishedAt: null, unpublished: true })
  })

  it('a conditional menu needs the default menu published (B6009); it goes to addconditional with its match rule, publishing again replaces it', async () => {
    const acc = await account()
    const accTag = await tag(acc)
    const cond = await add(conditional(acc, { matchTagId: accTag, matchPlatform: 'android' }))
    const refused = async () => {
      const res = await call('admin', 'post', `/${cond.id}/publish`).expect(422)
      expect(res.body.code).toBe(Err.WXOA_DEFAULT_MENU_REQUIRED.code)
    }
    await refused()
    const dflt = await add(defaultMenu(acc))
    await refused()
    expect(fake.calls).toEqual([])
    fake.on(CREATE, { errcode: 0 })
    await publish(dflt.id)
    fake.on(ADD_COND, { menuid: 1001 }, { menuid: '1002' }, { menuid: '1003' })
    fake.on(DEL_COND, { errcode: 0 }, upstreamError(45009))
    expect(await publish(cond.id)).toMatchObject({ wxMenuId: '1001', unpublished: false })
    expect(bodies(ADD_COND)).toEqual([
      {
        button: [{ type: 'click', name: 'Hi', key: 'K_HI' }],
        matchrule: { tag_id: String(accTag), client_platform_type: '2' },
      },
    ])
    expect(fake.callsTo(DEL_COND)).toEqual([])
    expect(await publish(cond.id)).toMatchObject({ wxMenuId: '1002' })
    expect(bodies(DEL_COND)).toEqual([{ menuid: '1001' }])
    // the replaced menu not deleted on WeChat: the new one is published all the same
    expect(await publish(cond.id)).toMatchObject({ wxMenuId: '1003' })
    expect(bodies(DEL_COND)).toEqual([{ menuid: '1001' }, { menuid: '1002' }])
    // each replaced menu deleted only after its successor was added: no gap for the matched fans
    expect(fake.calls.map((c) => c.path)).toEqual([
      CREATE,
      ADD_COND,
      ADD_COND,
      DEL_COND,
      ADD_COND,
      DEL_COND,
    ])
    // a change of the match rule is an unpublished change
    await call('admin', 'put', `/${cond.id}`, {
      ...whole(conditional(acc)),
      matchTagId: accTag,
    }).expect(200)
    expect(await one(cond.id)).toMatchObject({ unpublished: true })
  })

  it('WeChat without a default menu (65303) → B6009, and the local default menu counts as unpublished', async () => {
    const acc = await account()
    fake.on(CREATE, { errcode: 0 })
    const dflt = await add(defaultMenu(acc))
    await publish(dflt.id)
    const cond = await add(conditional(acc))
    fake.on(ADD_COND, upstreamError(65303))
    const res = await call('admin', 'post', `/${cond.id}/publish`).expect(422)
    expect(res.body.code).toBe(Err.WXOA_DEFAULT_MENU_REQUIRED.code)
    expect(await one(dflt.id)).toMatchObject({ publishedAt: null, unpublished: true })
    expect(await one(cond.id)).toMatchObject({ publishedAt: null, wxMenuId: null })
    fake.reset()
    await call('admin', 'post', `/${cond.id}/publish`).expect(422)
    expect(fake.calls).toEqual([])
  })

  it('deleting a published conditional menu deletes it on WeChat first (one WeChat no longer has too); a refusal keeps it', async () => {
    const acc = await account()
    fake.on(CREATE, { errcode: 0 })
    await publish((await add(defaultMenu(acc))).id)
    fake.on(ADD_COND, { menuid: '2001' }, { menuid: '2002' })
    const first = await add(conditional(acc))
    const second = await add(conditional(acc, { matchPlatform: 'other' }))
    await publish(first.id)
    await publish(second.id)
    fake.on(DEL_COND, upstreamError(45009), { errcode: 0 })
    expect((await call('admin', 'delete', `/${first.id}`).expect(429)).body.code).toBe(
      Err.WXOA_QUOTA_EXCEEDED.code,
    )
    expect((await menuRow(first.id)).deleted_at).toBeNull()
    await call('admin', 'delete', `/${first.id}`).expect(200)
    expect((await menuRow(first.id)).deleted_at).not.toBeNull()
    fake.on(DEL_COND, upstreamError(65301))
    await call('admin', 'delete', `/${second.id}`).expect(200)
    expect(bodies(DEL_COND)).toEqual([{ menuid: '2001' }, { menuid: '2001' }, { menuid: '2002' }])
    // drafts and the default menu: nothing on WeChat
    fake.reset()
    const draft = await add(conditional(acc))
    await call('admin', 'delete', `/${draft.id}`).expect(200)
    const list = (await call('admin', 'get', `?accountId=${acc}`).expect(200)).body.data
    await call('admin', 'delete', `/${list[0].id}`).expect(200)
    expect(fake.calls).toEqual([])
    await call('admin', 'get', `/${draft.id}`).expect(404)
  })

  it('clear removes every menu on WeChat; the drafts stay, unpublished', async () => {
    const acc = await account()
    fake.on(CREATE, { errcode: 0 })
    fake.on(ADD_COND, { menuid: '3001' })
    fake.on(DELETE, { errcode: 0 })
    const dflt = await add(defaultMenu(acc))
    const cond = await add(conditional(acc))
    await publish(dflt.id)
    await publish(cond.id)
    await call('admin', 'post', '/clear', { accountId: acc }).expect(200)
    expect(fake.callsTo(DELETE).map((c) => [c.method, c.accountId, c.body])).toEqual([
      ['json', acc, undefined],
    ])
    for (const id of [dflt.id, cond.id])
      expect(await one(id)).toMatchObject({ wxMenuId: null, publishedAt: null, unpublished: true })
  })
})

describe('pull', () => {
  it('menu/get overwrites the local menus; a conditional menu matching neither a tag nor a platform is skipped and listed', async () => {
    const acc = await account()
    const accTag = await tag(acc)
    const localDefault = await add(defaultMenu(acc))
    const draft = await add(conditional(acc))
    const old = await add(conditional(acc, { matchPlatform: 'android' }))
    const kept = await add(conditional(acc, { matchPlatform: 'other' }))
    await ds.query(
      "UPDATE wxoa_menu SET wx_menu_id = '501', published_at = NOW(3), published_digest = REPEAT('0', 64) WHERE id = ?",
      [old.id],
    )
    await ds.query(
      "UPDATE wxoa_menu SET wx_menu_id = '601', published_at = NOW(3), published_digest = REPEAT('0', 64) WHERE id = ?",
      [kept.id],
    )
    fake.on(GET, {
      menu: {
        button: [
          { type: 'click', name: '今日', key: 'K_TODAY', sub_button: [] },
          {
            name: '旧的',
            sub_button: [
              { type: 'media_id', name: '图片', media_id: 'MEDIA_1', sub_button: [] },
              { type: 'view_limited', name: '图文', media_id: 'MEDIA_2' },
              { type: 'view', name: '官网', url: 'https://example.com/', sub_button: [] },
            ],
          },
        ],
        menuid: 400,
      },
      conditionalmenu: [
        {
          button: [{ type: 'click', name: 'iOS', key: 'K_IOS', sub_button: [] }],
          matchrule: { tag_id: '', sex: '', client_platform_type: '1' },
          menuid: 601,
        },
        {
          button: [{ type: 'click', name: 'VIP', key: 'K_VIP' }],
          matchrule: { group_id: String(accTag) },
          menuid: '602',
        },
        {
          button: [{ type: 'click', name: 'M', key: 'K_M' }],
          matchrule: { sex: '1', tag_id: '', client_platform_type: '' },
          menuid: 603,
        },
        {
          button: [{ type: 'unknown_kind', name: 'U', key: 'K_U' }],
          matchrule: { client_platform_type: '2' },
          menuid: 604,
        },
        {
          button: [{ type: 'click', name: 'A', key: 'K_A' }],
          matchrule: { client_platform_type: '2' },
        },
      ],
    })
    const res = (await call('admin', 'post', '/pull', { accountId: acc }).expect(200)).body.data
    // exactly the shared shape: parsing strips no key and rejects nothing
    expect(wxoaMenuPullResult.parse(res)).toEqual(res)
    expect(res.skipped).toEqual([
      { menuKind: 'conditional', wxMenuId: '603', reason: 'no_match' },
      { menuKind: 'conditional', wxMenuId: '604', reason: 'invalid' },
      // no menuid: nothing to delete or match it by later
      { menuKind: 'conditional', wxMenuId: null, reason: 'invalid' },
    ])
    const byId = new Map<number, any>(res.menus.map((m: { id: number }) => [m.id, m]))
    expect(byId.get(localDefault.id)).toMatchObject({
      label: localDefault.label,
      unpublished: false,
      buttons: [
        { name: '今日', kind: 'click', key: 'K_TODAY' },
        {
          name: '旧的',
          subButtons: [
            { name: '图片', kind: 'media_id', mediaId: 'MEDIA_1' },
            { name: '图文', kind: 'view_limited', mediaId: 'MEDIA_2' },
            { name: '官网', kind: 'view', url: 'https://example.com/' },
          ],
        },
      ],
    })
    expect(byId.get(kept.id)).toMatchObject({
      label: kept.label,
      wxMenuId: '601',
      matchTagId: null,
      matchPlatform: 'ios',
      buttons: [{ name: 'iOS', kind: 'click', key: 'K_IOS' }],
      unpublished: false,
    })
    const added = res.menus.find((m: { wxMenuId: string | null }) => m.wxMenuId === '602')
    expect(added).toMatchObject({
      menuKind: 'conditional',
      matchTagId: accTag,
      matchPlatform: null,
      unpublished: false,
    })
    expect(byId.get(old.id)).toMatchObject({ wxMenuId: null, publishedAt: null, unpublished: true })
    expect(byId.get(draft.id)).toMatchObject({ publishedAt: null, buttons: BUTTONS })
    expect(res.menus).toHaveLength(5)
    expect(
      await ds.query(
        "SELECT id FROM wxoa_menu WHERE account_id = ? AND wx_menu_id IN ('603','604')",
        [acc],
      ),
    ).toEqual([])

    // the pulled retired buttons: kept as they are or dropped, never changed or added
    const body = { label: 'pulled', buttons: byId.get(localDefault.id).buttons }
    await call('admin', 'put', `/${localDefault.id}`, body).expect(200)
    const [today, legacy] = body.buttons
    const subs = legacy.subButtons
    const withSubs = (subButtons: object[]) => ({
      ...body,
      buttons: [today, { ...legacy, subButtons }],
    })
    await call(
      'admin',
      'put',
      `/${localDefault.id}`,
      withSubs([{ ...subs[0], mediaId: 'MEDIA_9' }, subs[1], subs[2]]),
    ).expect(400)
    await call(
      'admin',
      'put',
      `/${localDefault.id}`,
      withSubs([{ ...subs[0], name: 'renamed' }, subs[1], subs[2]]),
    ).expect(400)
    await call('admin', 'put', `/${localDefault.id}`, withSubs([...subs, subs[0]])).expect(400)
    await call('admin', 'put', `/${localDefault.id}`, withSubs([subs[2]])).expect(200)
    expect((await one(localDefault.id)).buttons[1].subButtons).toEqual([subs[2]])
    await call('admin', 'put', `/${localDefault.id}`, withSubs(subs)).expect(400)
  })

  it('a default menu WeChat has but this module cannot take is listed; the local one shows unpublished changes', async () => {
    const acc = await account()
    fake.on(CREATE, { errcode: 0 })
    const dflt = await add(defaultMenu(acc))
    await publish(dflt.id)
    fake.on(GET, {
      menu: { button: [{ type: 'unknown_kind', name: 'U', key: 'K_U' }], menuid: 800 },
    })
    const res = (await call('admin', 'post', '/pull', { accountId: acc }).expect(200)).body.data
    expect(res.skipped).toEqual([{ menuKind: 'default', wxMenuId: '800', reason: 'invalid' }])
    expect(res.menus).toEqual([
      expect.objectContaining({ id: dflt.id, buttons: BUTTONS, unpublished: true }),
    ])
    expect(res.menus[0].publishedAt).not.toBeNull()
  })

  it('a pulled menu matching a tag not kept here is saved unchanged (200); changed to another account’s tag → 404', async () => {
    const acc = await account()
    const bTag = await tag(b)
    fake.on(GET, {
      menu: { button: [{ type: 'click', name: 'Hi', key: 'K_HI' }], menuid: 700 },
      conditionalmenu: [
        {
          button: [{ type: 'click', name: 'VIP', key: 'K_VIP' }],
          matchrule: { tag_id: '777', client_platform_type: '' },
          menuid: 701,
        },
      ],
    })
    const res = (await call('admin', 'post', '/pull', { accountId: acc }).expect(200)).body.data
    const pulled = res.menus.find((m: { wxMenuId: string | null }) => m.wxMenuId === '701')
    expect(pulled).toMatchObject({ matchTagId: 777, matchPlatform: null })
    const body = { label: 'renamed', matchTagId: 777, matchPlatform: null, buttons: pulled.buttons }
    await call('admin', 'put', `/${pulled.id}`, body).expect(200)
    await call('admin', 'put', `/${pulled.id}`, {
      ...body,
      label: 'other',
      matchTagId: bTag,
    }).expect(404)
    expect(await one(pulled.id)).toMatchObject({
      label: 'renamed',
      matchTagId: 777,
      unpublished: false,
    })
  })

  it('no menu on WeChat (46003): the published local menus become unpublished drafts', async () => {
    const acc = await account()
    fake.on(CREATE, { errcode: 0 })
    const dflt = await add(defaultMenu(acc))
    await publish(dflt.id)
    fake.on(GET, upstreamError(46003))
    const res = (await call('admin', 'post', '/pull', { accountId: acc }).expect(200)).body.data
    expect(res.skipped).toEqual([])
    expect(res.menus).toEqual([expect.objectContaining({ id: dflt.id, publishedAt: null })])
    fake.on(GET, upstreamError(45009))
    await call('admin', 'post', '/pull', { accountId: acc }).expect(429)
  })
})

it('try-match asks WeChat which menu a fan sees and answers it in this module’s shape', async () => {
  fake.on(TRY, {
    button: [
      { type: 'click', name: 'A', key: 'K_A', sub_button: [] },
      {
        name: 'P',
        sub_button: [
          {
            type: 'miniprogram',
            name: 'M',
            url: 'https://e.com/',
            appid: 'wx0123456789abcdef',
            pagepath: 'p/a',
          },
        ],
      },
    ],
  })
  const res = await call('reader', 'post', '/try-match', { accountId: a, userId: 'oFan' })
  expect(res.status).toBe(200)
  expect(res.body.data).toEqual({
    buttons: [
      { name: 'A', kind: 'click', key: 'K_A' },
      {
        name: 'P',
        subButtons: [
          {
            name: 'M',
            kind: 'miniprogram',
            url: 'https://e.com/',
            appId: 'wx0123456789abcdef',
            pagePath: 'p/a',
          },
        ],
      },
    ],
  })
  expect(wxoaMenuTryMatchVo.parse(res.body.data)).toEqual(res.body.data)
  expect(fake.callsTo(TRY)).toEqual([
    expect.objectContaining({ accountId: a, body: { user_id: 'oFan' } }),
  ])
  // WeChat matched no menu
  fake.on(TRY, { button: [] })
  const none = await call('reader', 'post', '/try-match', { accountId: a, userId: 'oNone' })
  expect(none.body.data).toEqual({ buttons: [] })
  await call('admin', 'post', '/try-match', { accountId: a }).expect(400)
})

describe('the account', () => {
  it('an unknown or deleted account → 404 on every route; a disabled one → B6011; no accountId → 400', async () => {
    const gone = await account()
    const ofGone = await add(defaultMenu(gone))
    const ofOff = await add(conditional(gone))
    await ds.query('UPDATE wxoa_menu SET account_id = ? WHERE id = ?', [off, ofOff.id])
    await ds.query('UPDATE wxoa_account SET deleted_at = NOW(3) WHERE id = ?', [gone])
    const byAccount = (acc: number) =>
      [
        ['get', `?accountId=${acc}`, undefined],
        ['post', '', defaultMenu(acc)],
        ['post', '/pull', { accountId: acc }],
        ['post', '/clear', { accountId: acc }],
        ['post', '/try-match', { accountId: acc, userId: 'oFan' }],
      ] as const
    const byRow = (id: number) =>
      [
        ['get', `/${id}`, undefined],
        ['put', `/${id}`, whole(conditional(0))],
        ['delete', `/${id}`, undefined],
        ['post', `/${id}/publish`, undefined],
      ] as const
    for (const [method, path, body] of [...byAccount(MISSING), ...byAccount(gone)])
      await call('admin', method, path, body).expect(404)
    for (const [method, path, body] of byRow(ofGone.id))
      await call('admin', method, path, body).expect(404)
    await call('admin', 'get', `/${MISSING}`).expect(404)
    for (const [method, path, body] of [...byAccount(off), ...byRow(ofOff.id)]) {
      const res = await call('admin', method, path, body)
      expect(res.status).toBe(Err.WXOA_ACCOUNT_DISABLED.status)
      expect(res.body.code).toBe(Err.WXOA_ACCOUNT_DISABLED.code)
    }
    expect((await menuRow(ofOff.id)).deleted_at).toBeNull()
    expect(fake.calls).toEqual([])
    await call('admin', 'get', '').expect(400)
    await call('admin', 'post', '/pull', {}).expect(400)
    await call('admin', 'post', '/clear', {}).expect(400)
  })
})

describe('403', () => {
  it('without the permission of a route the request is refused', async () => {
    const { id } = await add(conditional(a))
    await call('plain', 'get', `?accountId=${a}`).expect(403)
    await call('plain', 'get', `/${id}`).expect(403)
    await call('plain', 'post', '/try-match', { accountId: a, userId: 'oFan' }).expect(403)
    await call('reader', 'get', `?accountId=${a}`).expect(200)
    await call('reader', 'get', `/${id}`).expect(200)
    for (const who of ['reader'] as const) {
      await call(who, 'post', '', conditional(a)).expect(403)
      await call(who, 'put', `/${id}`, whole(conditional(a))).expect(403)
      await call(who, 'delete', `/${id}`).expect(403)
      await call(who, 'post', '/pull', { accountId: a }).expect(403)
    }
    for (const who of ['reader', 'editor'] as const) {
      await call(who, 'post', `/${id}/publish`).expect(403)
      await call(who, 'post', '/clear', { accountId: a }).expect(403)
    }
    await call('editor', 'put', `/${id}`, whole(conditional(a))).expect(200)
    expect((await menuRow(id)).deleted_at).toBeNull()
    expect(fake.calls).toEqual([])
  })

  it('deleting a published conditional menu takes it off WeChat: modify alone → 403, nothing changed; drafts go with modify', async () => {
    const acc = await account()
    fake.on(CREATE, { errcode: 0 })
    const main = await add(defaultMenu(acc))
    await publish(main.id)
    fake.on(ADD_COND, { menuid: '3001' })
    const live = await add(conditional(acc))
    await publish(live.id)
    fake.reset()
    fake.on(DEL_COND, { errcode: 0 })
    const denied = await call('editor', 'delete', `/${live.id}`).expect(403)
    expect(denied.body.code).toBe(Err.FORBIDDEN.code)
    expect((await menuRow(live.id)).deleted_at).toBeNull()
    expect(fake.calls).toEqual([])
    // a draft and the default menu change nothing on WeChat
    const draft = await add(conditional(acc))
    await call('editor', 'delete', `/${draft.id}`).expect(200)
    await call('editor', 'delete', `/${main.id}`).expect(200)
    expect((await menuRow(draft.id)).deleted_at).not.toBeNull()
    expect(fake.calls).toEqual([])
    // modify and publish together take it off
    await call('publisher', 'delete', `/${live.id}`).expect(200)
    expect((await menuRow(live.id)).deleted_at).not.toBeNull()
    expect(bodies(DEL_COND)).toEqual([{ menuid: '3001' }])
  })
})

it('every write leaves an action log row with domain wxoa.menu, its verb and the id', async () => {
  const acc = await account()
  fake.on(CREATE, { errcode: 0 })
  fake.on(GET, upstreamError(46003))
  fake.on(DELETE, { errcode: 0 })
  const trace = `${PREFIX}${process.pid}-`
  const body = defaultMenu(acc)
  const created = await call('admin', 'post', '', body).set('X-Request-Id', `${trace}c`).expect(201)
  const { id } = created.body.data
  await call('admin', 'put', `/${id}`, whole(body)).set('X-Request-Id', `${trace}u`).expect(200)
  await call('admin', 'post', `/${id}/publish`).set('X-Request-Id', `${trace}p`).expect(200)
  await call('admin', 'delete', `/${id}`).set('X-Request-Id', `${trace}d`).expect(200)
  for (const [suffix, verb] of [
    ['c', 'create'],
    ['u', 'modify'],
    ['p', 'publish'],
    ['d', 'remove'],
  ])
    expect(await logOf(ds, `${trace}${suffix}`)).toMatchObject({
      domain: 'wxoa.menu',
      verb,
      biz_id: String(id),
      ok: 1,
    })
  await call('admin', 'post', '/pull', { accountId: acc }).set('X-Request-Id', `${trace}s`)
  await call('admin', 'post', '/clear', { accountId: acc }).set('X-Request-Id', `${trace}x`)
  expect(await logOf(ds, `${trace}s`)).toMatchObject({ domain: 'wxoa.menu', verb: 'sync', ok: 1 })
  expect(await logOf(ds, `${trace}x`)).toMatchObject({ domain: 'wxoa.menu', verb: 'clean', ok: 1 })
})

it('Swagger documents every route', async () => {
  const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
  expect(
    Object.keys(doc.paths)
      .filter((p) => p.startsWith(URL))
      .sort(),
  ).toEqual([
    URL,
    `${URL}/clear`,
    `${URL}/pull`,
    `${URL}/try-match`,
    `${URL}/{id}`,
    `${URL}/{id}/publish`,
  ])
  expect(Object.keys(doc.paths[URL]).sort()).toEqual(['get', 'post'])
  expect(Object.keys(doc.paths[`${URL}/{id}`]).sort()).toEqual(['delete', 'get', 'put'])
  const data = (path: string) =>
    doc.paths[`${URL}/${path}`].post.responses['200'].content['application/json'].schema.properties
      .data
  expect(Object.keys(data('pull').properties).sort()).toEqual(['menus', 'skipped'])
  expect(Object.keys(data('pull').properties.skipped.items.properties).sort()).toEqual([
    'menuKind',
    'reason',
    'wxMenuId',
  ])
  expect(Object.keys(data('try-match').properties)).toEqual(['buttons'])
  expect(data('try-match').properties.buttons.items.properties).toHaveProperty('subButtons')
})
