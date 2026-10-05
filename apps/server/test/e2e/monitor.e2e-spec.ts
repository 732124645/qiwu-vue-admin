// Monitor backends: `-t server`, `-t redis`, `-t cache`, `-t mysql`. A reader holds the
// four browse perms (not the cache clean-up, all from the monitor menu seed), a stranger none; admin
// (root) clears.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  CACHE_SCAN_MAX,
  cacheNamespaceVo,
  Err,
  MYSQL_STATUS_KEYS,
  MYSQL_VARIABLE_KEYS,
  monitorMysqlVo,
  monitorPerms,
  monitorRedisVo,
  monitorServerVo,
} from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import {
  CACHE_NAMESPACES,
  type CacheNamespaceName,
  keyPrefix,
  redisKey,
} from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { DictService } from '../../src/core/settings/dict.service.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const PREFIX = 'e2e-monitor-'
const URL = '/api/monitor'

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
const tokens: Record<'admin' | 'reader' | 'stranger', string> = {
  admin: '',
  reader: '',
  stranger: '',
}
const userIds: number[] = []
let roleId: number

const call = (who: keyof typeof tokens, method: 'get' | 'delete', path: string, query = {}) =>
  request(app.getHttpServer())[method](`${URL}${path}`).query(query).set(bearer(tokens[who]))

/** `redisKey` without the global prefix: how the cache API names keys. */
const bare = (name: CacheNamespaceName, ...parts: string[]) =>
  redisKey(name, ...parts).slice(keyPrefix().length)

async function addUser(name: string, role?: number) {
  const id = await insertRow(ds.manager, 'iam_user', {
    username: `${PREFIX}${name}`,
    display_name: name,
    password_hash: 'not-used-by-this-spec',
    password_changed_at: new Date(),
  })
  userIds.push(id)
  if (role)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [id, role])
  return (await signIn(app, `${PREFIX}${name}`)).accessToken
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
  for (const perms of [
    monitorPerms.server,
    monitorPerms.redis,
    monitorPerms.cache,
    monitorPerms.mysql,
  ])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      roleId,
      await findId(ds.manager, 'iam_menu', { kind: 'action', perms }),
    ])
  tokens.admin = (await signIn(app)).accessToken
  tokens.reader = await addUser('reader', roleId)
  tokens.stranger = await addUser('stranger')
})

/**
 * The next `ds.query` whose SQL contains `table` with `arg` as its first argument stalls after loading
 * (a dict / param fill that read the database) until `release()`; `restore()` ends the spy.
 */
function gateLoad(table: string, arg: string) {
  const query = ds.query.bind(ds)
  let loaded!: () => void
  const atGate = new Promise<void>((r) => (loaded = r))
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let gated = false
  const spy = vi
    .spyOn(ds, 'query')
    .mockImplementation(async (sql: string, args?: Parameters<typeof query>[1]) => {
      const rows = await query(sql, args)
      if (!gated && sql.includes(table) && Array.isArray(args) && args[0] === arg) {
        gated = true
        loaded()
        await gate
      }
      return rows
    })
  return { atGate, release, restore: () => spy.mockRestore() }
}

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM cfg_dict_entry WHERE dict_code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM cfg_dict WHERE code LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM cfg_param WHERE param_key LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
    await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('server', () => {
  it('server: host and process figures for the perm holder; 403 without it', async () => {
    const res = await call('reader', 'get', '/server').expect(200)
    const vo = monitorServerVo.parse(res.body.data)
    expect(vo.cpu.cores).toBeGreaterThan(0)
    expect(vo.cpu.usage).toBeGreaterThanOrEqual(0)
    expect(vo.cpu.loadAvg).toHaveLength(3)
    expect(vo.mem.total).toBeGreaterThan(0)
    expect(vo.mem.usage).toBeGreaterThan(0)
    expect(vo.mem.usage).toBeLessThanOrEqual(100)
    expect(vo.disks.length).toBeGreaterThan(0)
    for (const d of vo.disks) expect(d.size).toBeGreaterThan(0)
    expect(vo.node).toEqual({ version: process.versions.node, v8: process.versions.v8 })
    expect(vo.process.pid).toBe(process.pid)
    expect(vo.process.heapUsed).toBeGreaterThan(0)
    const denied = await call('stranger', 'get', '/server').expect(403)
    expect(denied.body.code).toBe(Err.FORBIDDEN.code)
  })
})

describe('redis', () => {
  it('redis: the whitelisted INFO sections without host paths, command stats by calls, the own db only; 403 without the perm', async () => {
    const vo = monitorRedisVo.parse((await call('reader', 'get', '/redis').expect(200)).body.data)
    expect(Object.keys(vo.info).sort()).toEqual(
      ['server', 'clients', 'memory', 'persistence', 'stats', 'cpu'].sort(),
    )
    expect(vo.info.server?.redis_version).toMatch(/^\d+\.\d+/)
    expect(vo.info.server).not.toHaveProperty('executable')
    expect(vo.info.server).not.toHaveProperty('config_file')
    expect(Number(vo.info.memory?.used_memory)).toBeGreaterThan(0)
    expect(vo.commandStats.length).toBeGreaterThan(0)
    const calls = vo.commandStats.map((c) => c.calls)
    expect(calls).toEqual([...calls].sort((a, b) => b - a))
    expect(vo.commandStats.map((c) => c.command)).toContain('get')
    // the app's own db, which holds at least this spec's sessions
    expect(vo.keyspace.db).toBe(Number(process.env.REDIS_DB))
    expect(vo.keyspace.keys).toBeGreaterThan(0)
    const denied = await call('stranger', 'get', '/redis').expect(403)
    expect(denied.body.code).toBe(Err.FORBIDDEN.code)
  })
})

describe('cache', () => {
  it('cache: the registered namespaces with their flags', async () => {
    const list = z
      .array(cacheNamespaceVo)
      .parse((await call('reader', 'get', '/cache/namespaces').expect(200)).body.data)
    expect(list).toEqual(Object.entries(CACHE_NAMESPACES).map(([name, ns]) => ({ name, ...ns })))
    expect(list.filter((n) => n.prefix.startsWith('auth')).every((n) => !n.clearable)).toBe(true)
    await call('stranger', 'get', '/cache/namespaces').expect(403)
  })

  it('cache: keys of one namespace without the global prefix (not a longer prefix’s); unknown → 404, bad → 400', async () => {
    const tag = `${PREFIX}${process.pid}`
    await redis.set(redisKey('dict', `${tag}-a`), '1')
    await redis.set(redisKey('dict', `${tag}-b`), '2')
    await redis.set(redisKey('authRefresh', `${tag}-rt`), '{}')
    await redis.set(redisKey('authRefreshGrace', `${tag}-grace`), '{}')
    const dict = (await call('reader', 'get', '/cache/keys', { ns: 'dict' }).expect(200)).body.data
    expect(dict.truncated).toBe(false)
    expect(dict.keys).toEqual(
      expect.arrayContaining([bare('dict', `${tag}-a`), bare('dict', `${tag}-b`)]),
    )
    expect(dict.keys.every((k: string) => !k.startsWith(keyPrefix()))).toBe(true)
    const rt = (await call('reader', 'get', '/cache/keys', { ns: 'authRefresh' }).expect(200)).body
      .data.keys
    expect(rt).toContain(bare('authRefresh', `${tag}-rt`))
    expect(rt).not.toContain(bare('authRefreshGrace', `${tag}-grace`))
    await call('reader', 'get', '/cache/keys', { ns: 'nope' }).expect(404)
    await call('reader', 'get', '/cache/keys', { ns: 'dict:*' }).expect(400)
    await call('reader', 'get', '/cache/keys').expect(400)
    await call('stranger', 'get', '/cache/keys', { ns: 'dict' }).expect(403)
  })

  it('cache: SCAN stops at the cap and says so', async () => {
    const tx = redis.multi()
    for (let i = 0; i <= CACHE_SCAN_MAX; i++)
      tx.set(redisKey('excelReport', `${PREFIX}cap`, i), 'x', { EX: 60 })
    await tx.exec()
    const res = (await call('reader', 'get', '/cache/keys', { ns: 'excelReport' }).expect(200)).body
      .data
    expect(res.truncated).toBe(true)
    expect(res.keys).toHaveLength(CACHE_SCAN_MAX)
    const cleared = await call('admin', 'delete', '/cache/keys', { ns: 'excelReport' }).expect(200)
    expect(cleared.body.data.deleted).toBeGreaterThanOrEqual(CACHE_SCAN_MAX + 1)
  })

  it('cache: a value by type with its TTL; masked namespaces show none; unregistered key → 404', async () => {
    const k = (type: string) => redisKey('idem', `${PREFIX}${type}`)
    await redis.set(k('string'), 'hello', { EX: 120 })
    await redis.hSet(k('hash'), { a: '1', b: '2' })
    await redis.rPush(k('list'), ['x', 'y'])
    await redis.sAdd(k('set'), ['m'])
    await redis.zAdd(k('zset'), [{ score: 2, value: 'z' }])
    const value = async (key: string) =>
      (
        await call('reader', 'get', '/cache/value', { key: key.slice(keyPrefix().length) }).expect(
          200,
        )
      ).body.data
    expect(await value(k('string'))).toMatchObject({
      type: 'string',
      masked: false,
      value: 'hello',
    })
    expect((await value(k('string'))).ttl).toBeGreaterThan(100)
    expect(await value(k('hash'))).toMatchObject({
      type: 'hash',
      ttl: -1,
      value: { a: '1', b: '2' },
    })
    expect(await value(k('list'))).toMatchObject({ type: 'list', value: ['x', 'y'] })
    expect(await value(k('set'))).toMatchObject({ type: 'set', value: ['m'] })
    expect(await value(k('zset'))).toMatchObject({
      type: 'zset',
      value: [{ value: 'z', score: 2 }],
    })
    expect(await value(redisKey('idem', `${PREFIX}gone`))).toMatchObject({
      type: 'none',
      value: null,
    })
    // masked: param values may be secrets
    await redis.set(redisKey('param', `${PREFIX}secret`), '{"value":"s3cret"}')
    const masked = await value(redisKey('param', `${PREFIX}secret`))
    expect(masked).toMatchObject({ type: 'string', masked: true, value: null })
    expect(JSON.stringify(masked)).not.toContain('s3cret')
    // another user's import error report (base64 .xlsx of their rows) neither
    await redis.set(redisKey('excelReport', 999, `${PREFIX}report`), 'UEsDBBQ-private-rows', {
      EX: 60,
    })
    const report = await value(redisKey('excelReport', 999, `${PREFIX}report`))
    expect(report).toMatchObject({ type: 'string', masked: true, value: null })
    expect(JSON.stringify(report)).not.toContain('private-rows')
    await call('reader', 'get', '/cache/value', { key: 'nope:x' }).expect(404)
    await call('reader', 'get', '/cache/value', { key: '' }).expect(400)
    await call('stranger', 'get', '/cache/value', { key: bare('idem', 'x') }).expect(403)
  })

  it('cache: clear one key or one clearable namespace; action-logged; never a non-clearable one (422)', async () => {
    const one = redisKey('dict', `${PREFIX}one`)
    const other = redisKey('dict', `${PREFIX}other`)
    const idem = redisKey('idem', `${PREFIX}kept`)
    await redis.mSet([
      [one, '1'],
      [other, '2'],
      [idem, '3'],
    ])
    const trace = `${PREFIX}${process.pid}-clear-key`
    const byKey = await call('admin', 'delete', '/cache/keys', {
      key: bare('dict', `${PREFIX}one`),
    })
      .set('X-Request-Id', trace)
      .expect(200)
    expect(byKey.body.data).toEqual({ deleted: 1 })
    expect(await redis.exists([one, other])).toBe(1)
    expect(await logOf(ds, trace)).toMatchObject({
      domain: 'monitor.cache',
      verb: 'remove',
      biz_id: bare('dict', `${PREFIX}one`),
      ok: 1,
    })
    const byNs = await call('admin', 'delete', '/cache/keys', { ns: 'dict' }).expect(200)
    expect(byNs.body.data.deleted).toBeGreaterThanOrEqual(1)
    expect(await redis.exists(other)).toBe(0)
    expect(await redis.exists(idem)).toBe(1)
    // sessions end only through SessionRevoker: auth namespaces are never cleared here
    const session = redisKey('authSession', `${PREFIX}sess`)
    await redis.set(session, '{}')
    for (const query of [{ ns: 'authSession' }, { key: bare('authSession', `${PREFIX}sess`) }]) {
      const refused = await call('admin', 'delete', '/cache/keys', query).expect(422)
      expect(refused.body.code).toBe(Err.UNPROCESSABLE.code)
    }
    expect(await redis.exists(session)).toBe(1)
    await call('admin', 'delete', '/cache/keys', { ns: 'nope' }).expect(404)
    await call('admin', 'delete', '/cache/keys', { key: 'nope:x' }).expect(404)
    // exactly one of ns / key
    await call('admin', 'delete', '/cache/keys').expect(400)
    await call('admin', 'delete', '/cache/keys', { ns: 'dict', key: bare('dict', 'x') }).expect(400)
    // browsing is not clearing
    const denied = await call('reader', 'delete', '/cache/keys', { ns: 'dict' }).expect(403)
    expect(denied.body.code).toBe(Err.FORBIDDEN.code)
    await call('reader', 'delete', '/cache/all-registered').expect(403)
    expect(await redis.exists(idem)).toBe(1)
  })

  it('cache: the dict / param versions are listed read-only and survive every clear, which bumps them', async () => {
    const code = `${PREFIX}ver-${process.pid}`
    const param = `${PREFIX}ver-${process.pid}`
    const cached = [redisKey('dict', 'entries', code), redisKey('param', param)]
    const versions = () => redis.mGet([redisKey('dictVer', code), redisKey('paramVer', param)])
    const cache = () =>
      redis.mSet([
        [cached[0]!, '{"version":7,"entries":[]}'],
        [cached[1]!, '{"value":"v","isPublic":false}'],
      ])
    await redis.mSet([
      [redisKey('dictVer', code), '7'],
      [redisKey('paramVer', param), '7'],
    ])
    await cache()
    const listed = (await call('reader', 'get', '/cache/keys', { ns: 'dictVer' }).expect(200)).body
      .data.keys
    expect(listed).toContain(bare('dictVer', code))
    const dictKeys = (await call('reader', 'get', '/cache/keys', { ns: 'dict' }).expect(200)).body
      .data.keys
    expect(dictKeys).toContain(bare('dict', 'entries', code))
    expect(dictKeys).not.toContain(bare('dictVer', code))
    for (const query of [
      { ns: 'dictVer' },
      { ns: 'paramVer' },
      { key: bare('dictVer', code) },
      { key: bare('paramVer', param) },
    ])
      await call('admin', 'delete', '/cache/keys', query).expect(422)
    // one key, its namespace, all: each drops the value and bumps its version, never resets it
    const byKey = await call('admin', 'delete', '/cache/keys', {
      key: bare('dict', 'entries', code),
    }).expect(200)
    expect(byKey.body.data).toEqual({ deleted: 1 })
    await call('admin', 'delete', '/cache/keys', { key: bare('param', param) }).expect(200)
    expect(await versions()).toEqual(['8', '8'])
    await cache()
    await call('admin', 'delete', '/cache/keys', { ns: 'dict' }).expect(200)
    await call('admin', 'delete', '/cache/keys', { ns: 'param' }).expect(200)
    expect(await versions()).toEqual(['9', '9'])
    await cache()
    await call('admin', 'delete', '/cache/all-registered').expect(200)
    expect(await versions()).toEqual(['10', '10'])
    expect(await redis.exists(cached)).toBe(0)
  })

  it('cache: a clear racing a dict fill (namespace) or a param fill (key) leaves no stale value cached', async () => {
    const code = `${PREFIX}race-${process.pid}`
    await ds.query('INSERT INTO cfg_dict (code, name) VALUES (?, ?)', [code, code])
    await ds.query('INSERT INTO cfg_dict_entry (dict_code, value, label) VALUES (?, ?, ?)', [
      code,
      'a',
      'old',
    ])
    // never invalidated yet: no version key, the state a clear used to leave behind too
    const dictGate = gateLoad('FROM cfg_dict_entry', code)
    try {
      const racing = app.get(DictService).entries(code)
      await dictGate.atGate
      // changed behind the API, then the cache cleared (what the monitor is for)
      await ds.query('UPDATE cfg_dict_entry SET label = ? WHERE dict_code = ?', ['new', code])
      await call('admin', 'delete', '/cache/keys', { ns: 'dict' }).expect(200)
      dictGate.release()
      expect((await racing)?.entries.map((e) => e.label)).toEqual(['new'])
    } finally {
      dictGate.restore()
    }
    expect(await redis.get(redisKey('dict', 'entries', code))).toBeNull()
    expect((await app.get(DictService).entries(code))?.entries.map((e) => e.label)).toEqual(['new'])

    const key = `${PREFIX}race-${process.pid}`
    await ds.query('INSERT INTO cfg_param (param_key, param_value, name) VALUES (?, ?, ?)', [
      key,
      'old',
      key,
    ])
    const paramGate = gateLoad('FROM cfg_param', key)
    try {
      const racing = app.get(ParamService).get(key)
      await paramGate.atGate
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['new', key])
      await call('admin', 'delete', '/cache/keys', { key: bare('param', key) }).expect(200)
      paramGate.release()
      expect(await racing).toBe('new')
    } finally {
      paramGate.restore()
    }
    expect(await redis.get(redisKey('param', key))).toBeNull()
    expect(await app.get(ParamService).get(key)).toBe('new')
  })

  it('cache: all-registered clears every clearable namespace and nothing else', async () => {
    const clearable = (Object.keys(CACHE_NAMESPACES) as CacheNamespaceName[]).filter(
      (n) => CACHE_NAMESPACES[n].clearable,
    )
    for (const n of clearable) await redis.set(redisKey(n, `${PREFIX}all`), '1')
    const session = redisKey('authSession', `${PREFIX}all`)
    const lock = redisKey('lock', `${PREFIX}all`)
    await redis.mSet([
      [session, '{}'],
      [lock, '1'],
    ])
    const trace = `${PREFIX}${process.pid}-clear-all`
    const res = await call('admin', 'delete', '/cache/all-registered')
      .set('X-Request-Id', trace)
      .expect(200)
    expect(res.body.data.deleted).toBeGreaterThanOrEqual(clearable.length)
    expect(await redis.exists(clearable.map((n) => redisKey(n, `${PREFIX}all`)))).toBe(0)
    expect(await redis.exists([session, lock])).toBe(2)
    expect(await logOf(ds, trace)).toMatchObject({ domain: 'monitor.cache', verb: 'clean', ok: 1 })
    // the admin's own session survived (auth namespaces are not clearable)
    await call('admin', 'get', '/cache/namespaces').expect(200)
  })
})

describe('mysql', () => {
  it('mysql: the whitelisted status and variables with the pool; 403 without the perm', async () => {
    const vo = monitorMysqlVo.parse((await call('reader', 'get', '/mysql').expect(200)).body.data)
    expect(Object.keys(vo.status).sort()).toEqual([...MYSQL_STATUS_KEYS].sort())
    expect(vo.status.Uptime).toBeGreaterThan(0)
    expect(vo.status.Threads_connected).toBeGreaterThanOrEqual(1)
    expect(Object.keys(vo.variables).sort()).toEqual([...MYSQL_VARIABLE_KEYS].sort())
    expect(vo.variables.version).toMatch(/^\d+\.\d+/)
    expect(Number(vo.variables.max_connections)).toBeGreaterThan(0)
    expect(vo.pool).not.toBeNull()
    expect(vo.pool!.limit).toBeGreaterThanOrEqual(1)
    expect(vo.pool!.total).toBeGreaterThanOrEqual(1)
    expect(vo.pool!.idle).toBeLessThanOrEqual(vo.pool!.total)
    const denied = await call('stranger', 'get', '/mysql').expect(403)
    expect(denied.body.code).toBe(Err.FORBIDDEN.code)
  })

  it('mysql: Swagger documents every monitor route', async () => {
    const doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200)).body
    expect(
      Object.keys(doc.paths)
        .filter((p) => p.startsWith(URL))
        .sort(),
    ).toEqual(
      [
        '/server',
        '/redis',
        '/mysql',
        '/cache/namespaces',
        '/cache/keys',
        '/cache/value',
        '/cache/all-registered',
      ]
        .map((p) => `${URL}${p}`)
        .sort(),
    )
  })
})
