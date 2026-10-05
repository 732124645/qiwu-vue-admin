import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const HOME = msg('menu.home')
const DICT = msg('menu.settings.dict')
/** extra page from the e2e global setup (plain-text menu name) */
const EXTRA = 'E2E page'

const bar = (page: Page) => page.getByRole('navigation', { name: msg('common.tags.label') })
const tag = (page: Page, name: string) => bar(page).getByRole('link', { name, exact: true })
const keyword = (page: Page) => page.getByLabel(msg('field.settings.dict.name'), { exact: true })

/** Right-click a tag and pick an entry of its context menu. */
async function tagMenu(page: Page, name: string, item: string) {
  await tag(page, name).click({ button: 'right' })
  const entry = page.getByRole('menuitem', { name: msg(item), exact: true })
  await entry.click()
  await expect(entry).toBeHidden() // menus fade out; the next right-click must not see this one
}

/** Tab style and persistence live in the page settings drawer. */
async function openSettings(page: Page) {
  await page.getByRole('button', { name: msg('layout.settings.title') }).click()
  await expect(page.getByRole('dialog', { name: msg('layout.settings.title') })).toBeVisible()
}

async function openDict(page: Page) {
  await page.getByRole('main').getByRole('link', { name: DICT }).click() // home quick entry
  await expect(page).toHaveURL(/\/settings\/dicts$/)
}

test.beforeEach(async ({ page }) => {
  await signIn(page, 'admin', '/home')
})

test('each opened page gets a tag; the home tag has no close button', async ({ page }) => {
  await expect(bar(page).getByRole('link')).toHaveText([HOME])
  await openDict(page)
  await expect(bar(page).getByRole('link')).toHaveText([HOME, DICT])
  await expect(tag(page, DICT)).toHaveAttribute('aria-current', 'page')
  await expect(
    bar(page).getByRole('button', { name: msg('common.tags.close'), exact: true }),
  ).toHaveCount(1)

  await tag(page, HOME).click()
  await expect(page).toHaveURL(/\/home$/)
  await tag(page, HOME).click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: msg('common.tags.close'), exact: true }),
  ).toHaveAttribute('aria-disabled', 'true')
})

test('switching tags keeps unsaved input (keep-alive); refresh remounts the page', async ({
  page,
}) => {
  await openDict(page)
  await keyword(page).fill('unsaved')
  await tag(page, HOME).click()
  await tag(page, DICT).click()
  await expect(keyword(page)).toHaveValue('unsaved')

  await tagMenu(page, DICT, 'common.tags.refresh')
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  await expect(keyword(page)).toHaveValue('')

  // cached again after the refresh
  await keyword(page).fill('again')
  await tag(page, HOME).click()
  await tag(page, DICT).click()
  await expect(keyword(page)).toHaveValue('again')
})

test('close, close others / left / right / all never close home', async ({ page }) => {
  const openExtra = async () => {
    await page
      .getByRole('navigation', { name: msg('common.layout.sideMenu') })
      .getByRole('menuitem', { name: EXTRA })
      .click()
    await expect(page).toHaveURL(/\/e2e\/page$/)
  }
  const tabs = bar(page).getByRole('link')

  await openDict(page)
  await openExtra()
  await expect(tabs).toHaveText([HOME, DICT, EXTRA])
  await tagMenu(page, DICT, 'common.tags.closeOthers')
  await expect(tabs).toHaveText([HOME, DICT])
  await expect(page).toHaveURL(/\/settings\/dicts$/)

  await openExtra()
  await tagMenu(page, EXTRA, 'common.tags.closeLeft')
  await expect(tabs).toHaveText([HOME, EXTRA])
  await tagMenu(page, HOME, 'common.tags.closeRight')
  await expect(tabs).toHaveText([HOME])
  await expect(page).toHaveURL(/\/home$/)

  await openDict(page)
  await openExtra()
  await tagMenu(page, DICT, 'common.tags.closeAll')
  await expect(tabs).toHaveText([HOME])
  await expect(page).toHaveURL(/\/home$/)

  await openDict(page)
  await bar(page)
    .getByRole('button', { name: msg('common.tags.close'), exact: true })
    .click()
  await expect(tabs).toHaveText([HOME])
  await expect(page).toHaveURL(/\/home$/)

  // a closed page loses its cached state
  await openDict(page)
  await keyword(page).fill('gone')
  await tagMenu(page, HOME, 'common.tags.closeOthers')
  await openDict(page)
  await expect(keyword(page)).toHaveValue('')
})

test('open tags survive a browser reload unless persistence is switched off', async ({ page }) => {
  await openDict(page)
  await tag(page, HOME).click()
  await page.reload()
  await expect(bar(page).getByRole('link')).toHaveText([HOME, DICT])
  await expect(tag(page, HOME)).toHaveAttribute('aria-current', 'page')

  await openSettings(page)
  await page.getByText(msg('common.tags.persist'), { exact: true }).click()
  await expect(page.getByRole('switch', { name: msg('common.tags.persist') })).not.toBeChecked()
  await page.reload()
  await expect(bar(page).getByRole('link')).toHaveText([HOME])
})

test('card and chrome styles', async ({ page }) => {
  const view = page.locator('.tags-view')
  await expect(view).toHaveClass(/tags-view--card/)
  await openSettings(page)
  await page.getByRole('radio', { name: msg('common.tags.styleChrome') }).check({ force: true })
  await expect(view).toHaveClass(/tags-view--chrome/)
  await page.reload()
  await expect(view).toHaveClass(/tags-view--chrome/)
})
