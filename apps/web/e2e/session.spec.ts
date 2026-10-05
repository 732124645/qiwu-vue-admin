import { USERS } from './env.ts'
import { currentPage, expect, msg, signIn, test } from './fixtures.ts'

// Acceptance: an admin kicks a session from the online users page; the kicked
// browser (its own context) is told so over the socket and lands on the sign-in page within 2 s.

// the other browser's client IP: its session row is the only one with it
const OTHER_IP = '203.0.113.207'

test('online users: the admin kicks another browser, which lands on the sign-in page within 2 s', async ({
  page,
  browser,
}) => {
  const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': OTHER_IP } })
  try {
    // the other browser: e2e_limited signed in on the home page, its socket connected
    const other = await context.newPage()
    const login = await other.request.post('/api/auth/login', { data: USERS.limited })
    expect(login.ok(), await login.text()).toBe(true)
    await other.goto('/login')
    await other.evaluate(`localStorage.setItem('qw.auth.session', '1')`)
    const connected = other.waitForEvent('websocket', (ws) => ws.url().includes('/socket.io/'))
    await other.goto('/home')
    await expect(other).toHaveURL(/\/home$/)
    await connected

    await signIn(page, 'admin', '/monitor/sessions')
    await expect(currentPage(page, 'menu.iam.session')).toBeVisible()
    // the admin's own session: marked, no kick buttons
    await expect(page.getByRole('row').filter({ hasText: msg('iam.session.current') })).toHaveCount(
      1,
    )
    await page.getByRole('textbox', { name: msg('field.iam.session.ip') }).fill(OTHER_IP)
    await page.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
    const row = page.getByRole('row').filter({ hasText: OTHER_IP })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText(USERS.limited.username)

    await row.getByRole('button', { name: msg('iam.session.kick'), exact: true }).click()
    const confirm = page.getByRole('dialog', { name: msg('crud.confirm.title') })
    await confirm.getByRole('button', { name: msg('iam.session.kick'), exact: true }).click()
    const kickedAt = Date.now()
    await expect(page.getByText(msg('iam.session.kicked', 'zh-CN', { count: 1 }))).toBeVisible()
    await expect(row).toHaveCount(0)

    // pushed, not polled: the other browser leaves for the sign-in page (and says why)
    await expect(other).toHaveURL(/\/login\?redirect=\/home$/, { timeout: 2000 })
    expect(Date.now() - kickedAt).toBeLessThan(2000)
    await expect(other.getByText(msg('common.session.kicked'))).toBeVisible()
    // the session is over: a reload finds no refresh to fall back on
    await other.goto('/home')
    await expect(other).toHaveURL(/\/login\?redirect=\/home$/)
  } finally {
    await context.close()
  }
})
