// iam/user (complex golden sample; see docs/design-notes.md#layering, #auth-sessions, #data-scope, #security). `crud`: list (dept
// subtree, filters, masking), detail, create (initial password, policy, first sign-in must change it),
// edit, uniqueness (409), data scope (404), GrantPolicy.assertAssignableRoles (403 grant_exceeds_own),
// root protection, PermVersion on role changes, 403 per perm, @Idempotent, @ActionLog, Swagger.
// `actions`: delete / batch delete (links in the same transaction, sessions end, not self/root),
// enable/disable, reset password, assign roles (grant policy, next request), out of scope → 404, options.
// `excel`: export (masking, dept `<id> - <path>`, formulas escaped), template dropdowns (dept = the
// caller's scope), import insert/upsert (scope, duplicates, initial password, no roles) + error report.
// Perms reach the spec's roles through the seeded action rows (user.seed.ts, position.seed.ts).
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, USER_INITIAL_PASSWORD_PARAM, type UserVo, userPerms } from '@qiwu/shared'
import bcrypt from 'bcryptjs'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'user-e2e-'
const URL = '/api/iam/users'
const MISSING = 999_999
/** test value of the initial password param */
const INITIAL = 'Initial#Pass1'
const PW = 'Given#Pass1'
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let params: ParamService
let permVersion: PermVersion
const created = {
  users: [] as number[],
  roles: [] as number[],
  menus: [] as number[],
  depts: [] as number[],
}
let paramBefore: string | null | undefined
const dept: Record<string, number> = {}
const role: Record<string, number> = {}
const tok: Record<string, string> = {}
/** operator name → user id */
const uid: Record<string, number> = {}
let adminId: number
let rootRoleId: number
let seq = 0
let ipSeq = 0
const unique = () => `${PREFIX}${++seq}`

const http = () => request(app.getHttpServer())
const call = (
  token: string,
  method: 'get' | 'post' | 'put' | 'delete',
  path = '',
  body?: object,
) => {
  const req = http()[method](`${URL}${path}`).set(bearer(token))
  return body ? req.send(body) : req
}
const create = (body: object, token = tok.admin!) => call(token, 'post', '', body)
const login = (username: string, password: string) =>
  http()
    .post('/api/auth/login')
    .set('X-Forwarded-For', `10.77.0.${++ipSeq}`)
    .set('User-Agent', CHROME)
    .send({ username, password })

/** The action row carrying `perm`: the seeded one, else a temporary row. */
async function permMenu(perm: string): Promise<number> {
  const found = await findId(ds.manager, 'iam_menu', { kind: 'action', perms: perm })
  if (found !== undefined) return found
  const id = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'action',
    name: 'menu.action.browse',
    perms: perm,
  })
  created.menus.push(id)
  return id
}

async function addRole(code: string, dataScope: string, perms: string[], picked: number[] = []) {
  const id = await insertRow(ds.manager, 'iam_role', {
    code: PREFIX + code,
    name: PREFIX + code,
    data_scope: dataScope,
  })
  for (const p of perms)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      id,
      await permMenu(p),
    ])
  for (const d of picked)
    await ds.query('INSERT INTO iam_role_depts (role_id, dept_id) VALUES (?, ?)', [id, d])
  created.roles.push(id)
  role[code] = id
  return id
}

/** A signed-in user inserted directly (not through the API under test). */
async function operator(name: string, deptId: number | null, roles: number[]) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: PREFIX + name,
    display_name: name,
    dept_id: deptId,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  for (const r of roles)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, r])
  created.users.push(id)
  uid[name] = id
  tok[name] = (await signIn(app, PREFIX + name)).accessToken
  return id
}

/** A user created by admin through the API; returns its id. */
async function newUser(body: object = {}) {
  const res = await create({ username: unique(), displayName: 'u', ...body }).expect(201)
  return res.body.data.id as number
}

const me = (token: string) => http().get('/api/auth/me').set(bearer(token))
const alive = async (id: number) =>
  (await ds.query('SELECT deleted_at FROM iam_user WHERE id = ?', [id]))[0].deleted_at === null

async function setInitialPassword(value: string | null) {
  await ds.query('DELETE FROM cfg_param WHERE param_key = ?', [USER_INITIAL_PASSWORD_PARAM])
  if (value !== null)
    await insertRow(ds.manager, 'cfg_param', {
      param_key: USER_INITIAL_PASSWORD_PARAM,
      param_value: value,
      name: USER_INITIAL_PASSWORD_PARAM,
      is_secret: 1,
    })
  await params.invalidate(USER_INITIAL_PASSWORD_PARAM)
}

/** The user's live role links. */
const rolesOf = async (id: number) =>
  (
    await ds.query(
      'SELECT role_id FROM iam_user_roles WHERE user_id = ? AND deleted_at IS NULL ORDER BY role_id',
      [id],
    )
  ).map((r: { role_id: number }) => Number(r.role_id))
/** Every link row of the user in `table` (removed ones stay, soft-deleted): `[target id, live]`. */
const linksOf = async (table: string, column: string, id: number) =>
  (
    await ds.query<{ id: number; live: number }[]>(
      `SELECT ${column} AS id, deleted_at IS NULL AS live FROM ${table} WHERE user_id = ? ORDER BY 1`,
      [id],
    )
  ).map((r): [number, boolean] => [Number(r.id), Number(r.live) === 1])

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  params = app.get(ParamService)
  permVersion = app.get(PermVersion)
  await cleanRedis(redis)
  for (const key of ['hq', 'rd', 'platform', 'product', 'ops', 'support', 'finance'])
    dept[key] = (await findId(ds.manager, 'iam_dept', { name: `seed.dept.${key}` }))!
  adminId = (await findId(ds.manager, 'iam_user', { username: 'admin' }))!
  rootRoleId = (await findId(ds.manager, 'iam_role', { code: 'root' }))!
  const [param] = await ds.query('SELECT param_value FROM cfg_param WHERE param_key = ?', [
    USER_INITIAL_PASSWORD_PARAM,
  ])
  paramBefore = param ? param.param_value : null
  await setInitialPassword(INITIAL)
  tok.admin = (await signIn(app)).accessToken

  const all = Object.values(userPerms)
  // a manager of R&D and its subtree holding every user perm and one position perm
  await addRole('mgr', 'own_dept_tree', [...all, 'iam.position.browse'])
  await operator('mgr', dept.rd!, [role.mgr!])
  // the same perms, R&D only
  await addRole('lead', 'own_dept', [...all, 'iam.position.browse'])
  await operator('lead', dept.rd!, [role.lead!])
  // browse + view only, every dept: sees masked contacts
  await addRole('reader', 'all', [userPerms.browse, userPerms.view])
  await operator('reader', dept.hq!, [role.reader!])
  await operator('plain', dept.rd!, [])
  // roles the manager may or may not give
  await addRole('staff', 'own_rows', ['iam.position.browse'])
  await addRole('extraPerm', 'own_rows', ['iam.position.browse', 'iam.position.create'])
  await addRole('wide', 'all', ['iam.position.browse'])
  await addRole('pickedOut', 'picked_depts', ['iam.position.browse'], [dept.finance!])
  await addRole('pickedIn', 'picked_depts', ['iam.position.browse'], [dept.platform!])
  await addRole('tree', 'own_dept_tree', ['iam.position.browse'])
  await addRole('browser', 'own_dept', [userPerms.browse])
  await addRole('mobileModify', 'all', [userPerms.browse, userPerms.view, userPerms.modify])
  await addRole('mobileReset', 'own_dept', [userPerms['reset-password']])
  await operator('mobileEditor', dept.rd!, [role.mobileModify!])
  await operator('mobileWriter', dept.rd!, [role.mobileModify!, role.mobileReset!])
})

afterAll(async () => {
  if (ds) {
    const ids = [
      ...created.users,
      ...(await ds.query('SELECT id FROM iam_user WHERE username LIKE ?', [`${PREFIX}%`])).map(
        (r: { id: number }) => Number(r.id),
      ),
    ]
    if (ids.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user_positions WHERE user_id IN (?)', [ids])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [ids])
    }
    if (created.roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role_depts WHERE role_id IN (?)', [created.roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [created.roles])
    }
    await ds.query('DELETE FROM iam_position WHERE code LIKE ?', [`${PREFIX}%`])
    if (created.depts.length)
      await ds.query('DELETE FROM iam_dept WHERE id IN (?)', [created.depts])
    if (created.menus.length)
      await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [created.menus])
    if (params) await setInitialPassword(paramBefore ?? null)
    await ds.query('DELETE FROM msg_sms_otp WHERE mobile = ?', ['13912345679'])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('crud', () => {
  it('create → 201 detail: roles, positions, audit columns; no password = the initial one, changed at the first sign-in', async () => {
    const username = unique()
    const [position] = await ds.query('SELECT id FROM iam_position ORDER BY id LIMIT 1')
    const res = await create({
      username,
      displayName: 'Ann',
      deptId: dept.platform,
      mobile: '13800000001',
      email: `${username}@example.com`,
      gender: 'female',
      roleIds: [role.staff],
      positionIds: [position.id],
    }).expect(201)
    const row = res.body.data
    expect(row).toMatchObject({
      id: expect.any(Number),
      username,
      displayName: 'Ann',
      deptId: dept.platform,
      deptName: 'seed.dept.platform',
      mobile: '13800000001',
      email: `${username}@example.com`,
      masked: false,
      gender: 'female',
      enabled: true,
      root: false,
      lastLoginAt: null,
      note: null,
      createdBy: adminId,
      roleIds: [role.staff],
      roles: [{ id: role.staff, name: `${PREFIX}staff` }],
      positionIds: [Number(position.id)],
    })
    expect(row).not.toHaveProperty('passwordHash')
    expect((await call(tok.admin!, 'get', `/${row.id}`).expect(200)).body.data).toEqual(row)

    const [stored] = await ds.query(
      'SELECT password_hash, password_changed_at FROM iam_user WHERE id = ?',
      [row.id],
    )
    expect(stored.password_changed_at).toBeNull()
    expect(await bcrypt.compare(INITIAL, stored.password_hash)).toBe(true)
    // the first sign-in works with the initial password and must change it
    const signedIn = await login(username, INITIAL).expect(200)
    const me = await http()
      .get('/api/auth/me')
      .set(bearer(signedIn.body.data.accessToken))
      .expect(200)
    expect(me.body.data.flags).toEqual({ mustChangePassword: true, passwordExpired: false })
  })

  it('a given password must pass the policy (400, translated); it is stored hashed and still must be changed', async () => {
    const weak = await create({ username: unique(), displayName: 'x', password: 'short' })
      .set('Accept-Language', 'en-US')
      .expect(400)
    expect(weak.body.code).toBe(Err.VALIDATION_FAILED.code)
    expect(weak.body.errors[0].path).toBe('password')
    expect(weak.body.msg).toContain('Password')

    const username = unique()
    const { id } = (
      await create({ username, displayName: 'x', password: PW, mobile: '', email: ' ' }).expect(201)
    ).body.data
    const [stored] = await ds.query(
      'SELECT password_hash, password_changed_at, mobile, email FROM iam_user WHERE id = ?',
      [id],
    )
    expect(await bcrypt.compare(PW, stored.password_hash)).toBe(true)
    expect(stored).toMatchObject({ password_changed_at: null, mobile: null, email: null })
  })

  it('no password while the initial password param is unset or fails the policy → 422', async () => {
    try {
      for (const value of [null, 'weak']) {
        await setInitialPassword(value)
        const res = await create({ username: unique(), displayName: 'x' }).expect(422)
        expect(res.body.code).toBe(Err.IAM_INITIAL_PASSWORD_UNSET.code)
      }
    } finally {
      await setInitialPassword(INITIAL)
    }
  })

  it('username / mobile / email are unique among live users (409); blank contacts never collide', async () => {
    const username = unique()
    await create({ username, displayName: 'a', mobile: '13900000002', email: `${username}@x.io` })
    for (const clash of [
      { username },
      { username: unique(), mobile: '13900000002' },
      { username: unique(), email: `${username}@x.io` },
    ])
      expect((await create({ displayName: 'b', ...clash }).expect(409)).body.code).toBe(
        Err.DUPLICATE.code,
      )
    for (let i = 0; i < 2; i++)
      await create({ username: unique(), displayName: 'c', mobile: null, email: '' }).expect(201)
  })

  it('list: dept = its subtree, keyword / username / mobile / enabled / created range, sort, paging, dept name', async () => {
    const tag = unique()
    const add = (suffix: string, deptId: number, extra = {}) =>
      create({ username: `${tag}-${suffix}`, displayName: `${suffix} ${tag}`, deptId, ...extra })
    await add('a', dept.platform!, { mobile: '13700000003' })
    await add('b', dept.rd!)
    await add('c', dept.finance!, { enabled: false })
    const list = async (query: object) =>
      (await call(tok.admin!, 'get').query(query).expect(200)).body.data
    const names = async (query: object) => (await list(query)).items.map((u: UserVo) => u.username)

    expect(await names({ keyword: tag, deptId: dept.rd, sort: 'username' })).toEqual([
      `${tag}-a`,
      `${tag}-b`,
    ])
    expect(await names({ keyword: `c ${tag}` })).toEqual([`${tag}-c`])
    expect(await names({ username: `${tag}-`, enabled: 'false' })).toEqual([`${tag}-c`])
    expect(await names({ mobile: '1370000000' })).toEqual([`${tag}-a`])
    expect(await names({ username: tag, sort: '-username', page: 2, pageSize: 2 })).toEqual([
      `${tag}-a`,
    ])
    const from = new Date(Date.now() - 60_000).toISOString()
    expect(await names({ username: tag, createdAtFrom: from, sort: 'username' })).toHaveLength(3)
    expect(await names({ username: tag, createdAtTo: from })).toEqual([])
    const [a] = (await list({ username: `${tag}-a` })).items
    expect(a).toMatchObject({ deptName: 'seed.dept.platform', masked: false, root: false })
    const [admin] = (await list({ username: 'admin' })).items
    expect(admin).toMatchObject({ username: 'admin', root: true })
  })

  it('mobile / email are masked without iam.user.modify, in the list and the detail', async () => {
    const username = unique()
    const { id } = (
      await create({
        username,
        displayName: 'm',
        deptId: dept.hq,
        mobile: '13812345678',
        email: `${username}@example.com`,
      }).expect(201)
    ).body.data
    const [listed] = (await call(tok.reader!, 'get').query({ username }).expect(200)).body.data
      .items
    const detail = (await call(tok.reader!, 'get', `/${id}`).expect(200)).body.data
    for (const row of [listed, detail])
      expect(row).toMatchObject({
        mobile: '138****5678',
        email: `u***@example.com`,
        masked: true,
      })
  })

  it('the mobile filter is ignored for callers who see it masked (browse only): it would reveal the digits', async () => {
    await operator('browseOnly', dept.hq!, [role.browser!])
    const username = unique()
    await create({ username, displayName: 'b', deptId: dept.hq, mobile: '13812340001' }).expect(201)
    const found = async (token: string, mobile: string) =>
      (await call(token, 'get').query({ username, mobile }).expect(200)).body.data.items.map(
        (u: UserVo) => u.mobile,
      )
    for (const guess of ['1381234', '999'])
      expect(await found(tok.browseOnly!, guess)).toEqual(['138****0001'])
    // whoever sees the digits may search them
    expect(await found(tok.admin!, '1381234')).toEqual(['13812340001'])
    expect(await found(tok.admin!, '999')).toEqual([])
  })

  it('update changes the fields sent; a loaded row PUT back as is → 200; roles change → the next request of that user sees them', async () => {
    const username = unique()
    const row = (
      await create({ username, displayName: 'u', deptId: dept.rd, note: 'n' }).expect(201)
    ).body.data
    await call(tok.admin!, 'put', `/${row.id}`, {
      displayName: 'renamed',
      deptId: dept.product,
    }).expect(200)
    const got = (await call(tok.admin!, 'get', `/${row.id}`)).body.data
    expect(got).toMatchObject({ displayName: 'renamed', deptId: dept.product, note: 'n' })
    const { username: u, displayName, deptId, mobile, email, gender, enabled, note } = got
    const back = { username: u, displayName, deptId, mobile, email, gender, enabled, note }
    await call(tok.admin!, 'put', `/${row.id}`, { ...back, roleIds: [], positionIds: [] }).expect(
      200,
    )

    // a live session of the user gains the role's perm on its next request (PermVersion)
    const { accessToken: session, session: s } = await signIn(app, username)
    await call(session, 'get').expect(403)
    await call(tok.admin!, 'put', `/${row.id}`, { roleIds: [role.browser] }).expect(200)
    await call(session, 'get').expect(200)
    expect(await rolesOf(row.id)).toEqual([role.browser])
    // a new username reaches the session too (the action log's actor)
    await call(tok.admin!, 'put', `/${row.id}`, { username: `${username}-x` }).expect(200)
    await call(session, 'get').expect(200)
    const stored = JSON.parse((await redis.get(redisKey('authSession', s.sid)))!)
    expect(stored.username).toBe(`${username}-x`)
  })

  it('changing another mobile needs reset-password in that permission scope and revokes credentials', async () => {
    const username = unique()
    const id = await newUser({ username, deptId: dept.rd, mobile: '13912345678' })
    const session = (await signIn(app, username)).accessToken
    await me(session).expect(200)
    await call(tok.mobileEditor!, 'put', `/${id}`, { mobile: '13912345679' }).expect(403)
    expect((await ds.query('SELECT mobile FROM iam_user WHERE id = ?', [id]))[0].mobile).toBe(
      '13912345678',
    )
    await call(tok.mobileEditor!, 'put', `/${id}`, { displayName: 'Edited' }).expect(200)
    await call(tok.mobileEditor!, 'put', `/${id}`, { mobile: '13912345678' }).expect(200)
    await me(session).expect(200)
    const own = await call(tok.mobileEditor!, 'put', `/${uid.mobileEditor}`, {
      mobile: '13912345682',
    }).expect(422)
    expect(own.body.code).toBe(Err.IAM_OWN_MOBILE_IN_PROFILE.code)
    expect(
      (await ds.query('SELECT mobile FROM iam_user WHERE id = ?', [uid.mobileEditor]))[0].mobile,
    ).toBeNull()
    await call(tok.mobileEditor!, 'put', `/${uid.mobileEditor}`, { mobile: null }).expect(200)
    const rootOwn = await call(tok.admin!, 'put', `/${adminId}`, { mobile: '13912345682' }).expect(
      422,
    )
    expect(rootOwn.body.code).toBe(Err.IAM_OWN_MOBILE_IN_PROFILE.code)
    const [adminMobile] = await ds.query('SELECT mobile FROM iam_user WHERE id = ?', [adminId])
    await call(tok.admin!, 'put', `/${adminId}`, { mobile: adminMobile.mobile }).expect(200)
    await me(tok.mobileEditor!).expect(200)
    const outside = await newUser({ deptId: dept.platform, mobile: '13912345680' })
    await call(tok.mobileWriter!, 'put', `/${outside}`, { mobile: '13912345681' }).expect(404)
    expect((await ds.query('SELECT mobile FROM iam_user WHERE id = ?', [outside]))[0].mobile).toBe(
      '13912345680',
    )
    await ds.query(
      `INSERT INTO msg_sms_otp (mobile, scene, code, attempts, daily_seq, request_ip)
       VALUES (?, 'signin', '123456', 0, 1, '127.0.0.1')`,
      ['13912345679'],
    )
    await call(tok.mobileWriter!, 'put', `/${id}`, { mobile: '13912345679' }).expect(200)
    expect((await ds.query('SELECT mobile FROM iam_user WHERE id = ?', [id]))[0].mobile).toBe(
      '13912345679',
    )
    await me(session).expect(401)
    expect(
      (await ds.query('SELECT consumed_at FROM msg_sms_otp WHERE mobile = ?', ['13912345679']))[0]
        .consumed_at,
    ).not.toBeNull()
  })

  it('moving a mobile voids its old codes before another user can take the number', async () => {
    const [oldMobile, newMobile, unrelated] = ['13912345683', '13912345684', '13912345685']
    const id = await newUser({ mobile: oldMobile })
    await ds.query(
      `INSERT INTO msg_sms_otp (mobile, scene, code, attempts, daily_seq, request_ip)
       VALUES (?, 'signin', '654321', 0, 1, '127.0.0.1'),
              (?, 'reset_password', '123456', 0, 1, '127.0.0.1'),
              (?, 'signin', '111111', 0, 1, '127.0.0.1')`,
      [oldMobile, oldMobile, unrelated],
    )
    try {
      await call(tok.admin!, 'put', `/${id}`, { mobile: newMobile }).expect(200)
      created.users.push(
        await insertRow(ds.manager, 'iam_user', {
          username: unique(),
          display_name: 'replacement',
          password_hash: 'not-used',
          password_changed_at: new Date(),
          mobile: oldMobile,
        }),
      )
      const res = await http()
        .post('/api/auth/sms/login')
        .send({ mobile: oldMobile, code: '654321' })
        .expect(400)
      expect(res.body.code).toBe(Err.AUTH_SMS_CODE_INVALID.code)
      const codes = await ds.query<Array<{ mobile: string; consumed_at: Date | null }>>(
        'SELECT mobile, consumed_at FROM msg_sms_otp WHERE mobile IN (?) ORDER BY id',
        [[oldMobile, unrelated]],
      )
      expect(codes.filter((row) => row.mobile === oldMobile)).toHaveLength(2)
      expect(codes.filter((row) => row.mobile === oldMobile).every((row) => row.consumed_at)).toBe(
        true,
      )
      expect(codes.find((row) => row.mobile === unrelated)?.consumed_at).toBeNull()
    } finally {
      await ds.query('DELETE FROM msg_sms_otp WHERE mobile IN (?)', [
        [oldMobile, newMobile, unrelated],
      ])
    }
  })

  it('detail names the held roles, a disabled one too (the edit form shows it by name)', async () => {
    const id = await newUser({ roleIds: [role.staff] })
    await ds.query('UPDATE iam_role SET enabled = 0 WHERE id = ?', [role.staff])
    try {
      const got = (await call(tok.admin!, 'get', `/${id}`).expect(200)).body.data
      expect(got).toMatchObject({
        roleIds: [role.staff],
        roles: [{ id: role.staff, name: `${PREFIX}staff` }],
      })
    } finally {
      await ds.query('UPDATE iam_role SET enabled = 1 WHERE id = ?', [role.staff])
    }
  })

  it('unknown id → 404; unknown role / position ids → 404 and nothing is written', async () => {
    await call(tok.admin!, 'get', `/${MISSING}`).expect(404)
    await call(tok.admin!, 'put', `/${MISSING}`, { displayName: 'x' }).expect(404)
    const username = unique()
    await create({ username, displayName: 'x', roleIds: [MISSING] }).expect(404)
    await create({ username, displayName: 'x', positionIds: [MISSING] }).expect(404)
    expect(await findId(ds.manager, 'iam_user', { username })).toBeUndefined()
  })

  it('roles / positions replaced as sent: removed links soft-deleted, re-added ones revived (one row each), new ones inserted', async () => {
    const [p1, p2] = [
      await insertRow(ds.manager, 'iam_position', { code: unique(), name: unique() }),
      await insertRow(ds.manager, 'iam_position', { code: unique(), name: unique() }),
    ]
    const id = await newUser({ roleIds: [role.staff], positionIds: [p1] })
    const put = (body: object, path = '') => call(tok.admin!, 'put', `/${id}${path}`, body)
    await put({ roleIds: [role.browser], positionIds: [p2] }).expect(200)
    expect(await linksOf('iam_user_roles', 'role_id', id)).toEqual([
      [role.staff, false],
      [role.browser, true],
    ])
    expect(await linksOf('iam_user_positions', 'position_id', id)).toEqual([
      [p1, false],
      [p2, true],
    ])
    expect((await call(tok.admin!, 'get', `/${id}`)).body.data).toMatchObject({
      roleIds: [role.browser],
      positionIds: [p2],
    })
    await put({ roleIds: [role.staff, role.browser] }, '/roles').expect(200)
    await put({ positionIds: [p1, p2] }).expect(200)
    expect(await linksOf('iam_user_roles', 'role_id', id)).toEqual([
      [role.staff, true],
      [role.browser, true],
    ])
    expect(await linksOf('iam_user_positions', 'position_id', id)).toEqual([
      [p1, true],
      [p2, true],
    ])
    // a removed position is no longer assigned: it can be deleted, then not assigned again (404)
    await put({ positionIds: [p2] }).expect(200)
    await http().delete(`/api/iam/positions/${p1}`).set(bearer(tok.admin!)).expect(200)
    await put({ positionIds: [p1, p2] }).expect(404)
    expect((await call(tok.admin!, 'get', `/${id}`)).body.data.positionIds).toEqual([p2])
  })

  it('a deleted or unknown dept → 404 on create and move, root too; nothing written', async () => {
    const gone = await insertRow(ds.manager, 'iam_dept', {
      parent_id: 0,
      tree_path: '/',
      name: unique(),
      deleted_at: new Date(),
    })
    created.depts.push(gone)
    const username = unique()
    for (const deptId of [gone, MISSING])
      await create({ username, displayName: 'x', deptId }).expect(404)
    expect(await findId(ds.manager, 'iam_user', { username })).toBeUndefined()
    const id = await newUser({ deptId: dept.rd })
    await call(tok.admin!, 'put', `/${id}`, { deptId: gone }).expect(404)
    expect((await call(tok.admin!, 'get', `/${id}`)).body.data.deptId).toBe(dept.rd)
    await call(tok.admin!, 'put', `/${id}`, { deptId: null }).expect(200) // no dept is fine
  })

  it('a deleted dept reaches nothing: own_dept_tree skips it, a user left in one has no dept (own_dept sees nobody)', async () => {
    // older data (no foreign keys): a dept under R&D deleted with a user still in it
    const gone = await insertRow(ds.manager, 'iam_dept', {
      parent_id: dept.rd,
      tree_path: '/',
      name: unique(),
    })
    created.depts.push(gone)
    const [{ tree_path: rdPath }] = await ds.query('SELECT tree_path FROM iam_dept WHERE id = ?', [
      dept.rd,
    ])
    await ds.query('UPDATE iam_dept SET tree_path = ? WHERE id = ?', [`${rdPath}${gone}/`, gone])
    const tag = `gone${++seq}`
    await operator(`${tag}-left`, gone, [role.browser!])
    await ds.query('UPDATE iam_dept SET deleted_at = NOW(3) WHERE id = ?', [gone])
    const seen = async (token: string) =>
      (
        await call(token, 'get')
          .query({ keyword: `${PREFIX}${tag}`, pageSize: 100 })
          .expect(200)
      ).body.data.items.map((u: UserVo) => u.id)
    expect(await seen(tok.admin!)).toEqual([uid[`${tag}-left`]])
    // nor is it in R&D's subtree for the dept filter, and filtering by it finds nobody
    for (const deptId of [dept.rd, gone])
      expect(
        (
          await call(tok.admin!, 'get')
            .query({ keyword: `${PREFIX}${tag}`, deptId })
            .expect(200)
        ).body.data.items,
      ).toEqual([])
    expect(await seen(tok.mgr!)).toEqual([]) // own_dept_tree of R&D
    await permVersion.bumpUser(uid[`${tag}-left`]!) // its session reloads: the dept is gone
    expect(await seen(tok[`${tag}-left`]!)).toEqual([]) // own_dept of a deleted dept
  })

  it('data scope: a dept outside the caller scope → 404 on create and edit; users outside it are invisible', async () => {
    // mgr: R&D and below
    await create({ username: unique(), displayName: 'x', deptId: dept.finance }, tok.mgr).expect(
      404,
    )
    await create({ username: unique(), displayName: 'x', deptId: null }, tok.mgr).expect(404)
    const inside = (
      await create(
        { username: unique(), displayName: 'in', deptId: dept.platform },
        tok.mgr,
      ).expect(201)
    ).body.data
    await call(tok.mgr!, 'put', `/${inside.id}`, { deptId: dept.ops }).expect(404)
    await call(tok.mgr!, 'put', `/${inside.id}`, { deptId: dept.product }).expect(200)

    const outside = (
      await create({ username: unique(), displayName: 'out', deptId: dept.finance }).expect(201)
    ).body.data
    await call(tok.mgr!, 'get', `/${outside.id}`).expect(404)
    await call(tok.mgr!, 'put', `/${outside.id}`, { displayName: 'x' }).expect(404)
    const listed = (await call(tok.mgr!, 'get').query({ keyword: PREFIX, pageSize: 200 })).body.data
      .items
    expect(listed.map((u: UserVo) => u.id)).toContain(inside.id)
    expect(listed.map((u: UserVo) => u.id)).not.toContain(outside.id)
    // lead: R&D only
    await call(tok.lead!, 'get', `/${inside.id}`).expect(404)
  })

  it('GrantPolicy: a non-root caller may give only roles within its own perms and data scope (403 grant_exceeds_own)', async () => {
    const make = (roleIds: number[], token = tok.mgr!, deptId = dept.platform) =>
      create({ username: unique(), displayName: 'g', deptId, roleIds }, token)
    const refused = async (res: request.Test) =>
      expect((await res.expect(403)).body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)

    await refused(make([role.extraPerm!])) // a perm the caller lacks
    await refused(make([role.wide!])) // same perms, data scope all
    await refused(make([role.pickedOut!])) // same perms, picked depts outside
    await refused(make([rootRoleId])) // root
    await refused(make([role.staff!, role.wide!])) // one bad role spoils the set
    for (const ok of [[role.staff!], [role.pickedIn!], [role.tree!]]) await make(ok).expect(201)
    // relative scopes are judged at the user's dept: an own-dept lead cannot hand out R&D's subtree
    await refused(make([role.tree!], tok.lead, dept.rd))
    await make([role.staff!], tok.lead, dept.rd).expect(201)

    // editing: the same rules for added roles; roles the user already has may stay
    const { id } = (await make([])).body.data
    await refused(call(tok.mgr!, 'put', `/${id}`, { roleIds: [role.wide] }))
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, role.wide])
    await call(tok.mgr!, 'put', `/${id}`, { roleIds: [role.wide, role.staff] }).expect(200)
    expect(await rolesOf(id)).toEqual([role.wide, role.staff].sort((a, b) => a! - b!))
    await refused(call(tok.mgr!, 'put', `/${id}`, { roleIds: [role.wide, role.extraPerm] }))
    // root may give anything, root included
    await make([role.wide!, role.extraPerm!], tok.admin).expect(201)
  }, 30_000) // 12 creates, each a bcrypt hash (cost 12) before the grant check: ~2.6 s alone, 5 s under load

  it('GrantPolicy judges data scope per perm point: a role must fit the caller scope of every perm it carries', async () => {
    // assigning roles over R&D and its subtree, but viewing users in R&D only
    await addRole('assigner', 'own_dept_tree', [userPerms['assign-roles'], userPerms.browse])
    await addRole('viewer', 'own_dept', [userPerms.view])
    await operator('assigner', dept.rd!, [role.assigner!, role.viewer!])
    await addRole('viewTree', 'own_dept_tree', [userPerms.view])
    await addRole('viewDept', 'own_dept', [userPerms.view])
    const id = await newUser({ deptId: dept.rd })
    const assign = (roleIds: number[]) => call(tok.assigner!, 'put', `/${id}/roles`, { roleIds })
    // iam.user.view over R&D's subtree: wider than the caller's view scope, though the route's is not
    const res = await assign([role.viewTree!]).expect(403)
    expect(res.body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)
    expect(await rolesOf(id)).toEqual([])
    await assign([role.viewDept!]).expect(200)
    expect(await rolesOf(id)).toEqual([role.viewDept])
  })

  it('moving a user keeps its relative-scope roles within the caller (403 grant_exceeds_own)', async () => {
    // picker sees R&D and Platform, not Product
    await addRole('picker', 'picked_depts', [userPerms.modify], [dept.rd!, dept.platform!])
    await operator('picker', dept.rd!, [role.picker!])
    const { id } = (
      await create({
        username: unique(),
        displayName: 't',
        deptId: dept.platform,
        roleIds: [role.tree],
      }).expect(201)
    ).body.data
    // Platform → R&D stays visible to picker, but own_dept_tree would then also cover Product
    const res = await call(tok.picker!, 'put', `/${id}`, { deptId: dept.rd }).expect(403)
    expect(res.body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)
    await call(tok.mgr!, 'put', `/${id}`, { deptId: dept.rd }).expect(200) // mgr covers R&D's subtree
    await call(tok.mgr!, 'put', `/${id}`, { deptId: dept.platform, roleIds: [role.tree] }).expect(
      200,
    )
    await call(tok.picker!, 'put', `/${id}`, { deptId: dept.rd, roleIds: [role.tree] }).expect(403)
  })

  it('root users: only root edits them and they keep the root role (422 user_protected)', async () => {
    const protectedCode = Err.IAM_USER_PROTECTED.code
    // mgr cannot see admin (HQ), so 404; a caller that sees it gets 422
    await addRole('hqAdmin', 'all', [userPerms.modify, userPerms.view])
    await operator('hqAdmin', dept.hq!, [role.hqAdmin!])
    const res = await call(tok.hqAdmin!, 'put', `/${adminId}`, { displayName: 'x' }).expect(422)
    expect(res.body.code).toBe(protectedCode)
    const strip = await call(tok.admin!, 'put', `/${adminId}`, { roleIds: [] }).expect(422)
    expect(strip.body.code).toBe(protectedCode)
    await call(tok.admin!, 'put', `/${adminId}`, { roleIds: [rootRoleId] }).expect(200)
    expect(await rolesOf(adminId)).toEqual([rootRoleId])
  })

  it('403 without the route perm; 401 without a session', async () => {
    const { id } = (await create({ username: unique(), displayName: 'p' }).expect(201)).body.data
    await call(tok.plain!, 'get').expect(403)
    await call(tok.plain!, 'get', `/${id}`).expect(403)
    await create({ username: unique(), displayName: 'p' }, tok.plain).expect(403)
    await call(tok.reader!, 'put', `/${id}`, { displayName: 'x' }).expect(403)
    await http().get(URL).expect(401)
  })

  it('the same create twice at once → 429; the action log keeps the password masked', async () => {
    const body = { username: unique(), displayName: 'i', password: PW }
    const [first, second] = await Promise.all([create(body), create(body)])
    expect([first.status, second.status].sort()).toEqual([201, 429])
    const ok = first.status === 201 ? first : second
    const log = await logOf(ds, ok.headers['x-request-id'])
    expect(log).toMatchObject({ domain: 'iam.user', verb: 'create', ok: 1 })
    expect(log.biz_id).toBe(String(ok.body.data.id))
    expect(log.params).not.toContain(PW)
  })

  it('Swagger documents the routes', async () => {
    const doc = (await http().get('/api/docs-json').expect(200)).body
    expect(Object.keys(doc.paths[URL])).toEqual(expect.arrayContaining(['get', 'post']))
    expect(Object.keys(doc.paths[`${URL}/{id}`])).toEqual(expect.arrayContaining(['get', 'put']))
    const body = doc.paths[URL].post.requestBody.content['application/json'].schema
    expect(body.properties).toHaveProperty('password')
  })
})

describe('actions', () => {
  it('delete: soft delete + role/position links soft-deleted at once, the old token and refresh are 401, sign-in fails, the position becomes deletable', async () => {
    const posId = await insertRow(ds.manager, 'iam_position', {
      code: unique(),
      name: unique(),
    })
    const username = unique()
    const id = await newUser({
      username,
      password: PW,
      roleIds: [role.browser],
      positionIds: [posId],
    })
    const token = (await signIn(app, username)).accessToken
    await call(token, 'get').expect(200)
    const signedIn = await login(username, PW).expect(200)
    const cookie = ([] as string[])
      .concat(signedIn.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('qw_rt='))!
      .split(';')[0]!
    const position = (path = '') =>
      http().delete(`/api/iam/positions/${posId}${path}`).set(bearer(tok.admin!))
    expect((await position().expect(409)).body.code).toBe(Err.IN_USE.code)

    const res = await call(tok.admin!, 'delete', `/${id}`).expect(200)
    await call(token, 'get').expect(401)
    await me(signedIn.body.data.accessToken).expect(401)
    const origin = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`
    await http()
      .post('/api/auth/refresh')
      .set('Origin', origin)
      .set('User-Agent', CHROME)
      .set('Cookie', cookie)
      .expect(401)
    await login(username, PW).expect(401)
    expect(await alive(id)).toBe(false)
    // the links stay as rows, soft-deleted: nothing is live any more
    expect(await linksOf('iam_user_roles', 'role_id', id)).toEqual([[role.browser, false]])
    expect(await linksOf('iam_user_positions', 'position_id', id)).toEqual([[posId, false]])
    await call(tok.admin!, 'get', `/${id}`).expect(404)
    await position().expect(200)
    // the username is free again (unique among live users)
    await create({ username, displayName: 'again' }).expect(201)
    const log = await logOf(ds, res.headers['x-request-id'])
    expect(log).toMatchObject({ domain: 'iam.user', verb: 'remove', biz_id: String(id), ok: 1 })
  })

  it('batch delete: all or none; never yourself (422) or a root user (422); out of scope → 404 for the batch', async () => {
    const inRd = await newUser({ deptId: dept.rd })
    const inFinance = await newUser({ deptId: dept.finance })
    const root = await newUser({ roleIds: [rootRoleId] })
    const batch = (token: string, ids: number[]) => call(token, 'post', '/batch-delete', { ids })
    // lead sees R&D only
    await batch(tok.lead!, [inRd, inFinance]).expect(404)
    expect((await batch(tok.lead!, [inRd, uid.lead!]).expect(422)).body.code).toBe(
      Err.IAM_USER_SELF.code,
    )
    expect((await call(tok.admin!, 'delete', `/${adminId}`).expect(422)).body.code).toBe(
      Err.IAM_USER_SELF.code,
    )
    expect((await batch(tok.admin!, [inRd, root]).expect(422)).body.code).toBe(
      Err.IAM_USER_PROTECTED.code,
    )
    for (const id of [inRd, inFinance, root]) expect(await alive(id)).toBe(true)
    await batch(tok.admin!, [inRd, inFinance]).expect(200)
    expect([await alive(inRd), await alive(inFinance)]).toEqual([false, false])
  })

  it('disable ends every session and blocks sign-in; enable lets the user back; never yourself or a root user', async () => {
    const username = unique()
    const id = await newUser({ username, password: PW })
    const token = (await signIn(app, username)).accessToken
    await me(token).expect(200)
    await call(tok.admin!, 'put', `/${id}/enabled`, { enabled: false }).expect(200)
    await me(token).expect(401)
    await login(username, PW).expect(401)
    expect((await call(tok.admin!, 'get', `/${id}`)).body.data.enabled).toBe(false)
    await call(tok.admin!, 'put', `/${id}/enabled`, { enabled: true }).expect(200)
    await login(username, PW).expect(200)
    // the edit form's enabled switch does the same
    const again = (await signIn(app, username)).accessToken
    await call(tok.admin!, 'put', `/${id}`, { enabled: false }).expect(200)
    await me(again).expect(401)

    const self = await call(tok.admin!, 'put', `/${adminId}/enabled`, { enabled: false })
    expect(self.status).toBe(422)
    expect(self.body.code).toBe(Err.IAM_USER_SELF.code)
    const root = await newUser({ roleIds: [rootRoleId] })
    const res = await call(tok.admin!, 'put', `/${root}/enabled`, { enabled: false }).expect(422)
    expect(res.body.code).toBe(Err.IAM_USER_PROTECTED.code)
  })

  it('reset password: policy (400); every session ends; the new password signs in and must be changed', async () => {
    const username = unique()
    const id = await newUser({ username, password: PW })
    await ds.query('UPDATE iam_user SET password_changed_at = NOW() WHERE id = ?', [id])
    const token = (await signIn(app, username)).accessToken
    const weak = await call(tok.admin!, 'put', `/${id}/password`, { password: 'weak' }).expect(400)
    expect(weak.body.errors[0].path).toBe('password')
    const res = await call(tok.admin!, 'put', `/${id}/password`, { password: 'Reset#Pass2' })
    expect(res.status).toBe(200)
    await me(token).expect(401)
    const [stored] = await ds.query('SELECT password_changed_at FROM iam_user WHERE id = ?', [id])
    expect(stored.password_changed_at).toBeNull()
    await login(username, PW).expect(401)
    const signedIn = await login(username, 'Reset#Pass2').expect(200)
    expect((await me(signedIn.body.data.accessToken)).body.data.flags.mustChangePassword).toBe(true)
    const log = await logOf(ds, res.headers['x-request-id'])
    expect(log).toMatchObject({ verb: 'reset-password', biz_id: String(id), ok: 1 })
    expect(log.params).not.toContain('Reset#Pass2')

    // a root user's password: root only
    await addRole('resetter', 'all', [userPerms['reset-password']])
    await operator('resetter', dept.hq!, [role.resetter!])
    const other = await call(tok.resetter!, 'put', `/${adminId}/password`, { password: PW })
    expect(other.status).toBe(422)
    expect(other.body.code).toBe(Err.IAM_USER_PROTECTED.code)
  })

  it('assign roles: grant policy (403), the next request of the user has the new perms, root keeps root', async () => {
    const username = unique()
    const id = await newUser({ username, deptId: dept.platform })
    const token = (await signIn(app, username)).accessToken
    const assign = (roleIds: number[], who = tok.mgr!, target = id) =>
      call(who, 'put', `/${target}/roles`, { roleIds })
    await call(token, 'get').expect(403)
    const res = await assign([role.browser!]).expect(200)
    await call(token, 'get').expect(200)
    for (const bad of [role.extraPerm!, role.wide!, role.pickedOut!, rootRoleId])
      expect((await assign([role.browser!, bad]).expect(403)).body.code).toBe(
        Err.IAM_GRANT_EXCEEDS_OWN.code,
      )
    expect(await rolesOf(id)).toEqual([role.browser])
    await assign([]).expect(200)
    await call(token, 'get').expect(403)
    const stripRoot = await assign([role.staff!], tok.admin, adminId).expect(422)
    expect(stripRoot.body.code).toBe(Err.IAM_USER_PROTECTED.code)
    const log = await logOf(ds, res.headers['x-request-id'])
    expect(log).toMatchObject({ domain: 'iam.user', verb: 'grant', biz_id: String(id), ok: 1 })
  })

  it('every grant entry point (create, edit, assign roles) refuses a missing perm, scope all or picked depts outside → 403', async () => {
    const id = await newUser({ deptId: dept.platform })
    for (const bad of [role.extraPerm!, role.wide!, role.pickedOut!]) {
      const attempts = [
        create(
          { username: unique(), displayName: 'g', deptId: dept.platform, roleIds: [bad] },
          tok.mgr,
        ),
        call(tok.mgr!, 'put', `/${id}`, { roleIds: [bad] }),
        call(tok.mgr!, 'put', `/${id}/roles`, { roleIds: [bad] }),
      ]
      for (const attempt of attempts)
        expect((await attempt.expect(403)).body.code).toBe(Err.IAM_GRANT_EXCEEDS_OWN.code)
    }
    expect(await rolesOf(id)).toEqual([])
  })

  it('an own_dept admin on a user outside its dept: enable, reset, assign roles, delete, batch delete → 404', async () => {
    const id = await newUser({ deptId: dept.platform }) // lead sees R&D only
    const writes: [method: 'put' | 'delete' | 'post', path: string, body?: object][] = [
      ['put', `/${id}/enabled`, { enabled: false }],
      ['put', `/${id}/password`, { password: PW }],
      ['put', `/${id}/roles`, { roleIds: [role.staff] }],
      ['put', `/${id}`, { displayName: 'x' }],
      ['delete', `/${id}`],
      ['post', '/batch-delete', { ids: [id] }],
    ]
    for (const [method, path, body] of writes) await call(tok.lead!, method, path, body).expect(404)
    const row = (await call(tok.admin!, 'get', `/${id}`)).body.data
    expect(row).toMatchObject({ enabled: true, displayName: 'u', roleIds: [] })
  })

  it('options: enabled users of the caller scope, for any signed-in user; dept subtree and keyword filters', async () => {
    const tag = unique()
    const a = await newUser({ username: `${tag}-a`, deptId: dept.platform })
    const b = await newUser({ username: `${tag}-b`, deptId: dept.finance })
    await newUser({ username: `${tag}-c`, deptId: dept.platform, enabled: false })
    const options = async (token: string, query: object) =>
      (await call(token, 'get', '/options').query(query).expect(200)).body.data
    expect(await options(tok.admin!, { keyword: tag })).toEqual([
      { id: a, username: `${tag}-a`, displayName: 'u', deptName: 'seed.dept.platform' },
      { id: b, username: `${tag}-b`, displayName: 'u', deptName: 'seed.dept.finance' },
    ])
    expect(
      (await options(tok.admin!, { keyword: tag, deptId: dept.rd })).map((u: UserVo) => u.id),
    ).toEqual([a])
    expect((await options(tok.mgr!, { keyword: tag })).map((u: UserVo) => u.id)).toEqual([a])
    expect(await options(tok.plain!, { keyword: tag })).toEqual([])
    await http().get(`${URL}/options`).expect(401)
  })

  it('403 without the action perms', async () => {
    const id = await newUser()
    await call(tok.reader!, 'put', `/${id}/enabled`, { enabled: false }).expect(403)
    await call(tok.reader!, 'put', `/${id}/password`, { password: PW }).expect(403)
    await call(tok.reader!, 'put', `/${id}/roles`, { roleIds: [] }).expect(403)
    await call(tok.reader!, 'delete', `/${id}`).expect(403)
    await call(tok.reader!, 'post', '/batch-delete', { ids: [id] }).expect(403)
    expect(await alive(id)).toBe(true)
  })
})

describe('excel', () => {
  const HEAD = ['username', 'displayName', 'deptId', 'mobile', 'email', 'gender', 'enabled', 'note']
  /** Binary body as a Buffer whatever the content type. */
  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    })
  const workbook = async (res: request.Response) => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body as unknown as Parameters<typeof wb.xlsx.load>[0])
    return wb
  }
  const cells = (ws: ExcelJS.Worksheet, row: number, length: number) =>
    Array.from({ length }, (_, i) => ws.getRow(row).getCell(i + 1).value ?? null)
  const xlsx = async (rows: unknown[][]) => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('users')
    for (const r of rows) ws.addRow(r)
    return Buffer.from(await wb.xlsx.writeBuffer())
  }
  const upload = (token: string, file: Buffer, mode?: string) => {
    const req = http().post(`${URL}/import`).set(bearer(token)).attach('file', file, 'users.xlsx')
    return mode ? req.field('mode', mode) : req
  }
  const byName = async (username: string) =>
    (
      await ds.query('SELECT * FROM iam_user WHERE username = ? AND deleted_at IS NULL', [username])
    )[0]
  const path = (...names: string[]) => names.join(' / ')

  it('export: filtered rows in list order, translated headers and dict labels, dept as `<id> - <path>`, formulas escaped, contacts masked without modify', async () => {
    const tag = unique()
    await create({
      username: `${tag}-a`,
      displayName: '=1+1',
      deptId: dept.platform,
      mobile: '13600000005',
      gender: 'male',
    }).expect(201)
    await create({ username: `${tag}-b`, displayName: 'b', enabled: false }).expect(201)
    const exported = (token: string) =>
      binary(
        call(token, 'get', '/export')
          .query({ keyword: tag, sort: 'username', pageSize: 1 })
          .set('Accept-Language', 'en-US'),
      )
    const res = await exported(tok.admin!).expect(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="users.xlsx"')
    const ws = (await workbook(res)).worksheets[0]!
    expect(cells(ws, 1, 10)).toEqual([
      'Username',
      'Display name',
      'Department',
      'Mobile',
      'Email',
      'Gender',
      'Enabled',
      'Last sign-in',
      'Created at',
      'Note',
    ])
    const platformRef = `${dept.platform} - ${path('Headquarters', 'R&D Center', 'Platform Team')}`
    expect(cells(ws, 2, 7)).toEqual([
      `${tag}-a`,
      "'=1+1",
      platformRef,
      '13600000005',
      null,
      'Male',
      'Enabled',
    ])
    expect(cells(ws, 3, 7)).toEqual([
      `${tag}-b`,
      'b',
      null,
      null,
      null,
      'Not specified',
      'Disabled',
    ])
    expect(ws.actualRowCount).toBe(3)

    await addRole('exporter', 'all', [userPerms.export])
    await operator('exporter', dept.hq!, [role.exporter!])
    const masked = (await workbook(await exported(tok.exporter!).expect(200))).worksheets[0]!
    expect(cells(masked, 2, 4)[3]).toBe('136****0005')
    await binary(call(tok.reader!, 'get', '/export')).expect(403)
  })

  it('template: the import columns, dept dropdown = enabled depts of the caller scope as `<id> - <path>`, dict dropdowns', async () => {
    const res = await binary(
      call(tok.mgr!, 'get', '/import-template').set('Accept-Language', 'en-US'),
    ).expect(200)
    const [ws, lists] = (await workbook(res)).worksheets
    expect(cells(ws!, 1, 9)).toEqual([
      'Username',
      'Display name',
      'Department',
      'Mobile',
      'Email',
      'Gender',
      'Enabled',
      'Note',
      null,
    ])
    const rd = ['Headquarters', 'R&D Center']
    expect(lists!.getColumn(1).values.slice(1)).toEqual([
      `${dept.rd} - ${path(...rd)}`,
      `${dept.platform} - ${path(...rd, 'Platform Team')}`,
      `${dept.product} - ${path(...rd, 'Product Team')}`,
    ])
    expect(lists!.getColumn(2).values.slice(1)).toEqual(['Male', 'Female', 'Not specified'])
    expect(ws!.getCell('C2').dataValidation).toMatchObject({
      type: 'list',
      formulae: ['lists!$A$1:$A$3'],
    })
    expect(ws!.getCell('F2').dataValidation).toMatchObject({ formulae: ['lists!$B$1:$B$3'] })
    await binary(call(tok.reader!, 'get', '/import-template')).expect(403)
  })

  it('import (insert): 3 rows with 1 failing → 2 users with the initial password to change, no roles or positions; error report', async () => {
    const tag = unique()
    const file = await xlsx([
      ['用户名', '显示名', '所属部门', '手机号', '邮箱', '性别', '启用状态', '备注'],
      [`${tag}-a`, 'A', `${dept.platform} - any text`, '13500000006', null, '女', '启用', 'n'],
      [`${tag}-b`, 'B', dept.rd, null, 'not-an-email', 'male', 'false', null],
      [`${tag}-c`, 'C', null, null, null, null, 'Disabled', null],
    ])
    const res = await upload(tok.admin!, file).expect(200)
    expect(res.body.data).toEqual({
      inserted: 2,
      updated: 0,
      failed: 1,
      reportId: expect.any(String),
    })
    const a = await byName(`${tag}-a`)
    expect(a).toMatchObject({
      display_name: 'A',
      dept_id: dept.platform,
      mobile: '13500000006',
      gender: 'female',
      enabled: 1,
      note: 'n',
      password_changed_at: null,
    })
    expect(await bcrypt.compare(INITIAL, a.password_hash)).toBe(true)
    expect(await rolesOf(a.id)).toEqual([])
    expect(await byName(`${tag}-b`)).toBeUndefined()
    expect(await byName(`${tag}-c`)).toMatchObject({ dept_id: null, enabled: 0 })

    const report = await binary(
      http().get(`/api/excel/reports/${res.body.data.reportId}`).set(bearer(tok.admin!)),
    ).expect(200)
    const ws = (await workbook(report)).worksheets[0]!
    expect(ws.actualRowCount).toBe(2)
    const [line, username, ...rest] = cells(ws, 2, 10)
    expect([line, username]).toEqual([3, `${tag}-b`])
    expect(String(rest.at(-1))).toContain('邮箱')
    // someone else's report → 404
    await http()
      .get(`/api/excel/reports/${res.body.data.reportId}`)
      .set(bearer(tok.mgr!))
      .expect(404)
  })

  it('import (upsert): updates users the caller sees, inserts new ones; same-named users outside the scope and depts outside it fail their row', async () => {
    const tag = unique()
    const inside = await newUser({
      username: `${tag}-in`,
      displayName: 'old',
      deptId: dept.platform,
    })
    await newUser({ username: `${tag}-out`, displayName: 'old', deptId: dept.finance })
    const file = await xlsx([
      HEAD,
      [`${tag}-in`, 'new', dept.product, null, null, null, null, null],
      [`${tag}-out`, 'taken over', dept.platform, null, null, null, null, null],
      [`${tag}-new`, 'N', dept.platform, null, null, null, null, null],
      [`${tag}-far`, 'F', dept.finance, null, null, null, null, null],
    ])
    const res = await upload(tok.mgr!, file, 'upsert').expect(200)
    expect(res.body.data).toMatchObject({ inserted: 1, updated: 1, failed: 2 })
    expect(await byName(`${tag}-in`)).toMatchObject({
      id: inside,
      display_name: 'new',
      dept_id: dept.product,
    })
    expect(await byName(`${tag}-out`)).toMatchObject({ display_name: 'old', dept_id: dept.finance })
    expect(await byName(`${tag}-new`)).toMatchObject({ dept_id: dept.platform })
    expect(await byName(`${tag}-far`)).toBeUndefined()

    // insert mode never updates: an existing username fails its row (duplicate)
    const again = await upload(
      tok.admin!,
      await xlsx([HEAD, [`${tag}-in`, 'again', null, null, null, null, null, null]]),
    ).expect(200)
    expect(again.body.data).toMatchObject({ inserted: 0, updated: 0, failed: 1 })
    expect((await byName(`${tag}-in`)).display_name).toBe('new')
  })

  it('import: 403 without iam.user.import; 400 without a file', async () => {
    const file = await xlsx([HEAD, [unique(), 'x', null, null, null, null, null, null]])
    await upload(tok.reader!, file).expect(403)
    const res = await http().post(`${URL}/import`).set(bearer(tok.admin!)).field('mode', 'insert')
    expect(res.status).toBe(400)
  })
})
