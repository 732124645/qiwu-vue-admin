// Acceptance: a form built in the form builder (an input, a
// qw-user-select and a qw-upload) → its Vue SFC export is not empty → saved as a process form (the wf/form
// designer page: saved through the API, as exported) → bound to a dynamic model on 模型管理 → its
// review step designed as "the user the form field names" (formFieldUser) with the input hidden → the
// employee starts it on 发起申请 (the form rendered by form-create, a private wf.attachment upload) → the
// picked user has the to-do, and on its detail neither the hidden field's label nor its value shows, while
// the attachment downloads.
import { readFile } from 'node:fs/promises'
import { bearer, currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'

const MODEL = { modelKey: 'e2e-formkit-flow', name: 'E2E formkit flow' }
const FORM = 'E2E formkit flow form'
const SECRET = 'e2e hidden note'
const FILE = 'flow-note.txt'
/** the seeded OA supervisor's display name (the wf user picker searches display names) */
const SUPERVISOR = 'OA Supervisor'

type Rule = { type: string; field: string; title: string }

/** the designer's input item; ours in our group */
const input = (page: Page) =>
  page.locator('._fc-l-item').filter({ has: page.locator('i.icon-input') })
const ours = (page: Page, widget: string) =>
  page
    .locator('._fc-l-group')
    .filter({ has: page.locator('._fc-l-title', { hasText: msg('formkit.widget.menu') }) })
    .locator('._fc-l-item')
    .filter({ hasText: msg(`formkit.widget.${widget}`) })

test('form → SFC export → bound model → start → the picked user approves without the hidden field', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const root = { Authorization: await bearer(request) }

  // the form builder: an input, a user picker and an attachment field
  await signIn(page, 'admin', '/formkit/design')
  await input(page).click()
  await ours(page, 'qw-user-select').click()
  await ours(page, 'qw-upload').click()
  await expect(page.locator('._fc-designer ._fd-drag-tool')).toHaveCount(3)

  // export: form.json (the sanitized schema) and form.vue, downloaded, not empty
  await page.getByRole('button', { name: msg('formkit.export.action') }).click()
  const exported = page.getByRole('dialog', { name: msg('formkit.export.title') })
  const code = exported.locator('.code-viewer__code')
  await expect(code).toContainText('"rule"')
  const schema = JSON.parse(await code.innerText()) as { rule: Rule[] }
  expect(schema.rule.map((r) => r.type)).toEqual(['input', 'qw-user-select', 'qw-upload'])
  await exported.getByRole('treeitem', { name: 'form.vue' }).click()
  await expect(code).toContainText('<form-create')
  const saving = page.waitForEvent('download')
  await exported.getByRole('button', { name: msg('formkit.export.download') }).click()
  const sfc = await saving
  expect(sfc.suggestedFilename()).toBe('form.vue')
  const text = await readFile(await sfc.path(), 'utf8')
  expect(text).toContain('<form-create')
  expect(text).toContain('qw-user-select')
  await exported.getByRole('button', { name: msg('formkit.export.close'), exact: true }).click()
  const [secret, lead, files] = schema.rule

  // saved as a process form; a dynamic model without a form yet
  const form = await request.post('/api/wf/forms', {
    headers: root,
    data: { name: FORM, schemaJson: schema },
  })
  expect(form.status(), await form.text()).toBe(201)
  const created = await request.post('/api/wf/models', {
    headers: root,
    data: { ...MODEL, formKind: 'dynamic', category: 'finance' },
  })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = ((await created.json()) as { data: { id: number } }).data

  // 模型管理: bind the form
  await page.goto('/wf/models')
  const row = page.locator('.qw-table-panel .el-table__body tr').filter({ hasText: MODEL.name })
  await row.getByRole('button', { name: msg('crud.action.edit') }).click()
  const edit = page.getByRole('dialog', {
    name: msg('crud.title.edit', 'zh-CN', { name: msg('wf.model.entity') }),
  })
  // loaded (a click under the loading mask goes nowhere)
  await expect(edit.getByRole('textbox', { name: msg('field.wf.model.modelKey') })).toHaveValue(
    MODEL.modelKey,
  )
  await edit
    .locator('.el-form-item', { hasText: msg('field.wf.model.formId') })
    .locator('.el-select')
    .click()
  await page.getByRole('option', { name: FORM, exact: true }).click()
  const updated = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith(`/${id}`))
  await edit.getByRole('button', { name: msg('crud.action.save') }).click()
  expect((await updated).postDataJSON()).toMatchObject({ formId: expect.any(Number) })
  await expect(edit).toBeHidden()

  // 流程设计: one review by the user the form's user field names; the input hidden from it
  await row.getByRole('button', { name: msg('wf.model.list.design') }).click()
  await expect(page).toHaveURL(new RegExp(`/wf/models/${id}/design$`))
  const designer = page.locator('.wf-designer')
  const drawer = page.locator('.wf-node-drawer')
  await designer
    .getByRole('button', { name: msg('wf.designer.add') })
    .last()
    .click()
  await page.getByRole('menuitem', { name: msg('wf.designer.type.review') }).click()
  await designer.locator('.wf-card--review .wf-card__main').click()
  await drawer.getByRole('textbox', { name: msg('wf.designer.drawer.name') }).fill('E2E Lead')
  await drawer.getByText(msg('wf.designer.assignee.kinds.formFieldUser'), { exact: true }).click()
  // the form's only user field is taken
  await expect(drawer.locator('.el-select', { hasText: lead!.field })).toBeVisible()
  const access = drawer.locator('.wf-access .el-table__body tr').filter({ hasText: secret!.field })
  // columns: edit, read, hide
  await access.locator('.el-radio').nth(2).click()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  const published = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith(`/api/wf/models/${id}/versions`),
  )
  await page.getByRole('button', { name: msg('wf.model.design.publish') }).click()
  await page
    .getByRole('dialog', { name: msg('wf.model.design.confirmTitle') })
    .getByRole('button', { name: msg('wf.model.design.publish') })
    .click()
  expect((await published).postDataJSON()).toMatchObject({
    tree: {
      next: {
        type: 'review',
        assignee: { kind: 'formFieldUser', field: lead!.field },
        access: { [secret!.field]: 'hide' },
      },
    },
  })
  await expect(
    page.getByText(msg('wf.model.design.published', 'zh-CN', { version: 1 })),
  ).toBeVisible()

  // 发起申请 (the OA employee): the form, a user picked, a file attached
  await signIn(page, 'oaEmployee', '/workflow/start')
  await page.getByRole('button', { name: MODEL.name, exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: msg('wf.center.start.title', 'zh-CN', { name: MODEL.name }),
  })
  await dialog.locator('.el-form-item', { hasText: secret!.title }).locator('input').fill(SECRET)
  await dialog.getByRole('button', { name: msg('picker.user.title'), exact: true }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(SUPERVISOR)
  await picker.getByRole('row').filter({ hasText: SUPERVISOR }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
  await expect(picker).toBeHidden()
  const uploaded = page.waitForResponse(
    (r) => r.url().endsWith('/api/storage/objects') && r.request().method() === 'POST',
  )
  await dialog.locator('input[type=file]').setInputFiles({
    name: FILE,
    mimeType: 'text/plain',
    buffer: Buffer.from('formkit flow attachment'),
  })
  expect((await uploaded).ok()).toBe(true)
  await expect(dialog.locator('.file-upload__item')).toHaveText(new RegExp(FILE))
  const started = page.waitForResponse((r) => r.url().endsWith('/api/wf/instances'))
  await dialog.getByRole('button', { name: msg('wf.center.start.submit') }).click()
  const answer = await started
  expect(answer.status(), await answer.text()).toBe(201)
  const instanceId = ((await answer.json()) as { data: { id: number } }).data.id
  await expect(dialog).toBeHidden()
  expect(answer.request().postDataJSON()).toMatchObject({
    formValues: { [secret!.field]: SECRET, [files!.field]: expect.stringMatching(`/${FILE}$`) },
  })

  // the picked user's to-do
  await signIn(page, 'oaSupervisor', '/workflow/todo')
  await expect(currentPage(page, 'menu.workflow.todo')).toBeVisible()
  const todo = page.locator('.el-table__body tr').filter({ hasText: MODEL.name })
  await expect(todo).toHaveCount(1)
  const read = page.waitForResponse((r) => r.url().endsWith(`/api/wf/instances/${instanceId}`))
  await todo.getByRole('button', { name: msg('wf.center.list.handle') }).click()
  const detail = (await (await read).json()) as { data: { formValues: object } }
  // the hidden field never came: neither its value nor its label shows
  expect(detail.data.formValues).not.toHaveProperty(secret!.field)
  const card = page.locator('.wf-detail__form')
  await expect(card).toContainText(lead!.title)
  await expect(card).toContainText(files!.title)
  await expect(card).not.toContainText(secret!.title)
  await expect(page.locator('.wf-detail')).not.toContainText(SECRET)
  // the picked user by name; the attachment downloads
  await expect(card.locator('input').first()).toHaveValue(SUPERVISOR)
  const downloading = page.waitForEvent('download')
  await card.getByRole('button', { name: FILE }).click()
  const file = await downloading
  expect(file.suggestedFilename()).toBe(FILE)
  expect(await readFile(await file.path(), 'utf8')).toBe('formkit flow attachment')
})
