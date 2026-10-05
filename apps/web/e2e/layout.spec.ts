import { appTitle, expect, msg, signIn, test, type Page } from './fixtures.ts'

const sideMenu = (page: Page) =>
  page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
const topMenu = (page: Page) => page.getByRole('navigation', { name: msg('layout.topMenu') })
const drawer = (page: Page) => page.getByRole('dialog', { name: msg('layout.settings.title') })
/** switches are toggled through their visible text (the input itself is visually hidden) */
const toggle = (page: Page, key: string) =>
  drawer(page)
    .getByText(msg(`layout.settings.${key}`), { exact: true })
    .click()
const setting = (page: Page, key: string) =>
  drawer(page).getByRole('switch', { name: msg(`layout.settings.${key}`) })

async function openSettings(page: Page) {
  await page.getByRole('button', { name: msg('layout.settings.title') }).click()
  await expect(drawer(page)).toBeVisible()
}
async function closeSettings(page: Page) {
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toBeHidden()
}
async function pickLayout(page: Page, layout: 'side' | 'top' | 'mix') {
  await openSettings(page)
  await drawer(page)
    .getByRole('radio', { name: msg(`layout.settings.layouts.${layout}`) })
    .check({ force: true })
  await closeSettings(page)
}

test.beforeEach(async ({ page }) => {
  await signIn(page, 'admin', '/home')
})

test('side, top and mix layouts; the choice survives a reload', async ({ page }) => {
  const HOME = msg('menu.home')
  // the first group: later top-level entries may fold into the horizontal menu's overflow
  const GROUP = msg('menu.system.title')
  const PAGE = msg('menu.iam.position')
  // side (default): vertical menu with the logo, breadcrumb in the header
  await expect(sideMenu(page)).toBeVisible()
  await expect(topMenu(page)).toHaveCount(0)
  await expect(page.getByLabel(msg('common.layout.breadcrumb'))).toBeVisible()

  // top: the whole tree in a horizontal menu, no aside and no collapse toggle
  await pickLayout(page, 'top')
  await expect(sideMenu(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: msg('common.layout.collapse') })).toHaveCount(0)
  await topMenu(page).getByText(GROUP).hover()
  await page.getByRole('menuitem', { name: PAGE }).click()
  await expect(page).toHaveURL(/\/iam\/positions$/)
  await page.reload()
  await expect(topMenu(page).getByRole('menuitem', { name: HOME })).toBeVisible()
  await expect(sideMenu(page)).toHaveCount(0)

  // mix: top-level entries on top; a group opens its first page, its children fill the aside
  await pickLayout(page, 'mix')
  await expect(sideMenu(page).getByRole('menuitem', { name: PAGE })).toBeVisible()
  await topMenu(page).getByRole('menuitem', { name: HOME }).click()
  await expect(page).toHaveURL(/\/home$/)
  await expect(sideMenu(page)).toHaveCount(0) // a top-level page has nothing to list
  await topMenu(page).getByRole('menuitem', { name: GROUP }).click()
  await expect(page).toHaveURL(/\/iam\/users$/) // its first page
  await expect(sideMenu(page).getByRole('menuitem', { name: PAGE })).toBeVisible()
  await expect(sideMenu(page).getByText(HOME)).toHaveCount(0)

  await pickLayout(page, 'side')
  await expect(topMenu(page)).toHaveCount(0)
  await expect(sideMenu(page).getByRole('menuitem', { name: HOME })).toBeVisible()
})

test('dark mode survives a reload', async ({ page }) => {
  const html = page.locator('html')
  await expect(html).not.toHaveClass(/\bdark\b/)
  await openSettings(page)
  await toggle(page, 'dark')
  await expect(setting(page, 'dark')).toBeChecked()
  await expect(html).toHaveClass(/\bdark\b/)
  await page.reload()
  await expect(html).toHaveClass(/\bdark\b/)
  // the light canvas is rgb(242, 244, 247)
  await expect(page.locator('body')).not.toHaveCSS('background-color', 'rgb(242, 244, 247)')
})

test('the side menu collapse state survives a reload', async ({ page }) => {
  await page.getByRole('button', { name: msg('common.layout.collapse') }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: msg('common.layout.expand') })).toBeVisible()
  await expect(page.locator('.el-menu--collapse')).toBeVisible()
})

test('theme color, grey mode, logo, footer, fixed header and dynamic title', async ({ page }) => {
  const title = appTitle()
  await expect(page).toHaveTitle(`${msg('menu.home')} - ${title}`)
  await openSettings(page)
  await drawer(page)
    .getByRole('button', { name: msg('layout.settings.primary') })
    .click()
  await page.getByRole('button', { name: /#0f766e/i }).click()
  await page.getByRole('button', { name: /OK|确定/ }).click()
  for (const key of ['grey', 'showLogo', 'showFooter', 'fixedHeader', 'dynamicTitle'])
    await toggle(page, key)
  await closeSettings(page)

  const check = async () => {
    const primary = await page.evaluate<string>(
      `getComputedStyle(document.documentElement).getPropertyValue('--el-color-primary')`,
    )
    expect(primary.trim().toLowerCase()).toBe('#0f766e')
    await expect(page.locator('html')).toHaveClass(/\bqw-grey\b/)
    await expect(page.getByRole('link', { name: title })).toHaveCount(0)
    await expect(
      page.getByText(msg('layout.footer', 'zh-CN', { year: new Date().getFullYear() })),
    ).toBeVisible()
    await expect(page.locator('.app-layout')).not.toHaveClass(/app-layout--fixed/)
    await expect(page).toHaveTitle(title)
  }
  await check()
  await page.reload()
  await check()
})

test('375px: the menu is a drawer and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const noSideways = async () =>
    expect(
      await page.evaluate<number>(
        'document.documentElement.scrollWidth - document.documentElement.clientWidth',
      ),
    ).toBeLessThanOrEqual(0)

  await expect(sideMenu(page)).toBeHidden()
  await noSideways()
  // the other layouts fall back to the drawer too
  await pickLayout(page, 'mix')
  await expect(topMenu(page)).toHaveCount(0)
  await page.getByRole('button', { name: msg('common.layout.expand') }).click()
  const menu = sideMenu(page)
  await expect(menu).toBeVisible()
  await menu.getByText(msg('menu.system.title')).click()
  await menu.getByRole('menuitem', { name: msg('menu.settings.dict') }).click()
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  await expect(menu).toBeHidden() // navigating closes the drawer
  await noSideways()
})
