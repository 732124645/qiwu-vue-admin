import { SPA_CSP } from '../csp.ts'
import { USERS } from './env.ts'
import { expect, msg, signIn, submitLogin, test, type Page } from './fixtures.ts'

/** Every visible control has an accessible name (icon-only ones via an i18n aria-label). */
async function expectNamedControls(page: Page) {
  for (const role of ['button', 'link', 'menuitem', 'checkbox', 'textbox', 'combobox'] as const)
    for (const control of await page.getByRole(role).all())
      await expect(control, `${role} without a name`).toHaveAccessibleName(/\S/)
}

test('the api answers through the preview proxy', async ({ request }) => {
  const res = await request.get('/api/health')
  expect(res.ok()).toBe(true)
  expect((await res.json()).code).toBe(0)
})

test('the built app is served under the SPA CSP', async ({ page }) => {
  const res = await page.goto('/login')
  expect(res?.headers()['content-security-policy']).toBe(SPA_CSP)
  await expect(page.getByRole('heading', { name: msg('common.login.title') })).toBeVisible()
})

test('a signed-in admin lands on the first menu page', async ({ page }) => {
  await signIn(page, 'admin')
  await expect(page).toHaveURL(/\/home$/)
})

test('global setup seeded the limited and the must-change-password users', async ({ page }) => {
  await signIn(page, 'limited')
  await expect(page).toHaveURL(/\/home$/)
  await page.context().clearCookies()
  await signIn(page, 'fresh')
  await expect(page).toHaveURL(/\/password-change\?redirect=/)
})

test('controls have accessible names in both languages: sign-in page, header, side menu, tags', async ({
  page,
}) => {
  await page.goto('/login')
  const signInButton = (lang: string) =>
    page.getByRole('button', { name: msg('common.action.signIn', lang), exact: true })
  await expect(signInButton('zh-CN')).toBeVisible()
  // the password eye is a named toggle button, usable from the keyboard
  const password = page.getByLabel(msg('common.login.password'), { exact: true })
  await password.fill('secret')
  const eye = page.getByRole('button', { name: msg('common.form.showPassword'), exact: true })
  await eye.press('Enter')
  await expect(password).toHaveAttribute('type', 'text')
  await expect(eye).toHaveAttribute('aria-pressed', 'true')
  await expectNamedControls(page)

  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(signInButton('en-US')).toBeVisible()
  await expectNamedControls(page)

  await submitLogin(page, USERS.admin, 'en-US')
  await expect(page).toHaveURL(/\/home$/)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNamedControls(page)
})
