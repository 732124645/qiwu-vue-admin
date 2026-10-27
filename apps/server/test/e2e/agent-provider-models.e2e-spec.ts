// Loading a model service's model list for the provider form (see docs/agent.md): the route asks a local
// server speaking the OpenAI-compatible `GET /models` format; the key is the one typed in the form, or
// the stored key of the provider only while the address is still its stored one (a changed address never
// receives the stored key); upstream failures come back as short translated errors without the upstream
// body; root-only platform route, multi-tenancy on.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentProviderModule } from '../../src/core/agent/provider/agent-provider.module.js'
import { AgentProviderController } from '../../src/core/agent/provider/provider.controller.js'
import { PLATFORM_ONLY } from '../../src/core/auth/platform-only.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, createTenant, type PeopledTenant } from '../setup/tenants.js'

const PREFIX = 'e2e-agmodels-'
const KEY = 'e2e-stored-key-not-real-0123456789'
const TYPED = 'e2e-typed-key-not-real-9876543210'

let app: NestExpressApplication
let ds: DataSource
let root: string
let reader: string
let readerId = 0
let other: PeopledTenant
let otherAdmin: string

// ---- the local model service ----
let stub: Server
let origin = ''
let baseUrl = ''
let handler: (res: ServerResponse) => void = (res) => res.end()
const seen: { url?: string; auth?: string }[] = []
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const list = (ids: object[]) => (res: ServerResponse) =>
  json(res, 200, { object: 'list', data: ids })

const http = () => request(app.getHttpServer())
const load = (body: object, token = root) =>
  http().post('/api/agent/providers/models').set(bearer(token)).send(body)
const addProvider = async (name: string, extra: object = {}) => {
  const res = await http()
    .post('/api/agent/providers')
    .set(bearer(root))
    .send({ name: `${PREFIX}${name}`, baseUrl, models: [{ id: 'm' }], ...extra })
  expect(res.status).toBe(201)
  return res.body.data.id as number
}

beforeAll(async () => {
  stub = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ url: req.url, auth: req.headers.authorization })
    handler(res)
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`
  baseUrl = `${origin}/v1`
  const env = { ...process.env, APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentProviderModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  root = (await signIn(app)).accessToken
  readerId = await addUser(app, 1, `${PREFIX}reader`)
  reader = (await signIn(app, `${PREFIX}reader`)).accessToken
  other = await createTenant(app, { users: true })
  otherAdmin = (await signIn(app, 'admin', {}, other.id)).accessToken
})

afterAll(async () => {
  await ds?.query('DELETE FROM agent_provider WHERE name LIKE ?', [`${PREFIX}%`])
  if (readerId) await ds.query('DELETE FROM iam_user WHERE id = ?', [readerId])
  await other?.dispose()
  await app?.close()
  stub?.closeAllConnections()
  await new Promise((r) => stub?.close(r))
})

beforeEach(() => {
  seen.length = 0
  handler = (res) => res.end()
})

describe('POST /api/agent/providers/models', () => {
  it('lists the models with the typed key: sorted, de-duplicated, unstorable ids dropped', async () => {
    handler = list([
      { id: 'zeta', owned_by: 'acme' },
      { id: 'alpha', object: 'model' },
      { id: 'zeta', owned_by: 'acme' },
      { id: ' ' },
      { id: 'x'.repeat(129) },
    ])
    const res = await load({ baseUrl: `${baseUrl}/`, apiKey: TYPED })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ items: [{ id: 'alpha' }, { id: 'zeta', ownedBy: 'acme' }] })
    expect(seen).toEqual([{ url: '/v1/models', auth: `Bearer ${TYPED}` }])
  })

  it('caps the list', async () => {
    handler = list(
      Array.from({ length: 600 }, (_, i) => ({ id: `m-${String(i).padStart(3, '0')}` })),
    )
    const res = await load({ baseUrl, apiKey: TYPED })
    expect(res.body.data.items).toHaveLength(500)
    expect(res.body.data.items[0]).toEqual({ id: 'm-000' })
  })

  it('refuses an answer over 2 MB, declared or streamed, as a failing service', async () => {
    const big = JSON.stringify({ data: [{ id: 'a' }], pad: 'x'.repeat(2 * 1024 * 1024) })
    // a declared length over the cap, then a chunked answer without a length
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(big)
    }
    const declared = await load({ baseUrl, apiKey: TYPED })
    expect([declared.status, declared.body.code]).toEqual([502, Err.AGENT_PROVIDER_FAILED.code])
    handler = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      for (let i = 0; i < big.length; i += 65_536) res.write(big.slice(i, i + 65_536))
      res.end()
    }
    const streamed = await load({ baseUrl, apiKey: TYPED })
    expect([streamed.status, streamed.body.code]).toEqual([502, Err.AGENT_PROVIDER_FAILED.code])
    // just under the cap is fine
    handler = list([{ id: 'small' }])
    expect((await load({ baseUrl, apiKey: TYPED })).body.data.items).toEqual([{ id: 'small' }])
  })

  it('uses the stored key for the stored address, sends no key when none is stored', async () => {
    handler = list([{ id: 'stored-1' }])
    const id = await addProvider('stored', { apiKey: KEY })
    const res = await load({ id, baseUrl })
    expect(res.status).toBe(200)
    expect(res.body.data.items).toEqual([{ id: 'stored-1' }])
    expect(JSON.stringify(res.body)).not.toContain(KEY)
    const keyless = await addProvider('keyless')
    expect((await load({ id: keyless, baseUrl })).status).toBe(200)
    expect((await load({ baseUrl })).status).toBe(200)
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${KEY}`, undefined, undefined])
  })

  it('never sends the stored key to a changed address', async () => {
    handler = list([{ id: 'elsewhere-1' }])
    const id = await addProvider('moved', { apiKey: KEY })
    const moved = `${origin}/elsewhere/v1`
    const refused = await load({ id, baseUrl: moved })
    expect(refused.status).toBe(422)
    expect(refused.body.code).toBe(Err.AGENT_KEY_REQUIRED.code)
    expect(seen).toEqual([])
    const typed = await load({ id, baseUrl: moved, apiKey: TYPED })
    expect(typed.status).toBe(200)
    expect(seen).toEqual([{ url: '/elsewhere/v1/models', auth: `Bearer ${TYPED}` }])
  })

  it('a refused key and a failing service answer short translated errors without the upstream body', async () => {
    const detail = { error: { message: `upstream-detail ${TYPED}` } }
    handler = (res) => json(res, 401, detail)
    const rejected = await load({ baseUrl, apiKey: TYPED }).set('Accept-Language', 'en-US')
    expect(rejected.status).toBe(422)
    expect(rejected.body.code).toBe(Err.AGENT_PROVIDER_KEY_REJECTED.code)
    expect(rejected.body.msg).toBe(
      'The model service rejected the key. Check the key and the address',
    )
    for (const answer of [
      (res: ServerResponse) => json(res, 500, detail),
      (res: ServerResponse) => json(res, 200, { models: ['not-the-format'] }),
      (res: ServerResponse) => res.end('not json'),
      (res: ServerResponse) => {
        res.writeHead(302, { Location: `${origin}/v1/models` })
        res.end()
      },
    ]) {
      handler = answer
      const res = await load({ baseUrl, apiKey: TYPED })
      expect(res.status).toBe(502)
      expect(res.body.code).toBe(Err.AGENT_PROVIDER_FAILED.code)
      expect(JSON.stringify(res.body)).not.toContain('upstream-detail')
    }
    // a redirect is not followed: the key does not travel on
    expect(seen.filter((s) => s.auth)).toHaveLength(5)
  })

  it('400 for a bad body, 404 for a missing provider', async () => {
    for (const body of [{}, { baseUrl: 'ftp://x/v1' }, { baseUrl, id: 'one' }])
      expect((await load(body)).status).toBe(400)
    expect((await load({ id: 999_999_999, baseUrl })).status).toBe(404)
    expect(seen).toEqual([])
  })

  it('403 without agent.setting.modify and for a user of another tenant; root-only', async () => {
    for (const token of [reader, otherAdmin])
      expect((await load({ baseUrl, apiKey: TYPED }, token)).status).toBe(403)
    expect(seen).toEqual([])
    expect(Reflect.getMetadata(PLATFORM_ONLY, AgentProviderController.prototype.models)).toBe(
      'root',
    )
  })
})
