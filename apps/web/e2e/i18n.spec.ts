import { USERS } from './env.ts'
import { appTitle, expect, greeting, msg, submitLogin, test, type Page } from './fixtures.ts'

const EN = 'en-US'

async function switchLanguage(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: msg('common.layout.language', from) }).click()
  await page
    .getByRole('menuitem', { name: msg(`common.language.${to === EN ? 'enUS' : 'zhCN'}`) })
    .click()
  await expect(page.locator('html')).toHaveAttribute('lang', to)
}

test('en-US: sign-in page, server errors, menus, seeded names, dict labels and Element Plus', async ({
  page,
}) => {
  await page.goto('/login')
  // validation messages already shown switch language with the page
  const required = (lang: string, field: string) =>
    page.locator('.el-form-item__error', {
      hasText: msg('validation.required', lang, { field: msg(`field.auth.${field}`, lang) }),
    })
  await page.getByRole('button', { name: msg('common.action.signIn') }).click()
  await expect(required('zh-CN', 'username')).toBeVisible()
  await expect(required('zh-CN', 'password')).toBeVisible()
  await switchLanguage(page, 'zh-CN', EN)
  await expect(page.getByRole('heading', { name: msg('common.login.title', EN) })).toBeVisible()
  await expect(required(EN, 'username')).toBeVisible()
  await expect(required(EN, 'password')).toBeVisible()
  await expect(page.locator('.el-form-item__error')).toHaveCount(2)

  // the server translates by Accept-Language
  await submitLogin(page, { username: 'e2e_nobody', password: 'Wrong-Pass1' }, EN)
  await expect(
    page.getByRole('alert').filter({ hasText: 'Incorrect username or password' }),
  ).toBeVisible()

  await submitLogin(page, USERS.admin, EN)
  await expect(page).toHaveURL(/\/home$/)
  await expect(greeting(page, 'Administrator', EN)).toBeVisible()
  // seeded role and dept names are i18n keys (see docs/design-notes.md#i18n)
  await expect(page.getByText(msg('seed.role.root', EN), { exact: true })).toBeVisible()
  await expect(page.getByText(msg('seed.dept.hq', EN), { exact: true })).toBeVisible()

  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu', EN) })
  await expect(menu.getByRole('menuitem', { name: msg('menu.home', EN) })).toBeVisible()
  // Element Plus components follow the locale (pagination total)
  await menu.getByText(msg('menu.system.title', EN), { exact: true }).click()
  await menu.getByRole('menuitem', { name: msg('menu.iam.position', EN) }).click()
  await expect(page.locator('.el-pagination__total')).toHaveText(/^Total \d+$/)
  await menu.getByRole('menuitem', { name: msg('menu.settings.dict', EN) }).click()
  await expect(page).toHaveURL(/\/settings\/dicts$/)
  await expect(page).toHaveTitle(`${msg('menu.settings.dict', EN)} - ${appTitle(EN)}`)

  const code = page.getByLabel(msg('field.settings.dict.code', EN), { exact: true })
  const search = page.getByRole('button', { name: msg('crud.action.search', EN), exact: true })
  // an empty search shows the empty state in the page language
  await code.fill('no.such.dict')
  await search.click()
  await expect(page.getByText(msg('common.empty.noMatch', EN), { exact: true })).toBeVisible()
  await page.getByRole('button', { name: msg('crud.action.reset', EN), exact: true }).click()
  // dict names from name_i18n (newest first: core.enabled is found by its code)
  await code.fill('core.enabled')
  await search.click()
  await expect(page.getByRole('cell', { name: 'Enabled status', exact: true })).toBeVisible()

  // entry labels from label_i18n, DictTag keeps the tag type
  await page
    .getByRole('row', { name: /core\.enabled/ })
    .getByRole('button', { name: msg('settings.dict.entries', EN) })
    .click()
  await expect(page).toHaveURL(/\/settings\/dicts\/core\.enabled\/entries$/)
  await expect(page.getByRole('cell', { name: 'Enabled', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Disabled', exact: true })).toBeVisible()
  await expect(page.locator('.el-tag', { hasText: /^Success$/ })).toHaveClass(/el-tag--success/)

  // switching back relabels the page at once, no reload
  await switchLanguage(page, EN, 'zh-CN')
  await expect(page.getByRole('cell', { name: '启用', exact: true })).toBeVisible()
  await expect(page.locator('.el-tag', { hasText: /^成功$/ })).toBeVisible()
  await expect(page.getByText('Enabled', { exact: true })).toHaveCount(0)
})

test('the chosen language survives a reload and another dict switches with it', async ({
  page,
}) => {
  await page.goto('/login')
  await switchLanguage(page, 'zh-CN', EN)
  await submitLogin(page, USERS.admin, EN)
  await expect(page).toHaveURL(/\/home$/)
  await page.goto('/settings/dicts/iam.data_scope/entries')
  await expect(page.locator('html')).toHaveAttribute('lang', EN)
  await expect(page.getByText('Own department and below', { exact: true })).toBeVisible()
  await switchLanguage(page, EN, 'zh-CN')
  await expect(page.getByText('本部门及下级', { exact: true })).toBeVisible()
})
