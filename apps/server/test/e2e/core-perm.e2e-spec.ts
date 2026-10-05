// Auth and permission guards (see docs/design-notes.md#auth-sessions, #permissions): the global AuthGuard (@Public, console-only sessions except
// on @OAuthScope routes, password-change gate, permVer reload) and PermGuard (@RequirePerm any/all,
// `*`, @RequireRole, callers without a user → 403), with iam's UserLookup over the real tables.
import { Controller, Get, HttpCode, Post } from '@nestjs/common'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { OAuthScope, Public, RequirePerm, RequireRole } from '../../src/core/auth/decorators.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import {
  type SessionFlags,
  type SessionUser,
  TokenService,
} from '../../src/core/auth/token.service.js'
import { clsGet } from '../../src/core/context/cls.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { findId, insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'

const BROWSE = 'test.probe.browse'
const VIEW = 'test.probe.view'
const REMOVE = 'test.probe.remove'

@Controller('perm-probe')
class PermProbeController {
  @Public()
  @Get('public')
  open() {
    return { principal: clsGet('principal') ?? null }
  }

  @Get('me')
  me() {
    return { principal: clsGet('principal'), checkedPerm: clsGet('checkedPerm') ?? null }
  }

  @RequirePerm(BROWSE, VIEW)
  @Get('any')
  any() {
    return clsGet('checkedPerm')
  }

  @RequirePerm.all(BROWSE, REMOVE)
  @Get('all')
  all() {
    return clsGet('checkedPerm')
  }

  @RequireRole('probe-auditor')
  @Get('role')
  role() {
    return 'ok'
  }

  @RequireRole('root')
  @Get('root')
  rootOnly() {
    return 'ok'
  }

  @OAuthScope('user.read')
  @Get('oauth')
  oauth() {
    return { userId: clsGet('principal')?.userId ?? null }
  }

  @OAuthScope('user.read')
  @RequirePerm(BROWSE)
  @Get('oauth-perm')
  oauthPerm() {
    return 'ok'
  }

  @Post('write')
  @HttpCode(200)
  write() {
    return 'ok'
  }
}

let app: NestExpressApplication
let ds: DataSource
let redis: Redis
let tokens: TokenService
let permVersion: PermVersion
const id: Record<string, number> = {}

const http = () => request(app.getHttpServer())
const get = (path: string, token?: string) => {
  const req = http().get(`/api/perm-probe/${path}`)
  return token ? req.set(bearer(token)) : req
}
const tokenOf = async (username: string, flags?: SessionFlags) =>
  (await signIn(app, username, { flags })).accessToken

async function menu(perm: string) {
  return insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'action',
    name: `test.menu.${perm}`,
    perms: perm,
  })
}

async function role(code: string, menuIds: number[]) {
  const roleId = await insertRow(ds.manager, 'iam_role', {
    code,
    name: code,
    data_scope: 'own_dept',
  })
  for (const menuId of menuIds)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [roleId, menuId])
  return roleId
}

async function user(username: string, roleIds: number[], extra: Record<string, unknown> = {}) {
  const userId = await insertRow(ds.manager, 'iam_user', {
    username,
    display_name: username,
    password_hash: 'not-used-by-these-specs',
    password_changed_at: new Date(),
    ...extra,
  })
  for (const roleId of roleIds)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [userId, roleId])
  return userId
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: [PermProbeController],
  }).compile()
  app = setupApp(moduleRef.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  ds = app.get<DataSource>(getDataSourceToken())
  redis = app.get(REDIS)
  tokens = app.get(TokenService)
  permVersion = app.get(PermVersion)
  await cleanRedis(redis)

  id.mBrowse = await menu(BROWSE)
  id.mView = await menu(VIEW)
  id.mRemove = await menu(REMOVE)
  id.browser = await role('probe-browser', [id.mBrowse])
  id.remover = await role('probe-remover', [id.mRemove])
  id.auditor = await role('probe-auditor', [])
  id.temp = await role('probe-temp', [id.mView])
  // menu rows whose perms are not a <domain>.<resource>.<verb> code must grant nothing
  id.mWild = await menu('*')
  id.mBad = await menu('test:probe:remove')
  id.wild = await role('probe-wild', [id.mWild, id.mBad, id.mBrowse])
  // an action whose own row is enabled, under a group that the spec disables
  id.mGroup = await insertRow(ds.manager, 'iam_menu', {
    parent_id: 0,
    kind: 'group',
    name: 'test.menu.group',
  })
  id.mNested = await insertRow(ds.manager, 'iam_menu', {
    parent_id: id.mGroup,
    kind: 'action',
    name: 'test.menu.nested',
    perms: VIEW,
  })
  id.nested = await role('probe-nested', [id.mNested])
  const rd = await findId(ds.manager, 'iam_dept', { name: 'seed.dept.rd' })
  id.uBrowser = await user('perm-e2e-browser', [id.browser])
  id.uBoth = await user('perm-e2e-both', [id.browser, id.remover], {
    dept_id: rd,
    locale: 'en-US',
  })
  id.uAuditor = await user('perm-e2e-auditor', [id.auditor])
  id.uNone = await user('perm-e2e-none', [])
  id.uTemp = await user('perm-e2e-temp', [])
  id.uWild = await user('perm-e2e-wild', [id.wild])
  id.uNested = await user('perm-e2e-nested', [id.nested])
})

afterAll(async () => {
  if (ds) {
    const users = [id.uBrowser, id.uBoth, id.uAuditor, id.uNone, id.uTemp, id.uWild, id.uNested]
    const roles = [id.browser, id.remover, id.auditor, id.temp, id.wild, id.nested]
    await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
    await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roles])
    await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
    await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [
      [id.mBrowse, id.mView, id.mRemove, id.mWild, id.mBad, id.mNested, id.mGroup],
    ])
  }
  if (redis) await cleanRedis(redis)
  await app?.close()
})

describe('AuthGuard', () => {
  it('no token, a garbage token, a refresh token or another scheme → 401', async () => {
    const t = await signIn(app, 'perm-e2e-none')
    const attempts = [
      get('me'),
      get('me', 'garbage'),
      get('me', t.refreshToken),
      get('me').set('Authorization', `Basic ${t.accessToken}`),
    ]
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(401)
      expect(res.body.code).toBe(Err.UNAUTHENTICATED.code)
    }
    await get('me', t.accessToken).expect(200)
  })

  it('@Public routes and health need no session (and see no principal)', async () => {
    expect((await get('public').expect(200)).body.data).toEqual({ principal: null })
    await http().get('/api/health').expect(200)
  })

  it('a console session → the CLS principal (sid, roles, perms, dept, locale)', async () => {
    const t = await signIn(app, 'perm-e2e-both')
    const { principal, checkedPerm } = (await get('me', t.accessToken).expect(200)).body.data
    expect(checkedPerm).toBeNull()
    expect(principal).toMatchObject({
      userId: id.uBoth,
      sid: t.session.sid,
      deptId: expect.any(Number),
      deptTreePath: expect.stringMatching(/^\/\d+\/\d+\/$/),
      locale: 'en-US',
      roles: [
        { code: 'probe-browser', dataScope: 'own_dept', perms: [BROWSE] },
        { code: 'probe-remover', dataScope: 'own_dept', perms: [REMOVE] },
      ],
    })
    expect(principal.perms.sort()).toEqual([BROWSE, REMOVE])
  })

  it('other clients: 401 outside @OAuthScope, 403 without the scope, 200 with it', async () => {
    const u = (await permVersion.load(id.uBrowser))!
    const opts = { keepSignedIn: false, ip: '127.0.0.1', ua: 'probe', clientId: 'probe-app' }
    const scoped = await tokens.issue(u, { ...opts, scopes: ['user.read'] })
    expect((await get('me', scoped.accessToken)).status).toBe(401)
    expect((await get('oauth', scoped.accessToken).expect(200)).body.data).toEqual({
      userId: id.uBrowser,
    })
    const unscoped = await tokens.issue(u, { ...opts, scopes: [] })
    expect((await get('oauth', unscoped.accessToken)).status).toBe(403)
    // console sessions pass @OAuthScope routes like any other
    await get('oauth', await tokenOf('perm-e2e-browser')).expect(200)
  })

  it.each([
    ['mustChangePassword', { mustChangePassword: true, passwordExpired: false }],
    ['passwordExpired', { mustChangePassword: false, passwordExpired: true }],
  ])('%s: 403 password_change_required except the allowlisted routes', async (_, flags) => {
    const token = await tokenOf('perm-e2e-browser', flags)
    for (const res of [
      await get('me', token),
      await http().post('/api/perm-probe/write').set(bearer(token)),
    ]) {
      expect(res.status).toBe(403)
      expect(res.body.code).toBe(Err.AUTH_PASSWORD_CHANGE_REQUIRED.code)
    }
    await http().get('/api/auth/me').set(bearer(token)).expect(200)
    await http().get('/api/auth/menus').set(bearer(token)).expect(200)
  })

  it('permVer: grants and revocations reach a live session without signing in again', async () => {
    const token = await tokenOf('perm-e2e-temp')
    const any = async () => {
      const res = await get('any', token)
      return res.status === 200 ? res.body.data.perms[0] : res.status
    }
    expect(await any()).toBe(403)

    // a role assigned to the user: applies once the user's version moves (bumpUser)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id) VALUES (?, ?)', [
      id.uTemp,
      id.temp,
    ])
    expect(await any()).toBe(403)
    await permVersion.bumpUser(id.uTemp)
    expect(await any()).toBe(VIEW)

    // the role loses its menu: bumpUsersOfRole
    await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [id.temp])
    expect(await any()).toBe(VIEW)
    await permVersion.bumpUsersOfRole(id.temp)
    expect(await any()).toBe(403)

    // granted again, then the menu disabled: bumpAll reaches every session
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id) VALUES (?, ?)', [
      id.temp,
      id.mView,
    ])
    await permVersion.bumpAll()
    expect(await any()).toBe(VIEW)
    await ds.query('UPDATE iam_menu SET enabled = 0 WHERE id = ?', [id.mView])
    await permVersion.bumpAll()
    expect(await any()).toBe(403)
    await ds.query('UPDATE iam_menu SET enabled = 1 WHERE id = ?', [id.mView])

    // a disabled role no longer counts
    await permVersion.bumpAll()
    expect(await any()).toBe(VIEW)
    await ds.query('UPDATE iam_role SET enabled = 0 WHERE id = ?', [id.temp])
    await permVersion.bumpUsersOfRole(id.temp)
    expect(await any()).toBe(403)
    await ds.query('UPDATE iam_role SET enabled = 1 WHERE id = ?', [id.temp])
  })

  it('X-Perm-Ver: every signed-in response carries the version it ran under, 403s too; it moves with a bump', async () => {
    const token = await tokenOf('perm-e2e-browser')
    const version = async (path: string, status: number) => {
      const res = await get(path, token).expect(status)
      return res.headers['x-perm-ver']
    }
    const first = await version('me', 200)
    expect(first).toBe(await permVersion.current(id.uBrowser))
    expect(await version('root', 403)).toBe(first)
    await permVersion.bumpUser(id.uBrowser)
    const user = await version('me', 200)
    expect(user).not.toBe(first)
    await permVersion.bumpAll()
    expect(await version('root', 403)).not.toBe(user)
    expect((await get('public').expect(200)).headers['x-perm-ver']).toBeUndefined()
  })

  it('a menu under a disabled ancestor grants no perm (the /menus rule), after the permVer reload', async () => {
    const token = await tokenOf('perm-e2e-nested')
    const any = async () => (await get('any', token)).status
    expect(await any()).toBe(200)
    await ds.query('UPDATE iam_menu SET enabled = 0 WHERE id = ?', [id.mGroup])
    try {
      await permVersion.bumpAll()
      expect(await any()).toBe(403)
      expect((await http().get('/api/auth/menus').set(bearer(token))).body.data).toEqual([])
    } finally {
      await ds.query('UPDATE iam_menu SET enabled = 1 WHERE id = ?', [id.mGroup])
    }
    await permVersion.bumpAll()
    expect(await any()).toBe(200)
  })

  it('a user disabled after sign-in: the reload ends the session (401, revoked)', async () => {
    const t = await signIn(app, 'perm-e2e-temp')
    await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ?', [id.uTemp])
    try {
      await permVersion.bumpUser(id.uTemp)
      expect((await get('me', t.accessToken)).status).toBe(401)
      expect(await tokens.load(t.session.sid)).toBeNull()
    } finally {
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ?', [id.uTemp])
    }
  })
})

describe('PermGuard', () => {
  it('any of the perms by default; the held ones become checkedPerm', async () => {
    const res = await get('any', await tokenOf('perm-e2e-none'))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(Err.FORBIDDEN.code)
    expect((await get('any', await tokenOf('perm-e2e-browser')).expect(200)).body.data).toEqual({
      perms: [BROWSE],
      all: false,
    })
  })

  it('.all() needs every perm; checkedPerm carries all of them (data scope ANDs them)', async () => {
    expect((await get('all', await tokenOf('perm-e2e-browser'))).status).toBe(403)
    expect((await get('all', await tokenOf('perm-e2e-both')).expect(200)).body.data).toEqual({
      perms: [BROWSE, REMOVE],
      all: true,
    })
  })

  it('@RequireRole: any of the role codes', async () => {
    await get('role', await tokenOf('perm-e2e-auditor')).expect(200)
    expect((await get('role', await tokenOf('perm-e2e-browser'))).status).toBe(403)
  })

  it('root (`*`) passes every perm and role check', async () => {
    const token = await tokenOf('admin')
    expect((await get('any', token).expect(200)).body.data).toEqual({
      perms: [BROWSE, VIEW],
      all: false,
    })
    expect((await get('all', token).expect(200)).body.data).toEqual({
      perms: [BROWSE, REMOVE],
      all: true,
    })
    await get('role', token).expect(200)
    await get('root', token).expect(200)
    const { principal } = (await get('me', token).expect(200)).body.data
    expect(principal).toMatchObject({ root: true, perms: ['*'] })
  })

  it('a root session stored before the `root` flag existed is reloaded, not demoted', async () => {
    const t = await signIn(app, 'admin')
    const { root: _, ...previousShape } = t.session
    expect(await tokens.save(previousShape)).toBe(true)
    await get('root', t.accessToken).expect(200)
    expect((await tokens.load(t.session.sid))?.root).toBe(true)
  })

  it('a normal role granted a `*` or malformed menu gets neither `*` nor root', async () => {
    const token = await tokenOf('perm-e2e-wild')
    for (const path of ['all', 'role', 'root']) expect((await get(path, token)).status).toBe(403)
    const { principal } = (await get('me', token).expect(200)).body.data
    expect(principal).toMatchObject({
      root: false,
      perms: [BROWSE],
      roles: [{ code: 'probe-wild', perms: [BROWSE] }],
    })
    expect(
      (await http().get('/api/auth/me').set(bearer(token)).expect(200)).body.data.perms,
    ).toEqual([BROWSE])
    // root would see every enabled menu; this role was granted only actions
    expect((await http().get('/api/auth/menus').set(bearer(token)).expect(200)).body.data).toEqual(
      [],
    )
  })

  it('a token without a user (client_credentials) never passes PermGuard', async () => {
    const machine: SessionUser = {
      userId: null,
      userType: 'client',
      deptId: null,
      deptTreePath: null,
      roles: [],
      perms: ['*'],
      locale: null,
      permVer: '0.0',
    }
    const t = await tokens.issue(machine, {
      keepSignedIn: false,
      ip: '127.0.0.1',
      ua: 'probe',
      clientId: 'probe-app',
      scopes: ['user.read'],
    })
    expect((await get('oauth', t.accessToken).expect(200)).body.data).toEqual({ userId: null })
    expect((await get('oauth-perm', t.accessToken)).status).toBe(403)
  })
})
