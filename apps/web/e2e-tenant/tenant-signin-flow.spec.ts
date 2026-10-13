// Multi-tenancy on (playwright.tenant.config.ts): on a host bound to no tenant the sign-in page asks for a
// tenant code, blank = the default tenant. A code that does not exist and a wrong password get the same
// answer. Tenant B and its owner come from the global setup (env.ts TENANT_B).
import { readFileSync } from 'node:fs'
import { TENANT_B, USERS } from '../e2e/env.ts'
import { expect, greeting, msg, submitLogin, test, type Page } from '../e2e/fixtures.ts'

const codeField = (page: Page) =>
  page.getByRole('textbox', { name: msg('auth.tenant.code'), exact: true })

/** The server's message for a failed sign-in where a tenant code could be typed. */
const badCredentials = (
  JSON.parse(
    readFileSync(new URL('../../server/src/i18n/zh-CN/error.json', import.meta.url), 'utf8'),
  ) as { auth: Record<string, string> }
).auth.bad_credentials_tenant!

/** A sign-in that fails: the page shows the message and stays; the answer without its trace id. */
async function failedSignIn(
  page: Page,
  code: string,
  user: { username: string; password: string },
) {
  await page.goto('/login')
  await codeField(page).fill(code)
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/login')),
    submitLogin(page, user),
  ])
  await expect(page.getByRole('alert').filter({ hasText: badCredentials })).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
  const { traceId: _, ...body } = (await res.json()) as Record<string, unknown>
  return { status: res.status(), body }
}

test('the sign-in page shows the code field; an unknown code and a wrong password get the same answer', async ({
  page,
}) => {
  await page.goto('/login')
  await expect(codeField(page)).toBeVisible()
  await expect(codeField(page)).toHaveValue('')

  const unknownCode = await failedSignIn(page, 'e2e-nobody', TENANT_B.admin)
  const wrongPassword = await failedSignIn(page, TENANT_B.code, {
    ...TENANT_B.admin,
    password: 'Wrong-Pass1',
  })
  expect(unknownCode.status).toBe(401)
  expect(wrongPassword).toEqual(unknownCode)
})

test('a blank code signs in to the default tenant', async ({ page }) => {
  await page.goto('/login')
  await expect(codeField(page)).toHaveValue('')
  await submitLogin(page, USERS.admin)
  await expect(page).toHaveURL(/\/home$/)
  // the default tenant's `admin` (Administrator), not B's
  await expect(greeting(page)).toBeVisible()
})

test("tenant B's owner signs in with the code, changes the forced password and lands home", async ({
  page,
}) => {
  const field = (key: string) =>
    page.getByLabel(msg(`common.passwordChange.${key}`), { exact: true })
  const newPassword = 'E2e-Changed@2026'

  await page.goto('/login')
  await codeField(page).fill(TENANT_B.code)
  await submitLogin(page, TENANT_B.admin)
  await expect(page).toHaveURL(/\/password-change/)
  await expect(page.getByText(msg('common.passwordChange.required'))).toBeVisible()

  await field('oldPassword').fill(TENANT_B.admin.password)
  await field('newPassword').fill(newPassword)
  await field('confirmPassword').fill(newPassword)
  await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
  await expect(page).toHaveURL(/\/home$/)
  // B's own `admin` (display name = username), not the default tenant's Administrator
  await expect(greeting(page, TENANT_B.admin.username)).toBeVisible()
})
