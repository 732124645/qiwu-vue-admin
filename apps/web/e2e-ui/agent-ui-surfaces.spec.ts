import { readdirSync, readFileSync } from 'node:fs'
import {
  mergeLocaleFile,
  agentOptionsVo,
  agentProviderVo,
  agentToolVo,
  agentSkillVo,
  agentPromptVo,
  agentMemoryVo,
  accessTokenAdminVo,
  paramVo,
  type Messages,
  type MePayload,
} from '@qiwu/shared'
import { test, expect, type Page, type TestInfo } from '@playwright/test'

/** 从真实语言文件取可访问名称，避免测试复制一套与界面脱节的文案。 */
function messages(locale: string) {
  const root = new URL(`../src/locales/${locale}/`, import.meta.url)
  const all: Messages = {}
  for (const f of readdirSync(root).filter((f) => f.endsWith('.json')))
    mergeLocaleFile(all, f, JSON.parse(readFileSync(new URL(f, root), 'utf8')) as Messages)
  return (key: string) => {
    let value: unknown = all
    for (const part of key.split('.'))
      value = (value as Record<string, unknown> | undefined)?.[part]
    return typeof value === 'string' ? value : key
  }
}

const pages = [
  ['mcp/tools', 'platform/mcp/tool/index', 'menu.mcp.tool'],
  ['mcp/tokens', 'platform/mcp/token/index', 'menu.mcp.token'],
  ['agent/settings', 'platform/agent/setting/index', 'menu.agent.setting'],
  ['agent/skills', 'platform/agent/skill/index', 'menu.agent.skill'],
  ['agent/batch', 'platform/agent/batch/index', 'menu.agent.batch'],
  ['agent/usage', 'platform/agent/usage/index', 'menu.agent.usage'],
  ['agent/chat', 'platform/agent/chat/index', 'menu.agent.chat'],
  ['agent/automations', 'platform/agent/automation/index', 'menu.agent.automation'],
] as const
const stamp = '2026-10-22T02:00:00.000Z'
const tool = {
  name: 'iam.user.search',
  title: 'Search users',
  description: 'Search users within your access scope.',
  kind: 'read',
  perm: 'iam.user.browse',
  enabled: true,
  source: 'local',
  policy: 'auto',
  defaulted: true,
}
const model = {
  id: 'preview-model',
  label: '界面测试模型',
  reasoning: false,
  vision: false,
  fast: false,
  contextWindow: 32000,
  pricing: { input: '1', output: '2', cacheRead: null, cacheWrite: null, imageCredits: null },
  reasoningDefault: 'provider',
  reasoningStyle: 'standard',
}
const provider = {
  id: 1,
  name: '界面测试模型提供方',
  baseUrl: 'https://models.example.invalid/v1',
  hasKey: true,
  enabled: true,
  isDefault: true,
  sort: 0,
  models: [model],
  createdAt: stamp,
  updatedAt: stamp,
}
const skill = {
  id: 1,
  name: 'record-summary',
  description: '整理选中记录并提供清晰的摘要',
  body: '先读取记录，再给出摘要。修改前请确认。',
  scope: 'user',
  tools: null,
  editable: true,
  enabled: true,
  ownerId: 1,
  createdAt: stamp,
  updatedAt: stamp,
}
const options = {
  providers: [provider],
  defaults: { providerId: 1, model: model.id },
  skills: [skill],
  approvalModes: ['read_only', 'ask', 'trust', 'auto_review'],
  webSearch: false,
  paused: false,
  starters: ['查看我的待办'],
  prompts: [],
  trustSession: false,
  servers: [],
  tone: 'default',
}

/** 有限接口白名单：未知业务请求使测试失败，禁止请求落到真实后端或外部服务。 */
async function mock(page: Page, locale: string, dark = false) {
  const unexpected: string[] = []
  const errors: string[] = []
  await page.addInitScript(
    ({ locale, dark }) => {
      localStorage.setItem('qw.auth.session', '1')
      localStorage.setItem('qw.locale', locale)
      localStorage.setItem('qw.app.colorScheme', dark ? 'dark' : 'light')
    },
    { locale, dark },
  )
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/socket.io/**', (route) => route.abort())
  await page.routeWebSocket('**/socket.io/**', (socket) => socket.close())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/api/, '')
    const key = `${request.method()} ${path}`
    let data: unknown
    switch (key) {
      case 'POST /auth/refresh':
        data = { accessToken: 'local-ui-fixture', expiresIn: 900 }
        break
      case 'GET /auth/me':
        data = {
          user: {
            id: 1,
            username: 'preview',
            displayName: '界面检查',
            avatarUrl: null,
            deptId: null,
            deptName: null,
            roleNames: ['管理员'],
            locale: null,
            timezone: null,
          },
          roles: ['root'],
          perms: ['*'],
          flags: { mustChangePassword: false, passwordExpired: false },
          policy: { minLength: 8, charClasses: 2, expireDays: 0 },
          lastSignInAt: null,
        } satisfies MePayload
        break
      case 'GET /auth/menus':
        data = pages.map(([path, component, name], i) => ({
          id: i + 1,
          parentId: null,
          kind: 'page',
          routePath: `/${path}`,
          routeName: path === 'agent/chat' ? 'agent-chat' : `preview-${i}`,
          name,
          nameI18n: null,
          component,
          componentName: null,
          children: [],
          visible: path !== 'agent/chat',
          keepAlive: false,
          linkType: null,
          icon: null,
        }))
        break
      case 'GET /messaging/bulletins/feed':
        data = { items: [], unread: 0 }
        break
      case 'GET /messaging/inboxes/mine':
        data = { items: [], total: 0 }
        break
      case 'GET /messaging/inboxes/mine/unread':
        data = { unread: 0 }
        break
      case 'GET /settings/dicts/core.yes_no/entries':
        data = {
          version: 1,
          entries: [
            { value: 'false', label: '否', labelI18n: { 'zh-CN': '否', 'en-US': 'No' } },
            { value: 'true', label: '是', labelI18n: { 'zh-CN': '是', 'en-US': 'Yes' } },
          ],
        }
        break
      case 'GET /mcp/tools':
      case 'GET /mcp/my-tools':
        data = [tool]
        break
      case 'GET /mcp/tokens':
        data = {
          items: [
            {
              id: 1,
              name: '本地开发访问',
              userId: 1,
              username: 'preview',
              displayName: '界面检查',
              tokenHint: 'preview',
              tools: ['iam.user.search'],
              allowWrite: false,
              expiresAt: null,
              revokedAt: null,
              lastUsedAt: stamp,
              createdAt: stamp,
            },
          ],
          total: 1,
        }
        break
      case 'GET /agent/providers':
        data = [provider]
        break
      case 'GET /agent/search-providers':
        data = []
        break
      case 'GET /agent/mcp-servers':
        data = []
        break
      case 'GET /agent/tools':
        data = [tool]
        break
      case 'GET /agent/skills':
        data = [skill]
        break
      case 'GET /agent/platform-skills':
        data = [{ ...skill, scope: 'platform' }]
        break
      case 'GET /agent/prompts':
        data = [
          {
            id: 1,
            name: '工作汇总',
            body: '请汇总我今天的工作。',
            scope: 'user',
            editable: true,
            enabled: true,
            createdAt: stamp,
          },
        ]
        break
      case 'GET /agent/instructions/me':
        data = { body: '请使用中文，先说明结论。', tone: 'concise' }
        break
      case 'GET /agent/instructions/tenant':
        data = { body: '涉及业务写入时需要本人确认。' }
        break
      case 'GET /settings/params': {
        const values = {
          'agent.paused': 'false',
          'agent.trust_mode': 'true',
          'agent.instructions': '',
          'agent.web.mode': 'off',
          'agent.web.allowed_domains': '[]',
          'agent.limit.turn_steps': '20',
          'agent.limit.turn_seconds': '300',
          'agent.limit.turn_credits': '200',
          'agent.limit.user_daily_credits': '1000',
          'agent.limit.tenant_daily_credits': '10000',
          'agent.limit.user_concurrent_turns': '2',
          'agent.memory.extract': 'false',
          'agent.memory.per_turn': '5',
          'agent.review.model': '',
          'agent.limit.research_steps': '60',
          'agent.limit.research_seconds': '1200',
          'agent.limit.automations_per_user': '20',
          'agent.limit.automation_runs_per_day': '50',
        }
        const items = Object.entries(values).map(([paramKey, paramValue], i) => ({
          id: i + 1,
          paramKey,
          paramValue,
          name: paramKey,
          nameI18n: null,
          groupCode: 'agent',
          isBuiltin: true,
          isSecret: false,
          isPublic: false,
          note: null,
          createdBy: null,
          updatedBy: null,
          createdAt: stamp,
          updatedAt: stamp,
        }))
        paramVo.array().parse(items)
        data = { items, total: items.length }
        break
      }
      case 'GET /agent/diagnostics':
        data = {
          providers: [provider],
          search: [],
          mcpServers: [],
          queue: { waiting: 0, active: 0, failed: 0, delayed: 0 },
          turns: { running: 0, waiting: 0, failedToday: 0 },
          recentFailures: [],
          sweeps: { lastAt: null, requeued: 0, failed: 0 },
        }
        break
      case 'GET /agent/usage':
        data = [
          {
            key: '2026-10-22',
            label: '2026-10-22',
            calls: 3,
            promptTokens: 1200,
            completionTokens: 300,
            totalTokens: 1500,
            cacheReadTokens: 200,
            cacheWriteTokens: null,
            reasoningTokens: null,
            credits: '0.0018',
            unpricedCalls: 0,
            unreportedCalls: 0,
            legacyCalls: 0,
          },
        ]
        break
      case 'GET /agent/options':
        data = options
        break
      case 'GET /agent/threads':
        data = { items: [], total: 0 }
        break
      case 'GET /agent/profiles':
        data = []
        break
      case 'GET /agent/memories':
        data = {
          items: [
            {
              id: 1,
              content: '偏好简洁中文回复。',
              source: 'manual',
              sourceThreadId: null,
              lastUsedAt: null,
              createdAt: stamp,
            },
          ],
          total: 1,
        }
        break
      case 'GET /agent/notify-settings':
        data = { turnDone: { mail: false }, waiting: { mail: true }, automation: { mail: false } }
        break
      case 'GET /agent/automations':
        data = []
        break
      case 'GET /agent/automation-events':
      case 'GET /agent/automation-tools':
        data = []
        break
      case 'GET /agent/batches/1':
        data = {
          batch: {
            id: 1,
            skill: skill.name,
            target: 'iam.user',
            status: 'completed',
            total: 1,
            finished: 1,
            failed: 0,
            createdAt: stamp,
          },
          rows: [
            { targetId: 1, label: '工作摘要', threadId: 1, turnStatus: 'completed', pending: [] },
          ],
        }
        break
      default:
        if (request.method() === 'GET' && /^\/iam\/profile\/prefs\/table\.[\w.-]+$/.test(path))
          data = { value: null }
        else {
          unexpected.push(key)
          await route.fulfill({ status: 501, json: { code: 'UI_UNMOCKED', msg: key } })
          return
        }
    }
    const contracts = {
      '/agent/options': agentOptionsVo,
      '/agent/providers': agentProviderVo.array(),
      '/agent/tools': agentToolVo.array(),
      '/agent/skills': agentSkillVo.array(),
      '/agent/platform-skills': agentSkillVo.array(),
      '/agent/prompts': agentPromptVo.array(),
    }
    const contract = contracts[path as keyof typeof contracts]
    if (contract) contract.parse(data)
    if (path === '/mcp/tokens') accessTokenAdminVo.array().parse((data as { items: unknown }).items)
    if (path === '/agent/memories') agentMemoryVo.array().parse((data as { items: unknown }).items)
    await route.fulfill({ json: { code: 0, msg: 'ok', data } })
  })
  return { unexpected, errors }
}

/** 截图和布局断言同时留存，横向表格滚动不算整页横向溢出。 */
async function capture(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('.qw-page, .agent-chat').first()).toBeVisible()
  await expect(page.locator('.el-loading-mask:visible')).toHaveCount(0)
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    animations: 'disabled',
  })
  const main = page.locator('main')
  if (await main.evaluate((el) => el.scrollHeight > el.clientHeight + 1)) {
    await main.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.screenshot({
      path: info.outputPath(`${name}-bottom.png`),
      fullPage: true,
      animations: 'disabled',
    })
    await main.evaluate((el) => {
      el.scrollTop = 0
    })
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    name,
  ).toBeLessThanOrEqual(1)
  const raw = await page
    .locator('body')
    .innerText()
    .catch(() => '')
  expect(raw, `${name}: no untranslated labels`).not.toMatch(
    /\b(?:agent\.(?:admin|chat|automation|profile|memory|tools)\.|field\.agent\.|menu\.agent\.|mcp\.tool\.(?:label|desc)\.)[\w.]+/,
  )
}

for (const [locale, dark, narrow] of [
  ['zh-CN', false, false],
  ['en-US', true, false],
  ['zh-CN', false, true],
] as const) {
  test(`agent pages and panels ${locale} ${dark ? 'dark' : 'light'} ${narrow ? 'narrow' : 'desktop'}`, async ({
    page,
  }, info) => {
    if (narrow) await page.setViewportSize({ width: 390, height: 844 })
    const msg = messages(locale)
    const state = await mock(page, locale, dark)
    const coverage: string[] = []
    for (const [path] of pages) {
      await page.goto(`/${path}${path === 'agent/batch' ? '?id=1' : ''}`)
      await expect(page).toHaveURL(new RegExp(path))
      await capture(page, info, path.replaceAll('/', '-'))
      coverage.push(path)
      if (path === 'agent/settings' || path === 'agent/skills') {
        const tabs =
          path === 'agent/settings'
            ? ['providers', 'search', 'mcp', 'tools', 'skills', 'params', 'diagnostics']
            : ['skills', 'prompts', 'instructions']
        for (const tab of tabs) {
          await page
            .getByRole('tab', {
              name: msg(
                path === 'agent/skills' && tab === 'skills'
                  ? 'agent.admin.skill.entity'
                  : `agent.admin.tab.${tab}`,
              ),
              exact: true,
            })
            .click()
          await capture(page, info, `${path.replaceAll('/', '-')}-${tab}`)
          coverage.push(`${path}#${tab}`)
        }
      }
      if (path === 'agent/chat') {
        if (narrow)
          await page.getByRole('button', { name: msg('crud.action.more'), exact: true }).click()
        for (const key of ['agent.profile.title', 'agent.memory.title']) {
          await page.getByRole('button', { name: msg(key), exact: true }).click()
          await expect(page.getByRole('dialog')).toBeVisible()
          await page.screenshot({
            path: info.outputPath(`${key}.png`),
            fullPage: true,
            animations: 'disabled',
          })
          coverage.push(key)
          await page.keyboard.press('Escape')
          await expect(page.getByRole('dialog')).toHaveCount(0)
        }
        for (const [key, selector] of [
          ['agent.chat.notify.open', '.agent-notify'],
          ['agent.chat.shortcut.open', '.agent-shortcuts'],
        ] as const) {
          await page.getByRole('button', { name: msg(key), exact: true }).click()
          await expect(page.locator(selector)).toBeVisible()
          await expect(page.locator(selector).locator('..')).toHaveCSS('opacity', '1')
          await page.screenshot({
            path: info.outputPath(`${key}.png`),
            fullPage: true,
            animations: 'disabled',
          })
          coverage.push(key)
          await page.getByRole('button', { name: msg(key), exact: true }).click()
        }
      }
    }
    await info.attach('coverage', {
      body: JSON.stringify({ locale, dark, narrow, coverage }, null, 2),
      contentType: 'application/json',
    })
    expect(state.unexpected).toEqual([])
    expect(state.errors).toEqual([])
  })
}

test('chat keyboard candidates and workspace stay inside the available layout', async ({
  page,
}, info) => {
  const state = await mock(page, 'en-US')
  const skills = Array.from({ length: 24 }, (_, index) => ({
    name: `record-${String(index).padStart(2, '0')}-${'x'.repeat(54)}`,
    description: `Detailed skill ${index}: ${'complete description '.repeat(24)}\nSecond paragraph.`,
    scope: 'user',
  }))
  await page.route('**/api/agent/options', (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: { ...options, skills } } }),
  )
  const geometry = async () => {
    await expect(page.locator('.agent-chat')).toBeVisible()
    await expect(page.locator('.agent-composer textarea')).toBeEnabled()
    await expect
      .poll(() =>
        page.locator('.app-layout__main').evaluate((el) => el.scrollHeight - el.clientHeight),
      )
      .toBeLessThanOrEqual(1)
    expect(
      await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
    ).toBeLessThanOrEqual(1)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1)
    const composer = await page.locator('.agent-composer').boundingBox()
    expect(composer).not.toBeNull()
    expect(composer!.y + composer!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  }
  const selectedIsVisible = async () => {
    const selected = page.locator('.agent-composer__suggest [aria-selected="true"]')
    const bounds = await selected.evaluate((el) => {
      const row = el.getBoundingClientRect()
      const list = el.closest('ul')!.getBoundingClientRect()
      return { top: row.top - list.top, bottom: row.bottom - list.bottom }
    })
    expect(bounds.top).toBeGreaterThanOrEqual(0)
    expect(bounds.bottom).toBeLessThanOrEqual(1)
    await expect(page.locator('.agent-composer textarea')).toBeFocused()
    expect(await page.locator('.app-layout__main').evaluate((el) => el.scrollTop)).toBe(0)
  }
  for (const viewport of [
    { width: 1000, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/agent/chat')
    await geometry()
    const textarea = page.locator('.agent-composer textarea')
    await textarea.fill('/')
    await textarea.press('ArrowUp')
    await expect(page.locator('.agent-composer__suggest [aria-selected="true"]')).toContainText(
      '/clear',
    )
    await selectedIsVisible()
    await textarea.press('ArrowDown')
    await expect(page.locator('.agent-composer__suggest [aria-selected="true"]')).toContainText(
      '/new',
    )
    for (let i = 0; i < 9; i++) await textarea.press('ArrowDown')
    await selectedIsVisible()
    await textarea.fill('/c')
    await expect(page.locator('.agent-composer__suggest [aria-selected="true"]')).toContainText(
      '/compact',
    )
    await selectedIsVisible()
    await textarea.fill('$')
    await textarea.press('ArrowUp')
    await selectedIsVisible()
    await textarea.press('ArrowDown')
    await page.locator('.agent-composer__suggest [role="option"]').first().hover()
    const tooltip = page.locator('.agent-composer__tooltip:visible')
    await expect(tooltip).toContainText(skills[0]!.name)
    await expect(tooltip).toContainText(skills[0]!.description)
    await expect(tooltip).toHaveCSS('opacity', '1')
    const tooltipBox = await tooltip.boundingBox()
    expect(tooltipBox!.x).toBeGreaterThanOrEqual(0)
    expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(viewport.width)
    expect(tooltipBox!.y).toBeGreaterThanOrEqual(0)
    expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(viewport.height)
    const families = await tooltip.evaluate((el) => ({
      actual: getComputedStyle(el).fontFamily,
      expected: getComputedStyle(document.body).fontFamily,
    }))
    expect(families.actual).toBe(families.expected)
    expect(
      await page
        .locator('.agent-composer__suggest')
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1)
    await page.screenshot({ path: info.outputPath(`chat-${viewport.width}.png`), fullPage: true })
  }

  const thread = {
    id: 42,
    title: 'Long conversation',
    status: 'active',
    providerId: 1,
    model: model.id,
    reasoning: null,
    approvalMode: 'ask',
    planMode: false,
    pinned: false,
    temporary: false,
    unread: 0,
    shared: false,
    forkedFromId: null,
    profileId: null,
    memoryEnabled: true,
    parentThreadId: null,
    automationRunId: null,
    batchId: null,
    turnStatus: 'completed',
    lastActiveAt: stamp,
    createdAt: stamp,
  }
  await page.route(/\/api\/agent\/threads(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        code: 0,
        msg: 'ok',
        data: {
          items: Array.from({ length: 30 }, (_, index) => ({
            ...thread,
            id: 42 + index,
            title: `Conversation ${index + 1}`,
          })),
          total: 30,
        },
      },
    }),
  )
  await page.route('**/api/agent/threads/42/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let data: unknown
    if (path.endsWith('/items'))
      data = {
        thread,
        turn: null,
        items: Array.from({ length: 80 }, (_, index) => ({
          id: index + 1,
          seq: index + 1,
          turnId: 1,
          kind: index % 2 ? 'assistant' : 'user',
          status: 'completed',
          payload: { text: `Message ${index + 1}\n${'Conversation details. '.repeat(30)}` },
          createdAt: stamp,
        })),
      }
    else if (path.endsWith('/status'))
      data = {
        threadId: 42,
        model: model.id,
        contextUsed: 2000,
        contextWindow: model.contextWindow,
        turn: null,
        today: { userTokens: 2000, userLimit: 100000, tenantTokens: 2000, tenantLimit: 1000000 },
      }
    else if (path.endsWith('/read')) data = null
    else {
      state.unexpected.push(`${route.request().method()} ${path}`)
      data = null
    }
    await route.fulfill({ json: { code: 0, msg: 'ok', data } })
  })
  await page.setViewportSize({ width: 1000, height: 720 })
  await page.goto('/agent/chat?thread=42')
  await expect(page.locator('.agent-chat__title')).toHaveText('Long conversation')
  await geometry()
  expect(
    await page
      .locator('.agent-chat__stream')
      .evaluate((el) => el.scrollHeight > el.clientHeight + 500),
  ).toBe(true)
  expect(
    await page
      .locator('.agent-threads__scroll')
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true)
  expect((await page.locator('.agent-threads').boundingBox())!.height).toBeLessThanOrEqual(201)
  await expect(page.locator('.agent-threads__open').first()).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: info.outputPath('chat-long.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await geometry()
  await expect(page.locator('.agent-threads__open').first()).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: info.outputPath('chat-long-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1000, height: 720 })

  await page.evaluate(() =>
    localStorage.setItem(
      'qw.app.settings',
      JSON.stringify({ fixedHeader: false, showFooter: true, layout: 'top' }),
    ),
  )
  await page.reload()
  await geometry()
  await page.screenshot({ path: info.outputPath('chat-top-footer.png'), fullPage: true })
  await page.evaluate(() =>
    localStorage.setItem('qw.app.settings', JSON.stringify({ fixedHeader: true })),
  )

  await page.goto('/agent/skills')
  await expect(page.locator('.qw-page')).toBeVisible()
  await page.locator('.qw-page').evaluate((el) => {
    const tall = document.createElement('div')
    tall.style.height = '1800px'
    el.append(tall)
  })
  expect(
    await page
      .locator('.app-layout__main')
      .evaluate((el) => el.scrollHeight > el.clientHeight + 500),
  ).toBe(true)
  await expect(page.locator('.app-layout__main')).toHaveCSS('overflow-y', 'auto')
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('credit rates, unlimited budgets, raw snapshots and explicit external trust are reviewable', async ({
  page,
}, info) => {
  page.setDefaultTimeout(10_000)
  const state = await mock(page, 'en-US')
  const msg = messages('en-US')
  let configured = {
    ...provider,
    models: [
      {
        ...model,
        reasoning: true,
        pricing: null as unknown,
        reasoningDefault: 'off',
        reasoningStyle: 'standard',
      },
    ],
  }
  const saved: Record<string, unknown>[] = []
  await page.route('**/api/agent/providers', (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: [configured] } }),
  )
  await page.route('**/api/agent/providers/1', async (route) => {
    const body = route.request().postDataJSON()
    saved.push(body)
    configured = { ...configured, ...body }
    await route.fulfill({ json: { code: 0, msg: 'ok', data: configured } })
  })
  await page.goto('/agent/settings')
  await expect(
    page.getByText(msg('agent.admin.model.pricingMissing'), { exact: false }).first(),
  ).toBeVisible()
  await page
    .getByRole('button', { name: msg('crud.action.edit'), exact: true })
    .first()
    .click()
  const providerDialog = page.getByRole('dialog')
  await providerDialog
    .getByRole('button', { name: new RegExp(msg('agent.admin.model.configure')) })
    .click()
  await providerDialog.getByText(msg('agent.admin.model.pricingEnabled'), { exact: true }).click()
  await expect(
    providerDialog.getByRole('checkbox', {
      name: msg('agent.admin.model.pricingEnabled'),
      exact: true,
    }),
  ).toBeChecked()
  const rate = (name: string) =>
    providerDialog.getByRole('textbox', { name: msg(`agent.admin.model.${name}`), exact: true })
  await rate('inputCredits').fill('0.123456')
  await rate('outputCredits').fill('0')
  await rate('cacheReadCredits').fill('0')
  await rate('cacheWriteCredits').fill('')
  await rate('imageCredits').fill('0.000001')
  await providerDialog
    .getByRole('combobox', { name: msg('agent.admin.model.reasoningStyle') })
    .press('Enter')
  await page
    .getByRole('option', { name: msg('agent.admin.model.reasoningVllm'), exact: true })
    .click()
  await expect(providerDialog.getByText(msg('agent.admin.model.vllmHint'))).toBeVisible()
  await providerDialog
    .getByRole('combobox', { name: msg('agent.admin.model.reasoningDefault') })
    .press('Enter')
  await page
    .getByRole('option', { name: msg('agent.admin.model.reasoningOn'), exact: true })
    .click()
  const providerBounds = await providerDialog.boundingBox()
  expect(providerBounds!.x).toBeGreaterThanOrEqual(0)
  expect(providerBounds!.x + providerBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  await page.screenshot({ path: info.outputPath('credit-model-rates.png'), fullPage: true })
  await providerDialog.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(providerDialog).toHaveCount(0)
  expect(saved[0]).toMatchObject({
    models: [
      {
        pricing: {
          input: '0.123456',
          output: '0',
          cacheRead: '0',
          cacheWrite: null,
          imageCredits: '0.000001',
        },
        reasoningDefault: 'medium',
        reasoningStyle: 'vllm',
      },
    ],
  })

  const params = [
    ['agent.limit.turn_credits', '3'],
    ['agent.limit.user_daily_credits', '10'],
    ['agent.limit.tenant_daily_credits', '20'],
    ['agent.limit.turn_steps', '20'],
    ['agent.limit.turn_seconds', '300'],
    ['agent.limit.user_concurrent_turns', '2'],
  ].map(([paramKey, paramValue], index) => ({
    id: index + 1,
    paramKey,
    paramValue,
    name: paramKey,
    nameI18n: null,
    groupCode: 'agent',
    isBuiltin: true,
    isSecret: false,
    isPublic: false,
    note: null,
    createdBy: null,
    updatedBy: null,
    createdAt: stamp,
    updatedAt: stamp,
  }))
  const budgets: Record<string, string> = {}
  await page.route('**/api/settings/params**', async (route) => {
    if (route.request().method() === 'GET')
      await route.fulfill({
        json: { code: 0, msg: 'ok', data: { items: params, total: params.length } },
      })
    else {
      const row = params.find(
        (entry) => entry.id === Number(new URL(route.request().url()).pathname.split('/').pop()),
      )!
      row.paramValue = route.request().postDataJSON().paramValue
      budgets[row.paramKey!] = row.paramValue!
      await route.fulfill({ json: { code: 0, msg: 'ok', data: row } })
    }
  })
  await page.getByRole('tab', { name: msg('agent.admin.tab.params'), exact: true }).click()
  await page
    .getByRole('textbox', { name: msg('agent.admin.limit.turnCredits'), exact: true })
    .fill('0')
  await page
    .getByRole('textbox', { name: msg('agent.admin.limit.userDailyCredits'), exact: true })
    .fill('0.123456')
  await page.locator('.param-tab__save-limits').click()
  await expect.poll(() => budgets['agent.limit.turn_credits']).toBe('0')
  await expect.poll(() => budgets['agent.limit.user_daily_credits']).toBe('0.123456')
  await expect(
    page.getByRole('spinbutton', { name: msg('agent.admin.limit.turnSeconds'), exact: true }),
  ).toHaveAttribute('aria-valuemin', '1')
  await page.screenshot({ path: info.outputPath('credit-budgets.png'), fullPage: true })

  const usage = {
    promptTokens: 1000,
    completionTokens: 20,
    totalTokens: 1020,
    cacheReadTokens: 800,
    cacheWriteTokens: null,
    reasoningTokens: null,
    inputDetails: { cached_tokens: 800 },
    outputDetails: null,
    rawUsage: {
      prompt_tokens: 1000,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 800 },
    },
    usageReported: true,
  }
  const entry = {
    id: 1,
    userId: 1,
    providerId: 1,
    providerName: provider.name,
    model: model.id,
    threadId: 7,
    turnId: 9,
    kind: 'chat',
    usage,
    pricing: {
      input: '0.000004',
      output: '0',
      cacheRead: null,
      cacheWrite: null,
      imageCredits: null,
    },
    credits: '0.000001',
    usageReported: true,
    createdAt: stamp,
  }
  const pagesSeen: string[] = []
  await page.route('**/api/agent/usage/entries*', (route) => {
    pagesSeen.push(new URL(route.request().url()).searchParams.get('page')!)
    return route.fulfill({
      json: {
        code: 0,
        msg: 'ok',
        data: {
          items: [
            entry,
            { ...entry, id: 2, usage: null, pricing: null, credits: null, usageReported: false },
          ],
          total: 21,
        },
      },
    })
  })
  await page.goto('/agent/usage')
  await page.getByRole('button', { name: msg('agent.admin.usage.entries'), exact: true }).click()
  const usageDialog = page.getByRole('dialog')
  await usageDialog
    .getByRole('button', { name: msg('agent.admin.usage.entry'), exact: true })
    .first()
    .click()
  await expect(usageDialog.locator('.usage-entries__detail')).toContainText('800')
  await usageDialog.getByText('pricing.json', { exact: true }).click()
  await expect(usageDialog.locator('.usage-entries__detail')).toContainText('0.000004')
  await expect(
    usageDialog.getByRole('button', { name: msg('agent.admin.close'), exact: true }),
  ).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: info.outputPath('credit-rate-snapshot.png'), fullPage: true })
  await usageDialog
    .getByRole('button', { name: msg('agent.admin.usage.entry'), exact: true })
    .nth(1)
    .click()
  await expect(usageDialog.getByText(msg('agent.admin.usage.legacy'))).toBeVisible()
  await expect(usageDialog.locator('.usage-entries__detail')).toContainText(
    msg('agent.admin.usage.unpriced'),
  )
  await usageDialog.locator('.el-pagination .btn-next').click()
  await expect.poll(() => pagesSeen.at(-1)).toBe('2')
  await page.screenshot({ path: info.outputPath('credit-entries.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const external = {
    id: 4,
    name: 'explicit-trust-server',
    url: 'https://mcp.example.invalid/mcp',
    authKind: 'none',
    hasAuth: false,
    allowPrivate: false,
    enabled: true,
    status: 'ok',
    lastError: null,
    syncedAt: stamp,
    tools: [
      {
        id: 9,
        name: 'search.unknown',
        title: 'Search',
        description: 'No read-only declaration',
        readOnlyHint: false,
        enabled: true,
        policy: 'ask',
      },
    ],
  }
  const policyWrites: unknown[] = []
  await page.route('**/api/agent/mcp-servers', (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: [external] } }),
  )
  await page.route('**/api/agent/mcp-servers/4/tools/9', async (route) => {
    policyWrites.push(route.request().postDataJSON())
    await route.fulfill({
      json: { code: 0, msg: 'ok', data: { ...external.tools[0], policy: 'auto' } },
    })
  })
  await page.goto('/agent/settings')
  await page.getByRole('tab', { name: msg('agent.admin.tab.mcp'), exact: true }).click()
  await page.getByRole('button', { name: msg('agent.admin.mcp.tools'), exact: true }).click()
  const policy = page.getByRole('combobox', {
    name: `${msg('agent.admin.tool.policy')} search.unknown`,
  })
  await policy.press('Enter')
  await page.getByRole('option', { name: msg('agent.admin.policy.auto'), exact: true }).click()
  const confirmation = page.locator('.el-message-box')
  await expect(confirmation).toContainText(external.name)
  await expect(confirmation).toContainText('search.unknown')
  await expect(confirmation).toContainText(
    'does not change confirmation requirements for local tools',
  )
  await confirmation.getByRole('button', { name: msg('common.action.cancel'), exact: true }).click()
  expect(policyWrites).toHaveLength(0)
  await policy.press('Enter')
  await page.getByRole('option', { name: msg('agent.admin.policy.auto'), exact: true }).click()
  await confirmation.getByRole('button', { name: 'OK', exact: true }).click()
  await expect.poll(() => policyWrites.length).toBe(1)
  expect(policyWrites[0]).toEqual({ policy: 'auto' })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('chat displays effective thinking and separates estimated context from recorded credits', async ({
  page,
}, info) => {
  page.setDefaultTimeout(10_000)
  const state = await mock(page, 'en-US')
  const msg = messages('en-US')
  const th = {
    id: 77,
    title: 'Credit status',
    status: 'active',
    providerId: 1,
    model: model.id,
    reasoning: null,
    approvalMode: 'ask',
    planMode: false,
    pinned: false,
    temporary: false,
    unread: 0,
    shared: false,
    forkedFromId: null,
    profileId: null,
    memoryEnabled: true,
    parentThreadId: null,
    automationRunId: null,
    batchId: null,
    turnStatus: 'completed',
    lastActiveAt: stamp,
    createdAt: stamp,
  }
  const turn = {
    id: 9,
    threadId: 77,
    status: 'completed',
    steps: 3,
    promptTokens: 200,
    completionTokens: 30,
    credits: '0.000123',
    unpricedCalls: 2,
    unreportedCalls: 1,
    legacyUsage: true,
    error: null,
    startedAt: stamp,
    endedAt: stamp,
  }
  await page.route('**/api/agent/options*', (route) =>
    route.fulfill({
      json: {
        code: 0,
        msg: 'ok',
        data: {
          ...options,
          providers: [
            {
              ...provider,
              models: [
                { ...model, reasoning: true, reasoningDefault: 'off', reasoningStyle: 'vllm' },
              ],
            },
          ],
        },
      },
    }),
  )
  await page.route('**/api/agent/threads/77/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    let data: unknown
    if (path.endsWith('/items')) data = { thread: th, items: [], turn }
    else if (path.endsWith('/status'))
      data = {
        threadId: 77,
        model: model.id,
        contextUsed: 6400,
        contextWindow: 32000,
        turn,
        today: {
          userTokens: null,
          tenantTokens: null,
          userCredits: '1.25',
          tenantCredits: '2.5',
          userLimit: '0',
          tenantLimit: '10',
          userUnpricedCalls: 2,
          tenantUnpricedCalls: 4,
          userLegacyCalls: 3,
          tenantLegacyCalls: 3,
        },
      }
    else if (path.endsWith('/read')) data = null
    else {
      state.unexpected.push(`${route.request().method()} ${path}`)
      data = null
    }
    await route.fulfill({ json: { code: 0, msg: 'ok', data } })
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/agent/chat?thread=77')
  const textarea = page.locator('.agent-composer textarea')
  await expect(page.locator('.agent-chat__title')).toHaveText(th.title)
  const reasoning = page.getByRole('combobox', {
    name: msg('agent.chat.composer.reasoning'),
    exact: true,
  })
  await expect(page.locator('.agent-composer__reasoning')).toContainText('Model default: Off')
  expect(
    await page
      .locator('.agent-composer__reasoning .el-select__placeholder')
      .evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1)
  await reasoning.press('Enter')
  const choices = page.getByRole('option')
  await expect(choices).toHaveText(['Off', 'On'])
  await page.keyboard.press('Escape')
  await textarea.fill('/status')
  await textarea.press('Enter')
  const status = page.locator('.agent-chat__status')
  await expect(status).toContainText('0.000123')
  await expect(status.locator('dd').filter({ hasText: '0.000123' })).toBeInViewport({ ratio: 1 })
  await expect(status).toContainText('1.25 / Unlimited')
  await expect(status).toContainText('2.5 / 10')
  await expect(status).toContainText('Context estimate 20%')
  await expect(status).toContainText('Unpriced calls: 2')
  await expect(status).toContainText('Calls without reported usage: 1')
  await expect(status).toContainText(msg('agent.chat.status.legacyHint'))
  expect(
    await page.locator('.app-layout__main').evaluate((el) => el.scrollHeight - el.clientHeight),
  ).toBeLessThanOrEqual(1)
  const bounds = await page.locator('.agent-composer').boundingBox()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844)
  expect(await status.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath('chat-credit-status.png'), fullPage: true })
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('work panel summarizes only the current conversation and keeps desktop and drawer reading bounded', async ({
  page,
}, info) => {
  page.setDefaultTimeout(10_000)
  const state = await mock(page, 'en-US')
  const msg = messages('en-US')
  const remoteRequests: string[] = [],
    ledgerRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/agent\/usage/.test(request.url())) ledgerRequests.push(request.url())
  })
  await page.route(/^https?:\/\/[^/]+\.test\//, (route) => {
    remoteRequests.push(route.request().url())
    return route.abort()
  })
  let privateReads = 0
  await page.route('**/api/storage/objects/55/download*', (route) => {
    privateReads++
    return route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6fkoAAAAASUVORK5CYII=',
        'base64',
      ),
    })
  })
  const firstThread = {
    id: 101,
    title: 'First conversation',
    status: 'active',
    providerId: 1,
    model: model.id,
    reasoning: null,
    approvalMode: 'ask',
    planMode: false,
    pinned: false,
    temporary: false,
    unread: 0,
    shared: false,
    forkedFromId: null,
    profileId: null,
    memoryEnabled: true,
    parentThreadId: null,
    automationRunId: null,
    batchId: null,
    turnStatus: 'waiting',
    lastActiveAt: stamp,
    createdAt: stamp,
  }
  const secondThread = {
    ...firstThread,
    id: 102,
    title: 'Second conversation',
    turnStatus: 'completed',
  }
  const turn = {
    id: 1,
    threadId: 101,
    status: 'waiting',
    steps: 3,
    promptTokens: 100,
    completionTokens: 20,
    credits: '0.001',
    unpricedCalls: 0,
    unreportedCalls: 0,
    legacyUsage: false,
    error: null,
    startedAt: stamp,
    endedAt: null,
  }
  const entry = (id: number, kind: string, payload: object, status = 'done') => ({
    id,
    seq: id,
    turnId: 1,
    kind,
    payload,
    status,
    createdAt: stamp,
  })
  const firstItems = [
    entry(1, 'plan', { steps: [{ text: 'Old plan', status: 'done' }] }),
    entry(2, 'plan', {
      steps: [
        { text: 'Gather evidence', status: 'doing' },
        { text: 'Write the result', status: 'pending' },
      ],
    }),
    entry(3, 'tool_call', {
      callId: 'read',
      tool: 'custom.lookup',
      title: 'Look up records',
      source: 'local',
      kind: 'read',
      args: {},
    }),
    entry(4, 'tool_result', {
      callId: 'read',
      ok: true,
      preview: 'Found records',
      untrusted: false,
    }),
    entry(5, 'assistant', {
      text: '# First answer\n\nRead **the evidence**.\n\n```ts\nconst total = 2\n```',
      citations: [
        { title: 'First source', url: 'https://evidence.test/article' },
        { title: 'Duplicate', url: 'HTTPS://EVIDENCE.test/article' },
        { title: 'Unsafe source', url: 'javascript:bad()' },
        { title: 'Credential source', url: 'https://user:pass@private.test/' },
        { title: 'Control source', url: 'https://evi\ndence.test/other' },
      ],
    }),
    entry(6, 'report', {
      title: 'Research summary',
      text: '# Report detail\n\nThis is a reusable report.',
      citations: [{ title: 'Report source', url: 'https://research.test/report' }],
    }),
    entry(7, 'chart', {
      title: 'Counts',
      kind: 'table',
      categories: ['Count'],
      series: [{ name: 'Result', data: [2] }],
    }),
    entry(8, 'image', { fileId: 55, prompt: 'Generated illustration' }),
    entry(
      9,
      'tool_call',
      {
        callId: 'write',
        tool: 'custom.update',
        title: 'Update record',
        source: 'local',
        kind: 'write',
        args: { id: 1 },
      },
      'pending',
    ),
    entry(
      10,
      'approval',
      {
        callId: 'write',
        tool: 'custom.update',
        title: 'Update record',
        args: { id: 1 },
        sources: [],
        perCallConfirmation: true,
        confirmationToken: 'local-fixture-preview-only',
      },
      'pending',
    ),
  ]
  const secondItems = [
    entry(21, 'assistant', {
      text: '# Second answer',
      citations: [{ title: 'Second source', url: 'https://second.test/source' }],
    }),
  ]
  let releaseSecond!: () => void,
    secondRequested = false
  const secondGate = new Promise<void>((resolve) => {
    releaseSecond = resolve
  })
  await page.route(/\/api\/agent\/threads(?:\?|$)/, (route) =>
    route.fulfill({
      json: { code: 0, msg: 'ok', data: { items: [firstThread, secondThread], total: 2 } },
    }),
  )
  await page.route(/\/api\/agent\/threads\/(101|102)\//, async (route) => {
    const path = new URL(route.request().url()).pathname
    const second = path.includes('/102/')
    let data: unknown
    if (path.endsWith('/items')) {
      if (second) {
        secondRequested = true
        await secondGate
      }
      data = {
        thread: second ? secondThread : firstThread,
        items: second ? secondItems : firstItems,
        turn: second ? null : turn,
      }
    } else if (path.endsWith('/status'))
      data = {
        threadId: second ? 102 : 101,
        model: model.id,
        contextUsed: 2000,
        contextWindow: 32000,
        turn: second ? null : turn,
        today: {
          userTokens: 120,
          tenantTokens: 120,
          userCredits: '0.001',
          tenantCredits: '0.001',
          userLimit: '0',
          tenantLimit: '0',
          userUnpricedCalls: 0,
          tenantUnpricedCalls: 0,
        },
      }
    else if (path.endsWith('/read')) data = null
    else {
      state.unexpected.push(`${route.request().method()} ${path}`)
      data = null
    }
    await route.fulfill({ json: { code: 0, msg: 'ok', data } })
  })
  await page.route('**/api/agent/shared/panel-preview', (route) =>
    route.fulfill({
      json: {
        code: 0,
        msg: 'ok',
        data: { thread: firstThread, items: [firstItems[7]], turn: null },
      },
    }),
  )
  const panel = page.locator('.agent-context')
  const toggle = () => page.getByRole('button', { name: msg('agent.chat.panel.open'), exact: true })
  const openTab = async (key: string) =>
    panel.getByRole('tab', { name: msg(`agent.chat.panel.${key}`), exact: true }).click()
  const bounded = async () => {
    expect(
      await page.locator('.app-layout__main').evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeLessThanOrEqual(1)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1)
    const box = await page.locator('.agent-composer').boundingBox()
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  }
  await page.goto('/agent/chat?thread=101')
  await expect(page.locator('.agent-chat__title')).toHaveText(firstThread.title)
  await expect(panel).toHaveCount(0)
  await expect.poll(() => privateReads).toBe(1)
  await toggle().click()
  await expect(panel).toBeVisible()
  expect(Math.round((await panel.boundingBox())!.width)).toBe(340)
  await expect(panel).toContainText('Gather evidence')
  await expect(panel).not.toContainText('Old plan')
  await expect(panel.locator('.agent-context__tools')).toContainText('Waiting for you')
  await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(1)
  await openTab('sources')
  for (const link of await panel.locator('.agent-context__sources a').all()) {
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }
  expect(
    await panel
      .locator('.agent-context__sources a')
      .evaluateAll((links) => links.map((link) => link.getAttribute('href'))),
  ).toEqual(['https://evidence.test/article', 'https://research.test/report'])
  await openTab('outputs')
  await panel.getByRole('button', { name: 'Research summary', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Report detail', exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Counts', exact: true }).click()
  await expect(panel.locator('.agent-output__table')).toContainText('Count')
  await panel.getByRole('button', { name: 'Generated illustration', exact: true }).click()
  await expect(panel.locator('img')).toHaveAttribute('src', /^blob:/)
  await expect.poll(() => privateReads).toBe(2)
  await page.locator('.agent-composer textarea').fill('Draft remains')
  await panel.getByRole('button', { name: msg('agent.chat.panel.close'), exact: true }).click()
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.agent-composer textarea')).toHaveValue('Draft remains')
  const expand = page
    .locator('.agent-msg--assistant')
    .getByRole('button', { name: msg('agent.chat.markdown.expand'), exact: true })
  await expand.click()
  await expect(panel.getByRole('heading', { name: 'First answer', exact: true })).toBeVisible()
  await openTab('sources')
  await expand.click()
  await expect(
    panel.getByRole('tab', { name: msg('agent.chat.panel.outputs'), exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await bounded()
  await page.screenshot({
    path: info.outputPath('work-panel-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  })
  try {
    await page.locator('.agent-threads__open').filter({ hasText: secondThread.title }).click()
    await expect.poll(() => secondRequested).toBe(true)
    await expect(panel.locator('.agent-context__preview')).toHaveCount(0)
    await expect(panel.locator('.agent-context__sources a')).toHaveCount(0)
    await expect(panel).not.toContainText('First source')
  } finally {
    releaseSecond()
  }
  await expect(page.locator('.agent-chat__title')).toHaveText(secondThread.title)
  await openTab('sources')
  await expect(panel.locator('.agent-context__sources a')).toHaveText('Second source')
  await expect(panel).not.toContainText('First source')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/agent/chat?thread=101')
  await toggle().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(panel).toBeVisible()
  await openTab('outputs')
  await panel.getByRole('button', { name: 'Research summary', exact: true }).click()
  await expect(panel.getByRole('heading', { name: 'Report detail', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  const drawer = await page.getByRole('dialog').boundingBox()
  expect(drawer!.x).toBeGreaterThanOrEqual(0)
  expect(drawer!.x + drawer!.width).toBeLessThanOrEqual(390)
  await page.screenshot({
    path: info.outputPath('work-panel-drawer.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await panel.getByRole('button', { name: msg('agent.chat.panel.close'), exact: true }).click()
  await expect(panel).toHaveCount(0)
  await bounded()
  await expect.poll(() => privateReads).toBe(3)
  const readsBeforeShared = privateReads
  await page.goto('/agent/chat?shared=panel-preview')
  await toggle().click()
  await openTab('outputs')
  await panel.getByRole('button', { name: 'Generated illustration', exact: true }).click()
  await expect(panel).toContainText(msg('agent.output.image.shared'))
  await expect(panel.locator('img')).toHaveCount(0)
  expect(privateReads).toBe(readsBeforeShared)
  expect(ledgerRequests).toEqual([])
  expect(remoteRequests).toEqual([])
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})

test('floating chat keeps the business page and draft, and inspects child work without leaving its parent', async ({
  page,
}, info) => {
  page.setDefaultTimeout(10_000)
  const state = await mock(page, 'en-US')
  const msg = messages('en-US')
  const parent = {
    id: 501,
    title: 'Prepare stock report',
    status: 'active',
    providerId: 1,
    model: model.id,
    reasoning: null,
    approvalMode: 'ask',
    planMode: false,
    pinned: false,
    temporary: false,
    unread: 0,
    shared: false,
    forkedFromId: null,
    profileId: null,
    memoryEnabled: true,
    parentThreadId: null,
    automationRunId: null,
    batchId: null,
    turnStatus: 'running',
    lastActiveAt: stamp,
    createdAt: stamp,
  }
  const child = { ...parent, id: 502, title: 'Check warehouse stock', parentThreadId: 501 }
  const turn = {
    id: 1,
    threadId: 501,
    status: 'running',
    steps: 2,
    promptTokens: 10,
    completionTokens: 2,
    credits: '0.000014',
    unpricedCalls: 0,
    unreportedCalls: 0,
    legacyUsage: false,
    error: null,
    startedAt: stamp,
    endedAt: null,
  }
  const entry = (id: number, kind: string, payload: object, status = 'done') => ({
    id,
    seq: id,
    turnId: 1,
    kind,
    payload,
    status,
    createdAt: stamp,
  })
  const items = [
    entry(1, 'user', { text: 'Prepare a report using the latest warehouse stock.' }),
    entry(2, 'assistant', { text: 'I am checking stock and reviewing recent sales.' }),
    entry(3, 'subagent', {
      callId: 'delegate',
      tasks: [
        { title: child.title, threadId: 502, status: 'running' },
        {
          title: 'Review recent sales',
          threadId: 503,
          status: 'completed',
          summary: 'Recent sales have been reviewed.',
        },
        {
          title: 'Check missing receipts',
          threadId: 504,
          status: 'failed',
          summary: 'The source is temporarily unavailable.',
        },
      ],
    }),
  ]
  let cancels = 0,
    childReads = 0
  await page.route(/\/api\/agent\/threads(?:\?|$)/, (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: { items: [parent], total: 1 } } }),
  )
  await page.route(/\/api\/agent\/threads\/50[12]\//, async (route) => {
    const path = new URL(route.request().url()).pathname
    const isChild = path.includes('/502/')
    let data: unknown = null
    if (path.endsWith('/items')) {
      if (isChild) childReads++
      data = {
        thread: isChild ? child : parent,
        turn: isChild ? { ...turn, threadId: 502 } : turn,
        items: isChild
          ? [
              entry(
                21,
                'assistant',
                {
                  text: '# Warehouse stock\n\nThere are **24 available units**.\n\n| Item | Units |\n| --- | --- |\n| Spare parts | 24 |',
                },
                'running',
              ),
            ]
          : items,
      }
    } else if (path.endsWith('/status'))
      data = {
        threadId: 501,
        model: model.id,
        contextUsed: 100,
        contextWindow: 32000,
        turn,
        today: {
          userTokens: 12,
          tenantTokens: 12,
          userCredits: '0.000014',
          tenantCredits: '0.000014',
          userLimit: '0',
          tenantLimit: '0',
          userUnpricedCalls: 0,
          tenantUnpricedCalls: 0,
        },
      }
    else if (path.endsWith('/cancel')) cancels++
    else if (!path.endsWith('/read')) state.unexpected.push(`${route.request().method()} ${path}`)
    await route.fulfill({ json: { code: 0, msg: 'ok', data } })
  })
  await page.goto('/mcp/tools?filter=mine')
  const businessUrl = page.url()
  await expect(
    page
      .locator('.app-layout__aside')
      .getByRole('menuitem', { name: msg('menu.agent.chat'), exact: true }),
  ).toHaveCount(0)
  const floating = page.getByRole('button', { name: msg('agent.chat.entry'), exact: true })
  await floating.click()
  const dock = page.locator('.agent-chat-dock')
  const composer = dock.locator('.agent-composer textarea')
  await expect(composer).toBeVisible()
  expect(page.url()).toBe(businessUrl)
  await expect(dock.locator('.agent-chat__context')).toContainText(msg('menu.mcp.tool'))
  await composer.fill('$rec')
  await expect(dock.getByRole('option')).toHaveCount(1)
  await composer.press('Escape')
  await expect(dock.getByRole('option')).toHaveCount(0)
  await expect(dock).toBeVisible()
  await composer.fill('Keep my unsent draft')
  await dock.getByRole('button', { name: msg('agent.chat.dock.close'), exact: true }).click()
  await expect(dock).toBeHidden()
  await expect(floating).toBeFocused()
  await floating.click()
  await expect(composer).toHaveValue('Keep my unsent draft')
  await dock.getByRole('button', { name: msg('agent.chat.thread.list'), exact: true }).click()
  await dock.locator('.agent-threads__open').filter({ hasText: parent.title }).click()
  await expect(dock.locator('.agent-chat__title')).toHaveText(parent.title)
  await expect(dock.locator('.agent-subtasks')).toContainText('Active 1 · Finished 2')
  await expect(dock.locator('.agent-subtasks')).toContainText('Failed')
  await dock.locator('.agent-subtasks__task').filter({ hasText: child.title }).click()
  const inspector = page.locator('.agent-child')
  await expect(inspector).toContainText('24 available units')
  await expect(inspector.locator('.el-loading-mask')).toHaveCount(0)
  await expect(inspector.locator('textarea')).toHaveCount(0)
  expect(page.url()).toBe(businessUrl)
  await page.screenshot({
    path: info.outputPath('floating-chat-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await inspector.getByRole('button', { name: msg('agent.chat.subtask.back'), exact: true }).click()
  await dock.getByRole('button', { name: msg('agent.chat.dock.expand'), exact: true }).click()
  await expect(dock).toHaveCSS('width', '1440px')
  await dock.getByRole('button', { name: msg('agent.chat.dock.restore'), exact: true }).click()
  await expect(dock).toHaveCSS('width', '980px')
  await page.keyboard.press('Escape')
  await expect(dock).toBeHidden()
  await expect(floating).toBeFocused()
  expect(cancels).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await floating.click()
  await expect(composer).toHaveValue('Keep my unsent draft')
  const bounds = await dock.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.width).toBeLessThanOrEqual(390)
  const editorBounds = await composer.boundingBox()
  expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(844)
  await dock.locator('.agent-subtasks__task').filter({ hasText: child.title }).click()
  await expect(inspector).toContainText('24 available units')
  await page.screenshot({
    path: info.outputPath('floating-chat-phone.png'),
    fullPage: true,
    animations: 'disabled',
  })
  await inspector.getByRole('button', { name: msg('agent.chat.panel.close'), exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(dock).toBeHidden()
  expect(cancels).toBe(0)
  // 空输入且后台轮次仍运行时，Esc 也只收起浮层，不能冒泡成停止请求。
  await floating.click()
  await composer.fill('')
  await composer.press('Escape')
  await expect(dock).toBeHidden()
  await expect(floating).toBeFocused()
  expect(cancels).toBe(0)
  const beforeShare = childReads
  await page.route('**/api/agent/shared/dock-preview', (route) =>
    route.fulfill({ json: { code: 0, msg: 'ok', data: { thread: parent, items, turn: null } } }),
  )
  await page.goto('/agent/chat?shared=dock-preview')
  await expect(page.locator('.agent-subtasks__task').first()).toBeDisabled()
  await expect(floating).toHaveCount(0)
  expect(childReads).toBe(beforeShare)
  expect(state.unexpected).toEqual([])
  expect(state.errors).toEqual([])
})
