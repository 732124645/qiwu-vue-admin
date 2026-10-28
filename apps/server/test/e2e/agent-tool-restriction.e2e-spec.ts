// Tenant tool restrictions of the agent (see docs/agent.md), multi-tenancy on: a tenant administrator
// tightens a tool for the own tenant to `human` or `deny` (null removes it); the effective policy is the
// stricter of platform and tenant, so a tenant never loosens the platform and a later platform loosening
// keeps the tenant's row. External tools are keyed by their tool row id (`mcp:<id>`), never by the
// model-facing name. Covered: list, set, change and clear; 403 without the perms; 400 for anything but
// human, deny or null; 404 for an unknown tool; the platform page shows the platform layer only; one
// tenant's rows never reach another; the seed adds new actions to the packages that hold their page once.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { agentPerms, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { EXTERNAL_TOOL_SOURCE, type ExternalToolSource } from '../../src/core/agent/agent-ports.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { McpConnector } from '../../src/core/agent/mcp-client/mcp-connector.js'
import { assembleTools, TurnRunner } from '../../src/core/agent/runtime/turn-runner.js'
import { AgentToolPolicies } from '../../src/core/agent/tools/tool-policy.js'
import type { Principal } from '../../src/core/auth/principal.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { seedAgent } from '../../src/db/seeds/agent/agent.seed.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import {
  addRow,
  addUser,
  createPackage,
  createTenant,
  inTenant1,
  type PeopledTenant,
} from '../setup/tenants.js'

const PREFIX = 'e2e-agtr-'
const URL = '/api/agent/tool-restrictions'
const { browse, modify } = agentPerms.restriction

let app: NestExpressApplication
let ds: DataSource
let root = ''
let chatOnly = ''
let manager = ''
let other = ''
let roleIds: number[] = []
let userIds: number[] = []
let tenant: PeopledTenant
let serverId = 0
let extId = 0

const http = () => request(app.getHttpServer())
const list = async (token = manager) => {
  const res = await http().get(URL).set(bearer(token))
  expect(res.status).toBe(200)
  return res.body.data as { name: string; [k: string]: unknown }[]
}
const row = async (name: string, token = manager) =>
  (await list(token)).find((r) => r.name === name)
const put = (name: string, policy: unknown, token = manager) =>
  http()
    .put(`${URL}/${encodeURIComponent(name)}`)
    .set(bearer(token))
    .send({ policy })

/** A role of the default tenant holding the menus of `perms`, and a signed-in user holding it. */
async function holder(perms: string[]): Promise<string> {
  const name = `${PREFIX}${roleIds.length}`
  const roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', { code: name, name, data_scope: 'all' }),
  )
  roleIds.push(roleId)
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, 1 FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, perms],
  )
  userIds.push(await addUser(app, 1, name, { roleId }))
  return (await signIn(app, name)).accessToken
}

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  const reg = app.get(McpRegistry)
  const tool = (name: string, kind: 'read' | 'write') =>
    reg.add(
      { name, title: name, description: name, perm: null, kind, input: z.object({}) },
      () => ({ ok: true }),
    )
  tool('test.tr.read', 'read')
  tool('test.tr.write', 'write')
  tool('test.tr.purge', 'write')
  tool('test.tr.risky', 'write')
  await ds.query(
    "INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES ('test.tr.purge', 1, 'deny'), ('test.tr.risky', 1, 'human')",
  )
  serverId = await insertRow(ds.manager, 'agent_mcp_server', {
    name: `${PREFIX}srv`,
    url: 'https://mcp.example.com/mcp',
    auth_kind: 'none',
    enabled: 1,
  })
  extId = await insertRow(ds.manager, 'agent_mcp_tool', {
    server_id: serverId,
    name: 'lookup',
    title: 'Look up',
    enabled: 1,
    policy: 'auto',
    input_schema: { type: 'object' },
  })
  root = (await signIn(app)).accessToken
  chatOnly = await holder([agentPerms.chat.use])
  manager = await holder([browse, modify])
  tenant = await createTenant(app, { users: true })
  for (const perm of [browse, modify]) {
    const [menu] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
      [perm],
    )
    await addRow(app, tenant.id, 'iam_role_menus', { role_id: tenant.roleId, menu_id: menu!.id })
  }
  other = (await signIn(app, 'admin', {}, tenant.id)).accessToken
})

afterAll(async () => {
  if (ds) {
    await ds.query("DELETE FROM agent_tool_restriction WHERE tool LIKE 'test.tr.%'")
    await ds.query('DELETE FROM agent_tool_restriction WHERE tool IN (?)', [
      [`mcp:${extId}`, 'ext.e2e-agtr-srv.lookup'],
    ])
    await ds.query("DELETE FROM cfg_mcp_tool WHERE name LIKE 'test.tr.%'")
    await ds.query('DELETE FROM agent_mcp_tool WHERE server_id = ?', [serverId])
    await ds.query('DELETE FROM agent_mcp_server WHERE id = ?', [serverId])
    if (userIds.length) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [userIds])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [userIds])
    }
    if (roleIds.length) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id IN (?)', [roleIds])
      await ds.query('DELETE FROM iam_role WHERE id IN (?)', [roleIds])
    }
  }
  await tenant?.dispose()
  await app?.close()
})

afterEach(async () => {
  await ds.query("DELETE FROM agent_tool_restriction WHERE tool LIKE 'test.tr.%'")
  await ds.query('DELETE FROM agent_tool_restriction WHERE tool IN (?)', [
    [`mcp:${extId}`, 'ext.e2e-agtr-srv.lookup'],
  ])
})

describe('tenant tool restrictions', () => {
  it('lists the tools the platform offers with both layers; sets, changes and clears a restriction', async () => {
    const all = await list()
    expect(all.find((r) => r.name === 'test.tr.read')).toEqual({
      name: 'test.tr.read',
      title: 'test.tr.read',
      kind: 'read',
      origin: 'local',
      platformPolicy: 'auto',
      tenantPolicy: null,
      effective: 'auto',
    })
    expect(all.find((r) => r.name === `mcp:${extId}`)).toMatchObject({
      title: 'Look up',
      kind: 'read',
      origin: 'mcp',
      platformPolicy: 'auto',
      tenantPolicy: null,
    })
    // a tool the platform denies is not offered, so not listed
    expect(all.find((r) => r.name === 'test.tr.purge')).toBeUndefined()

    const set = await put('test.tr.read', 'human')
    expect(set.status).toBe(200)
    expect(set.body.data).toMatchObject({ tenantPolicy: 'human', effective: 'human' })
    expect((await put('test.tr.read', 'deny')).body.data).toMatchObject({
      tenantPolicy: 'deny',
      effective: 'deny',
    })
    expect(await row('test.tr.read')).toMatchObject({ tenantPolicy: 'deny', effective: 'deny' })
    const cleared = await put('test.tr.read', null)
    expect(cleared.body.data).toMatchObject({ tenantPolicy: null, effective: 'auto' })
    // setting it again after a clear makes a new row (the old one stays deleted)
    expect((await put('test.tr.read', 'human')).status).toBe(200)
    const [{ live, gone }] = await ds.query<{ live: number; gone: number }[]>(
      `SELECT SUM(deleted_at IS NULL) AS live, SUM(deleted_at IS NOT NULL) AS gone
         FROM agent_tool_restriction WHERE tenant_id = 1 AND tool = 'test.tr.read'`,
    )
    expect([Number(live), Number(gone)]).toEqual([1, 1])
  })

  it('403 without the perms; 400 for anything but human, deny or null; 404 for an unknown tool', async () => {
    expect((await http().get(URL).set(bearer(chatOnly))).status).toBe(403)
    expect((await put('test.tr.read', 'deny', chatOnly)).status).toBe(403)
    for (const bad of ['ask', 'auto', 'never', 1, undefined]) {
      const res = await put('test.tr.write', bad)
      expect([bad, res.status, res.body.code]).toEqual([bad, 400, Err.VALIDATION_FAILED.code])
    }
    expect((await put('test.tr.nope', 'deny')).status).toBe(404)
    expect((await put('mcp:999999999', 'deny')).status).toBe(404)
    expect((await put('mcp:abc', 'deny')).status).toBe(404)
    const [{ n }] = await ds.query<{ n: number }[]>(
      "SELECT COUNT(*) AS n FROM agent_tool_restriction WHERE tool LIKE 'test.tr.%' OR tool LIKE 'mcp:9%'",
    )
    expect(Number(n)).toBe(0)
  })

  it('a tenant never loosens the platform, a later platform loosening keeps the tenant row, and the platform page shows the platform layer only', async () => {
    // tightening a denied or human tool leaves it as strict as the platform has it
    expect((await put('test.tr.purge', 'human')).body.data).toMatchObject({
      platformPolicy: 'deny',
      tenantPolicy: 'human',
      effective: 'deny',
    })
    expect((await put('test.tr.risky', 'human')).body.data).toMatchObject({
      platformPolicy: 'human',
      effective: 'human',
    })
    expect((await put('test.tr.write', 'deny')).status).toBe(200)
    const platform = (value: string | null, name = 'test.tr.write') =>
      http()
        .put(`/api/agent/tools/${name}/policy`)
        .set(bearer(root))
        .send({ policy: value })
        .expect(200)
    await platform('human')
    try {
      expect(await row('test.tr.write')).toMatchObject({
        platformPolicy: 'human',
        tenantPolicy: 'deny',
        effective: 'deny',
      })
      // root's page in the default tenant: the platform's policy, not the default tenant's restriction
      const page = (await http().get('/api/agent/tools').set(bearer(root)).expect(200)).body
        .data as { name: string; policy: string }[]
      expect(page.find((t) => t.name === 'test.tr.write')!.policy).toBe('human')
      await platform('deny', 'test.tr.purge')
      await platform(null, 'test.tr.purge')
      // the platform loosening the purge back to its default keeps the tenant's human
      expect(await row('test.tr.purge')).toMatchObject({
        tenantPolicy: 'human',
        effective: 'human',
      })
      const now = await inTenant1(() => app.get(AgentToolPolicies).policies())
      expect([now.get('test.tr.write'), now.get('test.tr.purge')]).toEqual(['deny', 'human'])
    } finally {
      await platform(null)
      await ds.query("UPDATE cfg_mcp_tool SET agent_policy = 'deny' WHERE name = 'test.tr.purge'")
    }
  })

  it('an external tool is restricted by its id: deny drops it, human makes it ask; a row under its model-facing name does nothing', async () => {
    const source = app.get<ExternalToolSource>(EXTERNAL_TOOL_SOURCE)
    const mine = async () =>
      (await inTenant1(() => source.list({} as Principal))).find(
        (d) => d.serverName === `${PREFIX}srv`,
      )
    const before = await mine()
    expect(before).toMatchObject({ policy: 'auto' })
    await inTenant1(() =>
      insertRow(ds.manager, 'agent_tool_restriction', { tool: before!.name, policy: 'deny' }),
    )
    expect(await mine()).toMatchObject({ policy: 'auto' })
    expect((await put(`mcp:${extId}`, 'human')).body.data).toMatchObject({
      tenantPolicy: 'human',
      effective: 'human',
    })
    // still a read: offered in read-only and plan mode, asking a person at every call
    const human = await mine()
    expect(human).toMatchObject({ kind: 'read', policy: 'human', restricted: 'human' })
    const surface = assembleTools({
      registry: [],
      usable: [],
      switches: [],
      layers: new Map(),
      web: { live: false, searchable: false },
      external: [human!],
      builtins: [],
      readOnly: true,
      lists: [],
    })
    expect(surface.tools.get(human!.name)).toMatchObject({
      kind: 'read',
      policy: 'human',
      why: 'tenant',
    })
    expect((await put(`mcp:${extId}`, 'deny')).status).toBe(200)
    expect(await mine()).toBeUndefined()
    // still listed for the tenant administrator, who may take it back
    expect(await row(`mcp:${extId}`)).toMatchObject({ tenantPolicy: 'deny', effective: 'deny' })
    // another tenant still has it
    // qw:cross-tenant the spec reads the other tenant's view of a platform-wide tool
    const theirs = await withTenant(tenant.id, () => source.list({} as Principal))
    expect(theirs.find((d) => d.serverName === `${PREFIX}srv`)).toMatchObject({ policy: 'auto' })
  })

  it("one tenant's restrictions never reach another; another tenant's administrator changes only its own", async () => {
    expect((await put('test.tr.write', 'deny')).status).toBe(200)
    expect(await row('test.tr.write', other)).toMatchObject({
      tenantPolicy: null,
      effective: 'ask',
    })
    expect((await put('test.tr.read', 'human', other)).status).toBe(200)
    expect(await row('test.tr.read')).toMatchObject({ tenantPolicy: null, effective: 'auto' })
    // clearing the same name in the other tenant leaves this tenant's row alone
    expect((await put('test.tr.write', null, other)).status).toBe(200)
    expect(await row('test.tr.write')).toMatchObject({ tenantPolicy: 'deny' })
    const policies = app.get(AgentToolPolicies)
    // qw:cross-tenant the spec compares what each tenant's runtime sees
    const theirs = await withTenant(tenant.id, () => policies.policies())
    const ours = await inTenant1(() => policies.policies())
    expect([theirs.get('test.tr.read'), theirs.get('test.tr.write')]).toEqual(['human', 'ask'])
    expect([ours.get('test.tr.read'), ours.get('test.tr.write')]).toEqual(['auto', 'deny'])
  })

  it('a call of an external tool the tenant denied never reaches its server', async () => {
    const source = app.get<ExternalToolSource>(EXTERNAL_TOOL_SOURCE)
    const reach = vi
      .spyOn(app.get(McpConnector), 'callTool')
      .mockResolvedValue({ content: [{ type: 'text', text: 'found' }] })
    try {
      const name = (await inTenant1(() => source.list({} as Principal))).find(
        (d) => d.serverName === `${PREFIX}srv`,
      )!.name
      const call = () =>
        inTenant1(() =>
          source.call(
            { userId: 1, username: 'admin' } as Principal,
            name,
            {},
            {
              signal: new AbortController().signal,
              onElicit: async () => ({ action: 'cancel' }),
            },
          ),
        )
      expect((await call()).ok).toBe(true)
      expect(reach).toHaveBeenCalledTimes(1)
      expect((await put(`mcp:${extId}`, 'deny')).status).toBe(200)
      expect(await call()).toMatchObject({ ok: false })
      expect(reach).toHaveBeenCalledTimes(1)
    } finally {
      reach.mockRestore()
    }
  })

  it('an external tool the tenant denies while a turn runs is reported as the tenant’s restriction', async () => {
    const source = app.get<ExternalToolSource>(EXTERNAL_TOOL_SOURCE)
    const name = (await inTenant1(() => source.list({} as Principal))).find(
      (d) => d.serverName === `${PREFIX}srv`,
    )!.name
    const runner = app.get(TurnRunner) as unknown as {
      restrictionNow(ctx: { p: Principal }, def: { origin: string; name: string }): Promise<unknown>
    }
    const now = () =>
      inTenant1(() => runner.restrictionNow({ p: {} as Principal }, { origin: 'mcp', name }))
    expect(await now()).toBeNull()
    expect((await put(`mcp:${extId}`, 'deny')).status).toBe(200)
    expect(await now()).toBe('deny')
  })

  it("the tools a user may pick for a profile leave out the tenant's denied ones", async () => {
    const mine = async () =>
      (
        (await http().get('/api/agent/my-tools').set(bearer(chatOnly)).expect(200)).body.data as {
          name: string
          kind: string
        }[]
      ).map((t) => t.name)
    expect(await mine()).toContain('test.tr.write')
    expect((await put('test.tr.write', 'deny')).status).toBe(200)
    expect(await mine()).not.toContain('test.tr.write')
    expect((await put('test.tr.write', null)).status).toBe(200)
    expect(await mine()).toContain('test.tr.write')
  })

  // last: it recreates the action rows, so the roles above lose them
  it('the seed adds the actions it creates to the packages holding their page, once', async () => {
    const [page] = await ds.query<{ id: number }[]>(
      "SELECT id FROM iam_menu WHERE route_name = 'agent-skill' AND deleted_at IS NULL",
    )
    const pkg = await createPackage(app, { menuIds: [page!.id] })
    try {
      const actions = async () =>
        (
          await ds.query<{ id: number }[]>(
            "SELECT id FROM iam_menu WHERE kind = 'action' AND perms IN (?) ORDER BY perms",
            [[browse, modify]],
          )
        ).map((r) => Number(r.id))
      const held = async () =>
        (
          await ds.query<{ menu_id: number }[]>(
            'SELECT menu_id FROM iam_tenant_package_menus WHERE package_id = ?',
            [pkg.id],
          )
        ).map((r) => Number(r.menu_id))
      // an install from before these actions existed
      const old = await actions()
      await ds.query('DELETE FROM iam_role_menus WHERE menu_id IN (?)', [old])
      await ds.query('DELETE FROM iam_tenant_package_menus WHERE menu_id IN (?)', [old])
      await ds.query('DELETE FROM iam_menu WHERE id IN (?)', [old])
      await inTenant1(() => seedAgent(ds.manager))
      const made = await actions()
      expect(made).toHaveLength(2)
      expect(await held()).toEqual(expect.arrayContaining([page!.id, ...made]))
      // root takes one out of the package: another seed run does not put it back
      await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id = ? AND menu_id = ?', [
        pkg.id,
        made[1],
      ])
      await inTenant1(() => seedAgent(ds.manager))
      expect(await held()).not.toContain(made[1])
      expect(await held()).toContain(made[0])
    } finally {
      await pkg.dispose()
    }
  })
})
