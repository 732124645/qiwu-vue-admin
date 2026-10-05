// Our form-create components (see docs/design-notes.md#workflow) (`qw-user-select`, `qw-dept-select`,
// `qw-dict-select`, `qw-upload`, `qw-area-select`) in the form builder: their own group in the component
// list (in the app language), the existing pickers on the canvas and in the preview, a rule the designer
// exports that sanitizeFormSchema accepts, and attachments stored as private `wf.attachment` objects.
import { sanitizeFormSchema } from '@qiwu/shared'
import { expect, msg, signIn, test, type Page } from './fixtures.ts'

const WIDGETS = [
  'qw-user-select',
  'qw-dept-select',
  'qw-dict-select',
  'qw-upload',
  'qw-area-select',
] as const
const EN = 'en-US'

const group = (page: Page, lang = 'zh-CN') =>
  page
    .locator('._fc-l-group')
    .filter({ has: page.locator('._fc-l-title', { hasText: msg('formkit.widget.menu', lang) }) })

/** The rule in the preview's generated SFC: `formCreate.parseJson('<json>')`, quotes escaped. */
async function exportedRule(page: Page) {
  const preview = page.locator('._fd-preview-dialog')
  await preview.getByRole('tab', { name: '生成组件' }).click()
  const code = await preview.locator('._fd-preview-code').innerText()
  const json = /const rule = ref\(formCreate\.parseJson\('(.*)'\)\);/.exec(code)?.[1] ?? ''
  await preview.getByRole('tab', { name: '表单模式' }).click()
  return JSON.parse(json.replace(/\\(.)/g, '$1')) as unknown[]
}

test('the qw-* components: designer, exported rule, preview', async ({ page }) => {
  await signIn(page, 'admin', '/formkit/design')
  const items = group(page).locator('._fc-l-item')
  await expect(items).toHaveText(WIDGETS.map((w) => msg(`formkit.widget.${w}`)))

  // each onto the canvas: the real pickers render there (the upload button, the user search button)
  for (const w of WIDGETS) await items.filter({ hasText: msg(`formkit.widget.${w}`) }).click()
  const canvas = page.locator('._fc-designer ._fd-drag-tool')
  await expect(canvas).toHaveCount(WIDGETS.length)
  await expect(
    canvas.nth(3).locator('.el-button', { hasText: msg('upload.action.upload') }),
  ).toBeVisible()
  await expect(canvas.nth(0).getByRole('button', { name: msg('picker.user.title') })).toBeVisible()

  // the dict component's settings: its dict from the enabled dicts; upload: our labels
  const settings = page.locator('._fc-r-tab-props')
  await canvas.nth(2).click()
  await settings
    .locator('.el-form-item', { hasText: msg('formkit.widget.prop.code') })
    .locator('.el-select')
    .click()
  await page.getByRole('option', { name: '性别 (iam.gender)' }).click()
  await canvas.nth(3).click()
  await expect(settings).toContainText(msg('formkit.widget.prop.maxSize'))
  await expect(settings).toContainText(msg('formkit.widget.prop.limit'))

  // the rule the designer exports passes the schema whitelist (the server's save check)
  await page.getByRole('button', { name: '预览' }).click()
  const preview = page.locator('._fd-preview-dialog')
  const rule = await exportedRule(page)
  const result = sanitizeFormSchema({ rule })
  expect(result.ok, JSON.stringify(result.ok ? '' : result.errors)).toBe(true)
  if (!result.ok) return
  expect(result.schema.rule.map((r) => r.type)).toEqual(WIDGETS)
  expect(result.schema.rule[2]?.props).toMatchObject({ code: 'iam.gender' })

  // the preview: every enabled user (wf source) …
  await preview.getByRole('button', { name: msg('picker.user.title'), exact: true }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill('OA Supervisor')
  await picker.getByRole('row').filter({ hasText: 'OA Supervisor' }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
  await expect(picker).toBeHidden()
  await expect(preview.getByRole('textbox').first()).toHaveValue('OA Supervisor')
  // … the dept tree, the dict entries …
  // (el-tree-select is an el-select too: the dept one comes first)
  await preview.locator('.el-select').nth(0).click()
  await page.locator('.el-tree-node__content:visible', { hasText: '研发中心' }).click()
  await expect(preview.locator('.el-select').nth(0)).toContainText('研发中心')
  await preview.locator('.el-select').nth(1).click()
  await expect(page.getByRole('option', { name: '男', exact: true })).toBeVisible()
  await page.getByRole('option', { name: '男', exact: true }).click()
  // … a private workflow attachment …
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith('/api/storage/objects') && r.request().method() === 'POST',
  )
  await preview.locator('input[type=file]').setInputFiles({
    name: 'note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('formkit widget attachment'),
  })
  const stored = (await (await uploaded).json()) as { data: Record<string, unknown> }
  expect(stored.data).toMatchObject({ bizTag: 'wf.attachment', isPublic: false, url: null })
  await expect(preview.locator('.file-upload__item')).toHaveText(/note\.txt/)
  // … and the area cascader
  await preview.locator('.el-cascader').click()
  for (const name of ['北京市', '北京市', '东城区'])
    await page.locator('.el-cascader-node:visible', { hasText: name }).last().click()
  await expect(preview.locator('.el-cascader input')).toHaveValue(/东城区/)
  await preview.getByRole('button', { name: '关闭此对话框' }).click()
  await expect(preview).toBeHidden()

  // in en-US the group and the names follow
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(group(page, EN).locator('._fc-l-item')).toHaveText(
    WIDGETS.map((w) => msg(`formkit.widget.${w}`, EN)),
  )
})
