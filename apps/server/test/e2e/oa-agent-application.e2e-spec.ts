import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { Err, oaTripPerms, wfPerms, type WfBeginNode } from '@qiwu/shared'
import request from 'supertest'
import { EntityManager, type DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { loadPrincipal } from '../../src/core/agent/automation/pre-approval.js'
import { FakeChatModel } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { HumanConfirmation } from '../../src/core/agent/runtime/human-confirmation.js'
import { PermVersion } from '../../src/core/auth/perm-version.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { McpModule } from '../../src/core/mcp/mcp.module.js'
import { McpRegistry } from '../../src/core/mcp/mcp-registry.js'
import { ToolHost } from '../../src/core/mcp/tool-host.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { WfStartService } from '../../src/modules/workflow/center/wf-start.service.js'
import { TripService } from '../../src/modules/oa/trip/trip.service.js'
import { bearer } from '../setup/auth.js'
import { addUser, createTenant, signInDirect, type PeopledTenant } from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})
let app: NestExpressApplication
let ds: DataSource
let first: PeopledTenant
let second: PeopledTenant
let token: string
let foreignToken: string
let providerId: number
let fake = new FakeChatModel([])
let sequence = 0
const threads: number[] = []
const http = () => request(app.getHttpServer())
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const principal = (userId = first.ownerId, tid = first.id) =>
  withTenant(tid, () => loadPrincipal(app.get(PermVersion), userId))
const picks = () => ({ review: [first.users.alice] })
const trip = (extra: object = {}) => ({
  destination: 'Office north',
  startAt: '2026-11-03T08:00:00Z',
  endAt: '2026-11-04T08:00:00Z',
  reason: `Request ${++sequence}`,
  estimatedAmount: '12.30',
  initiatorPicks: picks(),
  ...extra,
})

async function items(threadId: number, kind?: string) {
  const rows = await ds.query<any[]>(
    'SELECT id, turn_id, kind, status, payload FROM agent_item WHERE tenant_id = ? AND thread_id = ? AND deleted_at IS NULL ORDER BY seq',
    [first.id, threadId],
  )
  for (const row of rows) if (typeof row.payload === 'string') row.payload = JSON.parse(row.payload)
  return kind ? rows.filter((row) => row.kind === kind) : rows
}
async function pending(threadId: number, old?: string) {
  for (const until = Date.now() + 12_000; ; await pause(25)) {
    const card = (await items(threadId, 'approval')).find(
      (row) => row.status === 'pending' && row.payload.confirmationToken !== old,
    )
    if (card) return card
    if (Date.now() > until) throw new Error('Application confirmation did not appear')
  }
}
async function ended(turnId: number) {
  for (const until = Date.now() + 12_000; ; await pause(25)) {
    const [turn] = await ds.query<{ status: string }[]>(
      'SELECT status FROM agent_turn WHERE id = ? AND tenant_id = ?',
      [turnId, first.id],
    )
    if (['completed', 'failed', 'cancelled'].includes(turn?.status ?? '')) return turn!.status
    if (Date.now() > until) throw new Error(`Application turn did not settle: ${turn?.status}`)
  }
}
async function begin(name: string, args: object) {
  fake = new FakeChatModel([{ toolCalls: [{ name, args }] }, { text: 'Finished.' }])
  const id = await withTenant(first.id, () =>
    insertRow(ds.manager, 'agent_thread', {
      user_id: first.ownerId,
      provider_id: providerId,
      model: 'm1',
      title: '',
    }),
  )
  threads.push(id)
  const res = await http()
    .post(`/api/agent/threads/${id}/messages`)
    .set(bearer(token))
    .send({ text: 'Start my application.' })
    .expect(201)
  return { id, turnId: Number(res.body.data.id) }
}
const decide = (card: any, actor = token) =>
  http()
    .post(`/api/agent/approvals/${card.id}`)
    .set(bearer(actor))
    .send({ decision: 'approve', confirmationToken: card.payload.confirmationToken })
async function count(
  table:
    | 'oa_trip_request'
    | 'oa_seal_request'
    | 'oa_expense_claim'
    | 'biz_leave_request'
    | 'wf_instance',
) {
  // arch-allow: sql-concat table is a closed union owned by this fixture; tenant: explicit predicate below
  const [row] = await ds.query<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND deleted_at IS NULL`,
    [first.id],
  )
  return Number(row.n)
}
async function file(userId = first.ownerId, tid = first.id, tag = 'oa.attachment') {
  const [{ id: storageId }] = await ds.query<{ id: number }[]>(
    'SELECT id FROM fs_storage WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  )
  return withTenant(tid, () =>
    insertRow(ds.manager, 'fs_object', {
      storage_id: storageId,
      object_key: `office-${tid}-${++sequence}.txt`,
      original_name: 'source.txt',
      mime: 'text/plain',
      size: 10,
      is_public: 0,
      biz_tag: tag,
      uploader_id: userId,
    }),
  )
}
async function call(name: string, args: object, userId = first.ownerId, tid = first.id) {
  const p = await principal(userId, tid)
  if (!p) throw new Error('Missing test user')
  return withTenant(tid, () => app.get(ToolHost).call(p, name, args, { threadId: 1, turnId: 1 }))
}
async function prepare(name: string, args: object) {
  const p = await principal()
  if (!p) throw new Error('Missing test user')
  return withTenant(first.id, () => app.get(ToolHost).preparePreview(p, name, args))
}

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MCP: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule, McpModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get<DataSource>(getDataSourceToken())
  first = await createTenant(app, { users: true })
  second = await createTenant(app, { users: true })
  await ds.query('UPDATE iam_user SET password_changed_at = NOW(3) WHERE tenant_id IN (?, ?)', [
    first.id,
    second.id,
  ])
  token = (await signInDirect(app, first.ownerId))!.accessToken
  foreignToken = (await signInDirect(app, second.ownerId))!.accessToken
  for (const key of ['leave', 'oa-trip', 'oa-expense', 'oa-seal', 'oa-generic']) {
    const [model] = await ds.query<{ id: number }[]>(
      'SELECT id FROM wf_model WHERE model_key = ? AND tenant_id = ? AND deleted_at IS NULL',
      [key, first.id],
    )
    await http()
      .post(`/api/wf/models/${model.id}/versions`)
      .set(bearer(token))
      .send({
        tree: {
          id: 'begin',
          type: 'begin',
          name: 'Begin',
          next: {
            id: 'review',
            type: 'review',
            name: 'Review',
            assignee: { kind: 'initiatorPicks' },
            sign: 'any',
            whenNobody: 'toManager',
            whenInitiatorIsReviewer: 'self',
            onReject: 'finish',
          },
        },
      })
      .expect(201)
  }
  providerId = await insertRow(ds.manager, 'agent_provider', {
    name: 'Office application provider',
    base_url: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm1', label: 'm1', contextWindow: 64000 }],
    enabled: 1,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)
})
afterAll(async () => {
  await second?.dispose()
  await first?.dispose()
  if (providerId) await ds.query('DELETE FROM agent_provider WHERE id = ?', [providerId])
  await app?.close()
})

it('registers only personal reads and five individually confirmed writes', async () => {
  const reg = app.get(McpRegistry)
  for (const kind of ['leave', 'trip', 'expense', 'seal', 'generic']) {
    const tool = reg.get(`oa.${kind}.apply`)!
    expect(tool).toMatchObject({
      perCallConfirmation: true,
      confirmationRevision: '1',
      feature: 'workflow',
      kind: 'write',
    })
  }
  expect(reg.get('oa.trip.apply')?.perm).toBe(oaTripPerms.create)
  const ordinary = (await principal(first.users.alice))!
  expect(ordinary.perms).not.toContain(oaTripPerms.create)
  expect(
    await withTenant(first.id, () =>
      app.get(ToolHost).preparePreview(ordinary, 'oa.trip.apply', trip()),
    ),
  ).toBeNull()
  expect(reg.get('oa.task.approve')).toBeUndefined()
  expect(reg.get('oa.attendance.clock')).toBeUndefined()
  expect(await call('oa.trip.apply', trip(), first.users.alice)).toMatchObject({
    ok: false,
    error: { code: Err.FORBIDDEN.code },
  })
  const before = await count('oa_trip_request')
  const out = await call('oa.trip.apply', trip())
  expect(out).toMatchObject({ ok: false, error: { code: Err.FORBIDDEN.code } })
  expect(await count('oa_trip_request')).toBe(before)
  expect(await call('oa.task.todo', { userId: second.ownerId })).toMatchObject({ ok: false })
  await expect(prepare('oa.trip.apply', { ...trip(), state: 'approved' })).rejects.toBeDefined()
  await expect(prepare('oa.trip.apply', { reason: 'Missing fields' })).rejects.toBeDefined()
  const denied = (await principal())!
  denied.features = []
  const refusal = await withTenant(first.id, () =>
    app.get(ToolHost).call(denied, 'oa.task.todo', {}, { threadId: 1, turnId: 1 }),
  )
  expect(refusal.ok).toBe(false)
})

it('shows exact values and submits all five types only through real personal confirmation', async () => {
  const cases = [
    [
      'leave',
      {
        leaveKind: 'annual',
        startAt: '2026-11-03T08:00:00Z',
        endAt: '2026-11-04T08:00:00Z',
        days: 1,
        reason: 'Personal leave',
        initiatorPicks: picks(),
      },
      'biz_leave_request',
    ],
    ['trip', trip(), 'oa_trip_request'],
    [
      'expense',
      {
        reason: 'Travel costs',
        items: [
          { expenseDate: '2026-11-03', expenseKind: 'travel', amount: '0.10', description: 'Bus' },
          {
            expenseDate: '2026-11-03',
            expenseKind: 'travel',
            amount: '0.20',
            description: 'Train',
          },
        ],
        initiatorPicks: picks(),
      },
      'oa_expense_claim',
    ],
    [
      'seal',
      {
        sealKind: 'company',
        documentName: 'Service contract',
        purpose: 'Contract',
        copies: 2,
        expectedDate: '2026-11-03',
        initiatorPicks: picks(),
      },
      'oa_seal_request',
    ],
    [
      'generic',
      {
        formValues: {
          title: 'Office proposal',
          description: 'Office improvements',
          expectedDate: '2026-11-03',
        },
        initiatorPicks: picks(),
      },
      'wf_instance',
    ],
  ] as const
  for (const [kind, args, table] of cases) {
    const before = await count(table)
    const t = await begin(`oa.${kind}.apply`, args)
    const card = await pending(t.id)
    expect(card.payload.perCallConfirmation).toBe(true)
    const preview = JSON.stringify(card.payload.changes)
    expect(preview).toContain('versionId')
    expect(preview).toContain(String(first.ownerId))
    if (kind === 'expense') {
      expect(preview).toContain('0.30')
      expect(preview).toContain('Train')
    }
    expect(await count(table)).toBe(before)
    await decide(card, foreignToken).expect(404)
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    const result = await items(t.id, 'tool_result')
    expect(result[0]?.payload).toMatchObject({ ok: true })
    expect(await count(table)).toBe(before + 1)
    await decide(card).expect(409)
    expect(await count(table)).toBe(before + 1)
  }
})

it('returns only own or participating applications and keeps cross-tenant and outsider ids hidden', async () => {
  const [viewMenu] = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
    [wfPerms.instance.view],
  )
  await withTenant(first.id, () =>
    insertRow(ds.manager, 'iam_role_menus', { role_id: first.roleId, menu_id: viewMenu.id }),
  )
  await app.get(PermVersion).bumpUsers([first.users.alice, first.users.admin])
  expect((await principal(first.users.admin))!.perms).toContain(wfPerms.instance.view)
  const [instance] = await ds.query<{ id: number }[]>(
    "SELECT id FROM wf_instance WHERE tenant_id = ? AND model_key = 'oa-trip' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [first.id],
  )
  expect((await call('oa.application.get', { instanceId: instance.id })).ok).toBe(true)
  expect(
    (await call('oa.application.get', { instanceId: instance.id }, first.users.alice)).ok,
  ).toBe(true)
  expect(
    await call('oa.application.get', { instanceId: instance.id }, first.users.admin),
  ).toMatchObject({ ok: false, error: { code: Err.NOT_FOUND.code } })
  expect(
    await call('oa.application.get', { instanceId: instance.id }, second.ownerId, second.id),
  ).toMatchObject({ ok: false, error: { code: Err.NOT_FOUND.code } })
  const out = await call('oa.task.todo', {}, first.users.alice)
  expect(out.ok).toBe(true)
  const foreign = await call('oa.task.todo', {}, second.ownerId, second.id)
  expect(foreign.ok && foreign.text).not.toContain(`"instanceId":${instance.id},`)
})

it('rejects foreign, other-owned and bound attachments or foreign reviewers before confirmation', async () => {
  const own = await file()
  const other = await file(first.users.alice)
  const foreign = await file(second.ownerId, second.id)
  expect(await prepare('oa.trip.apply', trip({ attachmentIds: [own] }))).not.toBeNull()
  for (const id of [other, foreign])
    expect(await prepare('oa.trip.apply', trip({ attachmentIds: [id] }))).toBeNull()
  await ds.query('UPDATE fs_object SET biz_ref = ? WHERE id = ? AND tenant_id = ?', [
    'oa:trip:999',
    own,
    first.id,
  ])
  expect(await prepare('oa.trip.apply', trip({ attachmentIds: [own] }))).toBeNull()
  expect(
    await prepare('oa.trip.apply', trip({ initiatorPicks: { review: [second.users.alice] } })),
  ).toBeNull()
})

it.each(['file', 'file-bound', 'file-owner', 'reviewer', 'reviewer-disabled', 'model'] as const)(
  'rejects changed %s facts after genuine receipt consumption and before business execution',
  async (kind) => {
    const attachmentId = await file()
    const args = trip({ attachmentIds: [attachmentId] })
    const before = await count('oa_trip_request')
    const t = await begin('oa.trip.apply', args)
    const card = await pending(t.id)
    const confirmation = app.get(HumanConfirmation)
    const original = confirmation.claim.bind(confirmation)
    let consumed = false
    const spy = vi.spyOn(confirmation, 'claim').mockImplementationOnce(async (...parameters) => {
      const receipt = await original(...parameters)
      expect(receipt?.confirmation).toBeDefined()
      consumed = true
      if (kind === 'file')
        await ds.query('UPDATE fs_object SET original_name = ? WHERE id = ? AND tenant_id = ?', [
          'changed.txt',
          attachmentId,
          first.id,
        ])
      if (kind === 'file-bound')
        await ds.query('UPDATE fs_object SET biz_ref = ? WHERE id = ? AND tenant_id = ?', [
          'oa:trip:777',
          attachmentId,
          first.id,
        ])
      if (kind === 'file-owner')
        await ds.query('UPDATE fs_object SET uploader_id = ? WHERE id = ? AND tenant_id = ?', [
          first.users.admin,
          attachmentId,
          first.id,
        ])
      if (kind === 'reviewer-disabled')
        await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
          first.users.alice,
          first.id,
        ])
      if (kind === 'reviewer')
        await ds.query('UPDATE iam_user SET display_name = ? WHERE id = ? AND tenant_id = ?', [
          'Changed reviewer',
          first.users.alice,
          first.id,
        ])
      if (kind === 'model')
        await ds.query(
          "UPDATE wf_model SET manager_user_ids = ? WHERE model_key = 'oa-trip' AND tenant_id = ?",
          [JSON.stringify([first.users.alice]), first.id],
        )
      return receipt
    })
    try {
      await decide(card).expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(false)
      expect(await count('oa_trip_request')).toBe(before)
      expect(consumed).toBe(true)
      const [unbound] = await ds.query<{ biz_ref: string | null }[]>(
        'SELECT biz_ref FROM fs_object WHERE id = ? AND tenant_id = ?',
        [attachmentId, first.id],
      )
      expect(unbound.biz_ref).toBe(kind === 'file-bound' ? 'oa:trip:777' : null)
    } finally {
      spy.mockRestore()
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
    }
  },
)

it('holds attachment locks through the existing submit service and rolls back a downstream failure', async () => {
  const attachmentId = await file()
  const service = app.get(TripService)
  const original = service.submit.bind(service)
  const before = await count('oa_trip_request')
  let lockVerified = false
  const spy = vi.spyOn(service, 'submit').mockImplementationOnce(async (dto) => {
    const runner = ds.createQueryRunner()
    await runner.connect()
    try {
      await runner.query('SET SESSION innodb_lock_wait_timeout = 1')
      await expect(
        runner.query('UPDATE fs_object SET original_name = ? WHERE id = ? AND tenant_id = ?', [
          'race.txt',
          attachmentId,
          first.id,
        ]),
      ).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
      lockVerified = true
    } finally {
      await runner.release()
    }
    await original(dto)
    throw new Error('Downstream business failure')
  })
  try {
    const t = await begin('oa.trip.apply', trip({ attachmentIds: [attachmentId] }))
    await decide(await pending(t.id)).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(false)
    expect(await count('oa_trip_request')).toBe(before)
    expect(lockVerified).toBe(true)
    const [unbound] = await ds.query<{ biz_ref: string | null }[]>(
      'SELECT biz_ref FROM fs_object WHERE id = ? AND tenant_id = ?',
      [attachmentId, first.id],
    )
    expect(unbound.biz_ref).toBeNull()
  } finally {
    spy.mockRestore()
  }
})

it('uses published generic field visibility and exposes required input choices without hidden data', async () => {
  const [model] = await ds.query<{ id: number }[]>(
    "SELECT id FROM wf_model WHERE model_key = 'oa-generic' AND tenant_id = ? AND deleted_at IS NULL",
    [first.id],
  )
  await http()
    .post(`/api/wf/models/${model.id}/versions`)
    .set(bearer(token))
    .send({
      tree: {
        id: 'begin',
        type: 'begin',
        name: 'Begin',
        access: { title: 'read', description: 'hide', expectedDate: 'edit', attachments: 'edit' },
        next: {
          id: 'review',
          type: 'review',
          name: 'Review',
          assignee: { kind: 'initiatorPicks' },
          sign: 'any',
          whenNobody: 'toManager',
          whenInitiatorIsReviewer: 'self',
          onReject: 'finish',
        },
      },
    })
    .expect(201)
  const options = await call('oa.application.options', { kind: 'generic' })
  expect(options.ok).toBe(true)
  const serialized = options.ok ? options.text : ''
  expect(serialized).toContain('expectedDate')
  expect(serialized).not.toContain('"field":"description"')
  expect(
    await prepare('oa.generic.apply', {
      formValues: {
        title: 'Public title',
        description: 'Private hidden reason',
        expectedDate: '2026-11-03',
      },
      initiatorPicks: picks(),
    }),
  ).toBeNull()
  const started = await http()
    .post('/api/wf/instances')
    .set(bearer(token))
    .send({
      modelKey: 'oa-generic',
      formValues: {
        title: 'Public title',
        description: 'Private hidden reason',
        expectedDate: '2026-11-03',
      },
      initiatorPicks: picks(),
    })
    .expect(201)
  const read = await call('oa.application.get', { instanceId: started.body.data.id })
  expect(read.ok).toBe(true)
  expect(read.ok && read.text).toContain('Public title')
  expect(read.ok && read.text).not.toContain('Private hidden reason')
})

/** 每个回归发布自己的简单流程，避免依赖另一项用例留下的管理员配置。 */
async function publishTrip(next: WfBeginNode['next']) {
  const [model] = await ds.query<{ id: number; current_version_id: number }[]>(
    "SELECT id, current_version_id FROM wf_model WHERE model_key = 'oa-trip' AND tenant_id = ? AND deleted_at IS NULL",
    [first.id],
  )
  await ds.query('UPDATE wf_model SET manager_user_ids = ? WHERE id = ? AND tenant_id = ?', [
    JSON.stringify([first.ownerId]),
    model.id,
    first.id,
  ])
  await http()
    .post(`/api/wf/models/${model.id}/versions`)
    .set(bearer(token))
    .send({ tree: { id: 'begin', type: 'begin', name: `Begin ${++sequence}`, next } })
    .expect(201)
  return model.id
}
const review = (extra: object = {}) => ({
  id: 'review',
  type: 'review' as const,
  name: 'Review',
  assignee: { kind: 'initiatorPicks' as const },
  sign: 'any' as const,
  whenNobody: 'toManager' as const,
  whenInitiatorIsReviewer: 'self' as const,
  onReject: 'finish' as const,
  ...extra,
})
const shownPeople = (card: any): number[] =>
  card.payload.changes.fields
    .find((field: any) => field.to?.steps)
    .to.steps.flatMap((step: any) => step.userIds)

it.each(['deptHead', 'fallback'] as const)(
  'confirms effective %s reviewers and rejects their change after receipt consumption',
  async (kind) => {
    const [actor] = await ds.query<{ dept_id: number }[]>(
      'SELECT dept_id FROM iam_user WHERE id = ? AND tenant_id = ?',
      [first.ownerId, first.id],
    )
    const [dept] = await ds.query<{ head_user_id: number | null }[]>(
      'SELECT head_user_id FROM iam_dept WHERE id = ? AND tenant_id = ?',
      [actor.dept_id, first.id],
    )
    const before = await count('oa_trip_request')
    await ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ? AND tenant_id = ?', [
      first.users.alice,
      actor.dept_id,
      first.id,
    ])
    const emptyRole = await withTenant(first.id, () =>
      insertRow(ds.manager, 'iam_role', {
        code: `empty-reviewers-${++sequence}`,
        name: `Empty reviewers ${sequence}`,
        data_scope: 'all',
      }),
    )
    await publishTrip(
      kind === 'deptHead'
        ? review({ assignee: { kind: 'initiator' }, whenInitiatorIsReviewer: 'deptHead' })
        : review({
            assignee: { kind: 'roles', ids: [emptyRole] },
            whenNobody: 'toUser',
            fallbackUserId: first.users.alice,
          }),
    )
    const t = await begin('oa.trip.apply', trip({ initiatorPicks: {} }))
    const card = await pending(t.id)
    expect(shownPeople(card)).toContain(first.users.alice)
    const confirmation = app.get(HumanConfirmation)
    const original = confirmation.claim.bind(confirmation)
    let consumed = false
    const spy = vi.spyOn(confirmation, 'claim').mockImplementationOnce(async (...args) => {
      const receipt = await original(...args)
      consumed = !!receipt?.confirmation
      if (kind === 'deptHead')
        await ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ? AND tenant_id = ?', [
          first.users.admin,
          actor.dept_id,
          first.id,
        ])
      else
        await ds.query('UPDATE iam_user SET enabled = 0 WHERE id = ? AND tenant_id = ?', [
          first.users.alice,
          first.id,
        ])
      return receipt
    })
    try {
      await decide(card).expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect(consumed).toBe(true)
      expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(false)
      expect(await count('oa_trip_request')).toBe(before)
    } finally {
      spy.mockRestore()
      await ds.query('UPDATE iam_user SET enabled = 1 WHERE id = ? AND tenant_id = ?', [
        first.users.alice,
        first.id,
      ])
      await ds.query('UPDATE iam_dept SET head_user_id = ? WHERE id = ? AND tenant_id = ?', [
        dept.head_user_id,
        actor.dept_id,
        first.id,
      ])
    }
  },
)

it('refuses creation when effective create permission is removed after consuming the receipt', async () => {
  await publishTrip(review())
  const [menu] = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
    [oaTripPerms.create],
  )
  const before = await count('oa_trip_request')
  const t = await begin('oa.trip.apply', trip())
  const card = await pending(t.id)
  const confirmation = app.get(HumanConfirmation)
  const original = confirmation.claim.bind(confirmation)
  let revoked = false
  const spy = vi.spyOn(confirmation, 'claim').mockImplementationOnce(async (...args) => {
    const receipt = await original(...args)
    expect(receipt?.confirmation).toBeDefined()
    await ds.query('DELETE FROM iam_tenant_package_menus WHERE package_id = ? AND menu_id = ?', [
      first.packageId,
      menu.id,
    ])
    await app.get(PermVersion).bumpUsers([first.ownerId])
    revoked = true
    return receipt
  })
  try {
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(revoked).toBe(true)
    expect((await principal())!.perms).not.toContain(oaTripPerms.create)
    expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(false)
    expect(await count('oa_trip_request')).toBe(before)
  } finally {
    spy.mockRestore()
    await ds.query(
      'INSERT IGNORE INTO iam_tenant_package_menus (package_id, menu_id) VALUES (?, ?)',
      [first.packageId, menu.id],
    )
    await app.get(PermVersion).bumpUsers([first.ownerId])
  }
})

it('locks final organization facts before establishing the engine repeatable-read snapshot', async () => {
  await publishTrip(
    review({ assignee: { kind: 'users', ids: [first.users.alice, first.users.admin] } }),
  )
  const setPeople = (alice: number, other: number) =>
    ds.query(
      'UPDATE iam_user SET enabled = CASE id WHEN ? THEN ? ELSE ? END WHERE id IN (?) AND tenant_id = ?',
      [first.users.alice, alice, other, [first.users.alice, first.users.admin], first.id],
    )
  await setPeople(1, 0)
  const before = await count('oa_trip_request')
  const t = await begin('oa.trip.apply', trip({ initiatorPicks: {} }))
  const card = await pending(t.id)
  expect(shownPeople(card)).toContain(first.users.alice)
  const confirmation = app.get(HumanConfirmation)
  const claim = confirmation.claim.bind(confirmation)
  let consumed = false
  let blocked = false
  const claimSpy = vi.spyOn(confirmation, 'claim').mockImplementationOnce(async (...args) => {
    const receipt = await claim(...args)
    consumed = !!receipt?.confirmation
    await setPeople(0, 1)
    return receipt
  })
  const starts = app.get(WfStartService)
  const info = starts.info.bind(starts)
  const infoSpy = vi.spyOn(starts, 'info').mockImplementation(async (...args) => {
    const result = await info(...args)
    if (consumed && !blocked) {
      const runner = ds.createQueryRunner()
      await runner.connect()
      try {
        await runner.query('SET SESSION innodb_lock_wait_timeout = 1')
        await expect(
          runner.query('UPDATE iam_user SET enabled = 1 WHERE id = ? AND tenant_id = ?', [
            first.users.alice,
            first.id,
          ]),
        ).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
        blocked = true
      } finally {
        await runner.release()
      }
    }
    return result
  })
  try {
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(consumed && blocked).toBe(true)
    expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(false)
    expect(await count('oa_trip_request')).toBe(before)
  } finally {
    claimSpy.mockRestore()
    infoSpy.mockRestore()
    await setPeople(1, 1)
  }
})

it.each(['model', 'version', 'organization', 'people', 'package', 'membership', 'switch'] as const)(
  'holds %s facts through the existing submit boundary',
  async (kind) => {
    const modelId = await publishTrip(review({ assignee: { kind: 'roles', ids: [first.roleId] } }))
    const newUser = await addUser(app, first.id, `additional-reviewer-${++sequence}`)
    const [model] = await ds.query<{ current_version_id: number }[]>(
      'SELECT current_version_id FROM wf_model WHERE id = ? AND tenant_id = ?',
      [modelId, first.id],
    )
    const [actor] = await ds.query<{ dept_id: number }[]>(
      'SELECT dept_id FROM iam_user WHERE id = ? AND tenant_id = ?',
      [first.ownerId, first.id],
    )
    const [menu] = await ds.query<{ id: number }[]>(
      'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
      [oaTripPerms.create],
    )
    const service = app.get(TripService)
    const submit = service.submit.bind(service)
    let blocked = false
    const spy = vi.spyOn(service, 'submit').mockImplementationOnce(async (args) => {
      const runner = ds.createQueryRunner()
      await runner.connect()
      try {
        await runner.query('SET SESSION innodb_lock_wait_timeout = 1')
        let update: Promise<unknown>
        if (kind === 'model')
          update = runner.query('UPDATE wf_model SET name = name WHERE id = ? AND tenant_id = ?', [
            modelId,
            first.id,
          ])
        else if (kind === 'version')
          update = runner.query(
            'UPDATE wf_version SET version = version WHERE id = ? AND tenant_id = ?',
            [model.current_version_id, first.id],
          )
        else if (kind === 'organization')
          update = runner.query(
            'UPDATE iam_dept SET head_user_id = head_user_id WHERE id = ? AND tenant_id = ?',
            [actor.dept_id, first.id],
          )
        else if (kind === 'people')
          update = runner.query(
            'UPDATE iam_user SET display_name = display_name WHERE id = ? AND tenant_id = ?',
            [first.users.alice, first.id],
          )
        else if (kind === 'package')
          update = runner.query(
            'DELETE FROM iam_tenant_package_menus WHERE package_id = ? AND menu_id = ?',
            [first.packageId, menu.id],
          )
        else if (kind === 'switch')
          update = runner.query('INSERT INTO cfg_mcp_tool (name, enabled) VALUES (?, 0)', [
            'oa.trip.apply',
          ])
        else
          update = runner.query(
            'INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)',
            [newUser, first.roleId, first.id],
          )
        await expect(update).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' })
        blocked = true
      } finally {
        await runner.release()
      }
      return submit(args)
    })
    try {
      const t = await begin('oa.trip.apply', trip({ initiatorPicks: {} }))
      await decide(await pending(t.id)).expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect(blocked).toBe(true)
      expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
  },
)

it('recomputes dynamic totals in both the confirmed preview and the real routing values', async () => {
  const [model] = await ds.query<{ id: number; form_id: number }[]>(
    "SELECT id, form_id FROM wf_model WHERE model_key = 'oa-generic' AND tenant_id = ? AND deleted_at IS NULL",
    [first.id],
  )
  await http()
    .put(`/api/wf/forms/${model.form_id}`)
    .set(bearer(token))
    .send({
      schemaJson: {
        rule: [
          {
            type: 'qw-detail-table',
            field: 'items',
            title: 'Items',
            props: {
              columns: [
                { prop: 'item', label: 'Item' },
                { prop: 'amount', label: 'Amount', sum: 'total' },
              ],
            },
          },
        ],
      },
    })
    .expect(200)
  await http()
    .post(`/api/wf/models/${model.id}/versions`)
    .set(bearer(token))
    .send({
      tree: {
        id: 'begin',
        type: 'begin',
        name: 'Calculated application',
        next: {
          id: 'route',
          type: 'fork',
          name: 'Amount route',
          paths: [
            {
              id: 'large',
              name: 'Large',
              when: [[{ field: 'total', op: 'gt', value: 1000 }]],
              child: review({
                id: 'large-review',
                assignee: { kind: 'users', ids: [first.users.admin] },
              }),
            },
            {
              id: 'small',
              name: 'Small',
              when: [],
              fallback: true,
              child: review({
                id: 'small-review',
                assignee: { kind: 'users', ids: [first.users.alice] },
              }),
            },
          ],
        },
      },
    })
    .expect(201)
  const args = {
    formValues: {
      items: JSON.stringify([
        { item: 'Rail', amount: 40 },
        { item: 'Bus', amount: 60 },
      ]),
      total: 9000,
    },
    initiatorPicks: {},
  }
  const t = await begin('oa.generic.apply', args)
  const card = await pending(t.id)
  const confirmed = card.payload.changes.fields.find(
    (field: any) => field.to?.total !== undefined,
  ).to
  expect(confirmed.total).toBe(100)
  await decide(card).expect(201)
  expect(await ended(t.turnId)).toBe('completed')
  expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(true)
  const [instance] = await ds.query<{ id: number; form_values: { total: number } }[]>(
    "SELECT id, form_values FROM wf_instance WHERE tenant_id = ? AND model_key = 'oa-generic' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
    [first.id],
  )
  expect(instance.form_values.total).toBe(confirmed.total)
  const tasks = await ds.query<{ node_id: string; assignee_id: number }[]>(
    "SELECT node_id, assignee_id FROM wf_task WHERE instance_id = ? AND tenant_id = ? AND state = 'pending'",
    [instance.id, first.id],
  )
  expect(tasks).toEqual([{ node_id: 'small-review', assignee_id: first.users.alice }])
})

it('refuses invalid file tags, current file policy violations and more than ten aggregate expense files before confirmation', async () => {
  await publishTrip(review())
  const wrongTag = await file(first.ownerId, first.id, 'wf.attachment')
  const invalidFile = await file()
  await ds.query('UPDATE fs_object SET size = 0 WHERE id = ? AND tenant_id = ?', [
    invalidFile,
    first.id,
  ])
  for (const attachmentId of [wrongTag, invalidFile])
    expect(await prepare('oa.trip.apply', trip({ attachmentIds: [attachmentId] }))).toBeNull()
  const ids = await Promise.all(Array.from({ length: 11 }, () => file()))
  expect(
    await prepare('oa.expense.apply', {
      reason: 'Many receipts',
      attachmentIds: ids.slice(0, 6),
      items: [
        {
          expenseDate: '2026-11-03',
          expenseKind: 'travel',
          amount: '1.00',
          description: 'Receipts',
          attachmentIds: ids.slice(6),
        },
      ],
      initiatorPicks: picks(),
    }),
  ).toBeNull()
})

it.each(['feature', 'switch'] as const)(
  'refuses a %s revoked after receipt consumption',
  async (kind) => {
    await publishTrip(review())
    const menus = await ds.query<{ id: number }[]>(`WITH RECURSIVE descendants AS (
    SELECT id FROM iam_menu WHERE route_name = 'workflow' AND parent_id = 0 AND deleted_at IS NULL
    UNION ALL SELECT m.id FROM iam_menu m JOIN descendants d ON m.parent_id = d.id WHERE m.deleted_at IS NULL
  ) SELECT id FROM descendants`)
    const ids = menus.map((menu) => menu.id)
    const before = await count('oa_trip_request')
    const t = await begin('oa.trip.apply', trip())
    const card = await pending(t.id)
    const confirmation = app.get(HumanConfirmation)
    const claim = confirmation.claim.bind(confirmation)
    let consumed = false
    const spy = vi.spyOn(confirmation, 'claim').mockImplementationOnce(async (...args) => {
      const receipt = await claim(...args)
      consumed = !!receipt?.confirmation
      if (kind === 'feature')
        await ds.query(
          'DELETE FROM iam_tenant_package_menus WHERE package_id = ? AND menu_id IN (?)',
          [first.packageId, ids],
        )
      else await insertRow(ds.manager, 'cfg_mcp_tool', { name: 'oa.trip.apply', enabled: 0 })
      await app.get(PermVersion).bumpUser(first.ownerId)
      return receipt
    })
    try {
      await decide(card).expect(201)
      expect(await ended(t.turnId)).toBe('completed')
      expect(consumed).toBe(true)
      if (kind === 'feature') expect((await principal())!.features).not.toContain('workflow')
      expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(false)
      expect(await count('oa_trip_request')).toBe(before)
    } finally {
      spy.mockRestore()
      if (kind === 'feature')
        await ds.query(
          'INSERT IGNORE INTO iam_tenant_package_menus (package_id, menu_id) VALUES ?',
          [ids.map((id) => [first.packageId, id])],
        )
      else await ds.query('DELETE FROM cfg_mcp_tool WHERE name = ?', ['oa.trip.apply'])
      app.get(ToolHost).forgetSwitches()
      await app.get(PermVersion).bumpUser(first.ownerId)
    }
  },
)

it('keeps the first people read current across reviewer membership changes', async () => {
  const roleId = await withTenant(first.id, () =>
    insertRow(ds.manager, 'iam_role', {
      code: `snapshot-role-${++sequence}`,
      name: 'Snapshot reviewers',
      data_scope: 'all',
    }),
  )
  const setMember = async (userId: number) => {
    await ds.query('DELETE FROM iam_user_roles WHERE role_id = ? AND tenant_id = ?', [
      roleId,
      first.id,
    ])
    await ds.query('INSERT INTO iam_user_roles (user_id, role_id, tenant_id) VALUES (?, ?, ?)', [
      userId,
      roleId,
      first.id,
    ])
  }
  await setMember(first.users.alice)
  await publishTrip(review({ assignee: { kind: 'roles', ids: [roleId] } }))
  const confirmation = app.get(HumanConfirmation)
  const claim = confirmation.claim.bind(confirmation)
  let consumed = false
  let restored = false
  const claimSpy = vi.spyOn(confirmation, 'claim').mockImplementationOnce(async (...args) => {
    const receipt = await claim(...args)
    consumed = !!receipt?.confirmation
    await setMember(first.users.admin)
    return receipt
  })
  const query = EntityManager.prototype.query
  const querySpy = vi.spyOn(EntityManager.prototype, 'query').mockImplementation(async function (
    this: EntityManager,
    ...parameters: any[]
  ) {
    const result = await Reflect.apply(query, this, parameters)
    if (
      consumed &&
      !restored &&
      this.queryRunner?.isTransactionActive &&
      String(parameters[0]).includes('SELECT id, display_name, dept_id FROM iam_user')
    ) {
      restored = true
      await setMember(first.users.alice)
    }
    return result
  } as typeof query)
  try {
    const t = await begin('oa.trip.apply', trip({ initiatorPicks: {} }))
    const card = await pending(t.id)
    expect(shownPeople(card)).toEqual([first.users.alice])
    await decide(card).expect(201)
    expect(await ended(t.turnId)).toBe('completed')
    expect(consumed && restored).toBe(true)
    expect((await items(t.id, 'tool_result'))[0]?.payload.ok).toBe(true)
    const [latest] = await ds.query<{ id: number }[]>(
      "SELECT id FROM wf_instance WHERE model_key = 'oa-trip' AND initiator_id = ? AND tenant_id = ? ORDER BY id DESC LIMIT 1",
      [first.ownerId, first.id],
    )
    const tasks = await ds.query<{ assignee_id: number }[]>(
      "SELECT assignee_id FROM wf_task WHERE instance_id = ? AND tenant_id = ? AND state = 'pending'",
      [latest.id, first.id],
    )
    expect(tasks.map((row) => row.assignee_id)).toEqual([first.users.alice])
  } finally {
    claimSpy.mockRestore()
    querySpy.mockRestore()
    await setMember(first.users.alice)
  }
})
it('refuses a nonparticipant even when the underlying workflow detail authorizes full-scope administration', async () => {
  await publishTrip(review())
  const t = await begin('oa.trip.apply', trip())
  await decide(await pending(t.id)).expect(201)
  expect(await ended(t.turnId)).toBe('completed')
  const [instance] = await ds.query<{ id: number }[]>(
    "SELECT id FROM wf_instance WHERE tenant_id = ? AND model_key = 'oa-trip' ORDER BY id DESC LIMIT 1",
    [first.id],
  )
  const [role] = await ds.query<{ data_scope: string }[]>(
    'SELECT data_scope FROM iam_role WHERE id = ? AND tenant_id = ?',
    [first.roleId, first.id],
  )
  const [menu] = await ds.query<{ id: number }[]>(
    'SELECT id FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
    [wfPerms.instance.view],
  )
  const existingGrant = await ds.query(
    'SELECT 1 FROM iam_role_menus WHERE role_id = ? AND menu_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [first.roleId, menu.id, first.id],
  )
  if (!existingGrant.length)
    await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
      first.roleId,
      menu.id,
      first.id,
    ])
  try {
    await ds.query("UPDATE iam_role SET data_scope = 'all' WHERE id = ? AND tenant_id = ?", [
      first.roleId,
      first.id,
    ])
    await app.get(PermVersion).bumpUsers([first.users.admin])
    const outsider = (await signInDirect(app, first.users.admin))!.accessToken
    await http().get(`/api/wf/instances/${instance.id}`).set(bearer(outsider)).expect(200)
    expect(
      await call('oa.application.get', { instanceId: instance.id }, first.users.admin),
    ).toMatchObject({ ok: false, error: { code: Err.NOT_FOUND.code } })
  } finally {
    if (!existingGrant.length)
      await ds.query(
        'DELETE FROM iam_role_menus WHERE role_id = ? AND menu_id = ? AND tenant_id = ?',
        [first.roleId, menu.id, first.id],
      )
    await ds.query('UPDATE iam_role SET data_scope = ? WHERE id = ? AND tenant_id = ?', [
      role.data_scope,
      first.roleId,
      first.id,
    ])
    await app.get(PermVersion).bumpUsers([first.users.admin])
  }
})
