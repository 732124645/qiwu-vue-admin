// Files attached to an agent chat message, multi-tenancy on, with a scripted FakeChatModel for the
// provider: text files (UTF-8 or GBK) reach the model request as untrusted blocks, capped and marked when
// truncated; the first sheet of an xlsx as CSV; images become image parts only for a vision model (a
// model without vision refuses the message with 422 before a turn starts); other kinds are named only.
// The user item stores the files' metadata, never their content, and later turns name them only. A file
// the sender cannot read (another user's private file, another tenant's, unknown) is 404.
import { randomUUID } from 'node:crypto'
import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import type { ChatContentPart, ChatMessage } from '../../src/core/agent/provider/chat-model.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import {
  ATTACH_BINARY_MAX,
  ATTACH_TEXT_MAX,
} from '../../src/modules/platform/storage/agent-attachments.js'
import { LocalStorage } from '../../src/modules/platform/storage/local-storage.js'
import { bearer, signIn } from '../setup/auth.js'
import { addRow, addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})

const PREFIX = 'e2e_agat_'
// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

let app: NestExpressApplication
let ds: DataSource
let providerId = 0
let storageId = 0
let ownerId = 0
let otherId = 0
let owner = ''
let roleId = 0
let tenant: PeopledTenant
let fake = new FakeChatModel([])
const threads: number[] = []
const files: { id: number; key: string }[] = []
const local = new LocalStorage()

const http = () => request(app.getHttpServer())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const script = (...turns: FakeTurn[]) => (fake = new FakeChatModel(turns))

/** A thread of the owner in the default tenant on model `model` of the spec's provider. */
async function thread(model = 'm1'): Promise<number> {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'agent_thread', {
      user_id: ownerId,
      title: '',
      provider_id: providerId,
      model,
    }),
  )
  threads.push(id)
  return id
}

/** A private stored file (local storage) of `uploaderId` in `tenantId`; returns its id. */
async function file(
  name: string,
  data: Buffer,
  mime: string,
  uploaderId = ownerId,
  tenantId = 1,
): Promise<number> {
  const key = `${new Date().toISOString().slice(0, 10).replaceAll('-', '/')}/${randomUUID()}.${name.split('.').pop()}`
  await local.put(key, data, false)
  const id = await addRow(app, tenantId, 'fs_object', {
    storage_id: storageId,
    object_key: key,
    original_name: name,
    mime,
    size: data.length,
    is_public: 0,
    biz_tag: 'attachment',
    uploader_id: uploaderId,
  })
  files.push({ id, key })
  return id
}

const send = (id: number, text: string, fileIds: number[]) =>
  http().post(`/api/agent/threads/${id}/messages`).set(bearer(owner)).send({ text, fileIds })

const TERMINAL = ['completed', 'failed', 'cancelled']
async function settled(turnId: number, ms = 15_000) {
  for (const until = Date.now() + ms; ; await sleep(40)) {
    const [t] = await ds.query<{ status: string }[]>('SELECT status FROM agent_turn WHERE id = ?', [
      turnId,
    ])
    if (t && TERMINAL.includes(t.status)) return t.status
    if (Date.now() > until) throw new Error(`turn ${turnId} is still ${t?.status}`)
  }
}

/** Sends with files, waits for the turn to complete and returns the last user message the model got. */
async function turnWith(id: number, text: string, fileIds: number[]) {
  const res = await send(id, text, fileIds)
  expect(res.status).toBe(201)
  expect(await settled(res.body.data.id as number)).toBe('completed')
  const req = fake.requests.at(-1)!
  return req.messages
    .filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user')
    .at(-1)!.content
}
const textOf = (c: string | ChatContentPart[]) =>
  typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join('')

async function userPayloads(threadId: number): Promise<any[]> {
  const rows = await ds.query<{ payload: any }[]>(
    "SELECT payload FROM agent_item WHERE thread_id = ? AND kind = 'user' ORDER BY seq",
    [threadId],
  )
  return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload))
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

  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: `${PREFIX}provider`,
    base_url: 'http://127.0.0.1:9/v1',
    models: [
      { id: 'm1', label: 'm1', reasoning: false, contextWindow: 64_000 },
      { id: 'v1', label: 'v1', reasoning: false, vision: true, contextWindow: 64_000 },
    ],
    enabled: 1,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)
  const [primary] = await ds.query<{ id: number; driver: string }[]>(
    'SELECT id, driver FROM fs_storage WHERE is_primary = 1 AND enabled = 1 AND deleted_at IS NULL',
  )
  if (primary?.driver !== 'local')
    throw new Error('the spec writes files to a local primary storage')
  storageId = primary!.id

  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}chat`,
      name: `${PREFIX}chat`,
      data_scope: 'all',
    }),
  )
  const [chatMenu] = await ds.query<{ id: number }[]>(
    "SELECT id FROM iam_menu WHERE perms = 'agent.chat.use' AND deleted_at IS NULL",
  )
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, 1)', [
    roleId,
    chatMenu!.id,
  ])
  ownerId = await addUser(app, 1, `${PREFIX}owner`, { roleId })
  otherId = await addUser(app, 1, `${PREFIX}other`, { roleId })
  owner = (await signIn(app, `${PREFIX}owner`)).accessToken
  tenant = await createTenant(app, { users: true })
})

afterAll(async () => {
  if (ds) {
    if (threads.length) {
      await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
    }
    if (files.length)
      await ds.query('DELETE FROM fs_object WHERE id IN (?)', [files.map((f) => f.id)])
    for (const f of files) await local.remove(f.key, false)
    const users = [ownerId, otherId].filter(Boolean)
    if (users.length) {
      await ds.query('DELETE FROM agent_usage WHERE user_id IN (?) AND tenant_id = 1', [users])
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
    await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
  }
  await tenant?.dispose()
  await app?.close()
})

describe('text attachments', () => {
  it('a text file reaches the model as an untrusted block; the item keeps its metadata only; later turns name it', async () => {
    const note = await file('notes.md', Buffer.from('# Plan\nship on friday'), 'text/markdown')
    // GBK bytes of two CJK characters (a Windows-made txt)
    const gbk = await file('legacy.txt', Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), 'text/plain')
    script({ text: 'Read them.' }, { text: 'Sure.' })
    const id = await thread()
    const content = await turnWith(id, 'summarize these', [note, gbk])
    expect(typeof content).toBe('string')
    expect(content).toContain('summarize these')
    expect(content).toContain(
      '<external-content source="user file: notes.md">\n# Plan\nship on friday\n</external-content>',
    )
    expect(content).toContain('untrusted content')
    expect(content).toContain('中文')

    const [first] = await userPayloads(id)
    expect(first.attachments).toEqual([
      { fileId: note, name: 'notes.md', mime: 'text/markdown', size: 21 },
      { fileId: gbk, name: 'legacy.txt', mime: 'text/plain', size: 4 },
    ])
    expect(JSON.stringify(first)).not.toContain('ship on friday')

    // the next turn replays the earlier message with the file names only
    await turnWith(id, 'and now?', [])
    const replay = fake.requests[1]!.messages.filter((m) => m.role === 'user')
    expect(replay[0]!.content).toBe(
      'summarize these\n\n[Files attached earlier (content not repeated): notes.md, legacy.txt]',
    )
    expect(JSON.stringify(fake.requests[1]!.messages)).not.toContain('ship on friday')
  })

  it('a text file over the cap is truncated with a note; the first sheet of an xlsx comes as CSV', async () => {
    const big = await file('big.log', Buffer.alloc(ATTACH_TEXT_MAX + 5000, 'a'), 'text/plain')
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('First')
    ws.addRow(['name', 'note'])
    ws.addRow(['Acme', 'a, b'])
    wb.addWorksheet('Second').addRow(['hidden'])
    const xlsx = await file(
      'sheet.xlsx',
      Buffer.from(await wb.xlsx.writeBuffer()),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    script({ text: 'ok' })
    const content = textOf(await turnWith(await thread(), 'check', [big, xlsx]))
    expect(content).toContain(
      `[truncated: the file has ${ATTACH_TEXT_MAX + 5000} bytes, only the first ${ATTACH_TEXT_MAX} are included]`,
    )
    expect(content).toContain('a'.repeat(ATTACH_TEXT_MAX))
    expect(content).not.toContain('a'.repeat(ATTACH_TEXT_MAX + 1))
    expect(content).toContain('name,note\nAcme,"a, b"')
    expect(content).not.toContain('hidden')
  })

  it('unsupported kinds and images over the cap are named only', async () => {
    const pdf = await file('report.pdf', Buffer.from('%PDF-1.4 secret body'), 'application/pdf')
    const huge = await file(
      'huge.png',
      Buffer.concat([PNG, Buffer.alloc(ATTACH_BINARY_MAX)]),
      'image/png',
    )
    script({ text: 'ok' })
    const content = await turnWith(await thread('v1'), 'look', [pdf, huge])
    expect(typeof content).toBe('string')
    expect(content).toContain(
      '"report.pdf" (application/pdf, 20 bytes); its content cannot be read here',
    )
    expect(content).toContain(`"huge.png" (image/png, ${PNG.length + ATTACH_BINARY_MAX} bytes)`)
    expect(content).not.toContain('secret body')
  })
})

describe('image attachments', () => {
  it('an image goes to a vision model as an image part', async () => {
    const png = await file('dot.png', PNG, 'image/png')
    script({ text: 'A dot.' })
    const content = await turnWith(await thread('v1'), 'what is this?', [png])
    expect(content).toEqual([
      { type: 'text', text: expect.stringContaining('"dot.png" (image/png') },
      { type: 'image', dataUrl: `data:image/png;base64,${PNG.toString('base64')}` },
    ])
  })

  it('a model without vision refuses an image with 422 before a turn starts', async () => {
    const png = await file('dot2.png', PNG, 'image/png')
    script()
    const id = await thread('m1')
    const res = await send(id, 'what is this?', [png])
    expect(res.status).toBe(422)
    expect(await ds.query('SELECT id FROM agent_turn WHERE thread_id = ?', [id])).toEqual([])
    expect(await userPayloads(id)).toEqual([])
    expect(fake.requests).toEqual([])
  })
})

describe('access', () => {
  it("another user's private file, another tenant's file and an unknown id are 404", async () => {
    const mine = await file('mine.txt', Buffer.from('mine'), 'text/plain')
    const others = await file('theirs.txt', Buffer.from('theirs'), 'text/plain', otherId)
    const foreign = await file('foreign.txt', Buffer.from('foreign'), 'text/plain', 1, tenant.id)
    script()
    const id = await thread()
    for (const ids of [[mine, others], [foreign], [mine, 999_999_999]]) {
      const res = await send(id, 'read', ids)
      expect(res.status).toBe(404)
    }
    expect(await userPayloads(id)).toEqual([])
    expect(fake.requests).toEqual([])
  })
})
