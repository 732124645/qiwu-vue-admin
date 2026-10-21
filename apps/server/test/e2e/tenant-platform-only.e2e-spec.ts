// Platform pages and the multi-tenancy switch (see docs/design-notes.md#tenancy), with two apps on one
// database: `on` (APP_MULTI_TENANT=true) and `off` (APP_MULTI_TENANT=false, SWAGGER_ENABLED=false).
// Three checks keep a platform page away from the other tenants: `platform_only` follows the ancestors
// (menu writes too), their sessions lose every perm of a platform menu, and `@PlatformOnly()` sits on
// exactly the routes behind such a perm (all walked). The API logs hold every tenant's rows: a caller
// other than root sees only the default tenant's and the anonymous ones, whatever the switch. The tenant
// and package pages leave the menus and the grant tree while the switch is off (only that switch: the API
// docs page stays grantable), and a grant of a hidden page survives editing the role. `@TenancyOn()`
// routes are no routes (404) while it is off. A session that entered another tenant works on its data
// except on the routes that run in the user's own tenant (`@HomeTenant()`, `@PlatformOnly()`);
// `@RequireFeature` routes follow the session's feature set; `/me` names the session's tenant and
// features while the switch is on.
import { Controller, Get, RequestMethod, type Type } from '@nestjs/common'
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants'
import { DiscoveryService, MetadataScanner, ModulesContainer, Reflector } from '@nestjs/core'
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ApiExcludeController } from '@nestjs/swagger'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  dictPerms,
  Err,
  httpFaultPerms,
  httpTracePerms,
  type MenuNode,
  type MePayload,
  monitorPerms,
  PROJECT_BUILTIN_DOMAINS,
  RESERVED_NAME_LISTS,
  type RoleMenuNode,
  ROOT_ONLY_ROUTES,
  userPerms,
} from '@qiwu/shared'
import ExcelJS from 'exceljs'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import {
  IS_PUBLIC,
  type PermRequirement,
  Public,
  REQUIRE_PERM,
  REQUIRE_ROLE,
  RequirePerm,
} from '../../src/core/auth/decorators.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import {
  PLATFORM_ONLY,
  PlatformOnly,
  PlatformOnlyGuard,
  type PlatformOnlyWho,
} from '../../src/core/auth/platform-only.js'
import {
  HOME_TENANT,
  HomeTenant,
  REQUIRE_FEATURE,
  RequireFeature,
} from '../../src/core/auth/tenant-scope.js'
import type { Session } from '../../src/core/auth/token.service.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { clsGet } from '../../src/core/context/cls.js'
import { tenantId } from '../../src/core/context/tenant.js'
import { TenancyOn } from '../../src/core/guard/tenancy-on.guard.js'
import { redisKey } from '../../src/core/redis/cache-namespaces.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { DictController } from '../../src/modules/platform/settings/dict/dict.controller.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import {
  addUser,
  bootApp,
  createTenant,
  type PeopledTenant,
  signInDirect,
} from '../setup/tenants.js'

const PREFIX = 'tpo-'
/** The tenant pages (seeded whatever the switch says). */
const TENANT_PAGES = ['iam-tenant', 'iam-tenant-package'] as const
/**
 * Routes behind `@PlatformOnly()` without a platform perm: leaving an entered tenant (inside it a platform
 * user holds no platform perm, so no perm can be asked for). Once registered, none carries `@RequirePerm`.
 */
const PERMLESS_PLATFORM_ROUTES = new Set(['POST /api/iam/tenants/leave'])

/** The request's data tenant and actor tenant, as AuthGuard left them. */
const tenants = () => ({ tenant: tenantId(), actor: clsGet('actorTenantId') })

@Controller('tenancy-fixture')
@ApiExcludeController()
class TenancyFixtureController {
  @Get('public')
  @Public()
  @TenancyOn()
  open() {
    return 'on'
  }

  @Get('signed-in')
  @TenancyOn()
  signedIn() {
    return 'on'
  }

  @Get('data')
  data() {
    return tenants()
  }

  @Get('home')
  @HomeTenant()
  home() {
    return tenants()
  }

  @Get('platform')
  @RequirePerm(dictPerms.browse)
  @PlatformOnly()
  platform() {
    return tenants()
  }

  @Get('feature')
  @RequireFeature('workflow')
  feature() {
    return 'on'
  }
}

/** `METHOD /api/<controller path>/<route path>` of a handler. */
function routeOf(controller: Type, handler: object): string {
  const part = (target: object) => String(Reflect.getMetadata(PATH_METADATA, target) ?? '')
  const path = ['api', part(controller), part(handler)]
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
  return `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod]} /${path}`
}

let on: NestExpressApplication
let off: NestExpressApplication
let ds: DataSource
let redis: Redis
let B: PeopledTenant
let root: string
let auditor: number
let auditorRole: number
let granterRole: number
/** menus this spec added (fixture pages, pages made through the API): hard-deleted in afterAll */
const menus: number[] = []
const trace = `${PREFIX}${Date.now()}`

const http = (app: NestExpressApplication) => request(app.getHttpServer())
const tokenOf = async (userId: number) => (await signInDirect(on, userId))!.accessToken
const idOf = async (where: string, params: unknown[]) =>
  Number(
    (await ds.query(`SELECT id FROM iam_menu WHERE ${where} AND deleted_at IS NULL`, params))[0].id,
  )
const pageId = (route: string) => idOf('route_name = ?', [route])
/** Grants role `roleId` (of tenant `tenantId`) the action menus carrying `perms`. */
const grant = (roleId: number, perms: string[], tenantId = 1) =>
  ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, ? FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, tenantId, perms],
  )
const role = async (code: string) =>
  Number(
    (
      await ds.query<{ insertId: number }>(
        "INSERT INTO iam_role (code, name, data_scope, tenant_id) VALUES (?, ?, 'all', 1)",
        [PREFIX + code, PREFIX + code],
      )
    ).insertId,
  )
/** The perms of the menus with (1) or without (0) `platform_only`. */
const flaggedPerms = async (flag: 0 | 1) =>
  new Set(
    (
      await ds.query<{ perms: string }[]>(
        `SELECT DISTINCT perms FROM iam_menu
          WHERE platform_only = ? AND deleted_at IS NULL AND perms IS NOT NULL AND perms <> ''`,
        [flag],
      )
    ).map((r) => r.perms),
  )
const flagOf = async (id: number) =>
  Number((await ds.query('SELECT platform_only FROM iam_menu WHERE id = ?', [id]))[0].platform_only)
/** Every id of a forest. */
const ids = (nodes: { id: number; children: { id: number }[] }[]): number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children as typeof nodes)])

beforeAll(async () => {
  on = await bootApp({ multiTenant: true, controllers: [TenancyFixtureController] })
  off = await bootApp({
    multiTenant: false,
    env: { SWAGGER_ENABLED: 'false' },
    controllers: [TenancyFixtureController],
  })
  ds = on.get<DataSource>(getDataSourceToken())
  redis = on.get(REDIS)
  await cleanRedis(redis)
  B = await createTenant(on, { users: true })
  auditorRole = await role('auditor')
  await grant(auditorRole, [
    ...Object.values(httpTracePerms),
    ...Object.values(httpFaultPerms),
    monitorPerms.cache,
    monitorPerms.queue,
    dictPerms.browse,
  ])
  auditor = await addUser(on, 1, `${PREFIX}auditor`, { roleId: auditorRole })
  granterRole = await role('granter')
  root = (await signIn(on)).accessToken
})

afterAll(async () => {
  if (ds) {
    await B?.dispose()
    const roles = [auditorRole, granterRole].filter(Boolean)
    if (roles.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roles])
      await ds.query('DELETE FROM iam_user_roles WHERE role_id IN (?)', [roles])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roles])
    }
    if (auditor) await ds.query('DELETE FROM iam_user WHERE id = ?', [auditor])
    if (menus.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [menus])
      await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [menus])
    }
    await ds.query('DELETE FROM aud_http_trace WHERE trace_id = ?', [trace])
    await ds.query('DELETE FROM aud_http_fault WHERE trace_id = ?', [trace])
  }
  if (redis) await cleanRedis(redis)
  await on?.close()
  await off?.close()
})

describe('@PlatformOnly() on the routes', () => {
  it('sits on exactly the routes behind a platform perm (root only on the logs, the cache and queue monitors); platform and tenant perms never meet', async () => {
    const platform = await flaggedPerms(1)
    const tenant = await flaggedPerms(0)
    expect(platform.size).toBeGreaterThan(0)
    expect([...platform].filter((p) => tenant.has(p))).toEqual([])
    const reflector = on.get(Reflector)
    const scanner = new MetadataScanner()
    const marked = new Map<string, PlatformOnlyWho>()
    const wrong: string[] = []
    for (const { metatype } of new DiscoveryService(on.get(ModulesContainer)).getControllers()) {
      if (!metatype) continue
      const proto = (metatype as Type).prototype
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name]
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue
        const targets = [handler, metatype]
        const need = reflector.getAllAndOverride<PermRequirement | undefined>(REQUIRE_PERM, targets)
        const who = reflector.getAllAndOverride<PlatformOnlyWho | undefined>(PLATFORM_ONLY, targets)
        const key = `${metatype.name}.${name}`
        const ofPlatform = need?.perms.filter((p) => platform.has(p)) ?? []
        if (who) marked.set(key, who)
        if (PERMLESS_PLATFORM_ROUTES.has(routeOf(metatype as Type, handler))) {
          if (need) wrong.push(`${key}: perms ${need.perms.join(',')} on a route that takes none`)
          if (!who) wrong.push(`${key}: @PlatformOnly missing`)
        } else if (ofPlatform.length > 0 !== (who !== undefined))
          wrong.push(
            `${key}: perms ${need?.perms.join(',') ?? 'none'}, @PlatformOnly ${who ?? 'none'}`,
          )
        else if (ofPlatform.length && ofPlatform.length !== need!.perms.length)
          wrong.push(`${key}: platform and tenant perms together (${need!.perms.join(',')})`)
      }
    }
    expect(wrong).toEqual([])
    expect(marked.get('DictController.page')).toBe('platform')
    expect(marked.has('DictController.options')).toBe(false)
    expect(marked.get('MonitorController.server')).toBe('platform')
    // exactly the API logs, the cache and queue monitors and the agent settings are root only, every other
    // marked route 'platform'
    const rootOnly = [...marked].filter(([, who]) => who === 'root').map(([key]) => key)
    expect(rootOnly.sort()).toEqual(
      [
        'HttpTraceController.page',
        'HttpTraceController.export',
        'HttpTraceController.get',
        'HttpFaultController.page',
        'HttpFaultController.export',
        'HttpFaultController.get',
        'HttpFaultController.handle',
        'MonitorController.namespaces',
        'MonitorController.keys',
        'MonitorController.value',
        'MonitorController.clear',
        'MonitorController.clearAll',
        'QueueMonitorController.list',
        'QueueMonitorController.jobs',
        'QueueMonitorController.retry',
        'QueueMonitorController.remove',
        // the agent's settings: models, web search, external MCP servers, tool policies, platform skills
        'AgentMcpServerController.create',
        'AgentMcpServerController.remove',
        'AgentMcpServerController.sync',
        'AgentMcpServerController.update',
        'AgentMcpServerController.updateTool',
        'AgentPlatformSkillController.create',
        'AgentPlatformSkillController.import',
        'AgentPlatformSkillController.remove',
        'AgentPlatformSkillController.update',
        'AgentProviderController.create',
        'AgentProviderController.remove',
        'AgentProviderController.update',
        'AgentSearchProviderController.create',
        'AgentSearchProviderController.remove',
        'AgentSearchProviderController.update',
        'AgentToolPolicyController.set',
      ].sort(),
    )
    expect([...marked.values()].filter((who) => who !== 'root' && who !== 'platform')).toEqual([])
    for (const key of ['UserController.page', 'SessionController.page', 'ActionLogController.page'])
      expect(marked.has(key)).toBe(false)
  })

  it('with multi-tenancy off every caller passes it (all are in the default tenant)', async () => {
    const handler = DictController.prototype.page
    const ctx = new ExecutionContextHost([{}], DictController, handler)
    const cls = off.get(ClsService)
    const as = (tenantId: number, app: NestExpressApplication) =>
      cls.run(() => {
        cls.set('principal', {
          userId: 1,
          deptId: null,
          deptTreePath: null,
          roles: [],
          perms: [],
          tenantId,
        })
        return new PlatformOnlyGuard(app.get(Reflector), app.get(AppConfigService)).canActivate(ctx)
      })
    expect(as(B.id, off)).toBe(true)
    expect(() => as(B.id, on)).toThrow()
    expect(as(1, on)).toBe(true)
  })
})

describe('platform_only follows the menus', () => {
  it('a menu added or moved below a platform page is platform-only at once, with its subtree; one moved out is not', async () => {
    const menu = (body: object) =>
      http(on).post('/api/iam/menus').set(bearer(root)).send(body).expect(201)
    const system = await pageId('system')
    const dicts = await pageId('settings-dict')
    const tag = `${PREFIX}${Date.now()}`
    const page = (
      await menu({
        kind: 'page',
        name: `${tag} page`,
        routePath: `/${tag}`,
        routeName: `${tag}-page`,
        component: 'home/index',
        parentId: dicts,
      })
    ).body.data.id
    menus.push(page)
    const act = (
      await menu({ kind: 'action', name: `${tag} act`, perms: `tpo.menu.run`, parentId: page })
    ).body.data.id
    menus.push(act)
    expect([await flagOf(page), await flagOf(act)]).toEqual([1, 1])
    const free = (
      await menu({
        kind: 'page',
        name: `${tag} free`,
        routePath: `/${tag}-free`,
        routeName: `${tag}-free`,
        component: 'home/index',
        parentId: system,
      })
    ).body.data.id
    menus.push(free)
    expect(await flagOf(free)).toBe(0)
    const move = (id: number, parentId: number) =>
      http(on).put(`/api/iam/menus/${id}`).set(bearer(root)).send({ parentId }).expect(200)
    await move(page, system)
    expect([await flagOf(page), await flagOf(act)]).toEqual([0, 0])
    await move(free, dicts)
    expect(await flagOf(free)).toBe(1)
  })
})

describe('the sessions of another tenant', () => {
  it('lose every perm a platform menu carries, whatever their roles were given; the default tenant keeps them', async () => {
    await grant(B.roleId, [dictPerms.browse, userPerms.browse], B.id)
    const b = (await signInDirect(on, B.users.alice))!
    const stored = JSON.parse((await redis.get(redisKey('authSession', b.session.sid)))!) as Session
    expect(stored.tenantId).toBe(B.id)
    expect(stored.perms).toEqual([userPerms.browse])
    expect(stored.roles.map((r) => r.perms)).toEqual([[userPerms.browse]])
    const a = (await signInDirect(on, auditor))!
    expect(a.session.tenantId).toBe(1)
    expect(a.session.perms).toContain(dictPerms.browse)
  })

  it('are refused by @PlatformOnly() (403) even holding a platform perm, while the switch is on', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    // a session that kept the perm (as if the load had not dropped it)
    const key = redisKey('authSession', b.session.sid)
    const session = JSON.parse((await redis.get(key))!) as Session
    session.perms = [...session.perms, dictPerms.browse]
    await redis.set(key, JSON.stringify(session), { KEEPTTL: true })
    const res = await http(on).get('/api/settings/dicts').set(bearer(b.accessToken))
    expect(res.status).toBe(403)
    expect(res.body.code).toBe(Err.FORBIDDEN.code)
    await http(on)
      .get('/api/settings/dicts')
      .set(bearer(await tokenOf(auditor)))
      .expect(200)
  })
})

describe('the API logs, the cache and queue monitors', () => {
  it('only root while the switch is on; anyone granted them while it is off', async () => {
    const reader = await tokenOf(auditor)
    const paths = [
      '/api/audit/http-traces',
      '/api/audit/http-faults',
      '/api/monitor/cache/namespaces',
      '/api/monitor/queues',
    ]
    for (const path of paths) {
      expect((await http(on).get(path).set(bearer(reader))).status).toBe(403)
      await http(on).get(path).set(bearer(root)).expect(200)
      await http(off).get(path).set(bearer(reader)).expect(200)
    }
  })

  it('show in the side menu of root only while the switch is on; off, of anyone granted them', async () => {
    const reader = await tokenOf(auditor)
    const routes = (nodes: MenuNode[]): string[] =>
      nodes.flatMap((n) => [...(n.routeName ? [n.routeName] : []), ...routes(n.children)])
    const sideMenu = async (app: NestExpressApplication, token: string) =>
      routes((await http(app).get('/api/auth/menus').set(bearer(token)).expect(200)).body.data)
    const pages = (names: string[]) => ROOT_ONLY_ROUTES.filter((r) => names.includes(r))
    const readerOn = await sideMenu(on, reader)
    expect(pages(readerOn)).toEqual([])
    // the rest of its grants stays
    expect(readerOn).toContain('settings-dict')
    expect(pages(await sideMenu(on, root))).toEqual(ROOT_ONLY_ROUTES)
    expect(pages(await sideMenu(off, reader))).toEqual(ROOT_ONLY_ROUTES)
  })

  describe("another tenant's rows (switch off)", () => {
    const row = async (table: 'aud_http_trace' | 'aud_http_fault', tenantId: number | null) => {
      const values =
        table === 'aud_http_trace'
          ? "(trace_id, method, url, status_code, biz_code, cost_ms, tenant_id) VALUES (?, 'GET', '/x', 200, '0', 1, ?)"
          : "(trace_id, method, url, error_name, tenant_id) VALUES (?, 'GET', '/x', 'Error', ?)"
      // table names are this spec's own constants
      const { insertId } = await ds.query<{ insertId: number }>(`INSERT INTO ${table} ${values}`, [
        trace,
        tenantId,
      ])
      return Number(insertId)
    }
    const rows = { trace: { b: 0, a: 0, none: 0 }, fault: { b: 0, a: 0, none: 0 } }
    beforeAll(async () => {
      for (const [kind, table] of [
        ['trace', 'aud_http_trace'],
        ['fault', 'aud_http_fault'],
      ] as const) {
        rows[kind].b = await row(table, B.id)
        rows[kind].a = await row(table, 1)
        rows[kind].none = await row(table, null)
      }
    })
    const URLS = { trace: '/api/audit/http-traces', fault: '/api/audit/http-faults' }
    const listed = async (token: string, kind: 'trace' | 'fault') =>
      (
        await http(off).get(URLS[kind]).query({ traceId: trace }).set(bearer(token)).expect(200)
      ).body.data.items
        .map((r: { id: number }) => r.id)
        .sort((x: number, y: number) => x - y)
    const exported = async (token: string, kind: 'trace' | 'fault') => {
      const res = await http(off)
        .get(`${URLS[kind]}/export`)
        .query({ traceId: trace })
        .set(bearer(token))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = []
          r.on('data', (c: Buffer) => chunks.push(c))
          r.on('end', () => cb(null, Buffer.concat(chunks)))
        })
        .expect(200)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(res.body as Parameters<typeof wb.xlsx.load>[0])
      // the header row aside
      return wb.worksheets[0]!.actualRowCount - 1
    }

    it.each(['trace', 'fault'] as const)(
      '%s: a caller other than root lists, exports and opens the default tenant’s and anonymous rows only; root all',
      async (kind) => {
        const reader = await tokenOf(auditor)
        const { a, b, none } = rows[kind]
        expect(await listed(reader, kind)).toEqual([a, none])
        expect(await exported(reader, kind)).toBe(2)
        await http(off).get(`${URLS[kind]}/${a}`).set(bearer(reader)).expect(200)
        expect((await http(off).get(`${URLS[kind]}/${b}`).set(bearer(reader))).status).toBe(404)
        expect(await listed(root, kind)).toEqual([b, a, none].sort((x, y) => x - y))
        expect(await exported(root, kind)).toBe(3)
        await http(off).get(`${URLS[kind]}/${b}`).set(bearer(root)).expect(200)
      },
    )

    it("fault: a caller other than root cannot handle another tenant's row (404, nothing stored); root can", async () => {
      const reader = await tokenOf(auditor)
      const state = async (id: number) =>
        (await ds.query('SELECT state FROM aud_http_fault WHERE id = ?', [id]))[0].state
      const handle = (token: string, id: number) =>
        http(off).put(`${URLS.fault}/${id}/state`).set(bearer(token)).send({ state: 'resolved' })
      expect((await handle(reader, rows.fault.b)).status).toBe(404)
      expect(await state(rows.fault.b)).toBe('open')
      await handle(reader, rows.fault.a).expect(200)
      expect(await state(rows.fault.a)).toBe('resolved')
      await handle(root, rows.fault.b).expect(200)
      expect(await state(rows.fault.b)).toBe('resolved')
    })
  })
})

describe('the tenant pages while the switch is off', () => {
  const tree = async (app: NestExpressApplication) =>
    ids(
      (await http(app).get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
        .data as RoleMenuNode[],
    )
  const sideMenu = async (app: NestExpressApplication) =>
    ids(
      (await http(app).get('/api/auth/menus').set(bearer(root)).expect(200)).body
        .data as MenuNode[],
    )
  const roleMenus = async (id: number) =>
    (
      await ds.query<{ menu_id: number }[]>(
        'SELECT menu_id FROM iam_role_menus WHERE role_id = ? AND deleted_at IS NULL ORDER BY menu_id',
        [id],
      )
    ).map((r) => Number(r.menu_id))
  const setMenus = (app: NestExpressApplication, menuIds: number[]) =>
    http(app)
      .put(`/api/iam/roles/${granterRole}/menus`)
      .set(bearer(root))
      .send({ menuLink: false, menuIds })

  it('leave the side menu and the grant tree (with what is under them); on, both have them', async () => {
    const pages = await Promise.all(TENANT_PAGES.map(pageId))
    const docs = await pageId('devtools-api-docs')
    const offTree = await tree(off)
    for (const id of pages) {
      expect(offTree).not.toContain(id)
      expect(await sideMenu(off)).not.toContain(id)
      expect(await tree(on)).toContain(id)
      expect(await sideMenu(on)).toContain(id)
    }
    // only that switch hides menus there: SWAGGER_ENABLED=false drops the docs page from the side menu only
    expect(await sideMenu(off)).not.toContain(docs)
    expect(offTree).toContain(docs)
    expect(offTree).toContain(await pageId('iam-user'))
  })

  it('editing a role keeps its grants of hidden pages; a hidden page cannot be granted (404)', async () => {
    const [tenantPage] = await Promise.all(TENANT_PAGES.map(pageId))
    const home = await pageId('home')
    const docs = await pageId('devtools-api-docs')
    await setMenus(on, [home, tenantPage!]).expect(200)
    expect(await roleMenus(granterRole)).toEqual([home, tenantPage!].sort((x, y) => x - y))
    await setMenus(off, [docs]).expect(200)
    expect(await roleMenus(granterRole)).toEqual([docs, tenantPage!].sort((x, y) => x - y))
    expect((await setMenus(off, [docs, tenantPage!])).status).toBe(404)
    expect(await roleMenus(granterRole)).toEqual([docs, tenantPage!].sort((x, y) => x - y))
    // what GET shows leaves the hidden page out and goes back as it is
    const shown = (
      await http(off).get(`/api/iam/roles/${granterRole}/menus`).set(bearer(root)).expect(200)
    ).body.data as { menuLink: boolean; menuIds: number[] }
    expect(shown.menuIds).toEqual([docs])
    await setMenus(off, shown.menuIds).expect(200)
    expect(await roleMenus(granterRole)).toEqual([docs, tenantPage!].sort((x, y) => x - y))
    // a grant left on a deleted menu is no hidden page: a save drops it
    const gone = await insertRow(ds.manager, 'iam_menu', {
      parent_id: home,
      kind: 'action',
      name: `${PREFIX}gone`,
      perms: 'tpo.gone.run',
    })
    menus.push(gone)
    await ds.query('UPDATE iam_menu SET deleted_at = NOW(3) WHERE id = ?', [gone])
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
      granterRole,
      gone,
    ])
    await setMenus(off, [docs]).expect(200)
    expect(await roleMenus(granterRole)).toEqual([docs, tenantPage!].sort((x, y) => x - y))
    await setMenus(on, [home]).expect(200)
    expect(await roleMenus(granterRole)).toEqual([home])
  })
})

describe('@TenancyOn()', () => {
  it('is no route while the switch is off (404, before any sign-in check); on, it answers', async () => {
    for (const path of ['/api/tenancy-fixture/public', '/api/tenancy-fixture/signed-in']) {
      const res = await http(off).get(path)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(Err.NOT_FOUND.code)
    }
    expect((await http(off).get('/api/tenancy-fixture/signed-in').set(bearer(root))).status).toBe(
      404,
    )
    await http(on).get('/api/tenancy-fixture/public').expect(200)
    expect((await http(on).get('/api/tenancy-fixture/signed-in')).status).toBe(401)
    await http(on).get('/api/tenancy-fixture/signed-in').set(bearer(root)).expect(200)
  })
})

/** Rewrites the stored session `sid` in place (as entering a tenant or a package would leave it). */
async function patchSession(sid: string, patch: (s: Session) => void): Promise<void> {
  const key = redisKey('authSession', sid)
  const session = JSON.parse((await redis.get(key))!) as Session
  patch(session)
  await redis.set(key, JSON.stringify(session), { KEEPTTL: true })
}

/**
 * The template's own API roots (platform, workflow, auth and friends): a project's domains (the samples'
 * `biz` and `demo` too) decide for their routes themselves.
 */
const TEMPLATE_ROOTS = new Set(
  [RESERVED_NAME_LISTS.domains, RESERVED_NAME_LISTS.apiRoots]
    .join(' ')
    .split(' ')
    .filter((name) => !PROJECT_BUILTIN_DOMAINS.includes(name)),
)
/**
 * The template's routes that need only a session and, on purpose, neither run in the user's own tenant nor
 * belong to a feature: they serve the data tenant's pages and forms (options, trees, files, import
 * reports) or read platform data every tenant shares; `userinfo` takes third-party sessions only.
 */
const OPEN_ROUTES = [
  'GET /api/excel/reports/:id',
  'GET /api/geo/areas/tree',
  'GET /api/iam/depts/tree',
  'GET /api/iam/positions/options',
  'GET /api/iam/roles/options',
  'GET /api/iam/users/options',
  'GET /api/messaging/mail-accounts/options',
  'GET /api/messaging/sms-channels/options',
  'GET /api/oauth2/userinfo',
  'GET /api/settings/dicts/:code/entries',
  'GET /api/settings/dicts/options',
  'GET /api/storage/objects/:id/download',
  'POST /api/storage/objects',
  'POST /api/storage/objects/confirm',
  'POST /api/storage/objects/presign',
]

describe('@HomeTenant() and @RequireFeature on the routes', () => {
  it('every template route needing only a session is personal (@HomeTenant()), of a feature (@RequireFeature) or listed open; the approval center is the workflow feature', () => {
    const reflector = on.get(Reflector)
    const scanner = new MetadataScanner()
    const home = new Set<string>()
    const feature = new Map<string, string>()
    const unsorted: string[] = []
    const open = new Set<string>()
    for (const { metatype } of new DiscoveryService(on.get(ModulesContainer)).getControllers()) {
      if (!metatype || metatype === TenancyFixtureController) continue
      const proto = (metatype as Type).prototype
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name]
        if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue
        const targets = [handler, metatype]
        const has = (key: string) => reflector.getAllAndOverride(key, targets) !== undefined
        const key = `${metatype.name}.${name}`
        if (reflector.getAllAndOverride<boolean>(HOME_TENANT, targets)) home.add(key)
        const group = reflector.getAllAndOverride<string | undefined>(REQUIRE_FEATURE, targets)
        if (group) feature.set(key, group)
        const route = routeOf(metatype as Type, handler)
        if (has(IS_PUBLIC) || has(REQUIRE_PERM) || has(REQUIRE_ROLE) || has(PLATFORM_ONLY)) continue
        if (!TEMPLATE_ROOTS.has(route.split('/')[2]!)) continue
        if (OPEN_ROUTES.includes(route)) open.add(route)
        else if (!home.has(key) && !group) unsorted.push(route)
      }
    }
    expect(unsorted).toEqual([])
    expect(OPEN_ROUTES.filter((r) => !open.has(r))).toEqual([])
    const personal = [
      'AuthController.me',
      'AuthController.menus',
      'AuthController.logout',
      'AuthController.verifyPassword',
      'ProfileController.get',
      'ProfileController.changePassword',
      'ProfileController.setPref',
      'ProfileSocialController.list',
      'MyInboxController.page',
      'BulletinFeedController.list',
      'WfCenterController.todo',
      'WfCenterController.done',
      'WfCenterController.mine',
      'WfCenterController.ccs',
      'WfTaskController.approve',
      'WfRoutingController.cancel',
      'ProviderController.decide',
    ]
    expect(personal.filter((key) => !home.has(key))).toEqual([])
    // an instance's detail serves the admin pages of the data tenant too
    expect(home.has('WfCenterController.detail')).toBe(false)
    const approvals = [
      'WfCenterController.todo',
      'WfCenterController.start',
      'WfCenterController.detail',
      'WfTaskController.approve',
      'WfRoutingController.cancel',
      'LeaveController.get',
    ]
    expect(approvals.filter((key) => feature.get(key) !== 'workflow')).toEqual([])
    expect([...new Set(feature.values())]).toEqual(['workflow'])
  })
})

describe('the data tenant of a session that entered another tenant', () => {
  it("is that tenant, except on the routes running in the user's own (@HomeTenant(), @PlatformOnly()); the actor stays the user's tenant", async () => {
    const s = await signIn(on)
    const token = bearer(s.accessToken)
    const tenants = async (path: string) =>
      (await http(on).get(`/api/tenancy-fixture/${path}`).set(token).expect(200)).body.data
    for (const path of ['data', 'home', 'platform'])
      expect(await tenants(path)).toEqual({ tenant: 1, actor: 1 })
    await patchSession(s.session.sid, (x) => {
      x.actingTenantId = B.id
      x.actingUntil = Date.now() + 3_600_000
    })
    expect(await tenants('data')).toEqual({ tenant: B.id, actor: 1 })
    expect(await tenants('home')).toEqual({ tenant: 1, actor: 1 })
    expect(await tenants('platform')).toEqual({ tenant: 1, actor: 1 })
    // the routes themselves: B's users on the user list; the root's own preference stays in its tenant
    const users = (
      await http(on).get('/api/iam/users').query({ pageSize: 200 }).set(token).expect(200)
    ).body.data.items.map((u: { id: number }) => u.id)
    expect(users.sort((x: number, y: number) => x - y)).toEqual(
      [B.ownerId, B.users.admin, B.users.alice].sort((x, y) => x - y),
    )
    const key = `table.${PREFIX.slice(0, -1)}.acting`
    await http(on)
      .put(`/api/iam/profile/prefs/${key}`)
      .set(token)
      .send({ value: { v: 1, columns: [{ prop: 'id', visible: true }] } })
      .expect(200)
    try {
      expect(
        await ds.query('SELECT tenant_id FROM iam_user_pref WHERE user_id = ? AND pref_key = ?', [
          s.session.userId,
          key,
        ]),
      ).toEqual([{ tenant_id: 1 }])
    } finally {
      await ds.query('DELETE FROM iam_user_pref WHERE pref_key = ?', [key])
    }
  })
})

describe('@RequireFeature', () => {
  it('a session whose feature set lacks the group finds no route (404); holding it passes; a reload takes the set of its tenant’s package anew', async () => {
    const b = (await signInDirect(on, B.users.alice))!
    const call = (path: string) => http(on).get(path).set(bearer(b.accessToken))
    const features = (list: string[] | undefined) =>
      patchSession(b.session.sid, (s) => {
        s.features = list
      })
    for (const path of ['/api/tenancy-fixture/feature', '/api/wf/tasks/todo'])
      await call(path).expect(200)
    await features(['system'])
    for (const path of ['/api/tenancy-fixture/feature', '/api/wf/tasks/todo']) {
      const res = await call(path)
      expect(res.status).toBe(404)
      expect(res.body.code).toBe(Err.NOT_FOUND.code)
    }
    // what needs no feature stays
    await call('/api/iam/profile').expect(200)
    await features(['system', 'workflow'])
    await call('/api/tenancy-fixture/feature').expect(200)
    await features([])
    await call('/api/tenancy-fixture/feature').expect(404)
    // permVer moved: the session is reloaded with the user's set (B's package: every menu open to
    // tenants, so every group but the platform's)
    await on.get(PermVersion).bumpUser(B.users.alice)
    await call('/api/tenancy-fixture/feature').expect(200)
    const stored = JSON.parse((await redis.get(redisKey('authSession', b.session.sid)))!) as Session
    expect(stored.features).toEqual(expect.arrayContaining(['workflow', 'system']))
  })
})

describe('/me', () => {
  it("names the session's data tenant and its features while the switch is on; off, neither", async () => {
    const groups = (
      await ds.query<{ route_name: string }[]>(
        `SELECT route_name FROM iam_menu
          WHERE parent_id = 0 AND kind = 'group' AND route_name IS NOT NULL AND deleted_at IS NULL
          ORDER BY sort_no, id`,
      )
    ).map((r) => r.route_name)
    expect(groups).toEqual(expect.arrayContaining(['workflow', 'system', 'monitor']))
    const meOf = async (app: NestExpressApplication, token: string) =>
      (await http(app).get('/api/auth/me').set(bearer(token)).expect(200)).body.data as MePayload
    const s = await signIn(on)
    const own = await meOf(on, s.accessToken)
    expect(own.tenant).toEqual({
      id: 1,
      code: 'default',
      name: 'seed.tenant.default',
      brandName: null,
      logoUrl: null,
      acting: false,
    })
    expect(own.features).toEqual(groups)
    const b = (await signInDirect(on, B.users.alice))!
    const ofB = await meOf(on, b.accessToken)
    expect(ofB.user.id).toBe(B.users.alice)
    expect(ofB.tenant).toEqual({
      id: B.id,
      code: B.code,
      name: B.code,
      brandName: null,
      logoUrl: null,
      acting: false,
    })
    await patchSession(b.session.sid, (x) => {
      x.features = ['system']
    })
    expect((await meOf(on, b.accessToken)).features).toEqual(['system'])
    // entered B: B is the tenant, the user and the features stay the platform user's own
    await patchSession(s.session.sid, (x) => {
      x.actingTenantId = B.id
      x.actingUntil = Date.now() + 3_600_000
    })
    const acting = await meOf(on, s.accessToken)
    expect(acting.tenant).toEqual({ ...ofB.tenant, acting: true })
    expect(acting.user.id).toBe(s.session.userId)
    expect(acting.features).toEqual(groups)
    // switch off: the payload as without multi-tenancy
    const offMe = await meOf(off, (await signIn(off)).accessToken)
    expect(offMe).not.toHaveProperty('tenant')
    expect(offMe).not.toHaveProperty('features')
  })
})
