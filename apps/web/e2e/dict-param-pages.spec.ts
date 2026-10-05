import { currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'

// Acceptance: dict labels per language, a dict change shows after a reload.

const EN = 'en-US'
const CODE = 'e2e.settings.fruit'
const button = (page: Page, key: string, lang?: string) =>
  page.getByRole('button', { name: msg(key, lang), exact: true })
const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text })
const dialog = (page: Page, title: string, entity: string) =>
  page.getByRole('dialog', { name: msg(title, 'zh-CN', { name: msg(entity) }) })

async function switchLanguage(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: msg('common.layout.language', from) }).click()
  await page
    .getByRole('menuitem', { name: msg(`common.language.${to === EN ? 'enUS' : 'zhCN'}`) })
    .click()
  await expect(page.locator('html')).toHaveAttribute('lang', to)
}

test('dicts: names and labels per language, en-US shows the English label, a change shows after a reload', async ({
  page,
}) => {
  await signIn(page, 'admin', '/settings/dicts')

  // a dict with a name per language
  await button(page, 'crud.action.create').click()
  const addDict = dialog(page, 'crud.title.create', 'settings.dict.entity')
  await addDict.getByRole('textbox', { name: msg('field.settings.dict.code') }).fill(CODE)
  await addDict.getByRole('textbox', { name: msg('field.settings.dict.name') }).fill('水果')
  const names = msg('field.settings.dict.nameI18n')
  await addDict.getByLabel(`${names} (${msg('common.language.enUS')})`).fill('Fruit')
  await addDict.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(addDict).toBeHidden()

  // its entries: the hidden sub-page of the row
  await page.getByRole('textbox', { name: msg('field.settings.dict.code') }).fill(CODE)
  await button(page, 'crud.action.search').click()
  await row(page, CODE)
    .getByRole('button', { name: msg('settings.dict.entries') })
    .click()
  await expect(page).toHaveURL(/\/settings\/dicts\/e2e\.settings\.fruit\/entries$/)
  await expect(currentPage(page, 'menu.settings.dictEntry')).toBeVisible()
  // the entries page's own code tag: the list (whose rows show the code too) has faded out
  await expect(page.locator('.qw-page-bar__context').getByText(CODE, { exact: true })).toBeVisible()

  await button(page, 'crud.action.create').click()
  const addEntry = dialog(page, 'crud.title.create', 'settings.dictEntry.entity')
  await addEntry.getByRole('textbox', { name: msg('field.settings.dictEntry.value') }).fill('apple')
  await addEntry.getByRole('textbox', { name: msg('field.settings.dictEntry.label') }).fill('苹果')
  const labels = msg('field.settings.dictEntry.labelI18n')
  await addEntry.getByLabel(`${labels} (${msg('common.language.enUS')})`).fill('Apple')
  await addEntry.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(addEntry).toBeHidden()
  await expect(page.getByRole('cell', { name: '苹果', exact: true })).toBeVisible()

  // English labels in en-US, at once
  await switchLanguage(page, 'zh-CN', EN)
  await expect(page.getByRole('cell', { name: 'Apple', exact: true })).toBeVisible()

  // a change is what the next load shows (the server cache moved with it)
  await row(page, 'apple')
    .getByRole('button', { name: msg('crud.action.edit', EN) })
    .click()
  const edit = page.getByRole('dialog', {
    name: msg('crud.title.edit', EN, { name: msg('settings.dictEntry.entity', EN) }),
  })
  const english = edit.getByLabel(
    `${msg('field.settings.dictEntry.labelI18n', EN)} (${msg('common.language.enUS', EN)})`,
  )
  await expect(english).toHaveValue('Apple')
  await english.fill('Green apple')
  await edit.getByRole('button', { name: msg('crud.action.save', EN) }).click()
  await expect(edit).toBeHidden()
  await page.reload()
  await expect(page.getByRole('cell', { name: 'Green apple', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Apple', exact: true })).toHaveCount(0)

  // back on the list the dict shows its English name; a dict with entries is kept (409)
  await page.goto('/settings/dicts')
  await page.getByRole('textbox', { name: msg('field.settings.dict.code', EN) }).fill(CODE)
  await button(page, 'crud.action.search', EN).click()
  await expect(row(page, CODE)).toContainText('Fruit')
  await row(page, CODE)
    .getByRole('button', { name: msg('crud.action.delete', EN) })
    .click()
  await page
    .getByRole('dialog', { name: msg('crud.confirm.title', EN) })
    .getByRole('button', { name: msg('crud.action.delete', EN), exact: true })
    .click()
  await expect(page.getByText('This record is in use and cannot be deleted')).toBeVisible()
  await expect(row(page, CODE)).toHaveCount(1)
})

test('params: builtin rows cannot be deleted, secret values show masked and stay when saved unchanged', async ({
  page,
}) => {
  const KEY = 'e2e.settings.api_secret'
  await signIn(page, 'admin', '/settings/params')
  const search = async (key: string) => {
    await page.getByRole('textbox', { name: msg('field.settings.param.paramKey') }).fill(key)
    await button(page, 'crud.action.search').click()
  }
  await search('core.default_timezone')
  await expect(
    row(page, 'core.default_timezone').getByRole('button', { name: msg('crud.action.delete') }),
  ).toBeDisabled()

  // a new secret param: masked in the list at once
  await button(page, 'crud.action.create').click()
  const add = dialog(page, 'crud.title.create', 'settings.param.entity')
  await add.getByRole('textbox', { name: msg('field.settings.param.paramKey') }).fill(KEY)
  await add
    .getByRole('textbox', { name: msg('field.settings.param.paramValue') })
    .fill('top-secret')
  await add.getByRole('textbox', { name: msg('field.settings.param.name') }).fill('E2E secret')
  const secret = page.getByRole('switch', { name: msg('field.settings.param.isSecret') })
  await add.locator('.el-switch').filter({ has: secret }).click()
  await expect(
    add.getByRole('switch', { name: msg('field.settings.param.isSecret') }),
  ).toBeChecked()
  await expect(
    add.getByRole('switch', { name: msg('field.settings.param.isPublic') }),
  ).toBeDisabled()
  await add.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(add).toBeHidden()
  await search(KEY)
  await expect(row(page, KEY)).toContainText('******')
  await expect(page.getByText('top-secret')).toHaveCount(0)

  // editing loads the mask with a hint; saved unchanged, it stays masked (the value: settings-param.e2e)
  await row(page, KEY)
    .getByRole('button', { name: msg('crud.action.edit') })
    .click()
  const edit = dialog(page, 'crud.title.edit', 'settings.param.entity')
  await expect(
    edit.getByRole('textbox', { name: msg('field.settings.param.paramValue') }),
  ).toHaveValue('******')
  await expect(edit.getByText(msg('settings.param.secretHint'))).toBeVisible()
  await expect(
    edit.getByRole('textbox', { name: msg('field.settings.param.paramKey') }),
  ).toBeDisabled()
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  await expect(edit).toBeHidden()
  await expect(row(page, KEY)).toContainText('******')
})
