// wf user options (see docs/design-notes.md#workflow): GET /api/wf/users/options, whom a process dialog picks (transfer,
// delegate, add-sign, cc, the initiator's picks). Sign-in only; every enabled live user (OrgDirectory's rule),
// not the caller's data scope: a staff user (own_rows) whose /iam/users/options lists only themselves picks a
// colleague here. Id, display name and dept only; the keyword matches display names, never usernames.
// GET /api/wf/depts/options: the same for a form's dept field, every enabled dept as a forest.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { PAGE_SIZE_MAX } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-wfu-'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let token = ''
let deptId = 0
const u: Record<string, number> = {}
const made = { iam_user: [] as number[], iam_dept: [] as number[] }

const get = (path: string, keyword?: string, auth = true) => {
  const req = request(app.getHttpServer())
    .get(`/api/${path}`)
    .query(keyword === undefined ? {} : { keyword })
  return auth ? req.set(bearer(token)) : req
}
const names = (res: { body: { data: { displayName: string }[] } }) =>
  res.body.data.map((r) => r.displayName)

/** `name`'s user: display name PREFIX + name, username PREFIX + 'login-' + name. */
async function user(name: string, extra: Record<string, unknown> = {}, roles: number[] = []) {
  u[name] = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}login-${name}`,
    display_name: PREFIX + name,
    dept_id: deptId,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
    ...extra,
  })
  made.iam_user.push(u[name]!)
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [u[name], r])
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  deptId = await insertRow(ds.manager, 'iam_dept', {
    parent_id: 0,
    name: `${PREFIX}dept`,
    tree_path: '/',
  })
  made.iam_dept.push(deptId)
  const staff = (await findId(ds.manager, 'iam_role', { code: 'staff' }))!
  await user('alice', {}, [staff])
  await user('bob', { dept_id: null })
  await user('carol', { enabled: false })
  await user('dave', { deleted_at: new Date() })
  token = (await signIn(app, `${PREFIX}login-alice`)).accessToken
})

afterAll(async () => {
  if (ds && made.iam_user.length) {
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [made.iam_user])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [made.iam_user])
  }
  if (ds && made.iam_dept.length)
    await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [made.iam_dept])
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('GET /api/wf/users/options', () => {
  it('a staff user (own_rows) sees only themselves in /iam/users/options, every colleague here', async () => {
    const scoped = await get('iam/users/options', PREFIX).expect(200)
    expect(scoped.body.data.map((r: { id: number }) => r.id)).toEqual([u.alice])

    const res = await get('wf/users/options', PREFIX).expect(200)
    // id, display name and dept only (no username), by display name
    expect(res.body.data).toEqual([
      { id: u.alice, displayName: `${PREFIX}alice`, deptName: `${PREFIX}dept` },
      { id: u.bob, displayName: `${PREFIX}bob`, deptName: null },
    ])
  })

  it('disabled and deleted users are never listed, with or without a keyword', async () => {
    for (const keyword of [PREFIX, `${PREFIX}carol`, `${PREFIX}dave`, undefined]) {
      const res = await get('wf/users/options', keyword).expect(200)
      const ids = res.body.data.map((r: { id: number }) => r.id)
      expect(ids).not.toContain(u.carol)
      expect(ids).not.toContain(u.dave)
      expect(ids.length).toBeLessThanOrEqual(PAGE_SIZE_MAX)
    }
  })

  it('the keyword matches display names only (literal %), not usernames', async () => {
    expect(names(await get('wf/users/options', 'e2e-wfu-b').expect(200))).toEqual([`${PREFIX}bob`])
    expect(names(await get('wf/users/options', `${PREFIX}login-bob`).expect(200))).toEqual([])
    expect(names(await get('wf/users/options', `${PREFIX}%`).expect(200))).toEqual([])
  })

  it('no session → 401; a keyword over 64 characters → 400', async () => {
    await get('wf/users/options', PREFIX, false).expect(401)
    await get('wf/users/options', 'x'.repeat(65)).expect(400)
  })
})

describe('GET /api/wf/depts/options', () => {
  type Node = { id: number; parentId: number; name: string; children: Node[] }
  const d: Record<string, number> = {}
  const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flat(n.children)])
  const dept = async (name: string, parentId: number, extra: Record<string, unknown> = {}) => {
    d[name] = await insertRow(ds.manager, 'iam_dept', {
      parent_id: parentId,
      name: PREFIX + name,
      tree_path: '/',
      ...extra,
    })
    made.iam_dept.push(d[name]!)
  }

  beforeAll(async () => {
    await dept('child', deptId, { sort_no: 2 })
    await dept('first', deptId, { sort_no: 1 })
    await dept('off', deptId, { enabled: false })
    await dept('orphan', d.off!)
    await dept('gone', deptId, { deleted_at: new Date() })
  })

  it("a staff user (own_rows) gets no dept from /iam/depts/tree, every enabled dept here in the tree's shape", async () => {
    expect((await get('iam/depts/tree').expect(200)).body.data).toEqual([])
    const forest: Node[] = (await get('wf/depts/options').expect(200)).body.data
    const leaf = (name: string, parentId: number) => ({
      id: d[name],
      parentId,
      name: PREFIX + name,
      children: [],
    })
    // by sort_no; a dept under a disabled one is a root; disabled and deleted ones are left out
    expect(forest.find((n) => n.id === deptId)).toEqual({
      id: deptId,
      parentId: 0,
      name: `${PREFIX}dept`,
      children: [leaf('first', deptId), leaf('child', deptId)],
    })
    expect(forest.find((n) => n.id === d.orphan)).toEqual(leaf('orphan', d.off!))
    const ids = flat(forest).map((n) => n.id)
    expect(ids).not.toContain(d.off)
    expect(ids).not.toContain(d.gone)
  })

  it('no session → 401', async () => {
    await get('wf/depts/options', undefined, false).expect(401)
  })
})
