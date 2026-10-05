// iam/dept (see docs/design-notes.md#data-scope), the tree golden sample: the list as a filtered forest, create
// under an enabled parent (tree_path = parent's + own id), a move rewriting the whole subtree's paths in one
// statement (never below itself), enable with the ancestors / no disable over an enabled child, no delete
// with children or users, sibling names unique (409), the head as a user of the caller's scope; the data
// scope of every read and write (`own_dept` admin: out-of-scope depts → 404; `own_dept_tree` admin: its
// subtree only, rows never leave it); sessions of moved depts' users reload their dept path; 403 per perm,
// 400 translated, @Idempotent, @ActionLog, Swagger. Seeded depts are never changed: every write happens
// on depts this spec adds (removed afterwards).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { deptPerms, type DeptNode, Err, userPerms } from '@qiwu/shared'
import { I18nService } from 'nestjs-i18n'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-dept-'
const URL = '/api/iam/depts'
const MISSING = 999_999
const ALL = Object.values(deptPerms)

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let i18n: I18nService
const tok: Record<string, string> = {}
const uid: Record<string, number> = {}
const dept: Record<string, number> = {}
const created = { users: [] as number[], roles: [] as number[] }
/** the table's last id before this spec: every dept above it is this spec's (cleanup) */
let lastId = 0
let seq = 0
const unique = () => `${PREFIX}${++seq}`

const call = (who: string, method: 'get' | 'post' | 'put' | 'delete', path = '', body?: object) => {
  const req = request(app.getHttpServer())[method](`${URL}${path}`).set(bearer(tok[who]!))
  return body ? req.send(body) : req
}
/** A dept added by admin through the API (a unique name unless given); returns the row POST answers. */
const add = async (parentId: number, over: object = {}, who = 'admin') =>
  (await call(who, 'post', '', { parentId, name: unique(), ...over }).expect(201)).body.data
const row = async (id: number) =>
  (
    await ds.query(
      'SELECT parent_id, tree_path, enabled, deleted_at, updated_by, updated_at FROM iam_dept WHERE id = ?',
      [id],
    )
  )[0]
const pathOf = async (id: number): Promise<string> => (await row(id)).tree_path
/** Synthetic ASCII ancestor ids, ending in the real id, for exact column-length fixtures. */
const setPathLength = async (id: number, length: number): Promise<string> => {
  const prefix = `/${MISSING}/`
  const padding = length - prefix.length - `${id}/`.length
  const odd = padding % 2
  const path = `${prefix}${'1/'.repeat((padding - odd * 3) / 2)}${odd ? '11/' : ''}${id}/`
  expect(path).toHaveLength(length)
  await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [path, id])
  return path
}
const t = (lang: string, key: string, args?: object) => i18n.t(key, { lang, args }) as string
const expectErr = (res: request.Response, status: number, code: string) => {
  expect(res.status).toBe(status)
  expect(res.body.code).toBe(code)
}
/** Name tree of a forest: `name` or `[name, children]`. */
type Shape = string | [string, Shape[]]
const shape = (nodes: DeptNode[]): Shape[] =>
  nodes.map((n) => (n.children.length ? [n.name, shape(n.children)] : n.name))
const find = (nodes: DeptNode[], id: number): DeptNode | undefined => {
  for (const n of nodes) {
    const hit = n.id === id ? n : find(n.children, id)
    if (hit) return hit
  }
}

async function addRole(code: string, dataScope: string, perms: string[]) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + code,
    name: PREFIX + code,
    data_scope: dataScope,
  })
  for (const p of perms)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      id,
      await findId(ds.manager, 'iam_menu', { kind: 'action', perms: p }),
    ])
  created.roles.push(id)
  return id
}

/** A user inserted directly; `signedIn` also starts a session (token in `tok[name]`). */
async function user(name: string, deptId: number | null, roles: number[], signedIn = true) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: `${name} display`,
    dept_id: deptId,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  created.users.push(id)
  uid[name] = id
  if (signedIn) tok[name] = (await signIn(app, PREFIX + name)).accessToken
  return id
}

/** Usernames the user list shows `who` (their data scope for iam.user.browse). */
const usersSeenBy = async (who: string): Promise<string[]> =>
  (
    await request(app.getHttpServer())
      .get('/api/iam/users')
      .query({ pageSize: 200 })
      .set(bearer(tok[who]!))
      .expect(200)
  ).body.data.items.map((u: { username: string }) => u.username)

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  i18n = app.get(I18nService)
  await cleanRedis(redis)
  lastId = Number((await ds.query('SELECT COALESCE(MAX(id), 0) AS n FROM iam_dept'))[0].n)
  for (const key of ['hq', 'rd', 'platform', 'product', 'ops', 'support', 'finance'])
    dept[key] = (await findId(ds.manager, 'iam_dept', { name: `seed.dept.${key}` }))!
  tok.admin = (await signIn(app)).accessToken
  // dept admins of the rd dept: exactly it / it and below; users browse to watch scopes follow moves
  await user('own', dept.rd!, [await addRole('own', 'own_dept', ALL)])
  await user('tree', dept.rd!, [await addRole('tree', 'own_dept_tree', [...ALL, userPerms.browse])])
  await user('reader', null, [await addRole('reader', 'all', [deptPerms.browse])])
  await user('plain', null, [])
})

afterAll(async () => {
  if (ds) {
    if (created.users.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [created.users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [created.users])
    }
    if (created.roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role_depts WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [created.roles])
    }
    await ds.query('DELETE FROM iam_dept WHERE id > ?', [lastId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('tree', () => {
  it.each(['zh-CN', 'en-US'])(
    'path length: create accepts exactly 512, rejects 513 in %s and rolls back the insert',
    async (lang) => {
      for (const length of [512, 513]) {
        const parent = await add(0)
        // This channel is exclusive: the next tree insert gets the id following the just-created parent.
        const nextId = parent.id + 1
        const path = await setPathLength(parent.id, length - `${nextId}/`.length)
        const before = await row(parent.id)
        const name = unique()
        const res = await call('admin', 'post', '', { parentId: parent.id, name }).set(
          'Accept-Language',
          lang,
        )
        if (length === 512) {
          expect(res.status).toBe(201)
          expect(res.body.data.id).toBe(nextId)
          expect(res.body.data.treePath).toBe(`${path}${nextId}/`)
          expect(res.body.data.treePath).toHaveLength(512)
        } else {
          expectErr(res, 422, Err.TREE_PATH_TOO_LONG.code)
          expect(res.body.msg).toBe(t(lang, Err.TREE_PATH_TOO_LONG.key))
          expect(res.body.traceId).toEqual(expect.any(String))
          expect(await ds.query('SELECT id FROM iam_dept WHERE name = ?', [name])).toEqual([])
          // The real rejected id was allocated, but its row was rolled back.
          expect((await add(0)).id).toBe(nextId + 1)
        }
        expect(await row(parent.id)).toEqual(before)
      }
    },
  )

  it.each([false, true])(
    'path length: the longest descendant (deleted=%s) may reach 512, but 513 rolls back the whole move',
    async (deleted) => {
      const a = await add(0)
      const b = await add(a.id)
      const c = await add(b.id)
      const x = await add(0)
      if (deleted) await call('admin', 'delete', `/${c.id}`).expect(200)
      await ds.query('UPDATE iam_dept SET updated_by = ? WHERE id IN (?)', [
        uid.reader,
        [a.id, b.id, c.id],
      ])
      const suffix = `${a.id}/${b.id}/${c.id}/`
      const before = await Promise.all([a.id, b.id, c.id].map(row))
      const tooDeep = await setPathLength(x.id, 513 - suffix.length)
      expect(`${tooDeep}${a.id}/`.length).toBeLessThan(512)
      const res = await call('admin', 'put', `/${a.id}`, { parentId: x.id, name: unique() })
      expectErr(res, 422, Err.TREE_PATH_TOO_LONG.code)
      expect(res.body.msg).toBe(t('zh-CN', Err.TREE_PATH_TOO_LONG.key))
      expect(await Promise.all([a.id, b.id, c.id].map(row))).toEqual(before)
      const boundary = await setPathLength(x.id, 512 - suffix.length)
      await call('admin', 'put', `/${a.id}`, { parentId: x.id }).expect(200)
      expect(await row(a.id)).toMatchObject({ parent_id: x.id, tree_path: `${boundary}${a.id}/` })
      expect(await pathOf(b.id)).toBe(`${boundary}${a.id}/${b.id}/`)
      expect(await pathOf(c.id)).toBe(`${boundary}${suffix}`)
      expect(await pathOf(c.id)).toHaveLength(512)
      expect((await row(c.id)).deleted_at !== null).toBe(deleted)
    },
  )

  it('list: the whole forest by sort_no, id; name filter matches seeded texts; a match whose parent does not is a root', async () => {
    const all: DeptNode[] = (await call('admin', 'get').expect(200)).body.data
    const hq = all.find((n) => n.id === dept.hq)!
    expect(hq).toMatchObject({ parentId: 0, treePath: `/${dept.hq}/`, headUserName: null })
    expect(shape([hq])[0]).toEqual([
      'seed.dept.hq',
      expect.arrayContaining([
        ['seed.dept.rd', ['seed.dept.platform', 'seed.dept.product']],
        ['seed.dept.ops', ['seed.dept.support']],
        'seed.dept.finance',
      ]),
    ])
    for (const lang of ['zh-CN', 'en-US']) {
      const res = await call('admin', 'get')
        .query({ name: t(lang, 'seed.dept.rd') })
        .expect(200)
      expect(shape(res.body.data)).toEqual(['seed.dept.rd'])
    }
    const off = await add(dept.hq!, { enabled: false })
    const res = await call('admin', 'get').query({ enabled: false }).expect(200)
    expect(res.body.data.map((n: DeptNode) => n.id)).toContain(off.id)
    expect(res.body.data.every((n: DeptNode) => !n.enabled && !n.children.length)).toBe(true)
    await call('admin', 'get').query({ enabled: 'maybe' }).expect(400)
  })

  it('create: tree_path = the parent path + own id, top level too; get shows the head name; a PUT of the loaded row is a no-op', async () => {
    const head = await user('head', dept.support!, [], false)
    const a = await add(dept.hq!, { sortNo: 5, headUserId: head, phone: '010-1234567' })
    expect(a).toMatchObject({
      parentId: dept.hq,
      treePath: `/${dept.hq}/${a.id}/`,
      sortNo: 5,
      headUserId: head,
      headUserName: 'head display',
      phone: '010-1234567',
      email: null,
      enabled: true,
    })
    const b = await add(a.id)
    expect(b.treePath).toBe(`${a.treePath}${b.id}/`)
    const top = await add(0)
    expect(top).toMatchObject({ parentId: 0, treePath: `/${top.id}/` })
    const got = (await call('admin', 'get', `/${a.id}`).expect(200)).body.data
    expect(got).toEqual(a)
    const { parentId, name, sortNo, headUserId, phone, email, enabled } = got
    const loaded = { parentId, name, sortNo, headUserId, phone, email, enabled }
    await call('admin', 'put', `/${a.id}`, loaded).expect(200)
    expect((await call('admin', 'get', `/${a.id}`).expect(200)).body.data).toMatchObject({
      ...got,
      updatedAt: expect.any(String),
    })
  })

  it('create: disabled parent → 422, unknown parent or head → 404, a sibling name taken → 409 (not elsewhere), bad body → 400 translated', async () => {
    const off = await add(dept.hq!, { enabled: false })
    expectErr(
      await call('admin', 'post', '', { parentId: off.id, name: unique() }),
      422,
      Err.TREE_PARENT_DISABLED.code,
    )
    expectErr(
      await call('admin', 'post', '', { parentId: MISSING, name: unique() }),
      404,
      Err.NOT_FOUND.code,
    )
    expectErr(
      await call('admin', 'post', '', { parentId: dept.hq, name: unique(), headUserId: MISSING }),
      404,
      Err.NOT_FOUND.code,
    )
    const a = await add(dept.hq!)
    const taken = await call('admin', 'post', '', { parentId: dept.hq, name: a.name, sortNo: 1 })
    expectErr(taken, 409, Err.DUPLICATE.code)
    expect(taken.body.msg).toBe(t('zh-CN', Err.DUPLICATE.key))
    await add(dept.finance!, { name: a.name }) // same name, other parent
    const bad = await call('admin', 'post', '', { parentId: -1, name: '' })
      .set('Accept-Language', 'en-US')
      .expect(400)
    expect(bad.body.errors.map((e: { path: string }) => e.path)).toEqual(['parentId', 'name'])
    expect(bad.body.errors[1].msg).toBe(
      t('en-US', 'validation.required', { field: t('en-US', 'field.iam.dept.name') }),
    )
  })

  it('move: one statement rewrites the paths of the whole subtree; never below itself (422); to the top level and back', async () => {
    const a = await add(dept.hq!)
    const b = await add(a.id)
    const c = await add(b.id)
    const x = await add(dept.hq!)
    // a deleted row under it moves too (paths stay consistent)
    const gone = await add(b.id)
    await call('admin', 'delete', `/${gone.id}`).expect(200)
    await call('admin', 'put', `/${a.id}`, { parentId: x.id }).expect(200)
    expect(await row(a.id)).toMatchObject({ parent_id: x.id, tree_path: `${x.treePath}${a.id}/` })
    expect(await pathOf(b.id)).toBe(`${x.treePath}${a.id}/${b.id}/`)
    expect(await pathOf(c.id)).toBe(`${x.treePath}${a.id}/${b.id}/${c.id}/`)
    expect(await pathOf(gone.id)).toBe(`${x.treePath}${a.id}/${b.id}/${gone.id}/`)
    const tree: DeptNode[] = (await call('admin', 'get').expect(200)).body.data
    expect(shape([find(tree, x.id)!])).toEqual([[x.name, [[a.name, [[b.name, [c.name]]]]]]])
    for (const parentId of [a.id, b.id, c.id]) {
      const res = await call('admin', 'put', `/${a.id}`, { parentId })
      expectErr(res, 422, Err.TREE_PARENT_INVALID.code)
      expect(res.body.msg).toBe(t('zh-CN', Err.TREE_PARENT_INVALID.key))
    }
    expect(await pathOf(c.id)).toBe(`${x.treePath}${a.id}/${b.id}/${c.id}/`)
    await call('admin', 'put', `/${b.id}`, { parentId: 0 }).expect(200)
    expect(await pathOf(c.id)).toBe(`/${b.id}/${c.id}/`)
    const off = await add(dept.hq!, { enabled: false })
    expectErr(
      await call('admin', 'put', `/${b.id}`, { parentId: off.id }),
      422,
      Err.TREE_PARENT_DISABLED.code,
    )
    await call('admin', 'put', `/${b.id}`, { parentId: a.id }).expect(200)
    expect(await pathOf(c.id)).toBe(`${x.treePath}${a.id}/${b.id}/${c.id}/`)
  })

  it('enabled: no disable over an enabled child (422); enabling a child enables its disabled ancestors', async () => {
    const a = await add(dept.hq!)
    const b = await add(a.id)
    const c = await add(b.id)
    expectErr(
      await call('admin', 'put', `/${a.id}/enabled`, { enabled: false }),
      422,
      Err.TREE_CHILD_ENABLED.code,
    )
    for (const id of [c.id, b.id, a.id])
      await call('admin', 'put', `/${id}/enabled`, { enabled: false }).expect(200)
    await call('admin', 'put', `/${c.id}`, { enabled: true }).expect(200)
    for (const id of [a.id, b.id, c.id]) expect((await row(id)).enabled).toBe(1)
    expect((await row(dept.hq!)).enabled).toBe(1)
  })

  it('delete: children → 409 has_children, users → 409 dept_has_users; a leaf is soft-deleted and its name free again', async () => {
    const a = await add(dept.hq!)
    const b = await add(a.id)
    expectErr(await call('admin', 'delete', `/${a.id}`), 409, Err.TREE_HAS_CHILDREN.code)
    const member = await user('member-of-b', b.id, [], false)
    const res = await call('admin', 'delete', `/${b.id}`)
    expectErr(res, 409, Err.IAM_DEPT_HAS_USERS.code)
    expect(res.body.msg).toBe(t('zh-CN', Err.IAM_DEPT_HAS_USERS.key))
    await ds.query('UPDATE iam_user SET deleted_at = NOW(3) WHERE id = ?', [member])
    await call('admin', 'delete', `/${b.id}`).expect(200)
    expect((await row(b.id)).deleted_at).not.toBeNull()
    await call('admin', 'get', `/${b.id}`).expect(404)
    await add(a.id, { name: b.name, sortNo: 1 }) // another body: not a duplicate submit
    expectErr(await call('admin', 'delete', `/${MISSING}`), 404, Err.NOT_FOUND.code)
  })
})

describe('data scope', () => {
  it('own_dept admin: sees only its dept; get / modify / enable / delete / add under a dept outside → 404, nothing changed', async () => {
    const list = (await call('own', 'get').expect(200)).body.data
    expect(shape(list)).toEqual(['seed.dept.rd'])
    const outside = await add(dept.ops!)
    for (const res of [
      await call('own', 'get', `/${outside.id}`),
      await call('own', 'put', `/${outside.id}`, { name: unique() }),
      await call('own', 'put', `/${outside.id}/enabled`, { enabled: false }),
      await call('own', 'delete', `/${outside.id}`),
      await call('own', 'post', '', { parentId: outside.id, name: unique() }),
      // a child of its own dept would not be its own: 404, nothing kept
      await call('own', 'post', '', { parentId: dept.rd, name: unique() }),
      // its own dept, but not under a parent it cannot see
      await call('own', 'put', `/${dept.rd}`, { parentId: dept.ops }),
    ])
      expectErr(res, 404, Err.NOT_FOUND.code)
    expect(await call('admin', 'get', `/${outside.id}`).expect(200)).toMatchObject({
      body: { data: { name: outside.name, enabled: true } },
    })
    expect(await row(dept.rd!)).toMatchObject({
      parent_id: dept.hq,
      tree_path: `/${dept.hq}/${dept.rd}/`,
    })
    const kept = await ds.query(
      'SELECT COUNT(*) AS n FROM iam_dept WHERE parent_id = ? AND id > ?',
      [dept.rd, lastId],
    )
    expect(Number(kept[0].n)).toBe(0)
  })

  it('path length: an out-of-scope parent, root or live descendant still returns 404 before the length check', async () => {
    const a = await add(dept.rd!, {}, 'tree')
    const b = await add(a.id, {}, 'tree')
    const x = await add(dept.ops!)
    await setPathLength(x.id, 512)
    const before = await Promise.all([a.id, b.id, x.id].map(row))
    for (const res of [
      await call('tree', 'post', '', { parentId: x.id, name: unique() }),
      await call('tree', 'put', `/${a.id}`, { parentId: x.id }),
      await call('tree', 'put', `/${x.id}`, { parentId: a.id }),
    ])
      expectErr(res, 404, Err.NOT_FOUND.code)
    // The root and target are picked, but the live descendant is not; its oversized suffix stays private.
    const role = await addRole('length-picked', 'picked_depts', ALL)
    for (const id of [a.id, x.id])
      await ds.query('INSERT INTO iam_role_depts (role_id, dept_id) VALUES (?, ?)', [role, id])
    await user('length-picked', null, [role])
    expectErr(
      await call('length-picked', 'put', `/${a.id}`, { parentId: x.id }),
      404,
      Err.NOT_FOUND.code,
    )
    expect(await Promise.all([a.id, b.id, x.id].map(row))).toEqual(before)
  })

  it('own_dept_tree admin: adds, moves and enables inside its subtree; a parent or row outside it → 404 and nothing moved', async () => {
    const a = await add(dept.rd!, {}, 'tree')
    const b = await add(dept.platform!, {}, 'tree')
    await call('tree', 'put', `/${b.id}`, { parentId: a.id }).expect(200)
    expect(await pathOf(b.id)).toBe(`${a.treePath}${b.id}/`)
    // out: a parent it cannot see, the top level, a dept above it
    for (const parentId of [dept.ops, 0, dept.hq])
      expectErr(await call('tree', 'put', `/${a.id}`, { parentId }), 404, Err.NOT_FOUND.code)
    expect(await row(a.id)).toMatchObject({
      parent_id: dept.rd,
      tree_path: `/${dept.hq}/${dept.rd}/${a.id}/`,
    })
    expect(await pathOf(b.id)).toBe(`${a.treePath}${b.id}/`)
    expectErr(
      await call('tree', 'post', '', { parentId: 0, name: unique() }),
      404,
      Err.NOT_FOUND.code,
    )
    // enabling a child enables its disabled ancestors inside the scope
    const c = await add(dept.rd!, {}, 'tree')
    const lower = await add(c.id, { enabled: false }, 'tree')
    await call('tree', 'put', `/${c.id}/enabled`, { enabled: false }).expect(200)
    await call('tree', 'put', `/${lower.id}/enabled`, { enabled: true }).expect(200)
    expect((await row(c.id)).enabled).toBe(1)
  })

  it('picked_depts admin: a disabled ancestor outside the scope cannot be enabled through its child (404)', async () => {
    const out = await add(dept.ops!)
    const inner = await add(out.id, { enabled: false })
    await call('admin', 'put', `/${out.id}/enabled`, { enabled: false }).expect(200)
    const role = await addRole('picked', 'picked_depts', ALL)
    await ds.query('INSERT INTO iam_role_depts (role_id, dept_id) VALUES (?, ?)', [role, inner.id])
    await user('picked', null, [role])
    expectErr(
      await call('picked', 'put', `/${inner.id}/enabled`, { enabled: true }),
      404,
      Err.NOT_FOUND.code,
    )
    expect([(await row(out.id)).enabled, (await row(inner.id)).enabled]).toEqual([0, 0])
    await call('picked', 'put', `/${inner.id}`, { name: unique() }).expect(200)
  })

  it('head: a new head must be a user of the caller scope (404), its name shows only to those who see it; an unchanged head outside it does not block saving', async () => {
    const outsider = await user('outsider', dept.ops!, [], false)
    const insider = await user('insider', dept.product!, [], false)
    const a = await add(dept.rd!, { headUserId: insider }, 'tree')
    expect(a.headUserName).toBe('insider display')
    expectErr(
      await call('tree', 'put', `/${a.id}`, { headUserId: outsider }),
      404,
      Err.NOT_FOUND.code,
    )
    await call('admin', 'put', `/${a.id}`, { headUserId: outsider }).expect(200)
    // the name only for callers who see that user
    const seen = async (who: string) =>
      (await call(who, 'get', `/${a.id}`).expect(200)).body.data.headUserName
    expect([await seen('admin'), await seen('tree')]).toEqual(['outsider display', null])
    const listed = find((await call('tree', 'get').expect(200)).body.data, a.id)
    expect(listed).toMatchObject({ headUserId: outsider, headUserName: null })
    await call('tree', 'put', `/${a.id}`, { headUserId: outsider, name: unique() }).expect(200)
    await call('tree', 'put', `/${a.id}`, { headUserId: null }).expect(200)
  })

  it("a moved dept: its own_dept_tree user still sees its subtree (session reloaded), the new parent's sees the moved users", async () => {
    const watch = await addRole('watch', 'own_dept_tree', [userPerms.browse])
    const a = await add(dept.hq!)
    const b = await add(a.id)
    const x = await add(dept.hq!)
    await user('mover', a.id, [watch])
    await user('watcher', x.id, [watch])
    await user('member', b.id, [], false)
    expect(await usersSeenBy('mover')).toEqual(
      expect.arrayContaining([`${PREFIX}mover`, `${PREFIX}member`]),
    )
    expect(await usersSeenBy('watcher')).not.toContain(`${PREFIX}member`)
    await call('admin', 'put', `/${a.id}`, { parentId: x.id }).expect(200)
    // the mover's session still held the old path: without the reload it would see nobody
    expect(await usersSeenBy('mover')).toEqual(
      expect.arrayContaining([`${PREFIX}mover`, `${PREFIX}member`]),
    )
    expect(await usersSeenBy('watcher')).toEqual(
      expect.arrayContaining([`${PREFIX}watcher`, `${PREFIX}mover`, `${PREFIX}member`]),
    )
  })
})

describe('errors', () => {
  it('403 per permission: browse-only may list, not view/create/modify/delete; no perm → no list', async () => {
    const a = await add(dept.hq!)
    await call('reader', 'get').expect(200)
    for (const res of await Promise.all([
      call('reader', 'get', `/${a.id}`),
      call('reader', 'post', '', { parentId: dept.hq, name: unique() }),
      call('reader', 'put', `/${a.id}`, {}),
      call('reader', 'put', `/${a.id}/enabled`, { enabled: false }),
      call('reader', 'delete', `/${a.id}`),
      call('plain', 'get'),
    ]))
      expectErr(res, 403, Err.FORBIDDEN.code)
    // the picker tree needs no perm
    await call('plain', 'get', '/tree').expect(200)
  })

  it('the same create submitted twice within 3 s → 429 (@Idempotent)', async () => {
    const body = { parentId: dept.hq, name: unique() }
    await call('admin', 'post', '', body).expect(201)
    expectErr(await call('admin', 'post', '', body), 429, Err.TOO_MANY_REQUESTS.code)
  })

  it('@ActionLog: every write leaves a row with domain iam.dept, its verb and the id', async () => {
    const trace = `${PREFIX}${process.pid}-`
    const res = await call('admin', 'post', '', { parentId: dept.hq, name: unique() })
      .set('X-Request-Id', `${trace}c`)
      .expect(201)
    const { id } = res.body.data
    await call('admin', 'put', `/${id}`, {}).set('X-Request-Id', `${trace}u`)
    await call('admin', 'put', `/${id}/enabled`, { enabled: false }).set(
      'X-Request-Id',
      `${trace}e`,
    )
    await call('admin', 'delete', `/${id}`).set('X-Request-Id', `${trace}d`)
    for (const [suffix, verb] of [
      ['c', 'create'],
      ['u', 'modify'],
      ['e', 'modify'],
      ['d', 'remove'],
    ])
      expect(await logOf(ds, `${trace}${suffix}`)).toMatchObject({
        domain: 'iam.dept',
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
    ).toEqual([URL, `${URL}/tree`, `${URL}/{id}`, `${URL}/{id}/enabled`])
    const data =
      doc.paths[URL].get.responses['200'].content['application/json'].schema.properties.data
    expect(data).toMatchObject({ type: 'array' })
  })
})
