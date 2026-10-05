// Shared Playwright fixture: every test fails on a CSP violation (securitypolicyviolation event or a
// console error about the policy), an uncaught page error, or an app document served without the CSP
// header (see docs/design-notes.md#security). Plus sign-in and locale-text helpers.
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  test as base,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { loadEnv } from 'vite'
import { USERS, type E2eUser } from './env.ts'

export { expect }
export type { Page }

let client = 0
/**
 * A made-up client IP (TEST-NET-2), honoured from the loopback preview proxy (TRUST_PROXY=loopback): each
 * test's browser and each API sign-in pose as their own client, so the per-IP login (20/min) and refresh
 * (60/min) limits never throttle the suite.
 */
export const clientIp = () => `198.51.100.${(client++ % 250) + 1}`

/**
 * Collects CSP violations, uncaught page errors and app documents served without the CSP header on
 * `page`; the `page` fixture asserts the list is empty at the end, a page from another context does it
 * itself.
 */
export async function watchPage(page: Page, baseURL = '') {
  const problems: string[] = []
  // init scripts run outside the page CSP; the violation is re-reported as a console error below
  await page.addInitScript({
    content: `document.addEventListener('securitypolicyviolation', (e) =>
        console.error('CSP violation: ' + e.violatedDirective + ' blocked ' + (e.blockedURI || 'inline')))`,
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && /content.security.policy|\bCSP\b/i.test(m.text()))
      problems.push(m.text())
  })
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`))
  page.on('response', (r) => {
    if (
      r.request().resourceType() === 'document' &&
      r.url().startsWith(baseURL) &&
      !r.headers()['content-security-policy']
    )
      problems.push(`document without a CSP header: ${r.url()}`)
  })
  return problems
}

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() })
    const problems = await watchPage(page, baseURL)
    await use(page)
    expect(problems, 'CSP violations / page errors').toEqual([])
  },
})

/**
 * Signs in through the API (the refresh cookie lands in the page's context) and leaves the session hint
 * the sign-in page would, then opens `path`; the router guard exchanges the cookie for an access token
 * like on any reload.
 */
export async function signIn(page: Page, user: E2eUser = 'admin', path = '/') {
  const res = await page.request.post('/api/auth/login', {
    data: USERS[user],
    headers: { 'X-Forwarded-For': clientIp() },
  })
  expect(res.ok(), await res.text()).toBe(true)
  await page.goto('/login')
  await page.evaluate(`localStorage.setItem('qw.auth.session', '1')`)
  await page.goto(path)
}

/**
 * Signs `user` in through the API context `request` (its own client IP) and returns the `Authorization`
 * header value of that session, e.g. for test setup calls or to watch a session end.
 */
export async function bearer(
  request: APIRequestContext,
  user: { username: string; password: string } = USERS.admin,
) {
  const res = await request.post('/api/auth/login', {
    data: user,
    headers: { 'X-Forwarded-For': clientIp() },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return `Bearer ${((await res.json()) as { data: { accessToken: string } }).data.accessToken}`
}

type Headers = Record<string, string>

/** A user's id by username (`GET /api/iam/users/options`, as the holder of `headers`). */
export async function userId(request: APIRequestContext, headers: Headers, username: string) {
  const res = await request.get('/api/iam/users/options', {
    headers,
    params: { keyword: username },
  })
  const list = ((await res.json()) as { data: { id: number; username: string }[] }).data
  return list.find((u) => u.username === username)!.id
}

/** Creates a dynamic workflow model and publishes `tree` as its first version (root's `headers`). */
export async function publishModel(
  request: APIRequestContext,
  headers: Headers,
  model: object,
  tree: object,
) {
  const created = await request.post('/api/wf/models', {
    headers,
    data: { formKind: 'dynamic', category: 'finance', ...model },
  })
  expect(created.ok(), await created.text()).toBe(true)
  const { id } = ((await created.json()) as { data: { id: number } }).data
  const version = await request.post(`/api/wf/models/${id}/versions`, {
    headers,
    data: { tree, fields: {} },
  })
  expect(version.ok(), await version.text()).toBe(true)
}

/** The OA employee's leave request of `days` days (it starts the seeded process `leave`); its instance id. */
export async function leaveRequest(request: APIRequestContext, days: number, reason: string) {
  const res = await request.post('/api/biz/leaves', {
    headers: { Authorization: await bearer(request, USERS.oaEmployee) },
    data: {
      leaveKind: 'personal',
      startAt: '2026-12-07T09:00:00+08:00',
      endAt: '2026-12-09T18:00:00+08:00',
      days,
      reason,
    },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { data: { instanceId: number } }).data.instanceId
}

/** Fills the sign-in form (labels in `lang`) and submits it; `user` may carry a wrong password. */
export async function submitLogin(
  page: Page,
  user: { username: string; password: string },
  lang = 'zh-CN',
) {
  await page
    .getByRole('textbox', { name: msg('common.login.username', lang), exact: true })
    .fill(user.username)
  await page.getByLabel(msg('common.login.password', lang), { exact: true }).fill(user.password)
  await page.getByRole('button', { name: msg('common.action.signIn', lang) }).click()
}

type Messages = { [key: string]: string | Messages }
const cache = new Map<string, Messages>()

/** Deep merge; the web loader does the same through `mergeLocaleFile` (@qiwu/shared, not built for e2e). */
const merge = (into: Messages, from: Messages): Messages => {
  for (const [k, v] of Object.entries(from))
    into[k] = typeof v === 'string' ? v : merge(typeof into[k] === 'object' ? into[k] : {}, v)
  return into
}

/**
 * Every web and shared locale file of `lang`, merged the way the app loads them: `<ns>.json` under `<ns>`,
 * a module fragment `<domain>.<biz>.json` at the root.
 */
function messages(lang: string) {
  let m = cache.get(lang)
  if (!m) {
    m = {}
    for (const dir of ['../src/locales/', '../../../packages/shared/src/i18n/']) {
      const root = new URL(`${dir}${lang}/`, import.meta.url)
      for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' }))
        if (file.endsWith('.json')) {
          const name = file.split(/[\\/]/).pop()!.slice(0, -5)
          const json = JSON.parse(readFileSync(new URL(file, root), 'utf8')) as Messages
          merge(m, name.includes('.') ? json : { [name]: json })
        }
    }
    cache.set(lang, m)
  }
  return m
}

/**
 * Web locale text by key (shared `validation.*` / `field.*` / `seed.*` and module fragments too), `{param}`s
 * filled in, e.g. `msg('menu.home')`, `msg('common.home.greeting.morning', 'en-US', { name: 'Administrator' })`.
 */
export function msg(key: string, lang = 'zh-CN', params: Record<string, string | number> = {}) {
  const value = key
    .split('.')
    .reduce<string | Messages | undefined>(
      (m, k) => (typeof m === 'object' ? m[k] : undefined),
      messages(lang),
    )
  if (typeof value !== 'string') throw new Error(`no ${lang} message '${key}'`)
  return value.replace(/\{(\w+)\}/g, (m, k: string) => String(params[k] ?? m))
}

/** The preview builds in production mode; configured branding wins in every locale, as in the router. */
export function appTitle(lang = 'zh-CN') {
  return (
    loadEnv('production', fileURLToPath(new URL('../', import.meta.url))).VITE_APP_TITLE ||
    msg('common.app.title', lang)
  )
}

/** The active tag names the current page in every layout mode. */
export function currentPage(page: Page, key: string, lang = 'zh-CN') {
  return page
    .getByRole('navigation', { name: msg('common.tags.label', lang) })
    .getByRole('link', { name: msg(key, lang), exact: true })
    .and(page.locator('[aria-current="page"]'))
}

/** The home page's greeting heading for `name`; the wording follows the time of day. */
export function greeting(page: Page, name = 'Administrator', lang = 'zh-CN') {
  const texts = ['morning', 'afternoon', 'evening'].map((k) =>
    msg(`common.home.greeting.${k}`, lang, { name }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  return page.getByRole('heading', { level: 1, name: new RegExp(`^(${texts.join('|')})$`) })
}

/**
 * The who-reviews choices in `scope` (a settings panel or drawer): no label's text runs into another one or out
 * of `scope`'s visible width (the English labels are the longest). `scope` and the labels are measured in one
 * frame: a drawer still slides in after it turned visible, and the slide moves both alike.
 */
export async function kindsFit(scope: Locator, lang: string) {
  const group = scope.getByRole('radiogroup', { name: msg('wf.designer.assignee.kind', lang) })
  await expect(group.getByRole('radio')).toHaveCount(11)
  const handle = await scope.elementHandle()
  const { outer, boxes } = await group.evaluate((g, s) => {
    const r = s!.getBoundingClientRect()
    return {
      outer: { left: r.left, right: r.left + s!.clientLeft + s!.clientWidth },
      boxes: [...g.querySelectorAll('.el-radio__label')].map((e) => {
        const b = e.getBoundingClientRect()
        return {
          text: e.textContent?.trim(),
          left: b.left,
          right: b.right,
          top: b.top,
          bottom: b.bottom,
        }
      }),
    }
  }, handle)
  await handle?.dispose()
  for (const [i, a] of boxes.entries()) {
    expect(a.left, a.text).toBeGreaterThanOrEqual(outer.left)
    expect(a.right, a.text).toBeLessThanOrEqual(outer.right)
    for (const b of boxes.slice(i + 1)) {
      const apart = a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top
      expect(apart, `${a.text} / ${b.text}`).toBe(true)
    }
  }
}
