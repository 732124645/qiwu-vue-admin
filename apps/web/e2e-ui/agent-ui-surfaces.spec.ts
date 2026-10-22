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
          routeName: `preview-${i}`,
          name,
          nameI18n: null,
          component,
          componentName: null,
          children: [],
          visible: true,
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
          'agent.limit.turn_tokens': '200000',
          'agent.limit.user_daily_tokens': '1000000',
          'agent.limit.tenant_daily_tokens': '10000000',
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
