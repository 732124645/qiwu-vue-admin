// End to end with the SDK's own client over HTTP (see docs/mcp.md): a personal access token as the
// Bearer header, then initialize, tools/list and tools/call the way an agent host does, the structured
// answers checked against the tools' output schemas by the client itself; a refused call comes back as a
// tool error, a wrong token fails the connection.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import type { AddressInfo } from 'node:net'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { patFor } from './mcp-kit.js'

let app: NestExpressApplication
let ds: DataSource
let url: URL
let adminId = 0

const connect = async (token: string) => {
  const client = new Client({ name: 'spec-agent', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

beforeAll(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.listen(0, '127.0.0.1')
  const { port } = app.getHttpServer().address() as AddressInfo
  url = new URL(`http://127.0.0.1:${port}/api/mcp`)
  ds = app.get<DataSource>(getDataSourceToken())
  adminId = Number(
    (
      await ds.query<{ id: number }[]>(
        "SELECT id FROM iam_user WHERE username = 'admin' AND tenant_id = 1",
      )
    )[0]!.id,
  )
})

afterAll(async () => {
  await ds?.query('DELETE FROM iam_access_token WHERE user_id = ?', [adminId])
  await app?.close()
})

it('initializes, lists and calls tools with the SDK client', async () => {
  const { token } = await patFor(app, adminId, { tools: ['iam.me.get', 'cfg.dict.options'] })
  const client = await connect(token)
  try {
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } })
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['cfg.dict.options', 'iam.me.get'])
    expect(tools.find((t) => t.name === 'iam.me.get')?.annotations?.readOnlyHint).toBe(true)

    const me = await client.callTool({ name: 'iam.me.get', arguments: {} })
    expect(me.isError).toBeFalsy()
    expect(me.structuredContent).toMatchObject({ id: adminId, username: 'admin' })

    const options = await client.callTool({
      name: 'cfg.dict.options',
      arguments: { code: 'core.enabled' },
    })
    expect((options.structuredContent as { entries: unknown[] }).entries.length).toBeGreaterThan(0)

    // not listed by the token: a tool error the agent can read, not a broken connection
    const refused = await client.callTool({ name: 'iam.user.search', arguments: {} })
    expect(refused.isError).toBe(true)
    const text = (refused.content as { type: string; text: string }[])[0]!.text
    expect(JSON.parse(text)).toMatchObject({ code: Err.MCP_TOOL_NOT_ALLOWED.code })
  } finally {
    await client.close()
  }
})

it('a wrong token fails the connection', async () => {
  await expect(connect(`qwmcp_${'x'.repeat(43)}`)).rejects.toThrow()
})
