// The two log pages beyond the generated read-only cases (hand-written; the generated specs are
// audit-action-log / audit-signin-log): delete one / a batch / everything (`-t delete`), the sort
// whitelist (`-t sort`), the sign-in log's unlock and its messages translated from msg_key (`-t unlock`,
// `-t msg`). Rows go straight into the tables.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { actionLogPerms, Err, loginSecurityParams, signinLogPerms } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId, insertRow, type Row } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-logs-'
const MISSING = 999_999_999

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'admin' | 'viewer', string> = { admin: '', viewer: '' }
const userIds: number[] = []
let roleId: number
let ipSeq = 0
let seq = 0
const unique = () => `${PREFIX}${++seq}`

interface LogPage {
  name: string
  url: string
  table: string
  domain: string
  /** a row of this log, made of `tag` */
  row: (tag: string, over?: Row) => Row
  /** the list filter holding the tag */
  filter: string
}
const LOGS: LogPage[] = [
  {
    name: 'action log',
    url: '/api/audit/action-logs',
    table: 'aud_action_log',
    domain: 'audit.actionLog',
    row: (tag, over = {}) => ({
      domain: tag,
      verb: 'modify',
      http_method: 'PUT',
      url: `/api/${tag}`,
      ok: 1,
      cost_ms: 1,
      ...over,
    }),
    filter: 'domain',
  },
  {
    name: 'sign-in log',
    url: '/api/audit/signin-logs',
    table: 'aud_signin_log',
    domain: 'audit.signinLog',
    row: (tag, over = {}) => ({
      kind: 'password',
      username: tag,
      client_id: 'console',
      ok: 1,
      msg_key: 'signin.ok',
      ...over,
    }),
    filter: 'username',
  },
]
const [ACTION, SIGNIN] = LOGS as [LogPage, LogPage]

const call = (
  who: keyof typeof tokens,
  method: 'get' | 'post' | 'delete',
  url: string,
  body?: object,
) => {
  const req = request(app.getHttpServer())[method](url).set(bearer(tokens[who]))
  return body ? req.send(body) : req
}
const ids = (res: request.Response) => res.body.data.items.map((r: { id: number }) => r.id)
const count = async (table: string) =>
  Number((await ds.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n) // arch-allow: sql-concat table name from the spec's constants

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  await cleanRedis(redis)
  // browse + view of both logs: no remove, no unlock
  roleId = await insertRow(ds.manager, 'iam_role', {
    code: `${PREFIX}viewer`,
    name: `${PREFIX}viewer`,
    data_scope: 'all',
  })
  for (const perm of [
    actionLogPerms.browse,
    actionLogPerms.view,
    signinLogPerms.browse,
    signinLogPerms.view,
  ])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      roleId,
      await findId(ds.manager, 'iam_menu', { perms: perm }),
    ])
  const viewer = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}viewer`,
    display_name: 'viewer',
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  userIds.push(viewer)
  await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [viewer, roleId])
  tokens.admin = (await signIn(app)).accessToken
  tokens.viewer = (await signIn(app, `${PREFIX}viewer`)).accessToken
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM aud_action_log WHERE domain LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM aud_signin_log WHERE username LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe.each(LOGS)('delete: $name', (log) => {
  const add = (tag: string, over?: Row) => insertRow(ds.manager, log.table, log.row(tag, over))
  // live (deleting is soft: the row stays, marked deleted)
  const exists = async (id: number) =>
    // arch-allow: sql-concat table name from the spec's constants
    (await ds.query(`SELECT 1 FROM ${log.table} WHERE id = ? AND deleted_at IS NULL`, [id]))
      .length === 1

  it('delete: one, then a batch (all or none: an unknown id deletes nothing); action-logged', async () => {
    const [a, b, c] = [await add(unique()), await add(unique()), await add(unique())]
    const trace = `${PREFIX}${process.pid}-${log.table}-`
    await call('admin', 'delete', `${log.url}/${a}`).set('X-Request-Id', `${trace}d`).expect(200)
    expect(await exists(a)).toBe(false)
    const refused = await call('admin', 'post', `${log.url}/batch-delete`, { ids: [b, MISSING] })
    expect(refused.status).toBe(404)
    expect(await exists(b)).toBe(true)
    await call('admin', 'post', `${log.url}/batch-delete`, { ids: [b, c] })
      .set('X-Request-Id', `${trace}b`)
      .expect(200)
    expect([await exists(b), await exists(c)]).toEqual([false, false])
    expect((await call('admin', 'delete', `${log.url}/${MISSING}`)).status).toBe(404)
    expect(await logOf(ds, `${trace}d`)).toMatchObject({
      domain: log.domain,
      verb: 'remove',
      biz_id: String(a),
      ok: 1,
    })
    expect(await logOf(ds, `${trace}b`)).toMatchObject({
      domain: log.domain,
      verb: 'remove',
      ok: 1,
    })
  })

  it('delete: 403 without the remove permission (delete, batch, clean): nothing deleted', async () => {
    const id = await add(unique())
    for (const res of [
      await call('viewer', 'delete', `${log.url}/${id}`),
      await call('viewer', 'post', `${log.url}/batch-delete`, { ids: [id] }),
      await call('viewer', 'post', `${log.url}/clean`),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(Err.FORBIDDEN.code)
    }
    expect(await exists(id)).toBe(true)
    await call('admin', 'post', `${log.url}/batch-delete`, { ids: [] }).expect(400)
  })

  it('delete: clean deletes every entry (soft: the rows stay until the purge); it is action-logged', async () => {
    for (let i = 0; i < 3; i++) await add(unique())
    const ids = async (where = '') =>
      (
        await ds.query(
          // arch-allow: sql-concat table name and condition from the spec's constants
          `SELECT id FROM ${log.table}${where} ORDER BY id`,
        )
      ).map((r: { id: number }) => Number(r.id))
    const before = await ids()
    expect(before.length).toBeGreaterThanOrEqual(3)
    const trace = `${PREFIX}${process.pid}-${log.table}-clean`
    await call('admin', 'post', `${log.url}/clean`).set('X-Request-Id', trace).expect(200)
    const logged = await logOf(ds, trace)
    expect(logged).toMatchObject({ domain: log.domain, verb: 'clean', ok: 1 })
    // the action log keeps only what came after the clean: the clean's own row
    expect(await ids(' WHERE deleted_at IS NULL')).toEqual(
      log === ACTION ? [Number(logged.id)] : [],
    )
    expect(await ids(' WHERE deleted_at IS NOT NULL')).toEqual(expect.arrayContaining(before))
    expect((await call('admin', 'get', log.url).expect(200)).body.data.total).toBe(
      log === ACTION ? 1 : 0,
    )
  })
})

describe('sort: the whitelist', () => {
  const list = (log: LogPage, query: object) => call('admin', 'get', log.url).query(query)

  it('sort: action log by costMs and createdAt, both directions; anything else → 400', async () => {
    const tag = unique()
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s))
    const slow = await insertRow(
      ds.manager,
      ACTION.table,
      ACTION.row(tag, { cost_ms: 900, created_at: at(1) }),
    )
    const fast = await insertRow(
      ds.manager,
      ACTION.table,
      ACTION.row(tag, { cost_ms: 5, created_at: at(3) }),
    )
    const mid = await insertRow(
      ds.manager,
      ACTION.table,
      ACTION.row(tag, { cost_ms: 40, created_at: at(2) }),
    )
    const by = async (sort: string) => ids(await list(ACTION, { domain: tag, sort }).expect(200))
    expect(await by('costMs')).toEqual([fast, mid, slow])
    expect(await by('-costMs')).toEqual([slow, mid, fast])
    expect(await by('createdAt')).toEqual([slow, mid, fast])
    expect(await by('-createdAt')).toEqual([fast, mid, slow])
    // the default (no sort): newest first by id
    expect(ids(await list(ACTION, { domain: tag }).expect(200))).toEqual([mid, fast, slow])
    for (const sort of ['username', 'domain', 'verb', 'params', 'costMs;drop', '-ok'])
      expect((await list(ACTION, { sort })).status).toBe(400)
  })

  it('sort: sign-in log by createdAt, both directions; anything else → 400', async () => {
    const tag = unique()
    const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s))
    const late = await insertRow(ds.manager, SIGNIN.table, SIGNIN.row(tag, { created_at: at(2) }))
    const early = await insertRow(ds.manager, SIGNIN.table, SIGNIN.row(tag, { created_at: at(1) }))
    const by = async (sort: string) => ids(await list(SIGNIN, { username: tag, sort }).expect(200))
    expect(await by('createdAt')).toEqual([early, late])
    expect(await by('-createdAt')).toEqual([late, early])
    for (const sort of ['costMs', 'username', 'kind', 'ip'])
      expect((await list(SIGNIN, { sort })).status).toBe(400)
  })
})

describe('unlock: a username locked by failed sign-ins', () => {
  const login = (username: string, ip: string) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip)
      .send({ username, password: 'Wrong#pass1' })
  /** A fresh documentation-range client IP (RFC 5737) per call. */
  const nextIp = () => `198.51.100.${++ipSeq}`

  it('unlock: every IP pair of the username ends at once (any spelling); 403 without unlock; action-logged', async () => {
    const name = `${PREFIX}lock${process.pid}`
    const [ipA, ipB] = [nextIp(), nextIp()]
    // 10 failures reach the cross-IP threshold, whose captcha gate comes before the lock check
    // (see docs/design-notes.md#auth-sessions): raised here so both pair locks answer
    const threshold = loginSecurityParams.crossIpThreshold
    const setThreshold = async (value: string) => {
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, threshold])
      await app.get(ParamService).invalidate(threshold)
    }
    const [{ param_value: before }] = await ds.query<{ param_value: string }[]>(
      'SELECT param_value FROM cfg_param WHERE param_key = ?',
      [threshold],
    )
    const url = `${SIGNIN.url}/unlock`
    await setThreshold('100')
    try {
      for (const ip of [ipA, ipB]) for (let i = 1; i <= 5; i++) await login(name, ip)
      for (const ip of [ipA, ipB]) {
        const locked = await login(name, ip)
        expect(locked.status).toBe(429)
        expect(locked.body.code).toBe(Err.AUTH_LOCKED.code)
      }
      expect((await call('viewer', 'post', url, { username: name })).status).toBe(403)
      expect((await login(name, ipA)).body.code).toBe(Err.AUTH_LOCKED.code)
    } finally {
      await setThreshold(before!)
    }
    await call('admin', 'post', url, { username: '' }).expect(400)
    const trace = `${PREFIX}${process.pid}-unlock`
    await call('admin', 'post', url, { username: name.toUpperCase() })
      .set('X-Request-Id', trace)
      .expect(200)
    // no longer locked: a wrong password is just a wrong password again, on both IPs
    for (const ip of [ipA, ipB]) {
      const res = await login(name, ip)
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.AUTH_BAD_CREDENTIALS.code)
    }
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'audit.signinLog',
      verb: 'unlock',
      biz_id: name.toUpperCase(),
      ok: 1,
    })
    // a username that was never locked: nothing to do, still 200
    await call('admin', 'post', url, { username: `${PREFIX}never*[x]?` }).expect(200)
  }, 30_000) // 15 sign-ins, 12 of them bcrypt compares (cost 12): ~2.5 s alone, past the 5 s default under load
})

describe('msg: the sign-in log message in the reader’s language', () => {
  it('msg: msg_key + msg_params translated in list, detail and export (zh-CN, en-US)', async () => {
    const tag = unique()
    const id = await insertRow(
      ds.manager,
      SIGNIN.table,
      SIGNIN.row(tag, {
        kind: 'locked',
        ok: 0,
        msg_key: 'signin.locked',
        msg_params: { minutes: 7 },
      }),
    )
    const zh = '登录失败次数过多，该用户名在此 IP 锁定 7 分钟'
    const en = 'Too many failed attempts: this username is locked on this IP for 7 minutes'
    const listed = await call('admin', 'get', SIGNIN.url).query({ username: tag }).expect(200)
    expect(listed.body.data.items[0]).toMatchObject({
      id,
      msgKey: 'signin.locked',
      msgParams: { minutes: 7 },
      msg: zh,
    })
    const got = await call('admin', 'get', `${SIGNIN.url}/${id}`)
      .set('Accept-Language', 'en-US')
      .expect(200)
    expect(got.body.data.msg).toBe(en)
    const res = await call('admin', 'get', `${SIGNIN.url}/export`)
      .query({ username: tag })
      .set('Accept-Language', 'en-US')
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      .expect(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0])
    const values = wb.worksheets[0]!.getRow(2).values as unknown[]
    expect(values).toContain(en)
    // a row without a key has no message
    const bare = await insertRow(ds.manager, SIGNIN.table, SIGNIN.row(unique(), { msg_key: null }))
    expect((await call('admin', 'get', `${SIGNIN.url}/${bare}`).expect(200)).body.data.msg).toBe(
      null,
    )
    expect(await count(SIGNIN.table)).toBeGreaterThan(0)
  })
})

describe('msg: the action log failure reason in the reader’s language', () => {
  it('msg: error_msg (an error key) translated in list and detail (zh-CN, en-US); none stays null', async () => {
    const tag = unique()
    const id = await insertRow(
      ds.manager,
      ACTION.table,
      ACTION.row(tag, { ok: 0, error_msg: Err.IAM_USER_PROTECTED.key }),
    )
    const zh = '超级管理员账号受保护，不能执行此操作'
    const en = 'The super administrator account is protected against this action'
    const listed = await call('admin', 'get', ACTION.url).query({ domain: tag }).expect(200)
    expect(listed.body.data.items[0]).toMatchObject({ id, errorMsg: zh })
    const got = await call('admin', 'get', `${ACTION.url}/${id}`)
      .set('Accept-Language', 'en-US')
      .expect(200)
    expect(got.body.data.errorMsg).toBe(en)
    const bare = await insertRow(ds.manager, ACTION.table, ACTION.row(unique()))
    expect(
      (await call('admin', 'get', `${ACTION.url}/${bare}`).expect(200)).body.data.errorMsg,
    ).toBe(null)
  })
})
