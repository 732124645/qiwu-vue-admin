import { SPA_CSP } from '../csp.ts'
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const sideMenu = (page: Page, lang?: string) =>
  page.getByRole('navigation', { name: msg('common.layout.sideMenu', lang) })

test('a user without settings.dict.browse sees neither the menu nor the page (404)', async ({
  page,
}) => {
  await signIn(page, 'limited')
  await expect(page).toHaveURL(/\/home$/)
  const menu = sideMenu(page)
  await expect(menu.getByRole('menuitem', { name: msg('menu.home') })).toBeVisible()
  await expect(menu.getByText(msg('menu.system.title'))).toHaveCount(0)
  await expect(menu.getByText(msg('menu.settings.dict'))).toHaveCount(0)

  // ungranted pages are not registered: 404, never 403 (no existence leak)
  const res = await page.goto('/settings/dicts')
  expect(res?.headers()['content-security-policy']).toBe(SPA_CSP)
  await expect(page.getByText('404', { exact: true })).toBeVisible()
  await expect(page.getByText(msg('common.error.notFound'))).toBeVisible()
  await expect(page).toHaveURL(/\/settings\/dicts$/)
})

test('admin opens the dictionaries from the side menu, breadcrumb follows', async ({ page }) => {
  await signIn(page, 'admin')
  const menu = sideMenu(page)
  await menu.getByText(msg('menu.system.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.settings.dict') }).click()
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  const crumbs = page.getByLabel(msg('common.layout.breadcrumb'))
  await expect(crumbs).toContainText(msg('menu.system.title'))
  await expect(crumbs).toContainText(msg('menu.settings.dict'))
  // newest dicts first: any seeded dict code (core.enabled left page 1 with the messaging dicts)
  await expect(page.getByRole('cell', { name: /^[a-z]+\.[a-z_]+$/ }).first()).toBeVisible()
})

test('home quick entries are the granted pages; none shows an empty state', async ({ page }) => {
  const entries = page.getByRole('region', { name: msg('common.home.entries') }).getByRole('list')
  await signIn(page, 'admin')
  await expect(entries.getByRole('link', { name: msg('menu.iam.position') })).toBeVisible()
  await entries.getByRole('link', { name: msg('menu.settings.dict') }).click()
  await expect(page).toHaveURL(/\/settings\/dicts$/)

  await page.getByRole('button', { name: msg('common.layout.userMenu') }).click()
  await page.getByRole('menuitem', { name: msg('common.action.signOut') }).click()
  await expect(page).toHaveURL(/\/login/)

  await signIn(page, 'limited')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByText(msg('common.home.noPages'), { exact: true })).toBeVisible()
  await expect(entries).toHaveCount(0)
})

test('header: language switch relabels the layout; user menu links to the password change', async ({
  page,
}) => {
  await signIn(page, 'admin')
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: 'English' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  const home = msg('menu.home', 'en-US')
  await expect(sideMenu(page, 'en-US').getByRole('menuitem', { name: home })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: msg('common.tags.label', 'en-US') }),
  ).toContainText(home)
  await expect(page.getByLabel(msg('common.layout.breadcrumb', 'en-US'))).toContainText(home)

  await page.getByRole('button', { name: msg('common.layout.userMenu', 'en-US') }).click()
  await page.getByRole('menuitem', { name: msg('common.layout.changePassword', 'en-US') }).click()
  await expect(page).toHaveURL(/\/password-change\?redirect=\/home$/)
})
