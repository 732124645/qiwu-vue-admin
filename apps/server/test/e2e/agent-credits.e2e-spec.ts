import { ConfigService } from '@nestjs/config'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { Test } from '@nestjs/testing'
import { getDataSourceToken } from '@nestjs/typeorm'
import { AGENT_LIMIT_PARAMS, agentPerms, Err } from '@qiwu/shared'
import request from 'supertest'
import type { DataSource } from 'typeorm'
import { AppModule } from '../../src/app.module.js'
import { setupApp } from '../../src/app.setup.js'
import { AgentModule } from '../../src/core/agent/agent.module.js'
import { EnvSchema } from '../../src/core/config/env.schema.js'
import { ParamService } from '../../src/core/settings/param.service.js'
import { UsageBook, usageDay } from '../../src/core/agent/runtime/usage-book.js'
import { ProviderRegistry } from '../../src/core/agent/provider/provider-registry.js'
import { estimatedUsage, usageOf, withUsageEstimate } from '../../src/core/agent/provider/usage.js'
import { bearer, signIn } from '../setup/auth.js'
import { addUser, createTenant, inTenant1, type PeopledTenant } from '../setup/tenants.js'
import { withTenant } from '../../src/core/context/tenant.js'
import { clearAgentUsage } from '../setup/agent-pricing.js'

const PREFIX = 'e2e-credit-'
const pricing = { input: '1.5', output: '3', cacheRead: '0.1', cacheWrite: '2', imageCredits: null }
let app: NestExpressApplication
let ds: DataSource
let book: UsageBook
let root = ''
let userId = 0
let forbidden = ''
let tenant: PeopledTenant
let tenantRoot = ''
const providers: number[] = []
const api = () => request(app.getHttpServer())
const target = (providerId = providers[0]!, model = 'same-model') => ({
  providerId,
  providerName: `${PREFIX}${providerId}`,
  model,
  pricing,
})
const original = usageOf({
  prompt_tokens: 1000,
  completion_tokens: 250,
  total_tokens: 1250,
  prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 100, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 70, accepted_prediction_tokens: 3 },
})

beforeAll(async () => {
  const env = { ...process.env, APP_AGENT: 'true', APP_MULTI_TENANT: 'true' }
  const mod = await Test.createTestingModule({ imports: [AppModule, AgentModule] })
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(EnvSchema.parse(env)))
    .compile()
  app = setupApp(mod.createNestApplication<NestExpressApplication>({ logger: false }))
  await app.init()
  ds = app.get(getDataSourceToken())
  book = app.get(UsageBook)
  root = (await signIn(app)).accessToken
  userId = await addUser(app, 1, `${PREFIX}user`)
  forbidden = (await signIn(app, `${PREFIX}user`)).accessToken
  for (let i = 0; i < 2; i++) {
    const r = await api()
      .post('/api/agent/providers')
      .set(bearer(root))
      .send({
        name: `${PREFIX}provider-${i}`,
        baseUrl: 'https://provider.example/v1',
        models: [{ id: 'same-model', pricing }],
      })
      .expect(201)
    providers.push(r.body.data.id)
  }
  tenant = await createTenant(app, { users: true })
  await ds.query(
    'INSERT INTO iam_role_menus (role_id, menu_id, tenant_id) SELECT ?, id, ? FROM iam_menu WHERE perms = ? AND deleted_at IS NULL',
    [tenant.roleId, tenant.id, agentPerms.usage.browse],
  )
  tenantRoot = (await signIn(app, 'admin', {}, tenant.id)).accessToken
})

beforeEach(async () => {
  await clearAgentUsage(ds, [userId])
  for (const key of [AGENT_LIMIT_PARAMS.userDailyCredits, AGENT_LIMIT_PARAMS.tenantDailyCredits]) {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['0', key])
    await app.get(ParamService).invalidate(key)
  }
})

afterAll(async () => {
  if (ds) {
    await clearAgentUsage(ds, [userId])
    await ds.query('DELETE FROM iam_user_roles WHERE user_id = ?', [userId])
    await ds.query('DELETE FROM iam_user WHERE id = ?', [userId])
    if (providers.length) await ds.query('DELETE FROM agent_provider WHERE id IN (?)', [providers])
    for (const key of [
      AGENT_LIMIT_PARAMS.userDailyCredits,
      AGENT_LIMIT_PARAMS.tenantDailyCredits,
    ]) {
      await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['0', key])
      await app.get(ParamService).invalidate(key)
    }
  }
  await tenant?.dispose()
  await app?.close()
})

it('keeps provider identity, cache detail and immutable per-call prices while adding precise credits', async () => {
  const a = target()
  expect(await inTenant1(() => book.add(userId, a, original))).toBe('0.002020')
  a.pricing = { ...pricing, input: '2' }
  await inTenant1(() => book.add(userId, a, original))
  await inTenant1(() => book.add(userId, target(providers[1]), original))
  const r = await api()
    .get('/api/agent/usage/entries')
    .set(bearer(root))
    .query({ from: usageDay(), to: usageDay(), pageSize: 200 })
    .expect(200)
  const rows = r.body.data.items.filter((x: { userId: number }) => x.userId === userId)
  expect(rows).toHaveLength(3)
  expect(rows[2]).toMatchObject({
    providerId: providers[0],
    credits: '0.002020',
    pricing,
    usage: original,
  })
  expect(rows[1]).toMatchObject({ pricing: { input: '2' }, credits: '0.002370' })
  expect(rows[0].providerId).toBe(providers[1])
  const aggregated = await api()
    .get('/api/agent/usage')
    .set(bearer(root))
    .query({ from: usageDay(), to: usageDay(), groupBy: 'model' })
    .expect(200)
  const models = aggregated.body.data.filter((x: { key: string }) =>
    providers.some((id) => x.key === `${id}:same-model`),
  )
  expect(models).toHaveLength(2)
  expect(models.find((x: { key: string }) => x.key === `${providers[0]}:same-model`)).toMatchObject(
    {
      calls: 2,
      promptTokens: 2000,
      completionTokens: 500,
      cacheReadTokens: 400,
      reasoningTokens: 140,
      credits: '0.004390',
    },
  )
})

it('enforces credit thresholds, leaves zero unlimited and charges estimated usage against the budget', async () => {
  await inTenant1(() => book.add(userId, target(), original))
  const key = AGENT_LIMIT_PARAMS.userDailyCredits
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['0.002020', key])
  await app.get(ParamService).invalidate(key)
  expect(await inTenant1(() => book.overDaily(userId))).toBe('user_daily')
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['0', key])
  await app.get(ParamService).invalidate(key)
  expect(await inTenant1(() => book.overDaily(userId))).toBeNull()
  // 配了费率但用量未知：按估算计积分，标为估算，不冒充供应商的 Token 统计
  const tokens = async () =>
    (
      await ds.query<{ p: string }[]>(
        'SELECT SUM(prompt_tokens) AS p FROM agent_usage WHERE tenant_id = 1 AND user_id = ?',
        [userId],
      )
    )[0]!.p
  expect(Number(await tokens())).toBe(1000)
  // 估算没有缓存细分：输入按三项里最高的缓存写入费率 2 计，1000 × 2 + 200 × 3
  expect(await inTenant1(() => book.add(userId, target(), estimatedUsage(1000, 200)))).toBe(
    '0.002600',
  )
  expect(Number(await tokens())).toBe(1000)
  expect(await inTenant1(() => book.today(userId))).toMatchObject({
    credits: '0.004620',
    promptTokens: null,
    unpricedCalls: 0,
    unreportedCalls: 1,
  })
  const [entry] = await ds.query<{ usage_json: unknown }[]>(
    'SELECT usage_json FROM agent_usage_entry WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId],
  )
  const stored =
    typeof entry!.usage_json === 'string' ? JSON.parse(entry!.usage_json) : entry!.usage_json
  expect(stored).toMatchObject({ estimated: true, usageReported: false })
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['0.004', key])
  await app.get(ParamService).invalidate(key)
  expect(await inTenant1(() => book.overDaily(userId))).toBe('user_daily')
})

it('charges reported usage it cannot split exactly, and an image without usage, against a finite budget', async () => {
  const key = AGENT_LIMIT_PARAMS.userDailyCredits
  const limitTo = async (value: string) => {
    await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', [value, key])
    await app.get(ParamService).invalidate(key)
  }
  const plain = { ...pricing, cacheRead: null, cacheWrite: null }
  const cases: [string, () => Promise<string | null>, string][] = [
    // 配了缓存费率却没报细分：全部输入按三项里最高的缓存写入费率 2 计
    [
      'cache rates without details',
      () =>
        inTenant1(() =>
          book.add(userId, target(), usageOf({ prompt_tokens: 1000, completion_tokens: 250 })),
        ),
      '0.002750',
    ],
    // total 与输入加输出不符：以 1000 + 250 计
    [
      'a total that disagrees',
      () =>
        inTenant1(() =>
          book.add(
            userId,
            { ...target(), pricing: plain },
            usageOf({ prompt_tokens: 1000, completion_tokens: 250, total_tokens: 9 }),
          ),
        ),
      '0.002250',
    ],
    // 图片成功但没报用量、也没配单张积分：提示词估算 + 固定的图片输出估算
    [
      'an image without usage',
      () => {
        const model = withUsageEstimate({
          stream: () => {
            throw new Error('unused')
          },
          complete: () => Promise.reject(new Error('unused')),
          image: async () => ({ data: Buffer.from('png'), usage: usageOf(undefined, true) }),
        })
        return inTenant1(async () => {
          await book.invoke(userId, { ...target(), pricing: plain, kind: 'image' }, {}, (receipt) =>
            model.image!({ model: 'same-model', prompt: 'a cat', ...receipt }),
          )
          const [row] = await ds.query<{ credits: string | null }[]>(
            'SELECT credits FROM agent_usage_entry WHERE user_id = ? ORDER BY id DESC LIMIT 1',
            [userId],
          )
          return row!.credits
        })
      },
      // 提示词 2 Token × 1.5 + 6240 × 3
      '0.018723',
    ],
  ]
  for (const [label, call, credits] of cases) {
    await clearAgentUsage(ds, [userId])
    await limitTo('0')
    // 用例名随结果一起比较，失败时能看出是哪种情况
    expect({ label, charged: await call() }).toEqual({ label, charged: credits })
    expect({ label, ...(await inTenant1(() => book.today(userId))) }).toMatchObject({
      label,
      credits,
      unpricedCalls: 0,
    })
    await limitTo(credits)
    expect({ label, over: await inTenant1(() => book.overDaily(userId)) }).toEqual({
      label,
      over: 'user_daily',
    })
  }
})

it('stores explicit free and image fallback charges without synthesizing token quantities', async () => {
  const free = {
    ...target(),
    pricing: { input: '0', output: '0', cacheRead: null, cacheWrite: null, imageCredits: null },
  }
  expect(await inTenant1(() => book.add(userId, free, usageOf(undefined)))).toBe('0.000000')
  expect(
    await inTenant1(() =>
      book.add(
        userId,
        { ...free, kind: 'image', pricing: { ...free.pricing, imageCredits: '3' } },
        usageOf(undefined, true),
      ),
    ),
  ).toBe('3.000000')
  const row = await inTenant1(() => book.today(userId))
  expect(row).toMatchObject({
    credits: '3.000000',
    unpricedCalls: 0,
    unreportedCalls: 2,
    promptTokens: null,
  })
})

it('serves a model without rates and records its calls as unpriced under a finite budget', async () => {
  const rows = [{ id: 'unpriced', reasoning: false, contextWindow: 64000 }]
  await ds.query('UPDATE agent_provider SET models = ? WHERE id = ?', [
    JSON.stringify(rows),
    providers[0],
  ])
  const key = AGENT_LIMIT_PARAMS.userDailyCredits
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['1', key])
  await app.get(ParamService).invalidate(key)
  try {
    const resolved = await app.get(ProviderRegistry).resolve(providers[0], 'unpriced')
    expect(resolved.model.pricing).toBeNull()
    const unpriced = { ...target(providers[0], 'unpriced'), pricing: null }
    for (let i = 0; i < 2; i++) {
      expect(await inTenant1(() => book.overDaily(userId))).toBeNull()
      expect(await inTenant1(() => book.add(userId, unpriced, original))).toBeNull()
    }
    expect(await inTenant1(() => book.today(userId))).toMatchObject({
      credits: '0.000000',
      unpricedCalls: 2,
      unreportedCalls: 0,
    })
  } finally {
    await ds.query('UPDATE agent_provider SET models = ? WHERE id = ?', [
      JSON.stringify([{ id: 'same-model', reasoning: false, contextWindow: 64000, pricing }]),
      providers[0],
    ])
  }
})

it('refuses a malformed rate in chat, image and the diagnostics probe instead of treating it as free', async () => {
  const bad = { input: 'abc', output: '1', cacheRead: null, cacheWrite: null, imageCredits: null }
  await ds.query('UPDATE agent_provider SET models = ? WHERE id = ?', [
    JSON.stringify([
      { id: 'bad-rate', reasoning: false, contextWindow: 64000, image: true, pricing: bad },
    ]),
    providers[0],
  ])
  const registry = app.get(ProviderRegistry)
  try {
    await expect(registry.resolve(providers[0], 'bad-rate')).rejects.toMatchObject({
      err: Err.AGENT_CREDIT_CONFIG_INVALID,
    })
    await expect(registry.resolveImage()).rejects.toMatchObject({
      err: Err.AGENT_CREDIT_CONFIG_INVALID,
    })
    const probe = await api()
      .post(`/api/agent/diagnostics/test-provider/${providers[0]}`)
      .set(bearer(root))
    expect(probe.status).toBe(422)
    expect(probe.body.code).toBe(Err.AGENT_CREDIT_CONFIG_INVALID.code)
  } finally {
    await ds.query('UPDATE agent_provider SET models = ? WHERE id = ?', [
      JSON.stringify([{ id: 'same-model', reasoning: false, contextWindow: 64000, pricing }]),
      providers[0],
    ])
  }
})

it('refuses a finite budget while an expired call is still unsettled, then lets it through once settled', async () => {
  const pending = await inTenant1(() => book.begin(userId, target(), {}))
  pending.release()
  await ds.query(
    'UPDATE agent_usage_entry SET lease_until = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE id = ?',
    [pending.id],
  )
  const key = AGENT_LIMIT_PARAMS.userDailyCredits
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['1', key])
  await app.get(ParamService).invalidate(key)
  // 结算暂时做不了（例如接管清理还没轮到它）：有限额度下先拒绝，不漏算后放行
  const recover = vi.spyOn(book, 'recoverExpired').mockResolvedValue(0)
  try {
    expect(await inTenant1(() => book.overDaily(userId))).toBe('user_daily')
  } finally {
    recover.mockRestore()
  }
  expect(await inTenant1(() => book.overDaily(userId))).toBeNull()
  const [row] = await ds.query<{ status: string }[]>(
    'SELECT status FROM agent_usage_entry WHERE id = ?',
    [pending.id],
  )
  expect(row!.status).toBe('unknown')
})

it('never marks a failed priced image as unpriced nor charges a paid image flat price without output', async () => {
  const zero = { input: '0', output: '0', cacheRead: '0', cacheWrite: '0', imageCredits: '0' }
  expect(
    await inTenant1(() =>
      book.add(userId, { ...target(), pricing: zero, kind: 'image' }, usageOf(undefined, true), {
        failed: true,
      }),
    ),
  ).toBe('0.000000')
  const key = AGENT_LIMIT_PARAMS.userDailyCredits
  await ds.query('UPDATE cfg_param SET param_value = ? WHERE param_key = ?', ['1', key])
  await app.get(ParamService).invalidate(key)
  expect(await inTenant1(() => book.overDaily(userId))).toBeNull()
  expect(
    await inTenant1(() =>
      book.add(
        userId,
        { ...target(), pricing: { ...pricing, imageCredits: '5' }, kind: 'image' },
        usageOf(undefined, true),
        { failed: true },
      ),
    ),
  ).toBe('0.000000') // 失败的图片没有产出，也没有请求估算可依：不收单张费用，但仍是已计价的调用
  expect(await inTenant1(() => book.today(userId))).toMatchObject({
    credits: '0.000000',
    unpricedCalls: 0,
    unreportedCalls: 2,
  })
})

it('guards the paged collection and never returns another tenant’s ledger entries', async () => {
  await inTenant1(() => book.add(userId, target(), original))
  await withTenant(tenant.id, () => book.add(tenant.users.admin, target(), original))
  const url = '/api/agent/usage/entries'
  const q = { from: usageDay(), to: usageDay(), pageSize: 200 }
  await api().get(url).query(q).expect(401)
  await api().get(url).query(q).set(bearer(forbidden)).expect(403)
  await api()
    .get(url)
    .query({ ...q, page: 0 })
    .set(bearer(root))
    .expect(400)
  const first = await api().get(url).query(q).set(bearer(root)).expect(200)
  expect(
    first.body.data.items.some((x: { userId: number }) => x.userId === tenant.users.admin),
  ).toBe(false)
  const second = await api().get(url).query(q).set(bearer(tenantRoot)).expect(200)
  expect(second.body.data.items).toHaveLength(1)
  expect(second.body.data.items[0].userId).toBe(tenant.users.admin)
})
