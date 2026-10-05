// Realtime on the H5 build, through the preview's socket proxy to the real server. A new
// to-do and its assignment message reach the tab badges within 2 s of the API's answer (the 60 s poll cannot
// explain it), and an admin's kick sends the app to the sign-in page within 2 s. The socket lives only while the
// app is in the foreground (App.vue onShow / onHide).
import { expect, test, type Page, type WebSocket } from '@playwright/test'
import { USERS, badge, bearer, clientIp, data, signIn } from './env'
import { EMPLOYEE, SUPERVISOR, counts, leave, seedWf } from './wf'

test.beforeAll(() => void seedWf())
test.beforeEach(({ page }) => page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() }))

/** Resolves with the page's next socket once it is up: the server acknowledged its CONNECT (`40{"sid":…}`). */
const connected = (page: Page) =>
  new Promise<WebSocket>((resolve) =>
    page.on('websocket', (ws) => {
      if (ws.url().includes('/socket.io/'))
        ws.on('framereceived', ({ payload }) => void (String(payload).startsWith('40') && resolve(ws)))
    }),
  )

/** uni-h5 runs App onHide / onShow on visibilitychange, as the App and mini program do on leaving and coming
 * back (a string: the e2e tsconfig has no DOM types). */
const visibility = (page: Page, state: 'hidden' | 'visible') =>
  page.evaluate(`Object.defineProperty(document, 'visibilityState', { value: '${state}', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))`)

/** A tab's badge shows `n` (none at 0). */
const shows = (page: Page, title: string, n: number, timeout?: number) =>
  n
    ? expect(badge(page, title)).toHaveText(n > 99 ? '99+' : String(n), { timeout })
    : expect(badge(page, title)).toHaveCount(0, { timeout })

test('a new to-do and its message reach the tab badges within 2 s, pushed', async ({
  page,
  request,
}) => {
  const up = connected(page)
  await page.goto('/')
  await signIn(page, SUPERVISOR)
  await up
  const before = await counts(request, await bearer(request, SUPERVISOR))
  await shows(page, '审批', before.todo)
  await shows(page, '消息', before.unread)

  // the employee's leave request: a to-do for the supervisor (`wf:task`) and its message (`notify:new`)
  await leave(request, await bearer(request, EMPLOYEE), 'mobile-push')
  await shows(page, '审批', before.todo + 1, 2_000)
  await shows(page, '消息', before.unread + 1, 2_000)
})

test('an admin kick reaches the app at once: the sign-in page within 2 s, and why', async ({
  page,
  request,
}) => {
  const up = connected(page)
  await page.goto('/')
  await signIn(page, SUPERVISOR)
  await up
  const admin = await bearer(request, USERS.admin)
  const sessions = await data<{ items: { sid: string }[] }>(
    request.get('/api/iam/sessions', {
      headers: admin,
      params: { username: SUPERVISOR.username, clientId: 'mobile', pageSize: 200 },
    }),
  )
  await data(
    request.post('/api/iam/sessions/kick', {
      headers: admin,
      data: { sids: sessions.items.map((s) => s.sid) },
    }),
  )
  await expect(page.locator('.qw-login__title')).toBeVisible({ timeout: 2_000 })
  await expect(page.getByText('你已被管理员强制下线，请重新登录')).toBeVisible()
})

test('the socket closes in the background and reconnects in the foreground, on any page', async ({ page }) => {
  await page.goto('/')
  await signIn(page, SUPERVISOR)
  // a page without the tab bar, opened cold: only the App's hooks start the socket (the first handshake has
  // no access token yet: refused, one refresh, connected)
  await page.goto('about:blank')
  let up = connected(page)
  await page.goto('/#/pages-sys/about/index')
  const first = await up
  await visibility(page, 'hidden')
  await expect.poll(() => first.isClosed(), { timeout: 2_000 }).toBe(true)
  up = connected(page)
  await visibility(page, 'visible')
  const again = await Promise.race([up, page.waitForTimeout(2_000).then(() => null)])
  expect(again, 'a new socket within 2 s').not.toBeNull()
})
