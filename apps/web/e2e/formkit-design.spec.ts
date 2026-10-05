// The form builder (see docs/design-notes.md#workflow), a 系统工具 page (seeded menu). The designer and the form-create
// renderers it holds (its settings panels, the preview) follow the app language (`setLocale`): in en-US
// they are English, and switching back relabels them without a reload.
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const EN = 'en-US'

const item = (page: Page, icon: string) =>
  page.locator('._fc-l-item').filter({ has: page.locator(`i.${icon}`) })

async function switchLanguage(page: Page, from: string, to: string) {
  await page.getByRole('button', { name: msg('common.layout.language', from) }).click()
  await page
    .getByRole('menuitem', { name: msg(`common.language.${to === EN ? 'enUS' : 'zhCN'}`) })
    .click()
  await expect(page.locator('html')).toHaveAttribute('lang', to)
}

test('the form builder page: designer and preview in the app language', async ({ page }) => {
  await signIn(page, 'admin', '/home')
  const menu = page.getByRole('navigation', { name: msg('common.layout.sideMenu') })
  await menu.getByText(msg('menu.devtools.title'), { exact: true }).click()
  await menu.getByRole('menuitem', { name: msg('menu.formkit.design') }).click()
  await expect(page).toHaveURL(/\/formkit\/design$/)
  // the designer's own texts (its locale files): zh-CN first
  const tab = page.locator('._fc-l-tab').first()
  await expect(tab).toHaveText('组件')
  await expect(item(page, 'icon-input')).toHaveText('输入框')
  // the disabled items stay hidden: rich text, raw html
  await expect(item(page, 'icon-editor')).toHaveCount(0)
  await expect(item(page, 'icon-html')).toHaveCount(0)

  await switchLanguage(page, 'zh-CN', EN)
  await expect(tab).toHaveText('Component')
  await expect(item(page, 'icon-input')).toHaveText('Input')
  await expect(item(page, 'icon-editor')).toHaveCount(0)

  // an input on the canvas: its settings (a form-create renderer) in English; made required
  await item(page, 'icon-input').click()
  const settings = page.locator('._fc-r-tab-props')
  await expect(settings).toContainText('Placeholder')
  await settings.locator('._fd-required .el-switch').click()

  // the preview renders the form in English: its buttons and the required message
  await page.getByRole('button', { name: 'Preview' }).click()
  const preview = page.locator('._fd-preview-dialog')
  await preview.getByRole('button', { name: 'Submit' }).click()
  await expect(preview.locator('.el-form-item__error')).toHaveText('Input is required')
  await preview.getByRole('button', { name: 'Close this dialog' }).click()
  await expect(preview).toBeHidden()

  // back to zh-CN: relabelled at once, the canvas kept
  await switchLanguage(page, EN, 'zh-CN')
  await expect(tab).toHaveText('组件')
  await expect(item(page, 'icon-input')).toHaveText('输入框')
  await expect(page.locator('._fc-designer ._fd-drag-tool')).toHaveCount(1)
})
