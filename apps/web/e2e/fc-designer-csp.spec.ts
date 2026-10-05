// The form-create designer (see docs/adr/004-form-create.md) (views/platform/formkit/FormDesigner.vue) in the built
// app under the SPA CSP. The `page` fixture fails the test on any `securitypolicyviolation`, CSP console
// error or uncaught page error. The form builder page (seeded under 系统工具) mounts it.
import { expect, msg, signIn, test } from './fixtures.ts'

test('the form designer mounts under the SPA CSP, its code editors hidden', async ({ page }) => {
  await signIn(page, 'admin', '/formkit/design')
  const item = (icon: string) =>
    page.locator('._fc-l-item').filter({ has: page.locator(`i.${icon}`) })
  await expect(item('icon-input')).toBeVisible()
  await expect(page.locator('._fc-l-item').nth(10)).toBeVisible()
  // its icon font stays on its own icons: the header's IconButtons (`.icon-button`) get no glyph
  expect(
    await page.evaluate(
      `getComputedStyle(document.querySelector('.icon-button'), '::before').content`,
    ),
  ).toBe('none')

  // hidden: the rich-text item (wangeditor stub), the AI and JSON modules (only the component list and
  // the language module stay in the left bar)
  await expect(item('icon-editor')).toHaveCount(0)
  await expect(page.locator('._fc-l-menu-item')).toHaveCount(2)
  await expect(
    page.locator('._fc-l-menu-item i.icon-ai, ._fc-l-menu-item i.icon-script'),
  ).toHaveCount(0)

  // an input and a select: each is added to the canvas and its settings open on the right
  const settings = page.locator('._fc-r-tab-props')
  await item('icon-input').click()
  await expect(page.locator('._fd-required')).toBeVisible()
  await item('icon-select').click()
  await expect(settings.locator('._td-table-opt')).toBeVisible()
  await expect(page.locator('._fc-designer ._fd-drag-tool')).toHaveCount(2)

  // no editor that evaluates code: events, function props, JSON options / props, remote fetch,
  // custom validators, form events
  const editors = '._fd-event, ._fd-fn-input, ._fd-fn-list, ._fd-struct, ._fd-gfc, ._fd-validate'
  await expect(page.locator(editors)).toHaveCount(0)
  await page.locator('._fc-r-tab').nth(1).click()
  await expect(page.locator('._fc-r-tab-form')).toBeVisible()
  await expect(page.locator(editors)).toHaveCount(0)
  // nor a form name (the whitelist drops it: a form is named where it is saved)
  await expect(page.locator('._fc-r-tab-form')).toContainText('标签的位置')
  await expect(page.locator('._fc-r-tab-form')).not.toContainText('表单名称')
})

test('it offers only what saving keeps: all of it on the canvas exports, no CSP violation', async ({
  page,
}) => {
  await signIn(page, 'admin', '/formkit/design')
  const items = page.locator('._fc-l-item')
  await expect(items.first()).toBeVisible()
  // refused by the whitelist, so not offered: the built-in upload with its `$FNX` onSuccess (ours is
  // qw-upload), colour, layouts, sub-forms, text, rich text, raw html
  const icons = ['upload', 'color', 'row', 'tab', 'subform', 'span', 'editor', 'html']
  for (const icon of icons)
    await expect(items.filter({ has: page.locator(`i.icon-${icon}`) })).toHaveCount(0)

  // every other one onto the canvas, but the day count (saved once its date fields are named)
  const offered = items.filter({ hasNot: page.locator('i.icon-date-range') })
  const n = await offered.count()
  expect(n).toBeGreaterThan(15)
  for (let i = 0; i < n; i++) await offered.nth(i).click()
  await expect(page.locator('._fc-designer ._fd-drag-tool')).toHaveCount(n)
  await page.getByRole('button', { name: msg('formkit.export.action') }).click()
  await expect(page.getByRole('dialog', { name: msg('formkit.export.title') })).toBeVisible()
})
