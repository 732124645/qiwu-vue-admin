import { TEST_AGENT_PRICING, clearAgentUsage } from '../setup/agent-pricing.js'
// Research and outputs (see docs/agent.md#深度研究, #图表图片与导出): a turn started with the platform research
// skill runs under the research step and time limits (a same-named personal skill does not); `report.write`
// keeps only citations of links readable in this turn (the rest stay in place without a link);
// `chart.render` takes declarative charts only and checks them; `image.generate` is offered only with an
// image model, stores the picture as the owner's file, counts its usage and is not paid twice when the call
// repeats; `GET /api/agent/items/:itemId/xlsx` exports a chart or a report table to the thread's owner only,
// every cell a plain value (formula-like text escaped). A turn draws at most four images, a provider reporting
// no usage is charged the fallback, and the pictures go with a reverted turn or a deleted thread.
import type { NestExpressApplication } from '@nestjs/platform-express'
import { ConfigService } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AGENT_LIMIT_PARAMS, AGENT_RESEARCH_SKILL, AGENT2_PARAMS, Err } from '@qiwu/shared'
import ExcelJS from 'exceljs'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AGENT_IMAGE_STORE, type AgentImageStore } from '../../src/core/agent/agent-ports.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import type { ChatRequest, ImageRequest } from '../../src/core/agent/provider/chat-model.js'
import { FakeChatModel, type FakeTurn } from '../../src/core/agent/provider/fake-chat-model.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { IMAGES_PER_TURN } from '../../src/core/agent/runtime/output-tools.js'
import { usageOf } from '../../src/core/agent/provider/usage.js'
import { BizError } from '../../src/core/http/biz-error.js'
import type { ChatUsage } from '../../src/core/agent/provider/chat-model.js'
import { LeaseLost } from '../../src/core/agent/runtime/turn-runner.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { insertRow } from '../../src/db/seeds/upsert.js'
import { LocalStorage } from '../../src/modules/platform/storage/local-storage.js'
import { bearer, signIn } from '../setup/auth.js'
import { addRow, addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'

vi.hoisted(() => {
  process.env.APP_AGENT = 'false'
  process.env.APP_MCP = 'false'
})

const PREFIX = 'e2e_agrs_'
// a 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/** The scripted model that also draws images (counting them). */
class ImageFake extends FakeChatModel {
  readonly images: ImageRequest[] = []
  /** what the provider answers (a PNG unless a test says otherwise) */
  data = PNG
  /** the usage it reports */
  usage: ChatUsage | null = usageOf({ input_tokens: 7, output_tokens: 70 }, true)
  async image(req: ImageRequest) {
    this.images.push(req)
    if (this.usage?.usageReported) req.onUsage?.(this.usage)
    return { data: this.data, usage: this.usage }
  }
}

let app: NestExpressApplication
let ds: DataSource
let providerId = 0
let imageProviderId = 0
let ownerId = 0
let otherId = 0
let noneId = 0
let roleId = 0
let owner = ''
let other = ''
let none = ''
let foreign = ''
let tenant: PeopledTenant
let fake = new ImageFake([])
let seededSkill = true
const threads: number[] = []
const local = new LocalStorage()

const http = () => request(app.getHttpServer())
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const script = (...turns: FakeTurn[]) => (fake = new ImageFake(turns))
const names = (req: ChatRequest | undefined) => (req?.tools ?? []).map((t) => t.name)
const toolMsgs = (i: number) =>
  fake.requests[i]!.messages.filter((m) => m.role === 'tool').map((m) => String(m.content))

async function setParam(key: string, value: string) {
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
  await app.get(ParamService).invalidate(key)
}

async function thread(): Promise<number> {
  const id = await inTenant1(() =>
    insertRow(ds.manager, 'agent_thread', {
      user_id: ownerId,
      title: '',
      provider_id: providerId,
      model: 'm1',
    }),
  )
  threads.push(id)
  return id
}

async function run(text: string, extra: object = {}) {
  const id = await thread()
  const res = await http()
    .post(`/api/agent/threads/${id}/messages`)
    .set(bearer(owner))
    .send({ text, ...extra })
  expect(res.status).toBe(201)
  const turnId = res.body.data.id as number
  for (const until = Date.now() + 15_000; ; await sleep(40)) {
    const [t] = await ds.query<
      { id: number; status: string; steps: number; error_code: string | null }[]
    >('SELECT id, status, steps, error_code FROM agent_turn WHERE id = ?', [turnId])
    if (t && ['completed', 'failed', 'cancelled'].includes(t.status)) return { id, turn: t }
    if (Date.now() > until) throw new Error(`turn ${turnId} is still ${t?.status}`)
  }
}

async function items(threadId: number, kind: string) {
  const rows = await ds.query<{ id: number; payload: any }[]>(
    'SELECT id, payload FROM agent_item WHERE thread_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY seq',
    [threadId, kind],
  )
  for (const r of rows) if (typeof r.payload === 'string') r.payload = JSON.parse(r.payload)
  return rows
}

/** A binary (xlsx) response body as a Buffer. */
const binary = (r: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = []
  r.on('data', (c: Buffer) => chunks.push(c))
  r.on('end', () => cb(null, Buffer.concat(chunks)))
}
const xlsx = (itemId: number, token: string, query = '') =>
  http()
    .get(`/api/agent/items/${itemId}/xlsx${query}`)
    .set(bearer(token))
    .buffer(true)
    .parse(binary)
async function sheetRows(body: Buffer): Promise<unknown[][]> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(body as never)
  const out: unknown[][] = []
  wb.worksheets[0]!.eachRow((row) => {
    out.push((row.values as unknown[]).slice(1))
  })
  return out
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
      {
        id: 'm1',
        label: 'm1',
        reasoning: false,
        pricing: TEST_AGENT_PRICING,
        contextWindow: 64_000,
      },
    ],
    enabled: 1,
    sort: -100,
  })
  vi.spyOn(app.get(ProviderRegistry), 'connect').mockImplementation(() => fake)
  const [skill] = await ds.query<{ id: number }[]>(
    'SELECT id FROM agent_platform_skill WHERE name = ? AND deleted_at IS NULL',
    [AGENT_RESEARCH_SKILL],
  )
  if (!skill) {
    seededSkill = false
    await insertRow(ds.manager, 'agent_platform_skill', {
      name: AGENT_RESEARCH_SKILL,
      description: 'research',
      body: 'Research.',
      enabled: 1,
    })
  }

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
  noneId = await addUser(app, 1, `${PREFIX}none`)
  owner = (await signIn(app, `${PREFIX}owner`)).accessToken
  other = (await signIn(app, `${PREFIX}other`)).accessToken
  none = (await signIn(app, `${PREFIX}none`)).accessToken
  tenant = await createTenant(app, { users: true })
  await ds.query('INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) VALUES (?, ?, ?)', [
    tenant.roleId,
    chatMenu!.id,
    tenant.id,
  ])
  foreign = (await signIn(app, 'admin', {}, tenant.id)).accessToken
})

afterAll(async () => {
  if (ds) {
    if (threads.length) {
      await ds.query('DELETE FROM agent_item WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_turn WHERE thread_id IN (?)', [threads])
      await ds.query('DELETE FROM agent_thread WHERE id IN (?)', [threads])
    }
    const files = await ds.query<{ id: number; object_key: string }[]>(
      "SELECT id, object_key FROM fs_object WHERE biz_tag = 'agent.image' AND uploader_id = ?",
      [ownerId],
    )
    for (const f of files) await local.remove(f.object_key, false).catch(() => undefined)
    if (files.length)
      await ds.query('DELETE FROM fs_object WHERE id IN (?)', [files.map((f) => f.id)])
    const users = [ownerId, otherId, noneId].filter(Boolean)
    if (users.length) {
      await ds.query('DELETE FROM agent_skill WHERE owner_user_id IN (?) AND tenant_id = 1', [
        users,
      ])
      await clearAgentUsage(ds, users)
      await ds.query('DELETE FROM iam_user_roles WHERE user_id IN (?)', [users])
      await ds.query('DELETE FROM iam_user WHERE id IN (?)', [users])
    }
    if (roleId) {
      await ds.query('DELETE FROM iam_role_menus WHERE role_id = ?', [roleId])
      await ds.query('DELETE FROM iam_role WHERE id = ?', [roleId])
    }
    await ds.query('DELETE FROM agent_provider WHERE id IN (?)', [[providerId, imageProviderId]])
    if (!seededSkill)
      await ds.query('DELETE FROM agent_platform_skill WHERE name = ?', [AGENT_RESEARCH_SKILL])
    await setParam(AGENT2_PARAMS.researchSteps, '60')
    await setParam(AGENT2_PARAMS.researchSeconds, '1200')
  }
  await tenant?.dispose()
  await app?.close()
})

const plan = { name: 'plan.update', args: { steps: [{ text: 'look', status: 'doing' }] } }

describe('research mode', () => {
  it('uses the research step and time limits for the platform research skill only', async () => {
    await setParam(AGENT2_PARAMS.researchSteps, '2')
    const loop = () =>
      script(...Array.from({ length: 4 }, () => ({ toolCalls: [plan] })), { text: 'Done.' })
    loop()
    const research = await run('research tea', { skill: AGENT_RESEARCH_SKILL })
    expect(research.turn).toMatchObject({
      status: 'failed',
      steps: 2,
      error_code: Err.AGENT_LIMIT.code,
    })
    // the same script without the skill runs under the normal limit
    loop()
    expect((await run('plain tea')).turn).toMatchObject({ status: 'completed', steps: 5 })
    // a personal skill of the same name wins when loaded, so it gets no research limits
    const mine = await addRow(app, 1, 'agent_skill', {
      owner_user_id: ownerId,
      name: AGENT_RESEARCH_SKILL,
      description: 'mine',
      body: 'Mine.',
    })
    loop()
    expect((await run('my tea', { skill: AGENT_RESEARCH_SKILL })).turn.status).toBe('completed')
    await ds.query('DELETE FROM agent_skill WHERE id = ?', [mine])

    await setParam(AGENT2_PARAMS.researchSteps, '60')
    await setParam(AGENT2_PARAMS.researchSeconds, '1')
    script({ delayMs: 3000, text: 'late' })
    const slow = await run('slow research', { skill: AGENT_RESEARCH_SKILL })
    expect(slow.turn).toMatchObject({ status: 'failed', error_code: Err.AGENT_LIMIT.code })
    await setParam(AGENT2_PARAMS.researchSeconds, '1200')
    const [limit] = await ds.query<{ param_value: string }[]>(
      'SELECT param_value FROM cfg_param WHERE param_key = ?',
      [AGENT_LIMIT_PARAMS.turnSteps],
    )
    expect(Number(limit!.param_value)).toBeGreaterThan(5)
  })

  it('report.write keeps only citations readable this turn, the rest unverified in place', async () => {
    script(
      {
        toolCalls: [
          {
            name: 'report.write',
            args: {
              title: 'Tea',
              text: 'Tea is old [1]. Made-up claim [2].\n\n| Kind | Price |\n|---|---|\n| =1+2 | 3 |',
              citations: [
                { title: 'A', url: 'https://example.com/tea' },
                { title: 'B', url: 'https://evil.example/fake' },
              ],
            },
          },
        ],
      },
      { text: 'Written.' },
    )
    const { id } = await run('summarize https://example.com/tea')
    const [report] = await items(id, 'report')
    expect(report!.payload).toMatchObject({
      title: 'Tea',
      text: expect.stringContaining('Tea is old'),
      citations: [
        { title: 'A', url: 'https://example.com/tea' },
        { title: 'B', url: '' },
      ],
    })
    expect(toolMsgs(1)[0]).toContain('https://evil.example/fake')

    // its table exports with the formula-like cell escaped; there is no second table
    const res = await xlsx(report!.id, owner, '?table=0')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet')
    expect(await sheetRows(res.body)).toEqual([
      ['Kind', 'Price'],
      ["'=1+2", '3'],
    ])
    expect((await xlsx(report!.id, owner, '?table=1')).status).toBe(404)
  })
})

describe('charts', () => {
  it('renders declarative charts only and checks them', async () => {
    const chart = {
      kind: 'bar',
      title: 'Sales',
      categories: ['=SUM(A1)', '@cmd', 'Q3'],
      series: [{ name: '+Total', data: [1, 2.5, null] }],
      unit: 'kg',
    }
    script(
      { toolCalls: [{ name: 'chart.render', args: chart }] },
      {
        toolCalls: [
          {
            name: 'chart.render',
            args: { ...chart, kind: 'pie', series: [chart.series[0], chart.series[0]] },
          },
        ],
      },
      { toolCalls: [{ name: 'chart.render', args: { ...chart, kind: 'html' } }] },
      {
        toolCalls: [
          {
            name: 'chart.render',
            args: { ...chart, series: [{ name: 'n', data: Array.from({ length: 201 }, () => 1) }] },
          },
        ],
      },
      { text: 'Shown.' },
    )
    const { id } = await run('chart it')
    const charts = await items(id, 'chart')
    expect(charts).toHaveLength(1)
    expect(charts[0]!.payload).toMatchObject(chart)
    const results = [1, 2, 3, 4].map((i) => toolMsgs(i).at(-1))
    expect(results[0]).toBe('The chart is shown to the user.')
    for (const r of results.slice(1)) expect(r).toContain(Err.VALIDATION_FAILED.code)

    // export: the owner only, every cell a plain value
    const res = await xlsx(charts[0]!.id, owner)
    expect(res.status).toBe(200)
    expect(await sheetRows(res.body)).toEqual([
      ['Sales (kg)', "'+Total"],
      ["'=SUM(A1)", 1],
      ["'@cmd", 2.5],
      ['Q3'],
    ])
    expect((await xlsx(charts[0]!.id, other)).status).toBe(404)
    expect((await xlsx(charts[0]!.id, foreign)).status).toBe(404)
    expect((await xlsx(charts[0]!.id, none)).status).toBe(403)
    const [user] = await items(id, 'user')
    expect((await xlsx(user!.id, owner)).status).toBe(404)
    expect((await xlsx(999_999_999, owner)).status).toBe(404)
  })
})

describe('image.generate', () => {
  it('is offered only with an image model, stores the picture once and counts its usage', async () => {
    script({ text: 'No images here.' })
    await run('hello')
    expect(names(fake.requests[0])).not.toContain('image.generate')

    imageProviderId = await insertRow(ds.manager, 'agent_provider', {
      name: `${PREFIX}images`,
      base_url: 'http://127.0.0.1:9/v1',
      models: [
        {
          id: 'img1',
          label: 'img1',
          reasoning: false,
          pricing: TEST_AGENT_PRICING,
          contextWindow: 4096,
          image: true,
        },
      ],
      enabled: 1,
      sort: 100,
    })
    // the first save is followed by a lost lock: the repeated call finds the stored picture
    const store = app.get<AgentImageStore>(AGENT_IMAGE_STORE)
    const save = store.save.bind(store)
    const spy = vi.spyOn(store, 'save').mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new LeaseLost()
    })
    script(
      {
        toolCalls: [
          { name: 'image.generate', args: { prompt: 'a red teapot', size: '1536x1024' } },
        ],
      },
      { text: 'Here it is.' },
    )
    const { id, turn } = await run('draw a teapot')
    spy.mockRestore()
    expect(turn.status).toBe('completed')
    expect(names(fake.requests[0])).toContain('image.generate')
    expect(fake.images).toEqual([
      expect.objectContaining({ model: 'img1', prompt: 'a red teapot', size: '1536x1024' }),
    ])
    const images = await items(id, 'image')
    expect(images).toHaveLength(1)
    // the picture's own size from its header, not the size asked for
    expect(images[0]!.payload).toMatchObject({ prompt: 'a red teapot', width: 1, height: 1 })
    const files = await ds.query<{ id: number; mime: string; is_public: number }[]>(
      "SELECT id, mime, is_public FROM fs_object WHERE biz_tag = 'agent.image' AND uploader_id = ?",
      [ownerId],
    )
    expect(files).toEqual([{ id: images[0]!.payload.fileId, mime: 'image/png', is_public: 0 }])
    const [usage] = await ds.query<{ p: string; c: string }[]>(
      "SELECT SUM(prompt_tokens) p, SUM(completion_tokens) c FROM agent_usage WHERE user_id = ? AND model = 'img1'",
      [ownerId],
    )
    expect([Number(usage!.p), Number(usage!.c)]).toEqual([7, 70])
    // the owner downloads it; another user may not
    expect(
      (await http().get(`/api/storage/objects/${files[0]!.id}/download`).set(bearer(owner))).status,
    ).toBe(200)
    expect(
      (await http().get(`/api/storage/objects/${files[0]!.id}/download`).set(bearer(other))).status,
    ).toBe(403)
  })

  it('refuses bytes that are no picture (HTML, SVG): 422 and no file', async () => {
    for (const bytes of [
      '<!doctype html><html><script>alert(1)</script></html>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
    ]) {
      script(
        { toolCalls: [{ name: 'image.generate', args: { prompt: 'not a picture' } }] },
        { text: 'Failed.' },
      )
      fake.data = Buffer.from(bytes)
      const { id } = await run('draw something odd')
      const [result] = await items(id, 'tool_result')
      expect(result!.payload).toMatchObject({ ok: false, error: { code: Err.UNPROCESSABLE.code } })
      expect(await items(id, 'image')).toEqual([])
    }
    const files = await ds.query<{ id: number }[]>(
      "SELECT id FROM fs_object WHERE biz_tag = 'agent.image' AND uploader_id = ? AND mime NOT LIKE 'image/%'",
      [ownerId],
    )
    expect(files).toEqual([])
    const [{ n }] = await ds.query<{ n: number }[]>(
      "SELECT COUNT(*) n FROM fs_object WHERE biz_tag = 'agent.image' AND uploader_id = ?",
      [ownerId],
    )
    expect(Number(n)).toBe(1)
  })
  it('records reported tokens from a failed image response instead of losing them or applying the flat fallback', async () => {
    const reported = usageOf({ input_tokens: 11, output_tokens: 22 }, true)
    const error = new BizError(Err.AGENT_PROVIDER_FAILED, { reason: 'bad_response' })
    script(
      { toolCalls: [{ name: 'image.generate', args: { prompt: 'a simple shape' } }] },
      { text: 'The image could not be returned.' },
    )
    const image = vi.spyOn(fake, 'image').mockImplementationOnce(async (req) => {
      req.onUsage?.(reported)
      throw error
    })
    try {
      const { id, turn } = await run('draw a shape')
      expect(turn.status).toBe('failed')
      expect(fake.requests).toHaveLength(1)
      const [risk] = await ds.query('SELECT recovery_required FROM agent_thread WHERE id = ?', [id])
      expect(risk.recovery_required).toBe(1)
      const [entry] = await ds.query<
        { credits: string; usage_json: any; usage_reported: number }[]
      >(
        "SELECT credits, usage_json, usage_reported FROM agent_usage_entry WHERE tenant_id = 1 AND turn_id = ? AND model = 'img1'",
        [turn.id],
      )
      expect(entry!.credits).toBe('33.000000')
      expect(Number(entry!.usage_reported)).toBe(1)
      expect(
        typeof entry!.usage_json === 'string' ? JSON.parse(entry!.usage_json) : entry!.usage_json,
      ).toMatchObject({ promptTokens: 11, completionTokens: 22, usageReported: true })
      expect(await items(id, 'image')).toEqual([])
    } finally {
      image.mockRestore()
    }
  })
})

describe('image limits and cleanup', () => {
  const alive = async (fileIds: number[]) =>
    (
      await ds.query<{ id: number }[]>(
        'SELECT id FROM fs_object WHERE id IN (?) AND deleted_at IS NULL',
        [fileIds],
      )
    ).map((r) => Number(r.id))
  const charged = async () => {
    const [u] = await ds.query<{ c: string | null }[]>(
      "SELECT SUM(credits) c FROM agent_usage WHERE user_id = ? AND model = 'img1'",
      [ownerId],
    )
    return Number(u!.c ?? 0)
  }

  it('draws at most four images and uses the explicit image price when usage is not reported', async () => {
    const calls = Array.from({ length: IMAGES_PER_TURN + 1 }, (_, i) => ({
      name: 'image.generate',
      args: { prompt: `picture ${i}` },
    }))
    script({ toolCalls: calls }, { text: 'Done.' })
    fake.usage = null
    const before = await charged()
    const { id, turn } = await run('draw five pictures')
    expect(turn.status).toBe('completed')
    expect(fake.images).toHaveLength(IMAGES_PER_TURN)
    expect(await items(id, 'image')).toHaveLength(IMAGES_PER_TURN)
    const failed = (await items(id, 'tool_result')).filter((r) => r.payload.ok === false)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.payload.error).toMatchObject({ code: Err.AGENT_LIMIT.code })
    expect((await charged()) - before).toBe(
      IMAGES_PER_TURN * Number(TEST_AGENT_PRICING.imageCredits),
    )
  })

  it('removes the pictures of a reverted turn and of a deleted thread', async () => {
    script({ toolCalls: [{ name: 'image.generate', args: { prompt: 'a cup' } }] }, { text: 'Ok.' })
    const { id } = await run('draw a cup')
    const first = (await items(id, 'image')).map((i) => Number(i.payload.fileId))
    script({ toolCalls: [{ name: 'image.generate', args: { prompt: 'a pot' } }] }, { text: 'Ok.' })
    const res = await http()
      .post(`/api/agent/threads/${id}/messages`)
      .set(bearer(owner))
      .send({ text: 'and a pot' })
    expect(res.status).toBe(201)
    for (const until = Date.now() + 15_000; ; await sleep(40)) {
      if ((await items(id, 'image')).length === 2) break
      if (Date.now() > until) throw new Error('the second picture never came')
    }
    for (const until = Date.now() + 15_000; ; await sleep(40)) {
      const [t] = await ds.query<{ status: string }[]>(
        'SELECT status FROM agent_turn WHERE thread_id = ? ORDER BY id DESC LIMIT 1',
        [id],
      )
      if (t?.status === 'completed') break
      if (Date.now() > until) throw new Error('the second turn never ended')
    }
    const second = (await items(id, 'image'))
      .map((i) => Number(i.payload.fileId))
      .filter((f) => !first.includes(f))
    expect(await alive([...first, ...second])).toEqual([...first, ...second])
    await http().post(`/api/agent/threads/${id}/revert`).set(bearer(owner)).expect(200)
    // only the reverted turn's picture goes
    expect(await alive([...first, ...second])).toEqual(first)
    await http().delete(`/api/agent/threads/${id}`).set(bearer(owner)).expect(200)
    expect(await alive(first)).toEqual([])
  })
})
