// Acceptance: 新建审批 → 从模板创建 the built-in leave template →
// a field added to its form, the "over 3 days" condition changed to "over 5 days", the OA supervisor made a
// process manager (nobody heads a dept in the e2e org: the supervisor steps go to the managers) → 发布, its
// model step failing once: the retry goes on with the saved form (one form created, then updated) → the
// employee starts it with 4 days computed from the start and end dates → the "otherwise" path (the supervisor
// step, not the two levels) reaches the supervisor, who approves: the instance is approved.
import { bearer, currentPage, expect, msg, signIn, test, type Page } from './fixtures.ts'

const NAME = 'E2E wizard leave'
const DESCRIPTION = 'E2E: over 5 days two levels of supervisors'
const REASON = 'e2e wizard family visit'
/** the seeded OA supervisor's display name (the user picker searches display names) */
const SUPERVISOR = 'OA Supervisor'

type Rule = { type: string; field: string }
type Tree = { next: { paths: { when: unknown }[] } }

const tab = (page: Page, n: number, step: string) =>
  page.getByRole('tab', {
    name: msg('wf.wizard.tab', 'zh-CN', { n, name: msg(`wf.wizard.steps.${step}`) }),
  })

test('leave template → a field and a condition changed → published after a retry → 4 days approved by the supervisor', async ({
  page,
  request,
}) => {
  test.setTimeout(150_000)
  const root = { Authorization: await bearer(request) }
  // the template's form texts (form-create `{{$t.<id>}}` texts, zh-cn)
  const listed = await request.get('/api/wf/models', {
    headers: root,
    params: { modelKey: 'tpl-leave' },
  })
  const template = ((await listed.json()) as { data: { items: { formId: number }[] } }).data
    .items[0]!
  const form = await request.get(`/api/wf/forms/${template.formId}`, { headers: root })
  const texts = (
    (await form.json()) as {
      data: { schemaJson: { option: { language: Record<string, Record<string, string>> } } }
    }
  ).data.schemaJson.option.language['zh-cn']!

  // 新建审批 from the leave template, renamed
  await signIn(page, 'admin', '/wf/wizard')
  await expect(currentPage(page, 'menu.wf.wizard')).toBeVisible()
  await page.getByRole('button', { name: msg('wf.wizard.fromTemplate') }).click()
  await page.getByRole('menuitem', { name: msg('seed.wf.tpl.leave'), exact: true }).click()
  const name = page.getByRole('textbox', { name: msg('field.wf.model.name') })
  await expect(name).toHaveValue(msg('seed.wf.tpl.leave'))
  await name.fill(NAME)
  await page.getByRole('textbox', { name: msg('field.wf.model.description') }).fill(DESCRIPTION)

  // the form: the template's five fields, one more added
  await tab(page, 2, 'form').click()
  const tools = page.locator('._fc-designer ._fd-drag-tool')
  await expect(tools).toHaveCount(5)
  await page
    .locator('._fc-l-item')
    .filter({ has: page.locator('i.icon-input') })
    .click()
  await expect(tools).toHaveCount(6)

  // the flow: "over 3 days" now over 5
  await tab(page, 3, 'flow').click()
  const paths = page.locator('.wf-designer .wf-fork__path')
  await expect(paths).toHaveCount(2)
  await paths.first().locator('.wf-card--path .wf-card__main').click()
  const drawer = page.locator('.wf-node-drawer')
  const value = drawer.getByRole('spinbutton', { name: msg('wf.designer.cond.value') })
  await expect(value).toHaveValue('3')
  await value.fill('5')
  await value.blur()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(paths.first()).toContainText(`days ${msg('wf.designer.op.gt')} 5`)

  // advanced: the supervisor manages the process
  await tab(page, 4, 'advanced').click()
  await page.getByRole('button', { name: msg('wf.designer.assignee.pickUsers') }).click()
  const picker = page.getByRole('dialog', { name: msg('picker.user.title') })
  await picker.getByRole('textbox', { name: msg('field.iam.user.keyword') }).fill(SUPERVISOR)
  await picker.getByRole('row').filter({ hasText: SUPERVISOR }).click()
  await picker.getByRole('button', { name: msg('picker.user.confirm'), exact: true }).click()
  await expect(picker).toBeHidden()

  // publish: the model step fails once (503); the retry updates the saved form instead of a second one
  const writes: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/wf/'))
      writes.push(`${r.method()} ${r.url()}`)
  })
  let failed = false
  await page.route(
    (url) => url.pathname === '/api/wf/models',
    async (route) => {
      if (route.request().method() !== 'POST' || failed) return route.fallback()
      failed = true
      await route.fulfill({
        status: 503,
        json: { code: 'C0503', msg: 'e2e unavailable', data: null, traceId: 'e2e' },
      })
    },
  )
  const created = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/api/wf/forms'),
  )
  await page.getByRole('button', { name: msg('wf.wizard.publish') }).click()
  const formBody = (await created).postDataJSON() as { schemaJson: { rule: Rule[] } }
  expect(formBody.schemaJson.rule.map((r) => r.type)).toEqual([
    'qw-dict-select',
    'datePicker',
    'datePicker',
    'qw-date-range-days',
    'input',
    'input',
  ])
  const box = page.getByRole('dialog', { name: msg('wf.wizard.failedTitle') })
  await expect(box).toContainText(msg('wf.wizard.step.model'))
  const published = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/wf\/models\/\d+\/versions$/.test(r.url()),
  )
  await box.getByRole('button', { name: msg('wf.wizard.retry') }).click()
  const version = await published
  expect(version.status(), await version.text()).toBe(201)
  const tree = version.request().postDataJSON() as { tree: Tree }
  expect(tree.tree.next.paths[0]!.when).toEqual([[{ field: 'days', op: 'gt', value: 5 }]])
  await expect(page.getByText(msg('wf.wizard.published', 'zh-CN', { version: 1 }))).toBeVisible()
  await expect(page).toHaveURL(/\/wf\/models$/)
  const formId = /\/api\/wf\/forms\/(\d+)$/
  expect(writes.filter((w) => w.startsWith('POST') && w.endsWith('/api/wf/forms'))).toHaveLength(1)
  expect(writes.some((w) => w.startsWith('PUT') && formId.test(w))).toBe(true)
  expect(writes.filter((w) => w.startsWith('POST') && w.endsWith('/api/wf/models'))).toHaveLength(2)

  // the employee: start and end dates, the days computed (4: not over 5)
  await signIn(page, 'oaEmployee', '/workflow/start')
  await page.getByRole('button', { name: `${NAME} ${DESCRIPTION}`, exact: true }).click()
  const dialog = page.getByRole('dialog', {
    name: msg('wf.center.start.title', 'zh-CN', { name: NAME }),
  })
  const item = (title: string) => dialog.locator('.el-form-item').filter({ hasText: title })
  await item(texts.leaveKind!).locator('.el-select').click()
  await page.locator('.el-select-dropdown__item:visible').first().click()
  for (const [field, day] of [
    ['startDate', '2026-10-12'],
    ['endDate', '2026-10-15'],
  ] as const) {
    const input = item(texts[field]!).locator('input')
    await input.fill(day)
    await input.press('Enter')
    await expect(input).toHaveValue(day)
  }
  await expect(item(texts.days!).locator('input')).toHaveValue('4')
  await item(texts.reason!).locator('textarea').fill(REASON)
  const started = page.waitForResponse((r) => r.url().endsWith('/api/wf/instances'))
  await dialog.getByRole('button', { name: msg('wf.center.start.submit') }).click()
  const answer = await started
  expect(answer.status(), await answer.text()).toBe(201)
  expect(answer.request().postDataJSON()).toMatchObject({
    formValues: { startDate: '2026-10-12', endDate: '2026-10-15', days: 4, reason: REASON },
  })
  const instanceId = ((await answer.json()) as { data: { id: number } }).data.id
  await expect(dialog).toBeHidden()

  // the supervisor's to-do is the supervisor step (the "otherwise" path), approved
  await signIn(page, 'oaSupervisor', '/workflow/todo')
  const todo = page.locator('.el-table__body tr').filter({ hasText: NAME })
  await expect(todo).toHaveCount(1)
  await todo.getByRole('button', { name: msg('wf.center.list.handle') }).click()
  // the detail shows the days the server stored
  await expect(
    page
      .locator('.wf-detail__form .el-form-item')
      .filter({ hasText: texts.days! })
      .locator('input'),
  ).toHaveValue('4')
  const approve = msg('wf.center.decide.approve')
  await page
    .locator('.wf-detail__actions')
    .getByRole('button', { name: approve, exact: true })
    .click()
  const decide = page.getByRole('dialog', {
    name: `${approve} · ${msg('seed.wf.node.supervisor')}`,
  })
  const approved = page.waitForResponse((r) => /\/api\/wf\/tasks\/\d+\/approve$/.test(r.url()))
  await decide.getByRole('button', { name: approve, exact: true }).click()
  expect((await approved).status()).toBe(200)
  await expect(decide).toBeHidden()
  const detail = await request.get(`/api/wf/instances/${instanceId}`, { headers: root })
  expect(((await detail.json()) as { data: { state: string } }).data.state).toBe('approved')
})
