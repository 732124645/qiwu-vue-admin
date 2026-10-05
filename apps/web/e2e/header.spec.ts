import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const search = (page: Page, lang?: string) =>
  page.getByRole('textbox', { name: msg('layout.search.placeholder', lang) })

test('menu search: keyboard only, localized names, navigates', async ({ page }) => {
  await signIn(page, 'admin', '/home')
  const hit = `${msg('menu.system.title')} / ${msg('menu.settings.dict')}`
  await search(page).focus()
  await page.keyboard.type('字典')
  await expect(page.getByRole('option', { name: hit })).toBeVisible()
  await expect(page.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter') // the first hit is highlighted
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  await expect(search(page)).toHaveValue('')

  // English names in English; arrow keys pick among several hits
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: 'English' }).click()
  await search(page, 'en-US').focus()
  await page.keyboard.type('E')
  const en = (key: string) => msg(key, 'en-US')
  const path = (...keys: string[]) => keys.map(en).join(' / ')
  // a stable subset in menu order (new menus may come in between), then one exact localized path
  await expect(page.getByRole('option')).toContainText([
    en('menu.home'),
    path('menu.system.title', 'menu.iam.user'),
    path('menu.system.title', 'menu.settings.dict'),
    path('menu.devtools.title', 'menu.demo.title', 'menu.demo.realtime'),
  ])
  await expect(
    page.getByRole('option', {
      name: path('menu.system.title', 'menu.settings.dict'),
      exact: true,
    }),
  ).toHaveCount(1)
  // ArrowDown from the highlighted first hit to the e2e-only page, wherever it lists
  const texts = await page.getByRole('option').allTextContents()
  const at = texts.findIndex((text) => text.trim() === 'E2E page')
  expect(at).toBeGreaterThan(0)
  for (let i = 0; i < at; i++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/e2e\/page$/)
})

test('menu search only lists menus the user was granted', async ({ page }) => {
  await signIn(page, 'limited', '/home')
  // an empty query lists every searchable page
  await search(page).focus()
  await expect(page.getByRole('option', { name: msg('menu.home') })).toBeVisible()
  await expect(page.getByRole('option', { name: msg('menu.settings.dict') })).toHaveCount(0)
})

test('full screen through the native Fullscreen API', async ({ page }) => {
  await signIn(page, 'admin', '/home')
  const fullscreen = () => page.evaluate<boolean>('document.fullscreenElement !== null')
  await page.getByRole('button', { name: msg('layout.fullscreen.enter') }).click()
  await expect.poll(fullscreen).toBe(true)
  await page.getByRole('button', { name: msg('layout.fullscreen.exit') }).click()
  await expect.poll(fullscreen).toBe(false)
  await expect(page.getByRole('button', { name: msg('layout.fullscreen.enter') })).toBeVisible()
})

test('component size applies to Element Plus components and survives a reload', async ({
  page,
}) => {
  await signIn(page, 'admin', '/settings/dicts')
  const input = page
    .locator('.el-input')
    .filter({ has: page.getByLabel(msg('field.settings.dict.name'), { exact: true }) })
  await expect(input).not.toHaveClass(/el-input--large/)
  await page.getByRole('button', { name: msg('layout.size.label') }).click()
  await page.getByRole('menuitem', { name: msg('layout.size.large') }).click()
  await expect(input).toHaveClass(/el-input--large/)
  await page.reload()
  await expect(input).toHaveClass(/el-input--large/)
  await page.getByRole('button', { name: msg('layout.size.label') }).click()
  await expect(page.getByRole('menuitem', { name: msg('layout.size.large') })).toHaveAttribute(
    'aria-disabled',
    'true',
  )
  await page.getByRole('menuitem', { name: msg('layout.size.small') }).click()
  await expect(input).toHaveClass(/el-input--small/)
})
