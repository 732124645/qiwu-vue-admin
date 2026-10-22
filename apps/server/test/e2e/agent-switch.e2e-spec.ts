// The in-app agent behind its start-up switch (see docs/agent.md), with the MCP switch beside it. The app
// module is imported with both switches off, so it loads neither module (what every other spec without
// APP_AGENT sees); the "on" apps add AgentModule (and McpModule) to it the way the switch does, each with
// its own parsed env. Off: the agent routes are no routes (404), no tool host exists, the side menu and
// the role grant tree leave the agent group out while the menu management lists it. On with MCP off: the
// module loads, its tools come through ToolHost under the same guards as MCP calls (logged as the in-app
// agent with thread and turn), `agent.paused` stops them, `/api/mcp` stays 404 and its menus hidden; the
// agent params are root's only. On with MCP on: MCP answers as before on the shared host, each pause
// switch stops its own channel only.
import type { Type } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import {
  AGENT2_PARAMS,
  excelImportParams,
  AGENT_INSTRUCTIONS_PARAM,
  AGENT_LIMIT_PARAMS,
  AGENT_PAUSED_PARAM,
  AGENT_TRUST_MODE_PARAM,
  AGENT_WEB_DOMAINS_PARAM,
  AGENT_WEB_MODE_PARAM,
  Err,
  MCP_PAUSED_PARAM,
  type MenuNode,
  type RoleMenuNode,
} from '@qiwu/shared'
import { ClsService } from 'nestjs-cls'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { agentOn } from '../../src/core/config/agent-switch.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { McpModule } from '../../src/core/mcp/mcp.module.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { McpService } from '../../src/core/mcp/mcp.service.js'
import { ToolHost } from '../../src/core/mcp/tool-host.js'
import { REDIS, type Redis } from '../../src/core/redis/redis.module.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { ParameterService } from '../../src/modules/platform/settings/param/param.service.js'
import { logOf } from '../setup/audit.js'
import { bearer, signIn } from '../setup/auth.js'
import { cleanRedis } from '../setup/redis.js'
import { inTenant1 } from '../setup/tenants.js'
import { callTool, patFor, toolNames } from './mcp-kit.js'

// before AppModule is imported: the module list reads the switches when the app module loads
vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})

const PREFIX = 'agent_switch_'
const AGENT_ROUTES = [
  'agent',
  'agent-chat',
  'agent-skill',
  'agent-setting',
  'agent-usage',
  'agent-automation',
]

/** An app of the switched-off AppModule plus `extra` modules, its config parsed from `env`. */
async function boot(env: Record<string, string>, extra: Type[] = []) {
  const mod = await Test.createTestingModule({ imports: [AppModule, ...extra] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse({ ...process.env, ...env })))
    .compile()
  const app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  return app
}

const routeNames = (nodes: MenuNode[]): string[] =>
  nodes.flatMap((n) => [...(n.routeName ? [n.routeName] : []), ...routeNames(n.children)])
const ids = (nodes: { id: number; children: { id: number }[] }[]): number[] =>
  nodes.flatMap((n) => [n.id, ...ids(n.children as typeof nodes)])

/** The ids of the agent menus (the group, its pages and their actions). */
const agentMenus = async (ds: DataSource): Promise<number[]> =>
  (
    await ds.query<{ id: number }[]>(
      `SELECT id FROM iam_menu WHERE deleted_at IS NULL
          AND (route_name LIKE 'agent%' OR perms LIKE 'agent.%') ORDER BY id`,
    )
  ).map((r) => Number(r.id))

const adminIdOf = async (ds: DataSource): Promise<number> =>
  Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
      )
    )[0]!.id,
  )

/** A hand-built principal of the default tenant: root, or holding exactly `perms`. */
const principal = (userId: number, perms: string[] | 'root'): Principal => ({
  userId,
  username: 'admin',
  deptId: null,
  deptTreePath: null,
  roles: [],
  perms: perms === 'root' ? ['*'] : perms,
  root: perms === 'root',
  tenantId: 1,
})

/** The in-app call of `name` in the default tenant under a fresh trace id (to find its log row). */
async function agentCall(
  app: NestExpressApplication,
  p: Principal,
  name: string,
  args: unknown = {},
) {
  const cls = app.get(ClsService)
  const traceId = `${PREFIX}${Date.now()}_${Math.random().toString(36).slice(2)}`
  const out = await cls.run(() => {
    cls.set('traceId', traceId)
    return inTenant1(() => app.get(ToolHost).call(p, name, args, { threadId: 7, turnId: 9 }))
  })
  return { out, traceId }
}

it('reads the switch like the other start-up switches: unset or invalid is off', () => {
  expect(agentOn({})).toBe(false)
  expect(agentOn({ APP_AGENT: 'yes-please' })).toBe(false)
  expect(agentOn({ APP_AGENT: 'false' })).toBe(false)
  expect(agentOn({ APP_AGENT: 'true' })).toBe(true)
  expect(agentOn({ APP_AGENT: '1' })).toBe(true)
})

describe('off', () => {
  let app: NestExpressApplication
  let ds: DataSource
  let root = ''

  beforeAll(async () => {
    app = await boot({ APP_AGENT: 'false', APP_MCP: 'false' })
    ds = app.get<DataSource>(getDataSourceToken())
    root = (await signIn(app)).accessToken
  })
  afterAll(() => app?.close())

  it('the agent routes are no routes and no tool host or registry exists', async () => {
    const http = () => request(app.getHttpServer())
    for (const [method, path] of [
      ['get', '/api/agent/options'],
      ['get', '/api/agent/threads'],
      ['post', '/api/agent/threads'],
      ['get', '/api/agent/tools'],
      ['post', '/api/mcp'],
    ] as const)
      await http()[method](path).set(bearer(root)).send({}).expect(404)
    expect(() => app.get(AgentModule, { strict: false })).toThrow()
    expect(() => app.get(ToolHost, { strict: false })).toThrow()
    expect(() => app.get(McpRegistry, { strict: false })).toThrow()
  })

  it('the side menu and the grant tree leave the agent group out; the menu management lists it', async () => {
    const menus = await agentMenus(ds)
    // the group, five pages, the hidden batch review page and their twelve actions
    expect(menus).toHaveLength(19)
    const http = () => request(app.getHttpServer())
    const side = (await http().get('/api/auth/menus').set(bearer(root)).expect(200)).body
      .data as MenuNode[]
    expect(ids(side).filter((id) => menus.includes(id))).toEqual([])
    const tree = (await http().get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
      .data as RoleMenuNode[]
    expect(ids(tree).filter((id) => menus.includes(id))).toEqual([])
    const listed = ids(
      (await http().get('/api/iam/menus').set(bearer(root)).expect(200)).body.data as MenuNode[],
    )
    expect(menus.filter((id) => !listed.includes(id))).toEqual([])
  })
})

describe('on, MCP off', () => {
  let app: NestExpressApplication
  let ds: DataSource
  let root = ''
  let adminId = 0
  const params = new Map<string, number>()
  const userIds: number[] = []
  const roleIds: number[] = []
  const http = () => request(app.getHttpServer())
  const setParam = (key: string, value: string, token = root) =>
    http()
      .put(`/api/settings/params/${params.get(key)}`)
      .set(bearer(token))
      .send({ paramValue: value })

  beforeAll(async () => {
    app = await boot({ APP_AGENT: 'true', APP_MCP: 'false' }, [AgentModule])
    ds = app.get<DataSource>(getDataSourceToken())
    await cleanRedis(app.get<Redis>(REDIS))
    root = (await signIn(app)).accessToken
    adminId = await adminIdOf(ds)
    for (const r of await ds.query<{ id: number; param_key: string }[]>(
      "SELECT id, param_key FROM cfg_param WHERE param_key LIKE 'agent.%' AND deleted_at IS NULL",
    ))
      params.set(r.param_key, Number(r.id))
  })

  afterAll(async () => {
    await setParam(AGENT_PAUSED_PARAM, 'false')
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
    await app?.close()
  })

  it('loads the module; /api/mcp, its admin routes and its menus stay away', async () => {
    expect(app.get(AgentModule, { strict: false })).toBeDefined()
    expect(() => app.get(McpService, { strict: false })).toThrow()
    for (const [method, path] of [
      ['post', '/api/mcp'],
      ['get', '/api/mcp/tools'],
      ['get', '/api/mcp/my-tokens'],
      ['get', '/.well-known/oauth-protected-resource'],
    ] as const)
      await http()[method](path).set(bearer(root)).send({}).expect(404)
    const menusRes = await http().get('/api/auth/menus').set(bearer(root))
    expect(menusRes.status).toBe(200)
    const side = routeNames(menusRes.body.data as MenuNode[])
    expect(side).toEqual(expect.arrayContaining(AGENT_ROUTES))
    expect(side.filter((r) => r.startsWith('mcp-'))).toEqual([])
    const tree = ids(
      (await http().get('/api/iam/roles/menu-tree').set(bearer(root)).expect(200)).body
        .data as RoleMenuNode[],
    )
    expect(tree).toEqual(expect.arrayContaining(await agentMenus(ds)))
  })

  it('lists the registered tools the caller may use through ToolHost', async () => {
    const all = (await app.get(ToolHost).list(principal(adminId, 'root'))).map((t) => t.name)
    expect(all).toEqual(
      expect.arrayContaining(['iam.me.get', 'iam.user.search', 'demo.book.create']),
    )
    expect(all).toEqual(
      app
        .get(McpRegistry)
        .list()
        .map((t) => t.name),
    )
    // without the perm the tool is not offered; a tool without a perm is
    const none = (await app.get(ToolHost).list(principal(adminId, []))).map((t) => t.name)
    expect(none).toContain('iam.me.get')
    expect(none).not.toContain('iam.user.search')
  })

  it('calls a tool as the thread owner and logs it as the in-app agent with thread and turn', async () => {
    const { out, traceId } = await agentCall(app, principal(adminId, 'root'), 'iam.me.get')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(JSON.parse(out.text)).toMatchObject({ username: 'admin' })
    const row = await logOf(ds, traceId)
    expect(row).toMatchObject({
      domain: 'mcp.tool',
      verb: 'call',
      biz_id: 'iam.me.get',
      user_id: adminId,
      ok: 1,
      tenant_id: 1,
    })
    expect(JSON.parse(row.params as string)).toMatchObject({
      agent: true,
      tool: 'iam.me.get',
      channel: 'in-app',
      threadId: 7,
      turnId: 9,
      argsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      arguments: {},
    })
  })

  it('refuses through the same guards: perm, arguments, unknown tool; needs a tenant context', async () => {
    const forbidden = await agentCall(app, principal(adminId, []), 'iam.user.search')
    expect(forbidden.out).toMatchObject({ ok: false, error: { code: Err.FORBIDDEN.code } })
    const row = await logOf(ds, forbidden.traceId)
    expect(row).toMatchObject({ biz_id: 'iam.user.search', ok: 0, error_msg: Err.FORBIDDEN.key })

    const invalid = await agentCall(app, principal(adminId, 'root'), 'iam.user.search', {
      pageSize: 'many',
    })
    expect(invalid.out).toMatchObject({
      ok: false,
      error: { code: Err.VALIDATION_FAILED.code, errors: [{ path: 'pageSize' }] },
    })
    const unknown = await agentCall(app, principal(adminId, 'root'), 'spec.nothing.here')
    expect(unknown.out).toMatchObject({ ok: false, error: { code: Err.NOT_FOUND.code } })
    await expect(
      app
        .get(ToolHost)
        .call(principal(adminId, 'root'), 'iam.me.get', {}, { threadId: 1, turnId: 1 }),
    ).rejects.toThrow(/tenant/)
  })

  it('agent.paused refuses every agent call at once; mcp.paused does not', async () => {
    await setParam(AGENT_PAUSED_PARAM, 'true').expect(200)
    try {
      const { out } = await agentCall(app, principal(adminId, 'root'), 'iam.me.get')
      expect(out).toMatchObject({ ok: false, error: { code: Err.AGENT_PAUSED.code } })
    } finally {
      await setParam(AGENT_PAUSED_PARAM, 'false').expect(200)
    }
    expect((await agentCall(app, principal(adminId, 'root'), 'iam.me.get')).out.ok).toBe(true)
  })

  it('seeds the agent params; only root changes them', async () => {
    const keys = [
      AGENT_PAUSED_PARAM,
      ...Object.values(AGENT_LIMIT_PARAMS),
      AGENT2_PARAMS.automationsPerUser,
      AGENT2_PARAMS.automationRunsPerDay,
      AGENT_TRUST_MODE_PARAM,
      AGENT_INSTRUCTIONS_PARAM,
      AGENT_WEB_MODE_PARAM,
      AGENT_WEB_DOMAINS_PARAM,
      AGENT2_PARAMS.reviewModel,
      AGENT2_PARAMS.memoryExtract,
      AGENT2_PARAMS.memoryPerTurn,
      AGENT2_PARAMS.researchSteps,
      AGENT2_PARAMS.researchSeconds,
    ]
    expect([...params.keys()].sort()).toEqual([...keys].sort())
    const id = await inTenant1(() =>
      insertRow(ds.manager, 'iam_user', {
        username: `${PREFIX}editor`,
        display_name: 'editor',
        password_hash: 'x',
        password_changed_at: new Date(),
      }),
    )
    userIds.push(id)
    const roleId = await inTenant1(() =>
      insertRow(ds.manager, 'iam_role', {
        code: `${PREFIX}params`,
        name: `${PREFIX}params`,
        data_scope: 'all',
      }),
    )
    roleIds.push(roleId)
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, 1)', [
      id,
      roleId,
    ])
    for (const m of await ds.query<{ id: number }[]>(
      "SELECT id FROM iam_menu WHERE perms IN ('settings.param.browse', 'settings.param.modify') AND deleted_at IS NULL",
    ))
      await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
        roleId,
        m.id,
      ])
    const editor = (await signIn(app, `${PREFIX}editor`)).accessToken
    for (const key of keys)
      expect((await setParam(key, '1', editor).expect(403)).body.code).toBe(
        Err.IAM_GRANT_EXCEEDS_OWN.code,
      )
    // renaming an ordinary param to a root-only key counts as writing that key (the PUT body drops the
    // key; the service refuses it on its own as well)
    const [plain] = await ds.query<{ id: number }[]>(
      'SELECT id FROM cfg_param WHERE param_key = ? AND deleted_at IS NULL',
      [excelImportParams.maxMb],
    )
    const cls = app.get(ClsService)
    for (const key of keys)
      await expect(
        cls.run(() => {
          cls.set('principal', principal(id, ['settings.param.modify']))
          return inTenant1(() =>
            app.get(ParameterService).update(Number(plain!.id), { paramKey: key }),
          )
        }),
      ).rejects.toMatchObject({ err: Err.IAM_GRANT_EXCEEDS_OWN })
    const [after] = await ds.query<{ param_key: string }[]>(
      'SELECT param_key FROM cfg_param WHERE id = ?',
      [plain!.id],
    )
    expect(after!.param_key).toBe(excelImportParams.maxMb)
  })
})

describe('on, MCP on', () => {
  let app: NestExpressApplication
  let ds: DataSource
  let root = ''
  let adminId = 0
  const paramIds = new Map<string, number>()
  const setParam = (key: string, value: string) =>
    request(app.getHttpServer())
      .put(`/api/settings/params/${paramIds.get(key)}`)
      .set(bearer(root))
      .send({ paramValue: value })
      .expect(200)

  beforeAll(async () => {
    app = await boot({ APP_AGENT: 'true', APP_MCP: 'true' }, [AgentModule, McpModule])
    ds = app.get<DataSource>(getDataSourceToken())
    root = (await signIn(app)).accessToken
    adminId = await adminIdOf(ds)
    for (const key of [AGENT_PAUSED_PARAM, MCP_PAUSED_PARAM])
      paramIds.set(
        key,
        Number(
          (
            await ds.query<{ id: number }[]>('SELECT id FROM cfg_param WHERE param_key = ?', [key])
          )[0]!.id,
        ),
      )
  })

  afterAll(async () => {
    await setParam(AGENT_PAUSED_PARAM, 'false')
    await setParam(MCP_PAUSED_PARAM, 'false')
    await ds?.query('DELETE FROM iam_access_token WHERE user_id = ? AND name = ?', [
      adminId,
      'spec token',
    ])
    await app?.close()
  })

  it('MCP lists and calls on the shared host as before', async () => {
    const pat = await patFor(app, adminId)
    const reads = (await app.get(ToolHost).list(principal(adminId, 'root')))
      .filter((t) => t.kind === 'read')
      .map((t) => t.name)
      .sort()
    expect(await toolNames(app, pat.token)).toEqual(reads)
    const me = await callTool(app, pat.token, 'iam.me.get')
    expect(me.data).toMatchObject({ username: 'admin' })
    expect(me.structured).toEqual(me.data)
    expect((await callTool(app, pat.token, 'demo.book.create', {})).error?.code).toBe(
      Err.MCP_WRITE_NOT_ALLOWED.code,
    )
  })

  it('each pause switch stops its own channel only', async () => {
    const pat = await patFor(app, adminId)
    await setParam(MCP_PAUSED_PARAM, 'true')
    try {
      expect((await callTool(app, pat.token, 'iam.me.get')).error?.code).toBe(Err.MCP_PAUSED.code)
      expect((await agentCall(app, principal(adminId, 'root'), 'iam.me.get')).out.ok).toBe(true)
    } finally {
      await setParam(MCP_PAUSED_PARAM, 'false')
    }
    await setParam(AGENT_PAUSED_PARAM, 'true')
    try {
      expect((await agentCall(app, principal(adminId, 'root'), 'iam.me.get')).out).toMatchObject({
        ok: false,
        error: { code: Err.AGENT_PAUSED.code },
      })
      expect((await callTool(app, pat.token, 'iam.me.get')).data).toMatchObject({
        username: 'admin',
      })
    } finally {
      await setParam(AGENT_PAUSED_PARAM, 'false')
    }
  })
})
