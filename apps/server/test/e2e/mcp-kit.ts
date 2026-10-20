// The MCP endpoint for e2e specs: personal access tokens made through the real service (in their user's
// tenant) and JSON-RPC requests over supertest, with the headers the Streamable HTTP transport expects.
import type { INestApplication } from '@nestjs/common'
import type { AccessTokenCreate } from '@qiwu/shared'
import request from 'supertest'
import { AccessTokenService } from '../../src/core/mcp/access-token.service.js'
import { withTenant } from '../../src/core/context/tenant.js'

/** A new personal access token of user `userId` (tenant `tenantId`); returns the token and its id. */
export async function patFor(
  app: INestApplication,
  userId: number,
  opts: Partial<AccessTokenCreate> = {},
  tenantId = 1,
): Promise<{ token: string; id: number }> {
  const t = await withTenant(tenantId, () =>
    app.get(AccessTokenService).create(userId, {
      name: 'spec token',
      allowWrite: false,
      currentPassword: 'unused',
      ...opts,
    }),
  )
  return { token: t.token, id: t.id }
}

let seq = 0

/** A JSON-RPC request to POST /api/mcp with `token` as the Bearer token (none when null). */
export function rpc(
  app: INestApplication,
  token: string | null,
  method: string,
  params?: Record<string, unknown>,
): request.Test {
  const r = request(app.getHttpServer())
    .post('/api/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json')
  if (token) r.set('Authorization', `Bearer ${token}`)
  return r.send({ jsonrpc: '2.0', id: ++seq, method, ...(params && { params }) })
}

/** What a `tools/call` answered: the tool's JSON (`data`), or its error (`error.code`), or the protocol error. */
export interface CallOutcome {
  status: number
  /** the parsed text content of a successful call */
  data?: unknown
  structured?: unknown
  /** the tool error of a refused or failed call */
  error?: { code: string; message: string; errors?: { path: string; msg: string }[] }
  /** a JSON-RPC error (unknown tool, …) */
  rpcError?: { code: number; message: string }
}

export async function callTool(
  app: INestApplication,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallOutcome> {
  const res = await rpc(app, token, 'tools/call', { name, arguments: args })
  const out: CallOutcome = { status: res.status }
  const body = res.body as {
    result?: { isError?: boolean; content?: { text: string }[]; structuredContent?: unknown }
    error?: { code: number; message: string }
  }
  if (body.error) out.rpcError = body.error
  const text = body.result?.content?.[0]?.text
  if (text !== undefined) {
    if (body.result?.isError) out.error = JSON.parse(text) as CallOutcome['error']
    else out.data = JSON.parse(text)
  }
  out.structured = body.result?.structuredContent
  return out
}

/** The names `tools/list` gives `token`. */
export async function toolNames(app: INestApplication, token: string): Promise<string[]> {
  const res = await rpc(app, token, 'tools/list').expect(200)
  return (res.body.result.tools as { name: string }[]).map((t) => t.name).sort()
}
