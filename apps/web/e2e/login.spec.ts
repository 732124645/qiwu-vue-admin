import { SPA_CSP } from '../csp.ts'
import { USERS } from './env.ts'
import { expect, greeting, msg, signIn, submitLogin, test, type Page } from './fixtures.ts'

const checkbox = (page: Page, key: string) =>
  page.getByRole('checkbox', { name: msg(key), exact: true })

async function signOut(page: Page) {
  await page.getByRole('button', { name: msg('common.layout.userMenu') }).click()
  await page.getByRole('menuitem', { name: msg('common.action.signOut') }).click()
  await expect(page).toHaveURL(/\/login$/)
}

/** The refresh cookie as the login response set it and as the browser keeps it. */
async function loginCookie(page: Page, submit: () => Promise<void>) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login')),
    submit(),
  ])
  expect(res.ok()).toBe(true)
  const header = (await res.headerValue('set-cookie')) ?? ''
  const stored = (await page.context().cookies()).find((c) => c.name === 'qw_rt')
  return { header, expires: stored?.expires }
}

test('sign in, stay signed in across a reload, sign out', async ({ page }) => {
  // the silent refresh runs only after a sign-in in this browser (session hint): no 401 while signed out
  const refreshes: number[] = []
  page.on('response', (r) => {
    if (r.url().endsWith('/api/auth/refresh')) refreshes.push(r.status())
  })
  const res = await page.goto('/home')
  expect(res?.headers()['content-security-policy']).toBe(SPA_CSP)
  await expect(page).toHaveURL(/\/login\?redirect=\/home$/)
  await expect(checkbox(page, 'common.login.keepSignedIn')).not.toBeChecked()

  // "keep me signed in" off → a session cookie (no Expires / Max-Age)
  const cookie = await loginCookie(page, () => submitLogin(page, USERS.admin))
  expect(cookie.header).toMatch(/^qw_rt=/)
  expect(cookie.header).not.toMatch(/expires=|max-age=/i)
  expect(cookie.expires).toBe(-1)
  await expect(page).toHaveURL(/\/home$/)
  await expect(greeting(page)).toBeVisible()

  await page.reload()
  await expect(page).toHaveURL(/\/home$/)
  await expect(greeting(page)).toBeVisible()

  await signOut(page)
  await page.goto('/home')
  await expect(page).toHaveURL(/\/login\?redirect=\/home$/)
  expect(refreshes).toEqual([200])
})

test('a reload while the API restarts (502s, then no answer) retries the refresh and stays signed in', async ({
  page,
}) => {
  await signIn(page, 'admin', '/home')
  await expect(greeting(page)).toBeVisible()
  // what the dev proxy or a load balancer answers while the API is down: 502, a refused connection
  let refreshes = 0
  await page.route('**/api/auth/refresh', async (route) => {
    refreshes++
    if (refreshes <= 2) await route.fulfill({ status: 502, body: '' })
    else if (refreshes === 3) await route.abort('connectionrefused')
    else await route.continue()
  })
  await page.reload()
  // the guard waits 1 + 1 + 2 s between the attempts
  await expect(greeting(page)).toBeVisible({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/home$/)
  expect(refreshes).toBe(4)
})

test('"keep me signed in" sets a persistent refresh cookie', async ({ page }) => {
  await page.goto('/login')
  await page.getByText(msg('common.login.keepSignedIn'), { exact: true }).click()
  const cookie = await loginCookie(page, () => submitLogin(page, USERS.admin))
  expect(cookie.header).toMatch(/max-age=\d+/i)
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 3600)
  await expect(page).toHaveURL(/\/home$/)

  // the session hint persists with the cookie: a new tab signs in silently
  const tab = await page.context().newPage()
  await tab.goto('/home')
  await expect(greeting(tab)).toBeVisible()
})

test('a signed-out visit to a page signs in and comes back; foreign redirects go home', async ({
  page,
}) => {
  await page.goto('/settings/dicts')
  await expect(page).toHaveURL(/\/login\?redirect=\/settings\/dicts$/)
  await submitLogin(page, USERS.admin)
  await expect(page).toHaveURL(/\/settings\/dicts$/)

  for (const target of ['//evil.example/x', 'https://evil.example/x', '/\\evil.example']) {
    await page.context().clearCookies()
    await page.goto(`/login?redirect=${encodeURIComponent(target)}`)
    await submitLogin(page, USERS.admin)
    await expect(page).toHaveURL(/127\.0\.0\.1:\d+\/home$/)
  }
})

test('remember username fills the form next time; unchecking forgets it', async ({ page }) => {
  const username = page.getByRole('textbox', { name: msg('common.login.username'), exact: true })
  await page.goto('/login')
  await expect(username).toHaveValue('')
  await page.getByText(msg('common.login.rememberUsername'), { exact: true }).click()
  await submitLogin(page, USERS.admin)
  await expect(page).toHaveURL(/\/home$/)
  await signOut(page)

  await expect(username).toHaveValue(USERS.admin.username)
  await expect(checkbox(page, 'common.login.rememberUsername')).toBeChecked()
  await page.getByText(msg('common.login.rememberUsername'), { exact: true }).click()
  await submitLogin(page, USERS.admin)
  await expect(page).toHaveURL(/\/home$/)
  await signOut(page)
  await expect(username).toHaveValue('')
  await expect(checkbox(page, 'common.login.rememberUsername')).not.toBeChecked()
})

test('wrong credentials show the server message inline and stay on the page', async ({ page }) => {
  await page.goto('/login?redirect=/home')
  await submitLogin(page, { username: 'e2e_nobody', password: 'Wrong-Pass1' })
  await expect(page.getByRole('alert').filter({ hasText: '用户名或密码错误' })).toBeVisible()
  await expect(page).toHaveURL(/\/login\?redirect=\/home$/)
})

test('forced password change: only that page and sign-out until changed, then the original target', async ({
  page,
}) => {
  const { changer } = USERS
  const newPassword = 'E2e-Changed@2026'
  const field = (key: string) =>
    page.getByLabel(msg(`common.passwordChange.${key}`), { exact: true })
  const fieldError = (text: string) => page.locator('.el-form-item__error', { hasText: text })
  const newLabel = { field: msg('field.auth.newPassword') }

  await page.goto('/home?from=login')
  await submitLogin(page, changer)
  await expect(page).toHaveURL(/\/password-change\?redirect=/)
  await expect(page.getByText(msg('common.passwordChange.required'))).toBeVisible()

  // sign-out is the only way out
  await page.getByRole('button', { name: msg('common.action.signOut') }).click()
  await expect(page).toHaveURL(/\/login$/)
  await submitLogin(page, changer)
  await expect(page).toHaveURL(/\/password-change\?redirect=\/$/)

  // any other route (reload included) comes back here, remembering the target
  await page.goto('/e2e/page')
  await expect(page).toHaveURL(/\/password-change\?redirect=\/e2e\/page$/)
  // public pages too, reached in-app (as Back / Forward would) while the session is known
  for (const path of ['/login', '/404']) {
    await page.evaluate(
      `history.pushState(null, '', '${path}'); dispatchEvent(new PopStateEvent('popstate'))`,
    )
    await expect(page).toHaveURL(/\/password-change$/)
    await expect(field('oldPassword')).toBeVisible()
  }
  await page.goto('/home?from=login')
  await expect(page).toHaveURL(/\/password-change\?redirect=\/home\?from=login$/)

  // the shared policy schema validates in the page, messages as the server's
  await field('oldPassword').fill(changer.password)
  await field('newPassword').fill('short')
  await field('confirmPassword').fill('other')
  await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
  await expect(
    fieldError(msg('validation.too_small.string', 'zh-CN', { ...newLabel, minimum: 8 })),
  ).toBeVisible()
  await expect(fieldError(msg('common.passwordChange.mismatch'))).toBeVisible()
  await field('newPassword').fill(changer.password)
  await field('confirmPassword').fill(changer.password)
  await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
  await expect(fieldError(msg('validation.password.same_as_old'))).toBeVisible()

  // the server's check of the old password shows inline
  await field('oldPassword').fill('Wrong-Pass1')
  await field('newPassword').fill(newPassword)
  await field('confirmPassword').fill(newPassword)
  await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
  await expect(page.getByRole('alert').filter({ hasText: '旧密码不正确' })).toBeVisible()

  await field('oldPassword').fill(changer.password)
  await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
  await expect(page).toHaveURL(/\/home\?from=login$/)
  await expect(greeting(page, changer.username)).toBeVisible()
  await page.reload()
  await expect(greeting(page, changer.username)).toBeVisible()

  // next sign-in with the new password goes straight in
  await signOut(page)
  await submitLogin(page, { ...changer, password: newPassword })
  await expect(page).toHaveURL(/\/home$/)
})
