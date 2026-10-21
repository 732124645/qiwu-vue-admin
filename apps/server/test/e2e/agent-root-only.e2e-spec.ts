// Root-only agent platform settings with multi-tenancy OFF (see docs/agent.md): model and search
// providers, external MCP servers and their tools, tool policies and platform skills decide every tenant's
// outbound targets and what runs without a confirmation, so a user granted agent.setting.modify who is not
// root is refused (403) on every change even though `@PlatformOnly('root')` alone lets everyone pass while
// the switch is off; reading the pages stays open to agent.setting.browse.
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { agentPerms } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, inTenant1 } from '../setup/tenants.js'

const PREFIX = 'e2e-agroot-'

let app: NestExpressApplication
let ds: DataSource
let root = ''
let admin = ''
let roleId = 0
let userId = 0

const http = () => request(app.getHttpServer())

beforeAll(async () => {
  const env = { ...process.env, APP_MULTI_TENANT: 'false', APP_AGENT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
  // an administrator of the agent settings who is not root
  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}r`,
      name: `${PREFIX}r`,
      data_scope: 'all',
    }),
  )
  await ds.query(
    `INSERT INTO iam_role_menus (role_id, menu_id, tenant_id)
     SELECT ?, id, 1 FROM iam_menu WHERE perms IN (?) AND deleted_at IS NULL`,
    [roleId, [agentPerms.setting.browse, agentPerms.setting.modify]],
  )
  userId = await addUser(app, 1, `${PREFIX}admin`, { roleId })
  admin = (await signIn(app, `${PREFIX}admin`)).accessToken
})

afterAll(async () => {
  if (ds) {
    await ds.query('DELETE FROM agent_provider WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_search_provider WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_platform_skill WHERE name LIKE ?', [`${PREFIX}%`])
    await ds.query('DELETE FROM agent_mcp_server WHERE name LIKE ?', [`${PREFIX}%`])
    if (userId) {
      await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [userId])
      await ds.query('DELETE FROM iam_user WHERE id = ?', [userId])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
  }
  await app?.close()
})

const skillMd = `---\nname: ${PREFIX}imp\ndescription: d\n---\n\nBody.\n`
/** Every change of the root-only settings, with a body that would pass validation. */
const changes: [string, string, object][] = [
  [
    'POST',
    '/api/agent/providers',
    { name: `${PREFIX}p`, baseUrl: 'https://api.example.com/v1', models: [{ id: 'm' }] },
  ],
  [
    'PUT',
    '/api/agent/providers/1',
    { name: `${PREFIX}p`, baseUrl: 'https://api.example.com/v1', models: [{ id: 'm' }] },
  ],
  ['DELETE', '/api/agent/providers/1', {}],
  ['POST', '/api/agent/search-providers', { kind: 'tavily', name: `${PREFIX}s` }],
  ['PUT', '/api/agent/search-providers/1', { kind: 'tavily', name: `${PREFIX}s` }],
  ['DELETE', '/api/agent/search-providers/1', {}],
  [
    'POST',
    '/api/agent/mcp-servers',
    { name: `${PREFIX}m`, url: 'https://mcp.example.com/mcp', authKind: 'none' },
  ],
  [
    'PUT',
    '/api/agent/mcp-servers/1',
    { name: `${PREFIX}m`, url: 'https://mcp.example.com/mcp', authKind: 'none' },
  ],
  ['DELETE', '/api/agent/mcp-servers/1', {}],
  ['POST', '/api/agent/mcp-servers/1/sync', {}],
  ['PUT', '/api/agent/mcp-servers/1/tools/1', { enabled: true, policy: 'auto' }],
  ['PUT', '/api/agent/tools/web.search/policy', { policy: 'deny' }],
  [
    'POST',
    '/api/agent/platform-skills',
    { name: `${PREFIX}k`, description: 'd', body: 'b', scope: 'user' },
  ],
  ['PUT', '/api/agent/platform-skills/1', { name: `${PREFIX}k`, description: 'd', body: 'b' }],
  ['DELETE', '/api/agent/platform-skills/1', {}],
  ['POST', '/api/agent/platform-skills/import', { text: skillMd }],
]

const send = (method: string, url: string, body: object, token: string) => {
  const req = http()[method.toLowerCase() as 'post' | 'put' | 'delete'](url).set(bearer(token))
  return method === 'DELETE' ? req : req.send(body)
}

describe('agent platform settings while multi-tenancy is off', () => {
  it.each(changes)(
    '%s %s: 403 for a non-root holder of agent.setting.modify',
    async (m, url, b) => {
      const res = await send(m, url, b, admin)
      expect(res.status).toBe(403)
    },
  )

  it('the holder still reads every settings page; root still changes them', async () => {
    for (const url of [
      '/api/agent/providers',
      '/api/agent/search-providers',
      '/api/agent/mcp-servers',
      '/api/agent/tools',
      '/api/agent/platform-skills',
    ])
      expect([url, (await http().get(url).set(bearer(admin))).status]).toEqual([url, 200])
    // nothing was written by the refused requests
    const [{ n }] = await ds.query<{ n: number }[]>(
      `SELECT (SELECT COUNT(*) FROM agent_provider WHERE name LIKE ?)
            + (SELECT COUNT(*) FROM agent_search_provider WHERE name LIKE ?)
            + (SELECT COUNT(*) FROM agent_mcp_server WHERE name LIKE ?)
            + (SELECT COUNT(*) FROM agent_platform_skill WHERE name LIKE ?) AS n`,
      [`${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`, `${PREFIX}%`],
    )
    expect(Number(n)).toBe(0)
    const created = await send('POST', '/api/agent/platform-skills/import', { text: skillMd }, root)
    expect(created.status).toBe(201)
    const out = await http()
      .get(`/api/agent/platform-skills/${created.body.data.id}/export`)
      .set(bearer(admin))
    expect(out.status).toBe(200)
    expect(out.body.data.name).toBe(`${PREFIX}imp.md`)
  })
})
