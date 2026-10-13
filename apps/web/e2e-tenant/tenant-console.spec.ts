// Multi-tenancy on (playwright.tenant.config.ts), the console end to end: the platform root opens a tenant
// on a package without the workflow menus from the tenant list (its administrator, a host name, a brand
// name and logo); that administrator signs in with the tenant code, changes the forced password and sees
// neither the workflow nor a platform page; the root enters the tenant with a reason, works under the
// banner and leaves. With UI_SHOTS=1 also the review screenshots of the tenant list, the packages, the
// banner and the branded sign-in page, light and dark, into docs/design/screenshots/.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  PLATFORM_ONLY_ROUTES,
  type MePayload,
  type MenuNode,
  type RoleMenuNode,
} from '@qiwu/shared'
import {
  bearer,
  expect,
  greeting,
  msg,
  signIn,
  submitLogin,
  test,
  type Page,
} from '../e2e/fixtures.ts'

test.describe.configure({ mode: 'serial' })

const TENANT = {
  code: 'e2e-console',
  name: 'E2E Console',
  brand: 'Acme Cloud',
  // the preview serves `localhost` too: a sign-in page there belongs to this tenant
  domain: 'localhost',
  admin: { username: 'owner', displayName: 'E2E Console Owner' },
}
const PACKAGE = 'E2E no workflow'
const NEW_PASSWORD = 'E2e-Console@2026'
/** the administrator's initial password, answered once when the tenant is opened */
let initialPassword = ''

/** the sign-in page on the host the tenant is bound to (the same preview, by `localhost`) */
const boundLogin = (baseURL = '') => `${baseURL.replace('127.0.0.1', TENANT.domain)}/login`
const field = (prop: string) => msg(`field.iam.tenant.${prop}`)
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const banner = (page: Page) =>
  page
    .getByRole('status')
    .filter({ hasText: msg('layout.tenant.banner', 'zh-CN', { name: TENANT.name }) })

/** sharp from the server's dependencies draws the logo (no web dependency for a test) */
const sharp = createRequire(new URL('../../server/package.json', import.meta.url))('sharp') as (o: {
  create: object
}) => {
  composite(layers: object[]): { png(): { toBuffer(): Promise<Buffer> } }
}
const square = (size: number, r: number, g: number, b: number) => ({
  create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 1 } },
})

/** A package of every menu open to tenants but the workflow group (root's API session). */
async function createPackage(page: Page) {
  const headers = { Authorization: await bearer(page.request) }
  const tree = await page.request.get('/api/iam/tenant-packages/menu-tree', { headers })
  expect(tree.ok(), await tree.text()).toBe(true)
  const ids = (nodes: RoleMenuNode[]): number[] =>
    nodes.filter((n) => n.name !== 'menu.workflow.title').flatMap((n) => [n.id, ...ids(n.children)])
  const menuIds = ids(((await tree.json()) as { data: RoleMenuNode[] }).data)
  const res = await page.request.post('/api/iam/tenant-packages', {
    headers,
    data: { name: PACKAGE, menuIds },
  })
  expect(res.ok(), await res.text()).toBe(true)
}

/** Enters the tenant from its row of the tenant list with a reason; the page reloads into it. */
async function enterTenant(page: Page) {
  await row(page, TENANT.code)
    .getByRole('button', { name: msg('iam.tenant.enter.action'), exact: true })
    .click()
  const dialog = page.getByRole('dialog', {
    name: msg('iam.tenant.enter.title', 'zh-CN', { name: TENANT.name }),
  })
  await dialog.getByRole('textbox', { name: field('reason') }).fill('e2e: check the console')
  await dialog.getByRole('button', { name: msg('iam.tenant.enter.submit') }).click()
  await expect(banner(page)).toBeVisible()
}

/** Leaves from the banner: the whole page reloads, and its `/auth/me` is no longer inside the tenant. */
async function leaveTenant(page: Page) {
  const [me] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/me')),
    banner(page)
      .getByRole('button', { name: msg('layout.tenant.leave') })
      .click(),
  ])
  expect(((await me.json()) as { data: MePayload }).data.tenant?.acting).toBe(false)
  await expect(banner(page)).toHaveCount(0)
}

test('the platform root opens a tenant with its administrator, host name and brand', async ({
  page,
  baseURL,
}) => {
  await signIn(page, 'admin', '/iam/tenants')
  await createPackage(page)
  await expect(row(page, msg('seed.tenant.default'))).toBeVisible()

  await page.getByRole('button', { name: msg('crud.action.create'), exact: true }).click()
  const create = page.getByRole('dialog', {
    name: msg('crud.title.create', 'zh-CN', { name: msg('iam.tenant.entity') }),
  })
  await create.getByRole('textbox', { name: field('code') }).fill(TENANT.code)
  await create.getByRole('textbox', { name: field('name') }).fill(TENANT.name)
  await create.getByRole('combobox', { name: field('packageId') }).click({ force: true })
  await page.getByRole('option', { name: PACKAGE, exact: true }).click()
  const domains = create.getByRole('textbox', { name: field('domains') })
  await domains.fill(TENANT.domain)
  await domains.press('Enter')
  await create.getByRole('textbox', { name: field('brandName') }).fill(TENANT.brand)
  const logo = await sharp(square(128, 15, 118, 110))
    .composite([{ input: square(56, 255, 255, 255), top: 36, left: 36 }])
    .png()
    .toBuffer()
  await create
    .locator('input[type=file]')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: logo })
  await expect(create.locator('.image-upload__img')).toBeVisible()
  await create.getByRole('textbox', { name: field('username') }).fill(TENANT.admin.username)
  await create.getByRole('textbox', { name: field('displayName') }).fill(TENANT.admin.displayName)
  await create.getByRole('button', { name: msg('crud.action.save') }).click()

  // the initial password, shown this once beside the administrator's username
  const shown = page.getByRole('dialog', { name: msg('iam.tenant.created.title') })
  await expect(
    shown.getByRole('textbox', { name: msg('iam.tenant.created.username') }),
  ).toHaveValue(TENANT.admin.username)
  initialPassword = await shown
    .getByRole('textbox', { name: msg('iam.tenant.created.password') })
    .inputValue()
  expect(initialPassword).not.toBe('')
  await shown.getByRole('button', { name: msg('iam.tenant.saved') }).click()
  await expect(shown).toBeHidden()
  await expect(create).toBeHidden()
  await expect(row(page, TENANT.code)).toContainText(PACKAGE)
  await expect(row(page, TENANT.code)).toContainText(TENANT.domain)

  // a sign-in page on the bound host shows the tenant's brand and asks for no code
  await page.goto(boundLogin(baseURL))
  const brand = page.locator('.auth-brand__logo')
  await expect(brand).toContainText(TENANT.brand)
  await expect(brand.locator('img')).toHaveAttribute('src', /^\/files\//)
  await expect(
    page.getByRole('textbox', { name: msg('auth.tenant.code'), exact: true }),
  ).toHaveCount(0)
})

test('its administrator signs in with the code, changes the password and sees no workflow or platform page', async ({
  page,
}) => {
  const pwd = (key: string) => page.getByLabel(msg(`common.passwordChange.${key}`), { exact: true })
  await page.goto('/login')
  await page.getByRole('textbox', { name: msg('auth.tenant.code'), exact: true }).fill(TENANT.code)
  await submitLogin(page, { username: TENANT.admin.username, password: initialPassword })
  await expect(page).toHaveURL(/\/password-change/)
  await expect(page.getByText(msg('common.passwordChange.required'))).toBeVisible()
  await pwd('oldPassword').fill(initialPassword)
  await pwd('newPassword').fill(NEW_PASSWORD)
  await pwd('confirmPassword').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: msg('common.passwordChange.submit') }).click()
  await expect(page).toHaveURL(/\/home$/)
  await expect(greeting(page, TENANT.admin.displayName)).toBeVisible()

  // the granted menus: the package's, without the workflow group and every platform page
  const [menus] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/auth/menus')),
    page.reload(),
  ])
  const routes = new Set<string | null>()
  const walk = (nodes: MenuNode[]): void =>
    nodes.forEach((n) => (routes.add(n.routeName), walk(n.children)))
  walk(((await menus.json()) as { data: MenuNode[] }).data)
  expect(routes).toContain('iam-user')
  expect(routes).not.toContain('workflow')
  for (const route of PLATFORM_ONLY_ROUTES) expect(routes, route).not.toContain(route)

  const side = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await expect(side.getByText(msg('menu.system.title'), { exact: true })).toBeVisible()
  await expect(side.getByText(msg('menu.workflow.title'), { exact: true })).toHaveCount(0)
  await side.getByText(msg('menu.system.title'), { exact: true }).click()
  await expect(side.getByText(msg('menu.iam.user'), { exact: true })).toBeVisible()
  await expect(side.getByText(msg('menu.iam.tenant'), { exact: true })).toHaveCount(0)
  await expect(side.getByText(msg('menu.iam.menu'), { exact: true })).toHaveCount(0)
})

test('the platform root enters the tenant under the banner and leaves it', async ({ page }) => {
  await signIn(page, 'admin', '/iam/tenants')
  await enterTenant(page)
  // still the root itself, not a user of the tenant
  await expect(page).toHaveURL(/\/home$/)
  await expect(greeting(page)).toBeVisible()

  await leaveTenant(page)
  await expect(page).toHaveURL(/\/home$/)
  await expect(greeting(page)).toBeVisible()
})

const OUT = fileURLToPath(new URL('../../../docs/design/screenshots/', import.meta.url))

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300) // route fade
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true, animations: 'disabled' })
}

for (const theme of ['light', 'dark'] as const)
  test(`screens ${theme} 1440`, async ({ page, baseURL }) => {
    test.skip(process.env.UI_SHOTS !== '1', 'set UI_SHOTS=1 to take the UI review screenshots')
    const tag = `${theme}-1440`
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript({
      content: `localStorage.setItem('qw.app.colorScheme', '${theme}')
        localStorage.setItem('qw.locale', 'zh-CN')`,
    })

    await page.goto(boundLogin(baseURL))
    await expect(page.locator('.auth-brand__logo')).toContainText(TENANT.brand)
    await expect(page.locator('.auth-brand__logo img')).toHaveJSProperty('complete', true)
    await shot(page, `login-tenant-brand-${tag}`)

    await signIn(page, 'admin', '/iam/tenants')
    await expect(row(page, TENANT.code)).toBeVisible()
    await shot(page, `tenants-${tag}`)

    await page.goto('/iam/tenant-packages')
    await expect(row(page, PACKAGE)).toBeVisible()
    await shot(page, `tenant-packages-${tag}`)

    await page.goto('/iam/tenants')
    await enterTenant(page)
    await expect(greeting(page)).toBeVisible()
    await shot(page, `tenant-banner-${tag}`)
    await leaveTenant(page)
  })
