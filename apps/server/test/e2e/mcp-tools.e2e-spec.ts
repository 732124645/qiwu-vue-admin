// The sample tools (see docs/mcp.md) run as their caller: iam.user.search answers the rows the user list
// gives the same user (data scope, masking), iam.me.get the token's own user, cfg.dict.options the labels
// in the request's language, demo.book.create writes like the create route (data scope of the dept,
// uniqueness, the creator) and is refused outside the caller's scope.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { bookPerms, DEFAULT_TENANT_ID, deptPerms, Err, userPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { callTool, patFor, rpc } from './mcp-kit.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'

const PREFIX = 'mcp-tools-e2e-'

let app: NestExpressApplication
let ds: DataSource
const DEPT = { mine: 0, other: 0 }
const users: Record<'scoped' | 'peer' | 'stranger', number> = { scoped: 0, peer: 0, stranger: 0 }
let roleId = 0
/** a second role of the caller: every row, but for another perm only */
let wideRoleId = 0
let token = ''
let lastBook = 0
let seq = 0

async function user(name: string, deptId: number, roles: number[] = []) {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'iam_user', {
      username: PREFIX + name,
      display_name: name,
      password_hash: 'not-used-by-this-spec',
      password_changed_at: new Date(),
      dept_id: deptId,
      mobile: `1380013800${++seq}`,
    }),
  )
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)', [
      id,
      r,
      DEFAULT_TENANT_ID,
    ])
  return id
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  await cleanRedis(app.get<Redis>(REDIS))
  lastBook = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM demo_book'))[0].n)
  for (const k of ['mine', 'other'] as const) {
    DEPT[k] = await inTenant1(() =>
      insertRow(ds.manager, 'iam_dept', { tree_path: '/', name: `${PREFIX}${k}` }),
    )
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`/${DEPT[k]}/`, DEPT[k]])
  }
  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}own`,
      name: `${PREFIX}own`,
      data_scope: 'own_dept',
    }),
  )
  for (const perms of [userPerms.browse, bookPerms.browse, bookPerms.create])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
      roleId,
      await findId(ds.manager, 'iam_menu', { perms }),
      DEFAULT_TENANT_ID,
    ])
  wideRoleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}wide`,
      name: `${PREFIX}wide`,
      data_scope: 'all',
    }),
  )
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
    wideRoleId,
    await findId(ds.manager, 'iam_menu', { perms: deptPerms.browse }),
    DEFAULT_TENANT_ID,
  ])
  users.scoped = await user('scoped', DEPT.mine, [roleId, wideRoleId])
  users.peer = await user('peer', DEPT.mine)
  users.stranger = await user('stranger', DEPT.other)
  token = (await patFor(app, users.scoped, { allowWrite: true })).token
})

afterAll(async () => {
  if (ds) {
    const ids = Object.values(users)
    await ds.query('DELETE FROM demo_book WHERE id > ?', [lastBook])
    await ds.query('DELETE FROM iam_access_token WHERE user_id IN (?)', [ids])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [ids])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [[roleId, wideRoleId]])
    await ds.query('DELETE FROM iam_role WHERE id IN (?)', [[roleId, wideRoleId]])
    await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [Object.values(DEPT)])
  }
  await app?.close()
})

it('iam.user.search answers exactly the rows the user list gives the same user, masked alike: the scope of the tool’s perm, not of every role', async () => {
  const console = (await signIn(app, `${PREFIX}scoped`)).accessToken
  const list = await request(app.getHttpServer())
    .get('/api/iam/users')
    .set(bearer(console))
    .query({ pageSize: 50 })
    .expect(200)
  const found = await callTool(app, token, 'iam.user.search', { pageSize: 50 })
  const items = (found.data as { items: { id: number; mobile: string | null }[]; total: number })
    .items
  expect(items.map((u) => u.id).sort()).toEqual(
    (list.body.data.items as { id: number }[]).map((u) => u.id).sort(),
  )
  expect((found.data as { total: number }).total).toBe(list.body.data.total)
  expect(items.map((u) => u.id)).toEqual(expect.arrayContaining([users.scoped, users.peer]))
  expect(items.map((u) => u.id)).not.toContain(users.stranger)
  // no iam.user.modify: contacts masked, as on the list
  expect(items.find((u) => u.id === users.peer)?.mobile).not.toMatch(/^1380013800\d$/)
  // the filters are the list's too
  const one = await callTool(app, token, 'iam.user.search', { keyword: `${PREFIX}peer` })
  expect((one.data as { items: { id: number }[] }).items.map((u) => u.id)).toEqual([users.peer])
  const none = await callTool(app, token, 'iam.user.search', { keyword: `${PREFIX}stranger` })
  expect(none.data).toEqual({ total: 0, items: [] })
})

it('iam.me.get answers the token’s own user', async () => {
  expect((await callTool(app, token, 'iam.me.get')).data).toMatchObject({
    id: users.scoped,
    username: `${PREFIX}scoped`,
    deptName: `${PREFIX}mine`,
    roleNames: expect.arrayContaining([`${PREFIX}own`, `${PREFIX}wide`]),
  })
})

it('cfg.dict.options answers the labels in the request’s language; an unknown dict is not found', async () => {
  const [row] = await ds.query<{ label: string; label_i18n: Record<string, string> | null }[]>(
    "SELECT label, label_i18n FROM cfg_dict_entry WHERE dict_code = 'core.enabled' AND value = 'true'",
  )
  const ask = (lang: string) =>
    rpc(app, token, 'tools/call', { name: 'cfg.dict.options', arguments: { code: 'core.enabled' } })
      .set('Accept-Language', lang)
      .expect(200)
      .then(
        (r) =>
          JSON.parse(r.body.result.content[0].text as string) as {
            entries: { value: string; label: string }[]
          },
      )
  expect((await ask('en-US')).entries.find((e) => e.value === 'true')?.label).toBe(
    row!.label_i18n?.['en-US'] ?? row!.label,
  )
  expect((await ask('zh-CN')).entries.find((e) => e.value === 'true')?.label).toBe(
    row!.label_i18n?.['zh-CN'] ?? row!.label,
  )
  expect(
    (await callTool(app, token, 'cfg.dict.options', { code: 'no.such_dict' })).error?.code,
  ).toBe(Err.NOT_FOUND.code)
})

it('demo.book.create writes like the create route: the caller’s dept scope, uniqueness, the creator', async () => {
  const made = await callTool(app, token, 'demo.book.create', {
    isbn: `${PREFIX}1`,
    title: 'Written by an agent',
    genre: 'fiction',
    deptId: DEPT.mine,
  })
  const id = (made.data as { id: number }).id
  const [row] = await ds.query<{ created_by: number; tenant_id: number; dept_id: number }[]>(
    'SELECT created_by, tenant_id, dept_id FROM demo_book WHERE id = ?',
    [id],
  )
  expect(row).toMatchObject({ created_by: users.scoped, tenant_id: 1, dept_id: DEPT.mine })
  const twice = await callTool(app, token, 'demo.book.create', {
    isbn: `${PREFIX}1`,
    title: 'Again',
    genre: 'fiction',
    deptId: DEPT.mine,
  })
  expect(twice.error?.code).toBe(Err.DUPLICATE.code)
  const outside = await callTool(app, token, 'demo.book.create', {
    isbn: `${PREFIX}2`,
    title: 'Elsewhere',
    genre: 'fiction',
    deptId: DEPT.other,
  })
  expect(outside.error).toBeDefined()
  expect(await ds.query('SELECT id FROM demo_book WHERE isbn = ?', [`${PREFIX}2`])).toEqual([])
})
