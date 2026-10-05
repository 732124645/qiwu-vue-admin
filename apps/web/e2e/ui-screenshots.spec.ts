// UI review screenshots: only with UI_SHOTS=1. Desktop admin only (1920 / 1440 / 1280 × 900),
// light and dark, into docs/design/screenshots/<page>-<theme>-<width>.png. Not part of the regular suite.
import { fileURLToPath } from 'node:url'
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

test.skip(process.env.UI_SHOTS !== '1', 'set UI_SHOTS=1 to take the UI review screenshots')
test.describe.configure({ timeout: 120_000 })

const OUT = fileURLToPath(new URL('../../../docs/design/screenshots/', import.meta.url))
const WIDTHS = [1920, 1440, 1280]
const THEMES = ['light', 'dark'] as const

async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(300) // route fade / dialog enter
  // a horizontal page scroll is a bug at every desktop width
  const overflow = await page.evaluate<number>(
    'document.documentElement.scrollWidth - document.documentElement.clientWidth',
  )
  if (overflow > 0) console.warn(`${name}: horizontal page overflow ${overflow}px`)
  await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true, animations: 'disabled' })
}

async function setup(page: Page, theme: string, width: number, locale = 'zh-CN') {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
  await page.addInitScript({
    content: `localStorage.setItem('qw.app.colorScheme', '${theme}')
      localStorage.setItem('qw.locale', '${locale}')`,
  })
}

async function openCreate(page: Page) {
  await page.locator('.table-toolbar__actions .el-button--primary').click()
  await expect(page.locator('.el-dialog')).toBeVisible()
}

for (const theme of THEMES)
  for (const width of WIDTHS)
    test(`screens ${theme} ${width}`, async ({ page }) => {
      const tag = `${theme}-${width}`
      await setup(page, theme, width)

      await page.goto('/login')
      await expect(page.getByRole('heading', { name: msg('common.login.title') })).toBeVisible()
      await shot(page, `login-${tag}`)

      await signIn(page, 'admin', '/home')
      await expect(page.locator('h1')).toBeVisible()
      await shot(page, `home-${tag}`)

      await page.goto('/iam/positions')
      await expect(page.getByRole('row').nth(1)).toBeVisible()
      await shot(page, `positions-${tag}`)

      if (width === 1440) {
        // keyboard focus on a toolbar icon button
        await page.getByRole('button', { name: msg('crud.action.refresh') }).focus()
        await page.keyboard.press('Tab')
        await shot(page, `positions-focus-${tag}`)
      }

      await openCreate(page)
      await shot(page, `position-dialog-${tag}`)
      await page.keyboard.press('Escape')
      await expect(page.locator('.el-dialog')).toBeHidden()

      await page.getByRole('textbox', { name: msg('field.iam.position.code') }).fill('no-such-code')
      await page.getByRole('button', { name: msg('crud.action.search'), exact: true }).click()
      await expect(page.locator('.empty-state')).toBeVisible()
      await shot(page, `position-empty-${tag}`)

      await page.goto('/settings/dicts')
      await expect(page.getByRole('row').nth(1)).toBeVisible()
      await shot(page, `dict-${tag}`)
    })

// English strings are longer: the tightest width, light
test('screens en-US light 1280', async ({ page }) => {
  await setup(page, 'light', 1280, 'en-US')
  await page.goto('/login')
  await expect(page.locator('form')).toBeVisible()
  await shot(page, 'login-en-light-1280')
  await signIn(page, 'admin', '/home')
  await expect(page.locator('h1')).toBeVisible()
  await shot(page, 'home-en-light-1280')
  await page.goto('/iam/positions')
  await expect(page.getByRole('row').nth(1)).toBeVisible()
  await shot(page, 'positions-en-light-1280')
  await openCreate(page)
  await shot(page, 'position-dialog-en-light-1280')
})
