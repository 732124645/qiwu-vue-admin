import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core'
import { I18nService } from 'nestjs-i18n'
import { getDataSourceToken } from '@nestjs/typeorm'
import { agentPerms, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { z } from 'zod'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import {
  AutomationPreApproval,
  loadPrincipal,
} from '../../src/core/agent/automation/pre-approval.js'
import type { AgentAutomation } from '../../src/core/agent/automation/automation.entity.js'
import { AgentBatchService } from '../../src/core/agent/batch/batch.service.js'
import { AgentBatchTargets } from '../../src/core/agent/batch/batch-targets.js'
import { AgentExtensions } from '../../src/core/agent/runtime/agent-extensions.js'
import { HumanConfirmation } from '../../src/core/agent/runtime/human-confirmation.js'
import { TurnControlService } from '../../src/core/agent/runtime/turn-control.service.js'
import { TurnQueue } from '../../src/core/agent/runtime/turn-queue.js'
import { keepForSubagent, type OfferedTool } from '../../src/core/agent/runtime/turn-tools.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { USER_LOOKUP, type UserLookup } from '../../src/core/auth/user-lookup.js'
import { AuditWriter } from '../../src/core/audit/audit-writer.js'
import { AppConfigService } from '../../src/core/config/config.module.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { ItemStore } from '../../src/core/agent/runtime/item-store.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { McpModule } from '../../src/core/mcp/mcp.module.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import type { ToolExecutionContext } from '../../src/core/mcp/mcp-tool.js'
import { ToolHost } from '../../src/core/mcp/tool-host.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { bearer, signIn } from '../setup/auth.js'
import { callTool, patFor } from './mcp-kit.js'
import {
  addRow,
  addUser,
  createTenant,
  inTenant1,
  TENANT_PASSWORD,
  type PeopledTenant,
} from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})

const NAME = 'test.confirm.create'
const PREFIX = 'e2e-confirm-'
let app: NestExpressApplication
let ds: DataSource
let ownerId: number
let owner: string
let otherUser: string
let foreign: PeopledTenant
let foreignUser: string
let providerId: number
let roleId: number
let fake = new FakeChatModel([])
let version = 1
let attachmentVersion = 1
let previewFails = false
const written: { args: unknown; context: ToolExecutionContext | undefined }[] = []
const threads: number[] = []
const batches: number[] = []
const http = () => request(app.getHttpServer())
const script = (...steps: FakeTurn[]) => {
  fake = new FakeChatModel(steps)
}
const call = () => ({ name: NAME, args: { id: 7, amount: '1.00' } })
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function rows(threadId: number, kind?: string) {
  const all = await ds.query<any[]>(
    'SELECT id, kind, status, turn_id, payload FROM agent_item WHERE thread_id = ? AND deleted_at IS NULL ORDER BY seq',
    [threadId],
  )
  for (const row of all) if (typeof row.payload === 'string') row.payload = JSON.parse(row.payload)
  return kind ? all.filter((row) => row.kind === kind) : all
}
async function pending(threadId: number, after = 0, token?: string) {
  for (const until = Date.now() + 12_000; ; await pause(25)) {
    const found = (await rows(threadId, 'approval')).find(
      (row) =>
        row.status === 'pending' &&
        row.id > after &&
        (!token || row.payload.confirmationToken !== token),
    )
    if (found) return found
    if (Date.now() > until) throw new Error('A current confirmation card did not appear')
  }
}
async function waitingOrEnded(turnId: number) {
  for (const until = Date.now() + 12_000; ; await pause(25)) {
    const [row] = await ds.query<{ status: string }[]>(
      'SELECT status FROM agent_turn WHERE id = ?',
      [turnId],
    )
    if (['waiting', 'completed', 'failed', 'cancelled'].includes(row?.status ?? ''))
      return row!.status
    if (Date.now() > until) throw new Error('Turn did not settle')
  }
}
async function ended(turnId: number) {
  for (const until = Date.now() + 12_000; ; await pause(25)) {
    const [row] = await ds.query<{ status: string }[]>(
      'SELECT status FROM agent_turn WHERE id = ?',
      [turnId],
    )
    if (['completed', 'failed', 'cancelled'].includes(row?.status ?? '')) return row!.status
    if (Date.now() > until) throw new Error(`Turn did not finish: ${row?.status}`)
  }
}
async function begin(extra: object = {}) {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'agent_thread', {
      user_id: ownerId,
      provider_id: providerId,
      model: 'm1',
      title: '',
      ...extra,
    }),
  )
  threads.push(id)
  const res = await http()
    .post(`/api/agent/threads/${id}/messages`)
    .set(bearer(owner))
    .send({ text: 'Create this request.' })
    .expect(201)
  return { id, turnId: Number(res.body.data.id) }
}
const decide = (
  card: any,
  decision = 'approve',
  token: string | undefined = card.payload.confirmationToken,
  actor = owner,
) =>
  http()
    .post(`/api/agent/approvals/${card.id}`)
    .set(bearer(actor))
    .send({ decision, ...(token && { confirmationToken: token }) })
const principal = async () => (await inTenant1(() => loadPrincipal(app.get(PermVersion), ownerId)))!

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MCP: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule, McpModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  app.get(McpRegistry).add(
    {
      name: NAME,
      title: 'Create request',
      description: 'Creates one request after personal confirmation.',
      perm: agentPerms.chat.use,
      kind: 'write',
      perCallConfirmation: true,
      confirmationRevision: '1',
      preview: 'preview',
      input: z.object({ id: z.number().int(), amount: z.string() }),
    },
    (args, context) => {
      written.push({ args, context })
      return { ok: true }
    },
    undefined,
    () => {
      if (previewFails) throw new Error('Preview unavailable')
      return {
        target: 'Request (#7)',
        fields: [
          { field: 'modelVersion', from: null, to: version },
          { field: 'attachment', from: null, to: { id: 4, version: attachmentVersion } },
        ],
      }
    },
  )
  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: `${PREFIX}provider`,
    base_url: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm1', label: 'm1', contextWindow: 64000, pricing: TEST_AGENT_PRICING }],
    enabled: 1,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)
  roleId = await inTenant1(() =>
    insertRow(ds.manager, 'iam_role', {
      code: `${PREFIX}role`,
      name: 'Confirmation test',
      data_scope: 'all',
    }),
  )
  const [chatMenu] = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
    [agentPerms.chat.use],
  )
  await addRow(app, 1, 'iam_role_menus', { role_id: roleId, menu_id: chatMenu!.id })
  ownerId = await addUser(app, 1, `${PREFIX}owner`, { roleId })
  await addUser(app, 1, `${PREFIX}other`, { roleId })
  owner = (await signIn(app, `${PREFIX}owner`)).accessToken
  otherUser = (await signIn(app, `${PREFIX}other`)).accessToken
  foreign = await createTenant(app, { users: true })
  await addRow(app, foreign.id, 'iam_role_menus', {
    role_id: foreign.roleId,
    menu_id: chatMenu!.id,
  })
  foreignUser = (await signIn(app, 'admin', {}, foreign.id)).accessToken
})

beforeEach(async () => {
  written.length = 0
  version = 1
  attachmentVersion = 1
  previewFails = false
  await ds.query('DELETE FROM cfg_mcp_tool WHERE name = ?', [NAME])
  app.get(ToolHost).forgetSwitches()
})

afterEach(async () => {
  for (const id of threads) {
    const [active] = await ds.query<{ id: number }[]>(
      "SELECT id FROM agent_turn WHERE thread_id = ? AND status IN ('running','waiting') AND deleted_at IS NULL",
      [id],
    )
    if (active) {
      await http().post(`/api/agent/threads/${id}/cancel`).set(bearer(owner)).send({})
      await ended(active.id)
    }
  }
})

afterAll(async () => {
  await foreign?.dispose()
  if (threads.length) {
    await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
    await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threads])
    await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
  }
  if (batches.length) await ds.query('DELETE FROM agent_batch WHERE id IN (?)', [batches])
  await ds.query('DELETE FROM cfg_mcp_tool WHERE name = ?', [NAME])
  for (const table of ['agent_usage_entry', 'agent_usage'])
    await ds.query(`DELETE FROM ${table} WHERE tenant_id = 1 AND provider_id = ?`, [providerId])
  await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
  await app?.close()
})

describe('per-call human confirmation', () => {
  it('rejects invalid declarations, direct MCP/PAT writes and client confirmation flags', async () => {
    const reg = app.get(McpRegistry)
    expect(() =>
      reg.add(
        {
          name: 'test.confirm.invalid',
          title: 'Bad',
          description: 'Bad',
          perm: null,
          kind: 'read',
          input: z.object({}),
          perCallConfirmation: true,
          confirmationRevision: '1',
          preview: 'preview',
        },
        () => ({}),
        undefined,
        () => ({}),
      ),
    ).toThrow(/write tool/)
    expect(() =>
      reg.add(
        {
          name: 'test.confirm.missing',
          title: 'Bad',
          description: 'Bad',
          perm: null,
          kind: 'write',
          input: z.object({}),
          perCallConfirmation: true,
        },
        () => ({}),
      ),
    ).toThrow(/preview/)
    for (const revision of [undefined, '', 'white space', '1\n', 'x'.repeat(65), 'v\u00e9']) {
      expect(() =>
        reg.add(
          {
            name: 'test.confirm.bad-revision',
            title: 'Bad revision',
            description: 'Bad revision',
            perm: null,
            kind: 'write',
            input: z.object({}),
            preview: 'preview',
            perCallConfirmation: true,
            confirmationRevision: revision,
          },
          () => ({}),
          undefined,
          () => ({ target: 'Record', fields: [] }),
        ),
      ).toThrow(/confirmationRevision/)
    }
    const pat = await patFor(app, ownerId, {
      tools: [NAME],
      allowWrite: true,
      currentPassword: TENANT_PASSWORD,
    })
    for (const args of [
      { id: 7, amount: '1.00' },
      { id: 7, amount: '1.00', confirmed: true },
      {
        id: 7,
        amount: '1.00',
        prepared: true,
        confirmationRevision: '999',
        canonical: { id: 7, amount: '0.01' },
      },
    ]) {
      const out = await callTool(app, pat.token, NAME, args)
      expect(out.error?.code).toBe(Err.FORBIDDEN.code)
    }
    const p = await principal()
    await expect(
      inTenant1(() =>
        app.get(HumanConfirmation).prepare(
          p,
          {
            threadId: 1,
            turnId: 1,
            callId: 'invalid-input',
          },
          NAME,
          { id: 'invalid', amount: '1.00' },
        ),
      ),
    ).rejects.toMatchObject({ err: Err.VALIDATION_FAILED })
    expect(written).toHaveLength(0)
  })

  it('ignores a session allowance and requires a fresh personal card for each call', async () => {
    script({ toolCalls: [call()] }, { toolCalls: [call()] }, { text: 'Done.' })
    const t = await begin({ trusted: [`1#${NAME}`] })
    expect(await waitingOrEnded(t.turnId)).toBe('waiting')
    const first = await pending(t.id)
    expect(first.payload.perCallConfirmation).toBe(true)
    expect(first.payload.sessionAllow).toBeUndefined()
    const visible = await http()
      .get(`/api/agent/threads/${t.id}/items`)
      .set(bearer(owner))
      .expect(200)
    expect(JSON.stringify(visible.body)).not.toContain('"internal"')
    await decide(first, 'approve_session').expect(400)
    await decide(first, 'approve', '').expect(409)
    await decide(first, 'approve', first.payload.confirmationToken, otherUser).expect(404)
    await decide(first, 'approve', first.payload.confirmationToken, foreignUser).expect(404)
    await decide(first).expect(201)
    const second = await pending(t.id, first.id)
    expect(written).toHaveLength(1)
    expect(second.payload.confirmationToken).not.toBe(first.payload.confirmationToken)
    await decide(second).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(written).toHaveLength(2)
    expect(written[0]!.context?.confirmation?.preview.fields[0]!.to).toBe(1)
    await decide(first).expect(409)
    expect(written).toHaveLength(2)
  })

  it('a message while the personal card waits rejects it with the message as the note', async () => {
    script({ toolCalls: [call()] }, { text: 'Left it.' })
    const t = await begin()
    expect(await waitingOrEnded(t.turnId)).toBe('waiting')
    const card = await pending(t.id)
    await http()
      .post(`/api/agent/threads/${t.id}/messages`)
      .set(bearer(owner))
      .send({ text: 'not this one' })
      .expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(written).toHaveLength(0)
    const [after] = (await rows(t.id, 'approval')) as { status: string; payload: any }[]
    expect([after!.status, after!.payload.note]).toEqual(['rejected', 'not this one'])
    await decide(card).expect(409)
  })

  it('renews the token when model, attachment or permission facts changed before the click', async () => {
    script({ toolCalls: [call()] }, { text: 'Done.' })
    const t = await begin()
    let card = await pending(t.id)
    for (const change of [
      () => {
        version++
      },
      () => {
        attachmentVersion++
      },
      () => app.get(PermVersion).bumpUser(ownerId),
    ]) {
      await change()
      const old = card
      await decide(old).expect(409)
      card = await pending(t.id, 0, old.payload.confirmationToken)
      await decide(card, 'approve', old.payload.confirmationToken).expect(409)
      expect(written).toHaveLength(0)
    }
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(written).toHaveLength(1)
  })

  it('returns to a fresh pending card when facts changed after approval but before execution', async () => {
    script({ toolCalls: [call()] }, { text: 'Done.' })
    const t = await begin()
    const card = await pending(t.id)
    const queue = app.get(TurnQueue)
    const held = vi.spyOn(queue, 'resume').mockResolvedValueOnce('skip')
    await decide(card).expect(201)
    held.mockRestore()
    version++
    await inTenant1(() => queue.resume(t.turnId, ownerId))
    const renewed = await pending(t.id, 0, card.payload.confirmationToken)
    expect(written).toHaveLength(0)
    await decide(renewed).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(written).toHaveLength(1)
  })

  it('consumes approval once under concurrent clicks and refuses a used receipt', async () => {
    script({ toolCalls: [call()] }, { text: 'Done.' })
    const t = await begin()
    const card = await pending(t.id)
    const out = await Promise.all([decide(card), decide(card)])
    expect(out.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await ended(t.turnId)).toBe('completed')
    const p = await principal()
    await expect(
      inTenant1(() =>
        app.get(HumanConfirmation).claim(
          p,
          {
            threadId: t.id,
            turnId: t.turnId,
            callId: card.payload.callId,
          },
          card.id,
          NAME,
          card.payload.args,
        ),
      ),
    ).rejects.toMatchObject({ err: Err.AGENT_APPROVAL_CLOSED })
    expect(written).toHaveLength(1)
  })

  it('binds changed canonical arguments and the tool schema to a new preview', async () => {
    script({ toolCalls: [call()] }, { text: 'Done.' })
    const t = await begin()
    const initial = await pending(t.id)
    const registered = app.get(McpRegistry).get(NAME)!
    const schema = registered.inputSchema
    registered.inputSchema = { ...schema, description: 'Changed tool contract' }
    try {
      await decide(initial).expect(409)
      const schemaCard = await pending(t.id, 0, initial.payload.confirmationToken)
      const [toolCall] = await rows(t.id, 'tool_call')
      // 即使改变的是解析后会丢弃的原始字段，也不能把另一份调用当成已经同意的那份。
      await ds.query('UPDATE agent_item SET payload = ? WHERE id = ? AND tenant_id = 1', [
        JSON.stringify({ ...toolCall.payload, args: { amount: '1.00', id: 7, prepared: true } }),
        toolCall.id,
      ])
      await decide(schemaCard).expect(201)
      expect(await waitingOrEnded(t.turnId)).toBe('waiting')
      const rawCard = await pending(t.id, 0, schemaCard.payload.confirmationToken)
      expect(rawCard.payload.args).toEqual({ id: 7, amount: '1.00' })
      expect(written).toHaveLength(0)
      await ds.query('UPDATE agent_item SET payload = ? WHERE id = ? AND tenant_id = 1', [
        JSON.stringify({ ...toolCall.payload, args: { amount: '2.00', id: 7 } }),
        toolCall.id,
      ])
      await decide(rawCard).expect(201)
      expect(await waitingOrEnded(t.turnId)).toBe('waiting')
      const changed = await pending(t.id, 0, rawCard.payload.confirmationToken)
      expect(changed.payload.args).toEqual({ id: 7, amount: '2.00' })
      expect(written).toHaveLength(0)
      await decide(changed).expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect(written[0]!.args).toEqual({ id: 7, amount: '2.00' })
    } finally {
      registered.inputSchema = schema
    }
  })

  it('rejects a new opaque validator under a bumped server confirmation revision', async () => {
    script({ toolCalls: [call()] }, { text: 'No write.' })
    const t = await begin()
    const card = await pending(t.id)
    const tool = app.get(McpRegistry).get(NAME)!
    const before = {
      input: tool.input,
      schema: tool.inputSchema,
      revision: tool.confirmationRevision,
    }
    try {
      // 版本本身变化也须重新确认，即使当前参数在新版本里仍然合法。
      tool.confirmationRevision = '2'
      await decide(card).expect(409)
      const revised = await pending(t.id, 0, card.payload.confirmationToken)
      expect(revised.payload.internal.confirmation.revision).toBe('2')
      expect(written).toHaveLength(0)
      tool.input = before.input.refine((input) => input.id !== 7, { error: 'validation.invalid' })
      const { $schema: _, ...schema } = z.toJSONSchema(tool.input, {
        io: 'input',
        unrepresentable: 'any',
      })
      tool.inputSchema = schema
      tool.confirmationRevision = '3'
      expect(tool.inputSchema).toEqual(before.schema)
      expect(tool.input.safeParse({ id: 7, amount: '1.00' }).success).toBe(false)
      expect(tool.input.safeParse({ id: 8, amount: '1.00' }).success).toBe(true)
      // 请求中的版本或 prepared 标志不能覆盖服务端声明的新契约。
      await http()
        .post(`/api/agent/approvals/${revised.id}`)
        .set(bearer(owner))
        .send({
          decision: 'approve',
          confirmationToken: revised.payload.confirmationToken,
          confirmationRevision: '2',
          prepared: true,
        })
        .expect(409)
      const current = await pending(t.id)
      expect(current.payload.confirmationToken).toBe(revised.payload.confirmationToken)
      await decide(current).expect(409)
      expect(written).toHaveLength(0)
    } finally {
      tool.input = before.input
      tool.inputSchema = before.schema
      tool.confirmationRevision = before.revision
    }
  })

  it('rejects a represented JSON constraint change independently of the unchanged confirmation revision', async () => {
    script({ toolCalls: [call()] }, { text: 'No write.' })
    const t = await begin()
    const card = await pending(t.id)
    const tool = app.get(McpRegistry).get(NAME)!
    const before = {
      input: tool.input,
      schema: tool.inputSchema,
      revision: tool.confirmationRevision,
    }
    try {
      tool.input = z.object({ id: z.number().int().max(6), amount: z.string() })
      const { $schema: _, ...schema } = z.toJSONSchema(tool.input, {
        io: 'input',
        unrepresentable: 'any',
      })
      tool.inputSchema = schema
      expect(tool.confirmationRevision).toBe(before.revision)
      expect(tool.inputSchema).not.toEqual(before.schema)
      expect(tool.input.safeParse({ id: 7, amount: '1.00' }).success).toBe(false)
      await decide(card).expect(409)
      const current = await pending(t.id)
      expect(current.payload.confirmationToken).toBe(card.payload.confirmationToken)
      await decide(current).expect(409)
      expect(written).toHaveLength(0)
    } finally {
      tool.input = before.input
      tool.inputSchema = before.schema
    }
  })

  it('rechecks the same stable revision across independent instances despite different dynamic-default schema samples', async () => {
    const name = 'test.confirm.replica'
    const samples: string[] = []
    const input = () =>
      z.object({
        id: z.number().int(),
        amount: z.string(),
        default: z.string().max(6),
        reference: z.string().default(() => {
          const sample = `generated-${samples.length + 1}`
          samples.push(sample)
          return sample
        }),
      })
    const register = (registry: McpRegistry) =>
      registry.add(
        {
          name,
          title: 'Replica request',
          description: 'Generates a request reference.',
          perm: agentPerms.chat.use,
          kind: 'write',
          perCallConfirmation: true,
          confirmationRevision: '1',
          preview: 'preview',
          input: input(),
        },
        (args, context) => {
          written.push({ args, context })
          return { ok: true }
        },
        undefined,
        (args) => ({ target: 'Replica (#7)', fields: [{ field: 'input', from: null, to: args }] }),
      )
    register(app.get(McpRegistry))
    const firstSample = samples.at(-1)
    script(
      { toolCalls: [{ name, args: { id: 7, amount: '1.00', default: 'stable' } }] },
      { text: 'Done.' },
    )
    const t = await begin()
    const card = await pending(t.id)
    const firstTool = app.get(McpRegistry).get(name)!
    const registry = new McpRegistry(
      app.get(DiscoveryService),
      app.get(MetadataScanner),
      app.get(Reflector),
    )
    register(registry)
    const secondSample = samples.at(-1)
    expect(secondSample).not.toBe(firstSample)
    expect(registry.get(name)!.input).not.toBe(firstTool.input)
    expect(registry.get(name)!.inputSchema).toEqual(firstTool.inputSchema)
    const wire = registry.get(name)!.inputSchema as {
      properties: Record<string, any>
      required: string[]
    }
    expect(wire.properties.reference.default).toBeUndefined()
    expect(wire.properties.default).toMatchObject({ type: 'string', maxLength: 6 })
    expect(wire.required).toContain('default')
    const host = new ToolHost(
      registry,
      app.get(ParamService),
      app.get(AuditWriter),
      app.get(I18nService),
      ds,
      app.get<UserLookup>(USER_LOOKUP),
      app.get(AppConfigService),
    )
    const replica = new HumanConfirmation(
      ds,
      registry,
      host,
      app.get(PermVersion),
      app.get(ItemStore),
    )
    const p = await principal()
    const ref = { threadId: t.id, turnId: t.turnId, callId: card.payload.callId }
    const receipt = card.payload.internal.confirmation
    const sampleCount = samples.length
    for (const service of [
      app.get(HumanConfirmation),
      replica,
      app.get(HumanConfirmation),
      replica,
    ]) {
      const checked = await inTenant1(() => service.prepare(p, ref, name, receipt.rawArgs, receipt))
      expect(checked.digest).toBe(receipt.digest)
      expect(checked.revision).toBe('1')
      expect(checked.args).toEqual(card.payload.args)
    }
    expect(samples).toHaveLength(sampleCount)
    expect((await pending(t.id)).payload.confirmationToken).toBe(card.payload.confirmationToken)
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(written).toHaveLength(1)
    expect(written[0]!.args).toEqual(card.payload.args)
    expect(samples).toHaveLength(sampleCount)
  })

  it('atomically consumes a receipt once even while its call and turn are still running', async () => {
    script({ toolCalls: [call()] })
    const t = await begin()
    const card = await pending(t.id)
    const held = vi.spyOn(app.get(TurnQueue), 'resume').mockResolvedValueOnce('skip')
    await decide(card).expect(201)
    held.mockRestore()
    await ds.query("UPDATE agent_turn SET status = 'running' WHERE id = ? AND tenant_id = 1", [
      t.turnId,
    ])
    await ds.query(
      "UPDATE agent_item SET status = 'running' WHERE thread_id = ? AND kind = 'tool_call' AND tenant_id = 1",
      [t.id],
    )
    const p = await principal()
    const claim = () =>
      inTenant1(() =>
        app.get(HumanConfirmation).claim(
          p,
          {
            threadId: t.id,
            turnId: t.turnId,
            callId: card.payload.callId,
          },
          card.id,
          NAME,
          card.payload.args,
        ),
      )
    const claims = await Promise.allSettled([claim(), claim()])
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter((c) => c.status === 'rejected')).toHaveLength(1)
    const stored = (await rows(t.id, 'approval')).find((c) => c.id === card.id)!
    expect(stored.payload.internal.confirmation.consumedAt).toBeTruthy()
    expect(written).toHaveLength(0)
  })

  it('refuses to consume an approved personal card once the thread is in plan or read-only mode', async () => {
    for (const mode of ['plan', 'read_only']) {
      script({ toolCalls: [call()] })
      const t = await begin()
      const card = await pending(t.id)
      const held = vi.spyOn(app.get(TurnQueue), 'resume').mockResolvedValueOnce('skip')
      await decide(card).expect(201)
      held.mockRestore()
      await ds.query("UPDATE agent_turn SET status = 'running' WHERE id = ? AND tenant_id = 1", [
        t.turnId,
      ])
      await ds.query(
        "UPDATE agent_item SET status = 'running' WHERE thread_id = ? AND kind = 'tool_call' AND tenant_id = 1",
        [t.id],
      )
      await ds.query('UPDATE agent_thread SET approval_mode = ? WHERE id = ? AND tenant_id = 1', [
        mode,
        t.id,
      ])
      const p = await principal()
      await expect(
        inTenant1(() =>
          app
            .get(HumanConfirmation)
            .claim(
              p,
              { threadId: t.id, turnId: t.turnId, callId: card.payload.callId },
              card.id,
              NAME,
              card.payload.args,
            ),
        ),
      ).rejects.toMatchObject({ err: Err.AGENT_APPROVAL_CLOSED })
      const stored = (await rows(t.id, 'approval')).find((c) => c.id === card.id)!
      expect([mode, stored.payload.internal.confirmation.consumedAt]).toEqual([mode, undefined])
      await ds.query("UPDATE agent_turn SET status = 'cancelled' WHERE id = ? AND tenant_id = 1", [
        t.turnId,
      ])
    }
    expect(written).toHaveLength(0)
  })

  it('skips automatic reviewers, excludes pre-approval and does not expose writes to children', async () => {
    const ext = app.get(AgentExtensions)
    const has = vi.spyOn(ext, 'hasReviewers').mockReturnValue(true)
    const review = vi
      .spyOn(ext, 'review')
      .mockResolvedValue({ verdict: 'approve', by: 'review', reason: 'Approved automatically' })
    try {
      await ds.query(
        "INSERT INTO cfg_mcp_tool (name, enabled, agent_policy) VALUES (?, 1, 'ask')",
        [NAME],
      )
      script({ toolCalls: [call()] }, { text: 'Not written.' })
      const t = await begin({ approval_mode: 'auto_review' })
      const card = await pending(t.id)
      expect(review).not.toHaveBeenCalled()
      expect(written).toHaveLength(0)
      const p = await principal()
      const pre = app.get(AutomationPreApproval)
      expect((await inTenant1(() => pre.offerable(p))).map((tool) => tool.name)).not.toContain(NAME)
      const credential = await inTenant1(() =>
        pre.credential(ownerId, NAME, { skill: null, profileId: null }),
      )
      expect(
        await inTenant1(() =>
          pre.validTools({
            userId: ownerId,
            writeMode: 'pre_approved',
            preApproved: [{ tool: NAME, ...credential! }],
            shared: false,
          } as AgentAutomation),
        ),
      ).toEqual(new Set())
      const offered: OfferedTool = {
        name: NAME,
        title: 'Create',
        description: '',
        parameters: {},
        origin: 'local',
        kind: 'write',
        policy: 'ask',
        preview: true,
        perCallConfirmation: true,
      }
      expect(keepForSubagent(new Map([[NAME, offered]]), [NAME]).size).toBe(0)
      await expect(
        inTenant1(() =>
          app
            .get(TurnControlService)
            .decideApproval(
              p,
              card.id,
              { decision: 'approve', confirmationToken: card.payload.confirmationToken },
              'batch',
            ),
        ),
      ).rejects.toMatchObject({ err: Err.AGENT_APPROVAL_CLOSED })
      await decide(card, 'reject').expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect(written).toHaveLength(0)
    } finally {
      has.mockRestore()
      review.mockRestore()
    }
  })

  it('bulk decisions leave a per-call card pending even on a registered batch target', async () => {
    script({ toolCalls: [call()] }, { text: 'Not written.' })
    const t = await begin()
    const card = await pending(t.id)
    const batch = await inTenant1(() =>
      insertRow(ds.manager, 'agent_batch', {
        user_id: ownerId,
        skill_name: 'test',
        target: 'test.confirm',
        total: 1,
      }),
    )
    batches.push(batch)
    await ds.query(
      'UPDATE agent_thread SET batch_id = ?, target_ref = ? WHERE id = ? AND tenant_id = 1',
      [batch, 'test.confirm:7', t.id],
    )
    const target = vi.spyOn(app.get(AgentBatchTargets), 'get').mockReturnValue({
      perm: agentPerms.chat.use,
      tools: [NAME],
      provider: { batchLabels: async () => new Map([[7, 'Request']]) },
    })
    try {
      const p = await principal()
      const result = await inTenant1(() => app.get(AgentBatchService).decide(p, batch, 'approve'))
      expect(result).toEqual({ decided: 0, skipped: 1 })
      expect(written).toHaveLength(0)
      expect((await rows(t.id, 'approval')).find((r) => r.id === card.id)?.status).toBe('pending')
    } finally {
      target.mockRestore()
    }
  })

  it('prepares canonical arguments and preview once, then executes that snapshot after one confirmation', async () => {
    const name = 'test.confirm.normalize'
    let parses = 0
    let defaults = 0
    app.get(McpRegistry).add(
      {
        name,
        title: 'Normalize text',
        description: 'Normalizes and writes text.',
        perm: agentPerms.chat.use,
        kind: 'write',
        perCallConfirmation: true,
        confirmationRevision: '1',
        preview: 'preview',
        input: z.object({
          text: z.string().transform((value) => `${value}:${++parses}`),
          reference: z.string().default(() => `generated-${++defaults}`),
          default: z.string().max(6),
        }),
      },
      (args, context) => {
        written.push({ args, context })
        return { ok: true }
      },
      undefined,
      (args) => ({ target: 'Text', fields: [{ field: 'input', from: null, to: args }] }),
    )
    const wire = app.get(McpRegistry).get(name)!.inputSchema as {
      properties: Record<string, any>
      required: string[]
    }
    expect(wire.properties.reference.default).toBeUndefined()
    expect(wire.properties.default).toMatchObject({ type: 'string', maxLength: 6 })
    expect(wire.required).toContain('default')
    app.get(McpRegistry).add(
      {
        name: 'test.confirm.ordinary-default',
        title: 'Ordinary default',
        description: 'Keeps ordinary schema annotations.',
        perm: null,
        kind: 'read',
        input: z.object({ reference: z.string().default('constant') }),
      },
      () => ({}),
    )
    const ordinary = app.get(McpRegistry).get('test.confirm.ordinary-default')!.inputSchema as {
      properties: Record<string, any>
    }
    expect(ordinary.properties.reference.default).toBe('constant')
    // JSON Schema 导出可能读取默认值；这里只计真实输入准备的解析次数。
    parses = 0
    defaults = 0
    const p = await principal()
    const prepared = await inTenant1(() =>
      app.get(HumanConfirmation).prepare(
        p,
        {
          threadId: 1,
          turnId: 1,
          callId: 'prepare-once',
        },
        name,
        { text: 'Hello', default: 'stable' },
      ),
    )
    expect(parses).toBe(1)
    expect(defaults).toBe(1)
    expect(prepared.args).toEqual({ text: 'Hello:1', reference: 'generated-1', default: 'stable' })
    expect(prepared.preview.fields[0]!.to).toEqual(prepared.args)
    parses = 0
    defaults = 0
    script({ toolCalls: [{ name, args: { text: 'Hello', default: 'stable' } }] }, { text: 'Done.' })
    const t = await begin()
    const card = await pending(t.id)
    expect(card.payload.args).toEqual({
      text: 'Hello:1',
      reference: 'generated-1',
      default: 'stable',
    })
    expect(card.payload.changes.fields[0].to).toEqual(card.payload.args)
    expect(parses).toBe(1)
    expect(defaults).toBe(1)
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(written).toHaveLength(1)
    expect(written[0]!.args).toEqual(card.payload.args)
    expect(written[0]!.context?.confirmation?.args).toEqual(card.payload.args)
    expect(parses).toBe(1)
    expect(defaults).toBe(1)
  })

  it('renews a real ordinary pending card when its declaration is upgraded to per-call confirmation', async () => {
    const tool = app.get(McpRegistry).get(NAME)!
    delete tool.perCallConfirmation
    try {
      script({ toolCalls: [call()] }, { text: 'Done.' })
      const t = await begin()
      const ordinary = await pending(t.id)
      expect(ordinary.payload.perCallConfirmation).toBeUndefined()
      expect(ordinary.payload.confirmationToken).toBeUndefined()
      tool.perCallConfirmation = true
      await decide(ordinary).expect(409)
      const renewed = await pending(t.id)
      expect(renewed.id).toBe(ordinary.id)
      expect(renewed.payload.perCallConfirmation).toBe(true)
      expect(renewed.payload.confirmationToken).toEqual(expect.any(String))
      expect(written).toHaveLength(0)
      await decide(renewed).expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect(written).toHaveLength(1)
    } finally {
      tool.perCallConfirmation = true
    }
  })

  it('rejects the owner principal in another real data tenant before producing a receipt', async () => {
    const p = await principal()
    await expect(
      withTenant(foreign.id, () =>
        app.get(HumanConfirmation).prepare(
          p,
          {
            threadId: 1,
            turnId: 1,
            callId: 'wrong-data-tenant',
          },
          NAME,
          { id: 7, amount: '1.00' },
        ),
      ),
    ).rejects.toMatchObject({ err: Err.FORBIDDEN })
    expect(written).toHaveLength(0)
  })

  it('fails closed when the required real preview cannot be produced', async () => {
    previewFails = true
    script({ toolCalls: [call()] }, { text: 'Unable to preview.' })
    const t = await begin()
    expect(await ended(t.turnId)).toBe('completed')
    expect(await rows(t.id, 'approval')).toHaveLength(0)
    expect(written).toHaveLength(0)
  })
})
import { TEST_AGENT_PRICING } from '../setup/agent-pricing.js'
