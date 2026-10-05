// 表单管理 (流程管理; see docs/design-notes.md#workflow) designs a process form in the form builder (its
// FormDesigner, its hidden items and language) inside the add / edit dialog. Saving sends the form as the
// shared `sanitizeFormSchema` keeps it (the server filters again, wf-form.e2e): a function string is refused
// with its reason and nothing is sent; settings outside the whitelist are listed, then dropped. Reopened,
// the designer shows the stored form.
import type { Locator } from '@playwright/test'
import { currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'

const EN = 'en-US'
/** GET /api/wf/forms/:id: the stored form */
const DETAIL = /\/api\/wf\/forms\/\d+$/

const item = (page: Page, icon: string) =>
  page.locator('._fc-l-item').filter({ has: page.locator(`i.${icon}`) })
/** the dialog's own fields above the designer (whose form settings have a "form name" too) */
const own = (dialog: Locator) => dialog.locator('.qw-form-cols-3')
const canvas = (page: Page) => page.locator('._fc-designer ._fd-drag-tool')
/** a setting of the selected component (the designer's right panel), by its label */
const setting = (page: Page, label: string) =>
  page.locator('._fc-r').getByRole('textbox', { name: label, exact: true })

/** 新增 → the dialog; `lang` the app language */
async function create(page: Page, lang: string) {
  await page.getByRole('button', { name: msg('crud.action.create', lang), exact: true }).click()
  const name = msg('crud.title.create', lang, { name: msg('wf.form.entity', lang) })
  const dialog = page.getByRole('dialog', { name })
  await expect(dialog.locator('._fc-designer')).toBeVisible()
  return dialog
}

/** 编辑 on the row named `name`: the dialog, the stored schema it loaded */
async function edit(page: Page, name: string, lang: string) {
  const loaded = page.waitForResponse((r) => DETAIL.test(r.url()))
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: msg('crud.action.edit', lang) })
    .click()
  const body = (await (await loaded).json()) as {
    data: { schemaJson: { rule: Record<string, unknown>[] } }
  }
  const dialog = page.getByRole('dialog', {
    name: msg('crud.title.edit', lang, { name: msg('wf.form.entity', lang) }),
  })
  await expect(dialog.locator('._fc-designer')).toBeVisible()
  return { dialog, schema: body.data.schemaJson }
}

test('a process form: designed in the dialog, saved, reopened in the designer', async ({
  page,
}) => {
  await signIn(page, 'admin', '/wf/forms')
  await expect(currentPage(page, 'menu.wf.form')).toBeVisible()

  const dialog = await create(page, 'zh-CN')
  // the form builder's designer: its texts in the app language, the disabled items hidden
  await expect(dialog.locator('._fc-l-tab').first()).toHaveText('组件')
  await expect(item(page, 'icon-editor')).toHaveCount(0)
  await expect(item(page, 'icon-html')).toHaveCount(0)
  await own(dialog).getByLabel(msg('field.wf.form.name')).fill('E2E 采购申请')
  await item(page, 'icon-input').click()
  await setting(page, '字段名称').fill('采购事由')
  await item(page, 'icon-date').click()
  await expect(canvas(page)).toHaveCount(2)

  // 1280x720: the whole dialog in view; ESC on the canvas does not close it (the design kept)
  await page.setViewportSize({ width: 1280, height: 720 })
  const save = dialog.getByRole('button', { name: msg('crud.action.save'), exact: true })
  await expect(save).toBeInViewport({ ratio: 1 })
  await canvas(page).first().click()
  await page.keyboard.press('Escape')
  await expect(canvas(page)).toHaveCount(2)
  await expect(dialog).toBeVisible()

  await save.click()
  await expect(page.getByText(msg('crud.msg.created'))).toBeVisible()
  await expect(dialog).toBeHidden()

  const { dialog: again, schema } = await edit(page, 'E2E 采购申请', 'zh-CN')
  expect(schema.rule.map((r) => r.type)).toEqual(['input', 'datePicker'])
  expect(schema.rule[0]).toMatchObject({ title: '采购事由' })
  await expect(canvas(page)).toHaveCount(2)
  await expect(canvas(page).first()).toContainText('采购事由')
  // saved again as reopened: nothing to drop, straight to PUT
  await again.getByRole('button', { name: msg('crud.action.save'), exact: true }).click()
  await expect(page.getByText(msg('crud.msg.updated'))).toBeVisible()
  await expect(again).toBeHidden()
})

test('en-US: a function string is refused, settings outside the whitelist dropped', async ({
  page,
}) => {
  await signIn(page, 'admin', '/wf/forms')
  await page.getByRole('button', { name: msg('common.layout.language') }).click()
  await page.getByRole('menuitem', { name: msg('common.language.enUS') }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', EN)

  const dialog = await create(page, EN)
  // the form's own fields above the designer
  await expect(own(dialog).locator('.el-form-item__label')).toHaveText(
    ['name', 'enabled', 'note'].map((f) => msg(`field.wf.form.${f}`, EN)),
  )
  await expect(dialog.locator('._fc-l-tab').first()).toHaveText('Component')
  await own(dialog).getByLabel(msg('field.wf.form.name', EN)).fill('E2E purchase')
  await item(page, 'icon-input').click()

  // code in a title: refused with the reason, nothing sent
  let posted = 0
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/wf/forms')) posted++
  })
  await setting(page, 'Title').fill('() => alert(1)')
  const save = dialog.getByRole('button', { name: msg('crud.action.save', EN), exact: true })
  await save.click()
  const reason = msg('validation.form.code', EN, { path: 'rule.0.title' })
  await expect(page.getByText(msg('wf.form.invalid', EN, { reason }))).toBeVisible()
  await expect(dialog).toBeVisible()
  expect(posted).toBe(0)

  // a class (the designer's style settings): listed, then dropped on save
  await setting(page, 'Title').fill('Reason')
  await setting(page, 'Class').fill('x-danger')
  await save.click()
  const box = page.getByRole('dialog', { name: msg('wf.form.removedTitle', EN) })
  await expect(box.locator('.el-message-box__message')).toHaveText(
    msg('wf.form.removed', EN, { settings: 'rule.0.class' }),
  )
  await box.getByRole('button', { name: msg('crud.action.save', EN) }).click()
  // exact: the list behind reads "Add" + "Edit" (toolbar, row) as one text too
  await expect(page.getByText(msg('crud.msg.created', EN), { exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
  expect(posted).toBe(1)

  const { schema } = await edit(page, 'E2E purchase', EN)
  expect(schema.rule).toHaveLength(1)
  expect(schema.rule[0]).toMatchObject({ type: 'input', title: 'Reason' })
  expect(schema.rule[0]).not.toHaveProperty('class')
})
